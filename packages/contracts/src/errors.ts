import * as z from 'zod';

export const apiErrorSchema = z.strictObject({
  code: z.enum([
    'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_REQUEST', 'NOT_FOUND', 'CONFLICT',
    'MISSING_AUTHORITY', 'INCOMPLETE_CAPTURE', 'CONTENT_UNAVAILABLE', 'SERVICE_UNAVAILABLE',
  ]),
  message: z.string(),
  issues: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
  expectedRevision: z.number().optional(),
  current: z.unknown().optional(),
  alternatives: z.array(z.strictObject({
    category: z.enum(['project', 'asset', 'slot']), id: z.string(), name: z.string(), url: z.string(),
  })).optional(),
  alternativesTruncated: z.boolean().optional(),
  alternativesUrl: z.string().optional(),
  watermark: z.number().optional(),
  cursorWatermark: z.number().optional(),
});

/** Shared HTTP/MCP failure envelope. Never embed an error in a successful result. */
export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'MISSING_AUTHORITY'
  | 'INCOMPLETE_CAPTURE'
  | 'CONTENT_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  issues?: { path: string; message: string }[];
  expectedRevision?: number;
  current?: unknown;
  alternatives?: { category: 'project' | 'asset' | 'slot'; id: string; name: string; url: string }[];
  alternativesTruncated?: boolean;
  alternativesUrl?: string;
  watermark?: number;
  cursorWatermark?: number;
}
