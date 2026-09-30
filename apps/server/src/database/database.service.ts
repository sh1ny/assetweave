import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ProfileService } from '../runtime/profile.service.js';

export interface Migration { version: number; sql: string }
const migrationFiles = [
  fileURLToPath(new URL('./migrations/001-domain.sql', import.meta.url)),
  fileURLToPath(new URL('./migrations/002-domain-integrity.sql', import.meta.url)),
  fileURLToPath(new URL('./migrations/003-decisions.sql', import.meta.url)),
  fileURLToPath(new URL('./migrations/004-search.sql', import.meta.url)),
  fileURLToPath(new URL('./migrations/005-project-history.sql', import.meta.url)),
];
const supportedVersion = migrationFiles.length;
const minimumSQLite = [3, 51, 3] as const;

function sqliteVersion(connection: DatabaseSync): number[] {
  const row = connection.prepare('SELECT sqlite_version() AS version, sqlite_compileoption_used(\'ENABLE_FTS5\') AS fts5').get() as
    { version: string; fts5: number };
  const parts = row.version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isSafeInteger(part)) ||
      (parts[0]! < minimumSQLite[0] ||
       (parts[0] === minimumSQLite[0] && parts[1]! < minimumSQLite[1]) ||
       (parts[0] === minimumSQLite[0] && parts[1] === minimumSQLite[1] && parts[2]! < minimumSQLite[2]))) {
    throw new Error(`SQLite ${row.version} is unsupported; AssetWeave needs SQLite 3.51.3 or newer (WAL reset fix).`);
  }
  if (row.fts5 !== 1) throw new Error('This SQLite build does not support FTS5; refusing to open the catalog.');
  return parts;
}

/** Check version before journal PRAGMAs or any migration can change an existing file. */
export function assertSupportedSchema(connection: DatabaseSync, latestVersion: number): number {
  const row = connection.prepare('PRAGMA user_version').get() as { user_version: number };
  if (!Number.isInteger(row.user_version) || row.user_version < 0 || row.user_version > latestVersion) {
    throw new Error(`Catalog schema ${row.user_version} is newer or unsupported; this service supports schema ${latestVersion}. No migration was attempted.`);
  }
  if (row.user_version === 0) {
    const preexisting = connection.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger', 'index') AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
    if (preexisting) throw new Error('An unversioned database already contains records. Refusing to reinterpret or overwrite it.');
  }
  return row.user_version;
}

/** SQL scripts contain DDL only: this function owns BEGIN/COMMIT and versioning. */
export function applyMigrations(connection: DatabaseSync, migrations: readonly Migration[]): void {
  const latest = migrations.at(-1)?.version ?? 0;
  if (migrations.some((migration, index) => migration.version !== index + 1)) {
    throw new Error('Database migrations must have contiguous ascending versions beginning at 1.');
  }
  const current = assertSupportedSchema(connection, latest);
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection.exec(migration.sql);
      connection.exec(`PRAGMA user_version = ${migration.version}`);
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }
}

function openCatalog(profile: ProfileService): DatabaseSync {
  profile.verify();
  // Probe the bundled library without creating or touching a user database.
  const probe = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    sqliteVersion(probe);
  } finally {
    probe.close();
  }
  const filename = join(profile.path, 'catalog.sqlite');
  if (existsSync(filename)) {
    const inspection = new DatabaseSync(filename, { readOnly: true, allowExtension: false });
    try {
      assertSupportedSchema(inspection, supportedVersion);
    } finally {
      inspection.close();
    }
  }
  profile.verify();
  const connection = new DatabaseSync(filename, { allowExtension: false, enableForeignKeyConstraints: true, timeout: 5000 });
  try {
    sqliteVersion(connection);
    connection.exec('PRAGMA foreign_keys = ON');
    const foreignKeys = connection.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    if (foreignKeys.foreign_keys !== 1) throw new Error('SQLite foreign keys are unavailable; refusing to open the catalog.');
    const journal = connection.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string };
    if (journal.journal_mode.toLowerCase() !== 'wal') throw new Error('SQLite WAL mode could not be enabled.');
    connection.exec('PRAGMA synchronous = FULL');
    const synchronous = connection.prepare('PRAGMA synchronous').get() as { synchronous: number };
    if (synchronous.synchronous !== 2) throw new Error('SQLite FULL synchronous commits could not be enabled.');
    applyMigrations(connection, migrationFiles.map((file, index) => ({ version: index + 1, sql: readFileSync(file, 'utf8') })));
    profile.verify();
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

