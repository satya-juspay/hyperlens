import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { decodeSnapshot, snapshotLines } from './cache.js';
import type { Snapshot, SnapshotCache } from './cache.js';

const gzipText = promisify(gzip);
const maxPartBytes = 2 * 1024 * 1024;
const rawBatchSize = 48;
const snapshotBatchSize = 12;

type RawConfig = { hash: string; compressed: Uint8Array };
type VersionRow = { version: string | null };
type SnapshotRow = VersionRow & { compressed: Buffer | null };

class SnapshotChanged extends Error {}

function storageError(action: string, error: unknown): Error {
  if (error instanceof SnapshotChanged) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const suffix = typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code) ? ` (${code})` : '';
  return new Error(`Postgres could not ${action}${suffix}.`);
}

async function* compressedParts(snapshot: Snapshot): AsyncGenerator<Uint8Array> {
  let lines: string[] = [];
  let size = 0;
  for (const line of snapshotLines(snapshot)) {
    const bytes = Buffer.byteLength(line);
    if (lines.length && size + bytes > maxPartBytes) {
      yield Uint8Array.from(await gzipText(lines.join(''), { level: 3 }));
      lines = [];
      size = 0;
    }
    lines.push(line);
    size += bytes;
  }
  if (lines.length) yield Uint8Array.from(await gzipText(lines.join(''), { level: 3 }));
}

export function postgresSchema(schema: string): string {
  if (!/^[a-z][a-z0-9_]{0,50}$/.test(schema)) throw new Error('Invalid Postgres schema name.');
  return '"' + schema + '"';
}

export function postgresPool(connectionString: string): Pool {
  try {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
    // Preserve certificate verification when connecting to a hosted database with `sslmode=require`.
    if (url.searchParams.get('sslmode') === 'require') url.searchParams.set('sslmode', 'verify-full');
    const pool = new pg.Pool({
      connectionString: url.href, max: 4, connectionTimeoutMillis: 12_000, idleTimeoutMillis: 15_000
    });
    // The pool replaces timed-out idle connections on the next request.
    pool.on('error', () => {});
    return pool;
  } catch {
    throw new Error('DATABASE_URL must be a standard PostgreSQL connection URL.');
  }
}

export class PostgresCache implements SnapshotCache {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(connection: string | Pool, schema = 'hyperlens') {
    this.schema = postgresSchema(schema);
    this.pool = typeof connection === 'string' ? postgresPool(connection) : connection;
  }

