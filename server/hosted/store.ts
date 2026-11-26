import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { emptyCoverage } from '../../shared/model.js';
import type { Progress, Status } from '../../shared/model.js';
import type { Snapshot } from '../cache.js';
import { PostgresCache, postgresPool, postgresSchema } from '../postgres.js';
import { ingestSnapshot } from '../refresh.js';
import { loadClients } from '../urls.js';
import { buildProjection, writeProjection } from './projection.js';
import type { HostedManifest, HostedSource } from './projection.js';

type Job = { id: string; started: string };
type WebState = {
  version: string | null;
  manifest: HostedManifest | null;
  notes: string[];
  job_started: Date | null;
  job_progress: Progress | null;
  job_error: string | null;
  running: boolean;
  expired: boolean;
};

const jobLeaseSeconds = 330;

export class HostedStore {
  readonly pool: Pool;
  readonly schema: string;
  readonly cache: PostgresCache;

  constructor(url: string, namespace = 'hyperlens') {
    this.schema = postgresSchema(namespace);
    this.pool = postgresPool(url);
    this.cache = new PostgresCache(this.pool, namespace);
  }

  async prepare(): Promise<void> {
    await this.cache.prepare();
    await this.writeTransaction(async connection => {
      await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.schema + ':hosted']);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.web_state (
          singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
          version uuid, manifest jsonb, csv text, definitions text, notes jsonb NOT NULL DEFAULT '[]',
          job_id uuid, job_started timestamptz, job_expires timestamptz, job_progress jsonb, job_error text
        );
        INSERT INTO ${this.schema}.web_state (singleton) VALUES (true) ON CONFLICT DO NOTHING;

        CREATE TABLE IF NOT EXISTS ${this.schema}.web_path (
          version uuid NOT NULL, id integer NOT NULL,
          path text NOT NULL, key text NOT NULL, logical_key text NOT NULL, logical_path text NOT NULL, unwrapped_path text,
          config_ids integer[] NOT NULL, kinds text[] NOT NULL, signatures text[] NOT NULL,
          PRIMARY KEY (version, id)
        );
        CREATE INDEX IF NOT EXISTS web_path_lookup_key ON ${this.schema}.web_path (version, md5(key));
        CREATE INDEX IF NOT EXISTS web_path_logical_key ON ${this.schema}.web_path (version, md5(logical_key));
        CREATE INDEX IF NOT EXISTS web_path_exact ON ${this.schema}.web_path (version, md5(path));
        CREATE INDEX IF NOT EXISTS web_path_logical ON ${this.schema}.web_path (version, md5(logical_path));
        CREATE INDEX IF NOT EXISTS web_path_unwrapped ON ${this.schema}.web_path (version, md5(unwrapped_path));

        CREATE TABLE IF NOT EXISTS ${this.schema}.web_reference (
          version uuid NOT NULL, config_id integer NOT NULL, target_id text NOT NULL, client_id text NOT NULL,
          platform text NOT NULL, environment text NOT NULL, owner text NOT NULL, revision text NOT NULL,
          url text NOT NULL, original_urls text[] NOT NULL, mjos_url text NOT NULL, stale boolean NOT NULL,
          PRIMARY KEY (version, config_id, target_id)
        );
        CREATE INDEX IF NOT EXISTS web_reference_detail ON ${this.schema}.web_reference (version, target_id, url);

        CREATE TABLE IF NOT EXISTS ${this.schema}.web_config (
          version uuid NOT NULL, id integer NOT NULL, fetched_at text NOT NULL, checked_at text NOT NULL,
          compressed bytea NOT NULL, PRIMARY KEY (version, id)
        );

        CREATE TABLE IF NOT EXISTS ${this.schema}.web_catalog (
          version uuid NOT NULL, path text NOT NULL, key text NOT NULL, data text NOT NULL,
          frequency integer NOT NULL, preferred integer NOT NULL, aliases text[] NOT NULL
        );
        CREATE INDEX IF NOT EXISTS web_catalog_version ON ${this.schema}.web_catalog (version);
      `);
    });
  }

  async seed(source: HostedSource): Promise<Snapshot> {
    loadClients(source.csv);
    const snapshot = await this.cache.read();
    if (!snapshot) throw new Error('Import a local snapshot with npm run db:import first.');
    const projection = await buildProjection(snapshot, source);
    await this.cache.extendActive(snapshot.version, async connection => {
      const { rows } = await connection.query<{ version: string | null; running: boolean }>(`
        SELECT version, (job_id IS NOT NULL AND job_expires > now()) AS running
        FROM ${this.schema}.web_state WHERE singleton FOR UPDATE
      `);
      if (rows[0].running) throw new Error('A hosted refresh is running. Retry after it completes.');
      await this.clearProjection(connection, rows[0].version);
      const manifest = await writeProjection(connection, this.schema, snapshot, source, projection);
      await connection.query(`
        UPDATE ${this.schema}.web_state
        SET version = $1, manifest = $2, csv = $3, definitions = $4, notes = $5,
          job_id = NULL, job_started = NULL, job_expires = NULL, job_progress = NULL, job_error = NULL
        WHERE singleton
      `, [snapshot.version, manifest, source.csv, JSON.stringify(source.definitions), JSON.stringify(source.notes)]);
    });
    return snapshot;
  }

  async data(connection: Pick<Pool, 'query'> | PoolClient = this.pool): Promise<WebState> {
    const { rows } = await connection.query<WebState>(`
      SELECT version, manifest, notes, job_started, job_progress, job_error,
        (job_id IS NOT NULL AND job_expires > now()) AS running,
        (job_id IS NOT NULL AND job_expires <= now()) AS expired
      FROM ${this.schema}.web_state WHERE singleton
    `);
    if (!rows[0]) throw new Error('The hosted index has not been prepared.');
    return rows[0];
  }

  async status(): Promise<Status> {
    const row = await this.data();
    const cached = row.manifest;
    const coverage = cached?.coverage ?? emptyCoverage;
    const error = row.job_error ?? (row.expired ? 'Refresh expired. Retry to build a new snapshot.'
      : cached?.failed ? 'Refresh could not validate any current client-environment combinations.' : null);
    const state = row.running ? 'refreshing' : error ? 'failed' : !cached ? 'idle'
      : coverage.failures || coverage.current < coverage.targets ? 'partial' : 'ready';
    return {
      state, error, coverage, progress: row.running ? row.job_progress : null,
      lastSuccessfulRefresh: cached?.lastSuccess ?? null, lastAttempt: row.job_started?.toISOString() ?? cached?.attempt ?? null,
      indexVersion: row.version, catalogSize: cached?.catalogSize ?? 0, knownSize: cached?.knownSize ?? 0, localMode: false
    };
  }

  async claim(): Promise<Job | undefined> {
    const id = randomUUID();
    const { rows } = await this.pool.query<{ job_started: Date }>(`
      UPDATE ${this.schema}.web_state
      SET job_id = $1, job_started = now(), job_expires = now() + $2::int * interval '1 second',
        job_progress = $3, job_error = NULL
      WHERE singleton AND csv IS NOT NULL AND (job_id IS NULL OR job_expires <= now())
      RETURNING job_started
    `, [id, jobLeaseSeconds, { phase: 'mjos', completed: 0, total: 0 }]);
    if (rows[0]) return { id, started: rows[0].job_started.toISOString() };
  }

  async run(job: Job, parallelism: number, fetcher?: typeof fetch): Promise<void> {
    let pending = Promise.resolve();
    let lastPhase: Progress['phase'] | undefined;
    let lastReport = 0;
    const report = (progress: Progress) => {
      if (lastPhase === progress.phase && Date.now() - lastReport < 2000) return;
      lastPhase = progress.phase;
      lastReport = Date.now();
      const copy = { ...progress };
      pending = pending.then(async () => {
        await this.pool.query(`
          UPDATE ${this.schema}.web_state SET job_progress = $2 WHERE singleton AND job_id = $1
        `, [job.id, copy]);
      }).catch(() => {});
    };
    try {
      const { rows } = await this.pool.query<{ csv: string; definitions: string; notes: string[] }>(`
        SELECT csv, definitions, notes FROM ${this.schema}.web_state WHERE singleton AND job_id = $1
      `, [job.id]);
      const row = rows[0];
      if (!row) return;
      const source: HostedSource = { csv: row.csv, definitions: JSON.parse(row.definitions), notes: row.notes };
      const previous = await this.cache.read();
      const snapshot = await ingestSnapshot({
        csv: source.csv, cache: this.cache, previous, attempt: job.started, parallelism, onProgress: report, fetcher
      });
      report({ phase: 'indexing', completed: 0, total: 1 });
      const projection = await buildProjection(snapshot, source);
      await pending;
      await this.cache.write(snapshot, previous?.version, async connection => {
        const { rows } = await connection.query<{ version: string | null }>(`
          SELECT version FROM ${this.schema}.web_state
          WHERE singleton AND job_id = $1 AND job_expires > now() FOR UPDATE
        `, [job.id]);
        if (!rows[0]) throw new Error('The refresh lease expired.');
        const manifest = await writeProjection(connection, this.schema, snapshot, source, projection);
        await this.clearProjection(connection, rows[0].version);
        await connection.query(`
          UPDATE ${this.schema}.web_state
          SET version = $2, manifest = $3, job_id = NULL, job_expires = NULL, job_progress = NULL, job_error = NULL
          WHERE singleton AND job_id = $1
        `, [job.id, snapshot.version, manifest]);
      });
    } catch {
      await pending;
      await this.pool.query(`
        UPDATE ${this.schema}.web_state
        SET job_id = NULL, job_expires = NULL, job_progress = NULL, job_error = 'Refresh failed. The last published index is available.'
        WHERE singleton AND job_id = $1
      `, [job.id]).catch(() => {});
    }
  }

  async readTransaction<T>(reader: (connection: PoolClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    let discard = false;
    try {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await reader(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      try { await connection.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally {
      connection.release(discard);
    }
  }

  private async writeTransaction(task: (connection: PoolClient) => Promise<void>): Promise<void> {
    const connection = await this.pool.connect();
    let discard = false;
    try {
      await connection.query('BEGIN');
      await task(connection);
      await connection.query('COMMIT');
    } catch (error) {
      try { await connection.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally {
      connection.release(discard);
    }
  }

  private async clearProjection(connection: PoolClient, version: string | null): Promise<void> {
    if (!version) return;
    for (const table of ['web_path', 'web_catalog', 'web_reference', 'web_config']) {
      await connection.query(`DELETE FROM ${this.schema}.${table} WHERE version = $1`, [version]);
    }
  }
}
