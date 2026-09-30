import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import * as z from 'zod';
import { ProfileService, type BridgeDiscovery } from '@assetweave/server/profile';
import { apiErrorSchema, type ApiError } from '@assetweave/contracts/errors';
import { captureRecordSchema } from '@assetweave/contracts/capture';
import { catalogId } from '@assetweave/contracts/catalog';
import { revisionKey } from '@assetweave/contracts/queries';

const unavailable = 'The selected AssetWeave service is unavailable. Start `corepack pnpm start` for the same ASSETWEAVE_DATA_DIR, then restart this MCP bridge.';
const changed = 'The selected AssetWeave service or profile changed. Restart this MCP bridge against the current service; no operation was retried.';
const playbackRevisionMembership = z.object({
  artifactId: catalogId,
  memberPreviewUrls: z.array(z.object({ ordinal: z.number().int().min(0).max(127) })),
});

/** Never return an exception's path, URL, credential, or untrusted HTTP body to an MCP host. */
export class BridgeFault extends Error {
  constructor(readonly detail: ApiError) { super(detail.message); }
}

export function bridgeError(error: unknown): ApiError {
  if (error instanceof BridgeFault) return error.detail;
  if (error instanceof z.ZodError) return { code: 'INVALID_REQUEST', message: 'An argument did not match the shared operation schema.',
    issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) };
  return { code: 'SERVICE_UNAVAILABLE', message: unavailable };
}

export function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

type BrowserIdentity = Partial<Record<
  'projectId' | 'assetId' | 'slotId' | 'artifactId' | 'candidateId' | 'clipId' | 'requestId' | 'revisionId',
  string | null
>>;
export function recordLink(origin: string, identities: BrowserIdentity): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(identities)) {
    if (value !== null && value !== undefined) {
      params.set(key, key === 'revisionId' ? revisionKey.parse(value) : catalogId.parse(value));
    }
  }
  return `${origin}/?${params.toString()}`;
}

