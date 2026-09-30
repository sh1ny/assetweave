import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PageInput, QueryPage } from '@assetweave/contracts/queries';
import { DatabaseService } from '../database/database.service.js';

interface Cursor { v: 1; signature: string; watermark: number; key: string[]; mac: string }
const secrets = new WeakMap<DatabaseService, Buffer>();
function secret(database: DatabaseService): Buffer {
  let value = secrets.get(database);
  if (!value) {
    const row = database.connection.prepare('SELECT secret FROM query_cursor_secrets WHERE id = 1')
      .get() as { secret: Buffer } | undefined;
    if (!row || row.secret.length !== 32) throw new Error('The catalog has no valid cursor signature key.');
    value = row.secret;
    secrets.set(database, value);
  }
  return value;
}
function mac(value: Omit<Cursor, 'mac'>, key: Buffer): string {
  return createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
}
function invalid(): never {
  throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid continuation cursor.' });
}
function decode(raw: string, key: Buffer): Cursor {
  if (raw.length > 65_536 || !/^[A-Za-z0-9_-]+$/.test(raw)) return invalid();
  let data: unknown;
  try { data = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { return invalid(); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return invalid();
  const cursor = data as Partial<Cursor>;
  if (cursor.v !== 1 || typeof cursor.signature !== 'string' || !/^[0-9a-f]{64}$/.test(cursor.signature) ||
      !Number.isSafeInteger(cursor.watermark) || cursor.watermark! < 0 ||
      !Array.isArray(cursor.key) || cursor.key.length < 1 || cursor.key.length > 4 ||
      cursor.key.some(part => typeof part !== 'string' || part.length > 48_000) ||
      typeof cursor.mac !== 'string' || !/^[0-9a-f]{64}$/.test(cursor.mac)) return invalid();
  const { mac: claimed, ...body } = cursor as Cursor;
  if (!timingSafeEqual(Buffer.from(claimed, 'hex'), Buffer.from(mac(body, key), 'hex'))) return invalid();
  return cursor as Cursor;
}
function encode(cursor: Omit<Cursor, 'mac'>, key: Buffer): string {
  return Buffer.from(JSON.stringify({ ...cursor, mac: mac(cursor, key) })).toString('base64url');
}

/** The loader must order by its key, fetch at most limit+1 rows and apply the strict keyset predicate. */
export function paginate<T>(database: DatabaseService, input: PageInput, identity: unknown,
  load: (after: readonly string[] | null, count: number) => T[], key: (row: T) => string[]): QueryPage<T> {
  const watermark = database.watermark;
  const fingerprint = createHash('sha256').update(JSON.stringify([identity, input.limit])).digest('hex');
  const keyMaterial = secret(database);
  const cursor = input.cursor ? decode(input.cursor, keyMaterial) : null;
  if (cursor && (cursor.signature !== fingerprint || cursor.watermark !== watermark)) {
    throw new ConflictException({ code: 'CONFLICT', message: 'The query or catalog changed. Start a fresh query.',
      watermark, cursorWatermark: cursor.watermark });
  }
  const rows = load(cursor?.key ?? null, input.limit + 1);
  if (rows.length > input.limit + 1) throw new Error('An unbounded pagination loader returned too many rows.');
  const items = rows.slice(0, input.limit);
  return { items, watermark, nextCursor: rows.length > input.limit && items.length
    ? encode({ v: 1, signature: fingerprint, watermark, key: key(items[items.length - 1]!) }, keyMaterial) : null };
}
