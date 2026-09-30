import type { CaptureMetadata, CaptureReceipt } from '@assetweave/contracts/capture';
import type { ApiError } from '@assetweave/contracts/errors';
import type { QueryPage, SearchHit, SearchInput } from '@assetweave/contracts/queries';

export class ApiClientError extends Error {
  readonly unauthorized: boolean;

  constructor(readonly status: number, readonly code: ApiError['code'] | undefined,
    message: string, readonly details?: ApiError) {
    super(message);
    this.name = 'ApiClientError';
    this.unauthorized = status === 401;
  }
}

/** Uses the paired browser session; never stores credentials or replays mutations. */
export class ApiClient {
  private unauthorizedSignaled = false;

  constructor(private readonly csrfToken: string, private readonly onUnauthorized?: () => void) {}

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 401 && !this.unauthorizedSignaled) {
        this.unauthorizedSignaled = true;
        this.onUnauthorized?.();
      }
      let envelope: Partial<ApiError> | null = null;
      try {
        const payload: unknown = await response.json();
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) envelope = payload as Partial<ApiError>;
      } catch { /* HTTP status is still available if the service returned no JSON. */ }
      const code = typeof envelope?.code === 'string' ? envelope.code : undefined;
      const message = typeof envelope?.message === 'string' ? envelope.message :
        `The local service returned HTTP ${response.status}.`;
      throw new ApiClientError(response.status, code, message,
        code ? envelope as ApiError : undefined);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  mutate<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method,
      headers: {
        'x-assetweave-csrf': this.csrfToken,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  upload(metadata: CaptureMetadata, files: File[]): Promise<CaptureReceipt> {
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    files.forEach((file, index) => form.append(`member${index}`, file));
    return this.request<CaptureReceipt>('/api/captures', {
      method: 'POST', headers: { 'x-assetweave-csrf': this.csrfToken }, body: form,
    });
  }

  page<T>(path: string, cursor?: string): Promise<QueryPage<T>> {
    if (!cursor) return this.get<QueryPage<T>>(path);
    const url = new URL(path, 'http://localhost');
    url.searchParams.set('cursor', cursor);
    return this.get<QueryPage<T>>(`${url.pathname}${url.search}${url.hash}`);
  }

  search(filters: SearchInput['filters'] = {}, text?: string,
    scope: 'current' | 'history' = 'current', cursor?: string): Promise<QueryPage<SearchHit>> {
    const params = new URLSearchParams({ filters: JSON.stringify(filters), scope });
    if (text?.trim()) params.set('text', text);
    return this.page<SearchHit>(`/api/queries/search?${params}`, cursor);
  }
}
