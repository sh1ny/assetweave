import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { ApiError, ApiErrorCode } from '@assetweave/contracts/errors';
import { RevisionConflict } from '../database/database.service.js';
import { CatalogConflict } from '../catalog/catalog.service.js';

const codes: Record<ApiErrorCode, true> = {
  UNAUTHORIZED: true, FORBIDDEN: true, INVALID_REQUEST: true, NOT_FOUND: true, CONFLICT: true,
  MISSING_AUTHORITY: true, INCOMPLETE_CAPTURE: true, CONTENT_UNAVAILABLE: true, SERVICE_UNAVAILABLE: true,
};
const defaultCodes: Record<number, ApiErrorCode> = {
  400: 'INVALID_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 413: 'INCOMPLETE_CAPTURE', 503: 'SERVICE_UNAVAILABLE',
};

/** The same safe envelope can be read by the browser and forwarded by MCP. */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (error instanceof RevisionConflict) {
      reply.status(409).send({ code: 'CONFLICT', message: error.message,
        expectedRevision: error.expectedRevision, current: error.current } satisfies ApiError);
      return;
    }
    if (error instanceof CatalogConflict) {
      reply.status(409).send({ code: 'CONFLICT', message: error.message, current: error.current } satisfies ApiError);
      return;
    }
    const status = error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const response = error instanceof HttpException ? error.getResponse() : null;
    const data = response && typeof response === 'object' && !Array.isArray(response)
      ? response as Record<string, unknown> : {};
    const code = typeof data.code === 'string' && Object.hasOwn(codes, data.code)
      ? data.code as ApiErrorCode : defaultCodes[status] ?? 'SERVICE_UNAVAILABLE';
    const message = typeof data.message === 'string' ? data.message :
      status >= 500 ? 'The local service could not complete this operation.' :
        error instanceof HttpException ? error.message : 'Invalid request.';
    const envelope: ApiError = { code, message };
    if (Array.isArray(data.issues)) envelope.issues = data.issues as ApiError['issues'];
    if (typeof data.expectedRevision === 'number') envelope.expectedRevision = data.expectedRevision;
    if ('current' in data) envelope.current = data.current;
    if (Array.isArray(data.alternatives)) envelope.alternatives = data.alternatives as ApiError['alternatives'];
    if (typeof data.alternativesTruncated === 'boolean') envelope.alternativesTruncated = data.alternativesTruncated;
    if (typeof data.alternativesUrl === 'string') envelope.alternativesUrl = data.alternativesUrl;
    if (typeof data.watermark === 'number') envelope.watermark = data.watermark;
    if (typeof data.cursorWatermark === 'number') envelope.cursorWatermark = data.cursorWatermark;
    reply.status(status).send(envelope);
  }
}