export class RevisionConflict extends Error {
  constructor(readonly expectedRevision: number, readonly current: unknown) {
    super('This record has changed. Reload the current record and explicitly retry your edit.');
  }
}

export interface ExpectedRevision {
  expectedRevision: number;
  readCurrent(connection: DatabaseSync): { revision: number } | undefined;
}

export interface MutationOptions {
  actor: string;
  targetType: string;
  targetId: string;
  at?: string;
  authority?: { channel: 'browser' | 'reported'; instruction: string };
  rationale?: string;
  expected?: readonly ExpectedRevision[];
}

export interface MutationEvent {
  id: number;
  actor: string;
  at: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  authorityId: string | null;
  rationale: string | null;
}
export interface MutationResult<T> { before: unknown; after: unknown; result: T }
export interface MutationContext { connection: DatabaseSync; eventId: number; at: string; authorityId: string | null }
export type TransactionalProjection = (event: MutationEvent, connection: DatabaseSync) => void;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly connection: DatabaseSync;
  private readonly projections: TransactionalProjection[] = [];
  private inMutation = false;
  private closed = false;

  constructor(profile: ProfileService) {
    this.connection = openCatalog(profile);
  }

  /** U7 registers projections here; they run after current/history writes, before COMMIT. */
  addProjection(projection: TransactionalProjection): void {
    this.projections.push(projection);
  }

  get watermark(): number {
    return (this.connection.prepare('SELECT watermark FROM mutation_clock WHERE id = 1').get() as { watermark: number }).watermark;
  }

  mutate<T>(options: MutationOptions, change: (context: MutationContext) => MutationResult<T>): T {
    if (this.closed || this.inMutation) throw new Error('The database is closed or a mutation transaction is already active.');
    if (!options.actor.trim() || !options.targetId.trim() || !options.targetType.trim()) throw new Error('A mutation requires an actor and target identity.');
    if (options.authority && !options.authority.instruction.trim()) throw new Error('A decision requires the human instruction that authorized it.');
    const at = options.at ?? new Date().toISOString();
    this.inMutation = true;
    try {
      this.connection.exec('BEGIN IMMEDIATE');
      try {
        for (const check of options.expected ?? []) {
          const current = check.readCurrent(this.connection);
          if (!current || current.revision !== check.expectedRevision) {
            throw new RevisionConflict(check.expectedRevision, current ?? null);
          }
        }
        const eventId = (this.connection.prepare('UPDATE mutation_clock SET watermark = watermark + 1 WHERE id = 1 RETURNING watermark').get() as
          { watermark: number }).watermark;
        const authorityId = options.authority ? randomUUID() : null;
        if (options.authority) {
          this.connection.prepare('INSERT INTO authorities(id, channel, instruction, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?)')
            .run(authorityId, options.authority.channel, options.authority.instruction, options.actor, at);
        }
        this.connection.prepare('INSERT INTO audit_events(id, actor, recorded_at, target_type, target_id, before_json, after_json, authority_id, rationale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(eventId, options.actor, at, options.targetType, options.targetId, 'null', 'null', authorityId, options.rationale ?? null);
        const changed = change({ connection: this.connection, eventId, at, authorityId });
        const event: MutationEvent = {
          id: eventId, actor: options.actor, at, targetType: options.targetType,
          targetId: options.targetId, before: changed.before, after: changed.after,
          authorityId, rationale: options.rationale ?? null,
        };
        this.connection.prepare('UPDATE audit_events SET before_json = ?, after_json = ? WHERE id = ?')
          .run(JSON.stringify(changed.before), JSON.stringify(changed.after), eventId);
        for (const projection of this.projections) projection(event, this.connection);
        this.connection.exec('COMMIT');
        return changed.result;
      } catch (error) {
        this.connection.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.inMutation = false;
    }
  }

  onModuleDestroy(): void { this.close(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
  }
}