  async prepare(): Promise<void> {
    await this.transaction('prepare the HyperLens schema', async connection => {
      await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.schema + ':setup']);
      await connection.query(`
        CREATE SCHEMA IF NOT EXISTS ${this.schema};

        CREATE TABLE IF NOT EXISTS ${this.schema}.active_snapshot (
          singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
          version uuid
        );

        CREATE TABLE IF NOT EXISTS ${this.schema}.snapshot_part (
          version uuid NOT NULL,
          position integer NOT NULL CHECK (position >= 0),
          compressed bytea NOT NULL,
          PRIMARY KEY (version, position)
        );

        CREATE TABLE IF NOT EXISTS ${this.schema}.raw_config (
          hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
          compressed bytea NOT NULL
        );

        INSERT INTO ${this.schema}.active_snapshot (singleton)
        VALUES (true) ON CONFLICT DO NOTHING;
      `);
    });
  }

  async read(): Promise<Snapshot | undefined> {
    try {
      const { rows } = await this.pool.query<SnapshotRow>(`
        SELECT active.version, part.compressed
        FROM ${this.schema}.active_snapshot AS active
        LEFT JOIN ${this.schema}.snapshot_part AS part USING (version)
        WHERE active.singleton
        ORDER BY part.position
      `);
      const version = rows[0]?.version;
      if (!version) return undefined;
      const snapshot = await decodeSnapshot(Readable.from(rows.map(row => {
        if (!row.compressed) throw new Error('Postgres snapshot part is missing.');
        return row.compressed;
      })));
      if (!snapshot || snapshot.version !== version) throw new Error('Postgres snapshot manifest is invalid.');
      return snapshot;
    } catch (error) {
      throw storageError('load the active snapshot', error);
    }
  }

  async write(snapshot: Snapshot, previousVersion?: string, publishIndex?: (connection: PoolClient) => Promise<void>): Promise<void> {
    await this.transaction('save the snapshot', async connection => {
      const activeVersion = await this.lockActiveVersion(connection);
      if (activeVersion === snapshot.version) return;
      if (activeVersion !== (previousVersion ?? null)) {
        throw new SnapshotChanged('The saved dataset was updated by another process. Restart HyperLens before refreshing again.');
      }
      if (publishIndex) await publishIndex(connection);
      await this.publish(connection, snapshot, activeVersion);
    });
  }

  async extendActive(snapshotVersion: string, publish: (connection: PoolClient) => Promise<void>): Promise<void> {
    await this.transaction('prepare the hosted index', async connection => {
      if (await this.lockActiveVersion(connection) !== snapshotVersion) {
        throw new SnapshotChanged('The active snapshot changed while preparing the hosted index. Retry the preparation.');
      }
      await publish(connection);
    });
  }

  async importSnapshot(snapshot: Snapshot, raw: AsyncIterable<RawConfig>): Promise<boolean> {
    return this.transaction('import the local snapshot', async connection => {
      const activeVersion = await this.lockActiveVersion(connection);
      if (activeVersion === snapshot.version) return false;
      if (activeVersion) throw new SnapshotChanged('Postgres already has an active snapshot. The local import was skipped.');
      let batch: RawConfig[] = [];
      for await (const config of raw) {
        batch.push(config);
        if (batch.length >= rawBatchSize) {
          await this.insertRaw(connection, batch);
          batch = [];
        }
      }
      if (batch.length) await this.insertRaw(connection, batch);
      await this.publish(connection, snapshot, null);
      return true;
    });
  }

  async putRaw(hash: string, text: string): Promise<void> {
    try {
      await this.insertRaw(this.pool, [{ hash, compressed: Uint8Array.from(await gzipText(text)) }]);
    } catch (error) {
      throw storageError('cache the raw hyperpay-config', error);
    }
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async lockActiveVersion(connection: PoolClient): Promise<string | null> {
    const { rows } = await connection.query<VersionRow>(
      `SELECT version FROM ${this.schema}.active_snapshot WHERE singleton FOR UPDATE`
    );
    if (!rows[0]) throw new Error('Postgres snapshot state is missing.');
    return rows[0].version;
  }

  private async insertRaw(connection: Pool | PoolClient, batch: RawConfig[]): Promise<void> {
    await connection.query(`
      INSERT INTO ${this.schema}.raw_config (hash, compressed)
      SELECT * FROM unnest($1::text[], $2::bytea[])
      ON CONFLICT (hash) DO NOTHING
    `, [batch.map(row => row.hash), batch.map(row => row.compressed)]);
  }

  private async publish(connection: PoolClient, snapshot: Snapshot, previousVersion: string | null): Promise<void> {
    let part = 0;
    let positions: number[] = [];
    let bytes: Uint8Array[] = [];
    const flush = async () => {
      await connection.query(`
        INSERT INTO ${this.schema}.snapshot_part (version, position, compressed)
        SELECT $1::uuid, position, compressed
        FROM unnest($2::integer[], $3::bytea[]) AS parts(position, compressed)
      `, [snapshot.version, positions, bytes]);
      positions = [];
      bytes = [];
    };
    for await (const compressed of compressedParts(snapshot)) {
      positions.push(part++);
      bytes.push(compressed);
      if (positions.length >= snapshotBatchSize) await flush();
    }
    if (positions.length) await flush();
    await connection.query(`UPDATE ${this.schema}.active_snapshot SET version = $1 WHERE singleton`, [snapshot.version]);
    if (previousVersion) {
      await connection.query(`DELETE FROM ${this.schema}.snapshot_part WHERE version = $1`, [previousVersion]);
    }
  }

  private async transaction<T>(action: string, task: (connection: PoolClient) => Promise<T>): Promise<T> {
    let connection: PoolClient | undefined;
    try {
      connection = await this.pool.connect();
      await connection.query('BEGIN');
      const result = await task(connection);
      await connection.query('COMMIT');
      connection.release();
      return result;
    } catch (error) {
      if (connection) {
        try {
          await connection.query('ROLLBACK');
          connection.release();
        } catch {
          connection.release(true);
        }
      }
      throw storageError(action, error);
    }
  }
}
