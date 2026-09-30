import { Injectable } from '@nestjs/common';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError, ApiErrorCode } from '@assetweave/contracts/errors';
import { ProfileService } from './profile.service.js';

const cookieName = 'assetweave_session';
const cookiePrefix = `${cookieName}=`;
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const pairingLifetimeMs = 2 * 60 * 1000;
const token = () => randomBytes(32).toString('base64url');

interface BrowserSession { csrfToken: string; expiresAt: number }
type Authorization = { kind: 'browser'; session: BrowserSession; id: string } | { kind: 'bridge' } | { kind: 'launcher' };

// Fastify's onRequest hook runs before body parsing, all route handlers and
// @fastify/static. Other modules must not bypass this one shared boundary.
declare module 'fastify' {
  interface FastifyRequest {
    localAuthorization?: Authorization;
  }
}

function equalSecret(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length || candidate.length > 512 || !/^[\w-]+$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

function error(reply: FastifyReply, status: number, code: ApiErrorCode, message: string): void {
  const response: ApiError = { code, message };
  reply.code(status).send(response);
}

function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const values = request.raw.rawHeaders;
  let count = 0;
  for (let i = 0; i < values.length; i += 2) {
    if (values[i]?.toLowerCase() === name) count++;
  }
  if (count > 1) return undefined;
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function hasDuplicate(request: FastifyRequest, name: string): boolean {
  const values = request.raw.rawHeaders;
  let count = 0;
  for (let i = 0; i < values.length; i += 2) {
    if (values[i]?.toLowerCase() === name) count++;
  }
  return count > 1;
}

@Injectable()
export class LocalAccessService {
  readonly bridgeBearer = token();
  readonly launcherToken = token();
  private origin: string | undefined;
  private pairing: { digest: string; expiresAt: number } | undefined;
  private sessions = new Map<string, BrowserSession>();

  constructor(readonly profile: ProfileService) {}

  setOrigin(origin: string): void {
    if (this.origin) throw new Error('Local service origin cannot change after startup.');
    this.origin = origin;
  }

  getOrigin(): string {
    if (!this.origin) throw new Error('The local service is not listening yet.');
    return this.origin;
  }

  private browserSession(request: FastifyRequest): Authorization | undefined {
    if (hasDuplicate(request, 'cookie')) return;
    const cookie = singleHeader(request, 'cookie');
    if (!cookie) return;
    let id: string | undefined;
    let start = 0;
    while (start < cookie.length) {
      let end = cookie.indexOf(';', start);
      if (end < 0) end = cookie.length;
      while (start < end && cookie[start] === ' ') start++;
      if (cookie.startsWith(cookiePrefix, start)) {
        if (id !== undefined) return;
        id = cookie.slice(start + cookiePrefix.length, end);
      }
      start = end + 1;
    }
    if (!id) return;
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return;
    }
    return { kind: 'browser', id, session };
  }

  authorize(request: FastifyRequest, reply: FastifyReply): void {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");

    const origin = this.origin;
    if (!origin) return error(reply, 503, 'SERVICE_UNAVAILABLE', 'The local service is still starting.');
    const expectedHost = origin.slice('http://'.length);
    if (hasDuplicate(request, 'host') || singleHeader(request, 'host') !== expectedHost) {
      return error(reply, 403, 'FORBIDDEN', `Use the exact local address ${origin}. Requests with another Host are refused.`);
    }
    const suppliedOrigin = singleHeader(request, 'origin');
    if (hasDuplicate(request, 'origin') || (suppliedOrigin !== undefined && suppliedOrigin !== origin)) {
      return error(reply, 403, 'FORBIDDEN', 'The request Origin does not match this local service.');
    }
    const fetchSite = singleHeader(request, 'sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return error(reply, 403, 'FORBIDDEN', 'Cross-site requests cannot access this local service.');
    }
    if (request.method === 'OPTIONS') return error(reply, 403, 'FORBIDDEN', 'Cross-origin requests are not enabled.');

    const query = request.url.indexOf('?');
    const path = query < 0 ? request.url : request.url.slice(0, query);
    if (path.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) || /%(?:2e|2f|5c|00)/i.test(path)) {
      return error(reply, 400, 'INVALID_REQUEST', 'Unsafe or ambiguous URL paths are refused.');
    }
    const browserPage = path === '/' || path === '/pair' || path === '/connection';
    if (browserPage || path.startsWith('/assets/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return error(reply, 405, 'INVALID_REQUEST', 'The browser shell only accepts read requests.');
      }
      return;
    }

    reply.header('Cache-Control', 'no-store');
    if (path === '/api/pair' && request.method === 'POST') {
      if (suppliedOrigin !== origin || hasDuplicate(request, 'authorization')) {
        return error(reply, 403, 'FORBIDDEN', 'Pairing requires a same-origin browser request and a one-time code.');
      }
      return;
    }

    const authHeader = singleHeader(request, 'authorization');
    if (path === '/__local/pair-capability' && request.method === 'POST') {
      if (suppliedOrigin !== undefined || hasDuplicate(request, 'authorization') ||
          !authHeader?.startsWith('Bearer ') || !equalSecret(authHeader.slice(7), this.launcherToken) ||
          request.headers.cookie !== undefined) {
        return error(reply, 401, 'UNAUTHORIZED', 'Only the private interactive launcher may request a pairing code.');
      }
      request.localAuthorization = { kind: 'launcher' };
      return;
    }

    if (!/^\/(api|media)(?:\/|$)/i.test(path)) return error(reply, 404, 'NOT_FOUND', 'No browser route exists at this address.');
    if (hasDuplicate(request, 'authorization') || hasDuplicate(request, 'cookie') || hasDuplicate(request, 'x-assetweave-csrf')) {
      return error(reply, 401, 'UNAUTHORIZED', 'Duplicate credentials are not accepted.');
    }
    if (authHeader !== undefined) {
      if (suppliedOrigin !== undefined || request.headers.cookie !== undefined ||
          !authHeader.startsWith('Bearer ') || !equalSecret(authHeader.slice(7), this.bridgeBearer)) {
        return error(reply, 401, 'UNAUTHORIZED', 'A current bridge credential is required.');
      }
      request.localAuthorization = { kind: 'bridge' };
      return;
    }
    const browser = this.browserSession(request);
    if (!browser) return error(reply, 401, 'UNAUTHORIZED', 'Pair this browser with the local service before accessing private records.');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (suppliedOrigin !== origin) return error(reply, 403, 'FORBIDDEN', 'Mutations require this browser origin.');
      const csrf = singleHeader(request, 'x-assetweave-csrf');
      if (browser.kind !== 'browser' || !csrf || !equalSecret(csrf, browser.session.csrfToken)) {
        return error(reply, 403, 'FORBIDDEN', 'A valid session CSRF header is required for mutations.');
      }
    }
    request.localAuthorization = browser;
  }

  issueCapability(): { capability: string; expiresAt: number } {
    const capability = token();
    const expiresAt = Date.now() + pairingLifetimeMs;
    this.pairing = { digest: createHash('sha256').update(capability).digest('hex'), expiresAt };
    return { capability, expiresAt };
  }

  pair(capability: string): { cookie: string; csrfToken: string } | undefined {
    const pending = this.pairing;
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pairing = undefined;
      return;
    }
    if (!/^[\w-]{43}$/.test(capability)) return;
    const digest = createHash('sha256').update(capability).digest('hex');
    if (!equalSecret(digest, pending.digest)) return;
    this.pairing = undefined;
    const id = token();
    const csrfToken = token();
    this.sessions.set(id, { csrfToken, expiresAt: Date.now() + sessionLifetimeMs });
    return { cookie: `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs / 1000}`, csrfToken };
  }

  session(request: FastifyRequest): BrowserSession {
    const auth = request.localAuthorization;
    if (!auth || auth.kind !== 'browser') throw new Error('Browser session is unavailable.');
    return auth.session;
  }

  endSession(request: FastifyRequest): void {
    const auth = request.localAuthorization;
    if (!auth || auth.kind !== 'browser') throw new Error('Browser session is unavailable.');
    this.sessions.delete(auth.id);
  }
}