function safeEnvelope(body: unknown): ApiError | null {
  const parsed = apiErrorSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

type PreviewResult =
  { status: 'available'; data: Buffer; mimeType: string; label: string } |
  { status: 'unavailable'; reason: string; label: string };

/** The first discovery is pinned for this stdio session. A restart cannot silently inherit a new bearer. */
export class BridgeClient {
  private profile: ProfileService | undefined;
  private pinned: BridgeDiscovery | undefined;

  constructor(private readonly profilePath?: string) {}

  private async discovery(): Promise<BridgeDiscovery> {
    try {
      this.profile ??= await ProfileService.forBridgeDiscovery(this.profilePath);
      const current = await this.profile.readBridge();
      if (this.pinned && (current.instanceId !== this.pinned.instanceId || current.origin !== this.pinned.origin ||
        current.bearer !== this.pinned.bearer)) throw new BridgeFault({ code: 'SERVICE_UNAVAILABLE', message: changed });
      this.pinned ??= current;
      return current;
    } catch (error) {
      if (error instanceof BridgeFault) throw error;
      throw new BridgeFault({ code: 'SERVICE_UNAVAILABLE', message: this.pinned ? changed : unavailable });
    }
  }

  private async raw(path: string, init: RequestInit, discovery: BridgeDiscovery, timeoutMs = 15_000): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${discovery.bearer}`);
    try {
      return await fetch(`${discovery.origin}${path}`, {
        ...init,
        headers,
        redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BridgeFault({ code: 'SERVICE_UNAVAILABLE', message: unavailable });
    }
  }

  private async checked(response: Response): Promise<Response> {
    if (response.ok) return response;
    let parsed: unknown;
    try { parsed = await response.json(); } catch { /* Untrusted error body is not displayed. */ }
    const error = safeEnvelope(parsed);
    if (error) {
      if (error.code === 'UNAUTHORIZED') throw new BridgeFault({ code: 'SERVICE_UNAVAILABLE', message: changed });
      throw new BridgeFault(error);
    }
    throw new BridgeFault({ code: 'SERVICE_UNAVAILABLE', message: 'The local service returned an invalid error response. Inspect its stderr and restart this bridge.' });
  }

  /** The authenticated owner reports the canonical profile; discovery alone does not prove identity. */
  private async authenticated(): Promise<BridgeDiscovery> {
    const discovery = await this.discovery();
    const response = await this.checked(await this.raw('/api/connection', { method: 'GET' }, discovery));
    let data: unknown;
    try { data = await response.json(); } catch { /* Invalid response. */ }
    const connection = z.strictObject({ profile: z.string(), origin: z.string() }).safeParse(data);
    if (!connection.success || connection.data.profile !== this.profile?.path ||
      connection.data.origin !== discovery.origin) {
      throw new BridgeFault({ code: 'SERVICE_UNAVAILABLE', message: changed });
    }
    return discovery;
  }

  async connect(): Promise<string> { return (await this.authenticated()).origin; }

  async json<T>(path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: unknown): Promise<T> {
    const discovery = await this.authenticated();
    const response = await this.checked(await this.raw(path, {
      method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }, discovery));
    try {
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result) && method === 'GET' || safeEnvelope(result)) {
        throw new Error('Unexpected service result.');
      }
      return result as T;
    } catch {
      throw new BridgeFault({ code: 'SERVICE_UNAVAILABLE', message: 'The local service returned an invalid operation result.' });
    }
  }

  async upload(body: AsyncIterable<Uint8Array>, boundary: string): Promise<unknown> {
    const discovery = await this.authenticated();
    let streamFault: BridgeFault | undefined;
    const guarded = async function* () {
      try { yield* body; }
      catch (error) {
        streamFault = error instanceof BridgeFault ? error :
          new BridgeFault({ code: 'INCOMPLETE_CAPTURE', message: 'An explicit file became unreadable during capture. Inspect the operation receipt before retrying.' });
        throw streamFault;
      }
    };
    let response: Response;
    try {
      response = await this.checked(await this.raw('/api/captures', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Readable.toWeb(Readable.from(guarded())) as ReadableStream,
        duplex: 'half',
      } as RequestInit, discovery, 135_000));
    } catch (error) { throw streamFault ?? error; }
    try { return await response.json() as unknown; }
    catch { throw new BridgeFault({ code: 'SERVICE_UNAVAILABLE', message: 'The local service returned an invalid capture receipt.' }); }
  }

  private async boundedBytes(response: Response, maximum: number): Promise<Buffer | null> {
    const reader = response.body?.getReader();
    if (!reader) throw new BridgeFault({ code: 'CONTENT_UNAVAILABLE', message: 'The local service returned no content stream.' });
    const result = Buffer.allocUnsafe(maximum);
    let position = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (position + value.length > maximum) {
          await reader.cancel();
          return null;
        }
        result.set(value, position);
        position += value.length;
      }
    } catch {
      throw new BridgeFault({ code: 'CONTENT_UNAVAILABLE', message: 'The local content transfer was interrupted; no complete bytes were returned.' });
    } finally {
      reader.releaseLock();
    }
    return result.subarray(0, position);
  }

  async original(artifactId: string, ordinal: number): Promise<{ data: Buffer; sha256: string; byteCount: number }> {
    const parsed = captureRecordSchema.safeParse(await this.json(`/api/artifacts/${catalogId.parse(artifactId)}`));
    if (!parsed.success) throw new BridgeFault({ code: 'SERVICE_UNAVAILABLE', message: 'The local service returned an invalid artifact record.' });
    const record = parsed.data;
    const member = record.members?.[ordinal];
    if (!member || member.ordinal !== ordinal || !Number.isSafeInteger(member.byteCount) ||
      member.byteCount < 1 || member.byteCount > 32 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(member.sha256)) {
      throw new BridgeFault({ code: 'CONTENT_UNAVAILABLE', message: 'The selected original has no valid preserved member descriptor.' });
    }
    const response = await this.checked(await this.raw(`/api/artifacts/${catalogId.parse(artifactId)}/members/${ordinal}/original`,
      { method: 'GET' }, await this.authenticated()));
    if (response.headers.get('content-length') !== String(member.byteCount)) {
      await response.body?.cancel();
      throw new BridgeFault({ code: 'CONTENT_UNAVAILABLE', message: 'The original byte count does not match its preserved descriptor.' });
    }
    const data = await this.boundedBytes(response, member.byteCount);
    if (!data || data.byteLength !== member.byteCount || createHash('sha256').update(data).digest('hex') !== member.sha256) {
      throw new BridgeFault({ code: 'CONTENT_UNAVAILABLE', message: 'The original bytes did not match their preserved digest.' });
    }
    return { data, sha256: member.sha256, byteCount: member.byteCount };
  }

  async preview(artifactId: string, ordinal: number, maxBytes = 256 * 1024): Promise<PreviewResult> {
    return this.readPreview(catalogId.parse(artifactId), ordinal, maxBytes);
  }

  async previewRevision(revisionId: string, ordinal: number, maxBytes = 256 * 1024): Promise<{ artifactId: string; preview: PreviewResult }> {
    const id = catalogId.parse(revisionId);
    const revision = playbackRevisionMembership.parse(await this.json(`/api/playback-revisions/${id}`));
    if (!revision.memberPreviewUrls.some(member => member.ordinal === ordinal)) {
      throw new BridgeFault({ code: 'NOT_FOUND', message: 'Member does not belong to this playback revision.' });
    }
    return { artifactId: revision.artifactId, preview: await this.readPreview(revision.artifactId, ordinal, maxBytes, id) };
  }

  private async readPreview(id: string, ordinal: number, maxBytes: number, revisionId?: string): Promise<PreviewResult> {
    const label = 'Bounded verified display preview; not a substitute for the exact original resource.';
    const media = await this.json<{ members: { preview: string; reason: string | null; member: { ordinal: number; byteCount: number } }[] }>(`/api/artifacts/${id}/media`);
    const member = media.members?.find(entry => entry.member?.ordinal === ordinal);
    if (!member) throw new BridgeFault({ code: 'NOT_FOUND', message: 'This artifact has no member at the requested ordinal.' });
    if (member.preview !== 'available') {
      return { status: 'unavailable', reason: member.reason ?? 'No verified display preview is available.', label };
    }
    if (member.member.byteCount > maxBytes) return { status: 'unavailable', reason: `Verified preview exceeds the ${maxBytes}-byte MCP display limit; use the exact original resource.`, label };
    const path = revisionId
      ? `/api/playback-revisions/${revisionId}/members/${ordinal}/preview`
      : `/api/artifacts/${id}/media/members/${ordinal}`;
    const response = await this.checked(await this.raw(path, { method: 'GET' }, await this.authenticated()));
    const mimeType = response.headers.get('content-type');
    if (mimeType !== 'image/png' && mimeType !== 'image/gif') {
      await response.body?.cancel();
      throw new BridgeFault({ code: 'CONTENT_UNAVAILABLE', message: 'The service did not return a supported display image.' });
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      return { status: 'unavailable', reason: `Verified preview exceeds the ${maxBytes}-byte MCP display limit; use the exact original resource.`, label };
    }
    const data = await this.boundedBytes(response, maxBytes);
    if (!data) return { status: 'unavailable', reason: 'Preview exceeded the MCP display limit; use the exact original resource.', label };
    return { status: 'available', data, mimeType, label };
  }
}
