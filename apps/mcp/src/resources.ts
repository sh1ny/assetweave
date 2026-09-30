import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { catalogId } from '@assetweave/contracts/catalog';
import { BridgeClient, BridgeFault, bridgeError } from './client.js';

const resourceIdentity = z.strictObject({
  artifactId: catalogId, ordinal: z.string().regex(/^\d{1,3}$/u).transform(Number).pipe(z.number().int().min(0).max(127)),
});
const revisionIdentity = z.strictObject({
  revisionId: catalogId, ordinal: z.string().regex(/^\d{1,3}$/u).transform(Number).pipe(z.number().int().min(0).max(127)),
});
function parseIdentity<S extends z.ZodType>(schema: S, params: unknown): z.output<S> {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new BridgeFault({ code: 'INVALID_REQUEST', message: 'Use an opaque UUID and member ordinal 0..127.' });
  return parsed.data;
}

export function registerResources(server: McpServer, client: BridgeClient): void {
  server.registerResource('preserved-original',
    new ResourceTemplate('assetweave://artifacts/{artifactId}/members/{ordinal}/original', { list: undefined }),
    { title: 'Preserved exact original member', description: 'Read complete original bytes by artifact ID and member ordinal, with a checked SHA-256. Not a preview.', mimeType: 'application/octet-stream' },
    async (uri, params) => {
      try {
        const { artifactId: id, ordinal: index } = parseIdentity(resourceIdentity, params);
        const { data, sha256, byteCount } = await client.original(id, index);
        return { contents: [
          { uri: uri.href, mimeType: 'application/octet-stream', blob: data.toString('base64') },
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ label: 'Exact preserved original, not a display preview.', artifactId: id, ordinal: index, byteCount, sha256 }) },
        ] };
      } catch (error) { throw new Error(JSON.stringify(bridgeError(error))); }
    });

  server.registerResource('pinned-playback-preview',
    new ResourceTemplate('assetweave://playback-revisions/{revisionId}/members/{ordinal}/preview', { list: undefined }),
    { title: 'Revision-pinned verified preview', description: 'Read a bounded verified image from an immutable playback revision, not the current clip.', mimeType: 'application/json' },
    async (uri, params) => {
      try {
        const { revisionId, ordinal: index } = parseIdentity(revisionIdentity, params);
        const { artifactId, preview } = await client.previewRevision(revisionId, index);
        const originalUri = `assetweave://artifacts/${artifactId}/members/${index}/original`;
        if (preview.status === 'unavailable') return { contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ ...preview, revisionId, originalUri }) },
        ] };
        return { contents: [
          { uri: uri.href, mimeType: preview.mimeType, blob: preview.data.toString('base64') },
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ status: 'available', label: preview.label, revisionId, originalUri }) },
        ] };
      } catch (error) { throw new Error(JSON.stringify(bridgeError(error))); }
    });

  server.registerResource('verified-preview',
    new ResourceTemplate('assetweave://artifacts/{artifactId}/members/{ordinal}/preview', { list: undefined }),
    { title: 'Bounded verified display preview', description: 'At most 256 KiB for verified display; may be unavailable. Exact originals use a separate resource URI.', mimeType: 'application/json' },
    async (uri, params) => {
      try {
        const { artifactId: id, ordinal: index } = parseIdentity(resourceIdentity, params);
        const originalUri = `assetweave://artifacts/${id}/members/${index}/original`;
        const preview = await client.preview(id, index);
        if (preview.status === 'unavailable') return { contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ ...preview, originalUri }) },
        ] };
        return { contents: [
          { uri: uri.href, mimeType: preview.mimeType, blob: preview.data.toString('base64') },
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ status: 'available', label: preview.label, originalUri }) },
        ] };
      } catch (error) { throw new Error(JSON.stringify(bridgeError(error))); }
    });
}
