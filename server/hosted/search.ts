import { gunzipSync } from 'node:zlib';
import type { PoolClient } from 'pg';
import { emptyCoverage } from '../../shared/model.js';
import type {
  CatalogEntry, Counts, Environment, Platform, ResultDetail, SearchQuery, SearchResponse, SearchResult, StaticValue
} from '../../shared/model.js';
import { abbreviate, formatValue } from '../index.js';
import { formatPath, parsePath } from '../paths.js';
import { csvHeader, csvLine } from '../result-csv.js';
import { BadRequest } from '../search-params.js';
import { databaseKey, jsonSignature, valueAtPath } from './projection.js';
import type { HostedStore } from './store.js';

interface Hit {
  path: string;
  kind: StaticValue['type'];
  config_id: number;
  target_id: string;
  client_id: string;
  platform: Platform;
  environment: Environment;
  owner: string;
  revision: string;
  url: string;
  original_urls: string[];
  mjos_url: string;
  stale: boolean;
}
interface ConfigRow { id: number; compressed: Buffer; fetched_at: string; checked_at: string }
type Config = ConfigRow & { tree: StaticValue };
interface SearchSql { from: string; select: string; order: string; values: unknown[] }

const noHits: Counts = { clients: 0, clientPlatforms: 0, targets: 0, occurrences: 0 };
const sortColumns = { clientId: 'r.client_id', platform: 'r.platform', environment: 'r.environment', path: 'p.path', hyperpayConfigUrl: 'r.url' };

function result(hit: Hit, node?: StaticValue): SearchResult {
  return {
    id: Buffer.from(JSON.stringify([hit.target_id, hit.url, hit.path])).toString('base64url'),
    clientId: hit.client_id, platform: hit.platform, environment: hit.environment,
    key: String(parsePath(hit.path).at(-1)), path: hit.path, valueType: hit.kind,
    ...(node && { preview: abbreviate(node) }), owner: hit.owner, version: hit.revision,
    hyperpayConfigUrl: hit.url, stale: hit.stale
  };
}

export class HostedSearch {
  constructor(private readonly store: HostedStore) {}

  private async sql(connection: PoolClient, version: string, query: SearchQuery): Promise<SearchSql> {
    const schema = this.store.schema;
    const values: unknown[] = [version];
    const bind = (value: unknown) => '$' + values.push(value);
    const terms = ['p.version = $1'];
    if (query.mode === 'exact-key') {
      const term = bind(databaseKey(query.query));
      terms.push(`((md5(p.key) = md5(${term}::text) AND p.key = ${term})
        OR (md5(p.logical_key) = md5(${term}::text) AND p.logical_key = ${term}))`);
    } else if (query.mode === 'exact-path') {
      const alias = await connection.query<{ path: string }>(`
        SELECT path FROM ${schema}.web_catalog WHERE version = $1 AND $2 = ANY(aliases)
        ORDER BY path LIMIT 1
      `, [version, databaseKey(query.query)]);
      let canonical = alias.rows[0]?.path;
      if (canonical === undefined) {
        try { canonical = formatPath(parsePath(query.query)); }
        catch (error) { throw new BadRequest((error as Error).message); }
      }
      const term = bind(canonical);
      terms.push('(' + ['path', 'logical_path', 'unwrapped_path'].map(field =>
        `(md5(p.${field}) = md5(${term}::text) AND p.${field} = ${term})`
      ).join(' OR ') + ')');
    } else {
      const term = bind(query.query.toLowerCase().replaceAll('\0', '\\0'));
      terms.push(`(strpos(lower(p.path), ${term}) > 0 OR strpos(lower(p.logical_path), ${term}) > 0
        OR strpos(lower(p.unwrapped_path), ${term}) > 0)`);
    }
    if (query.platforms.length) terms.push(`r.platform = ANY(${bind(query.platforms)}::text[])`);
    if (query.environments.length) terms.push(`r.environment = ANY(${bind(query.environments)}::text[])`);
    if (query.clientIds.length) terms.push(`r.client_id = ANY(${bind(query.clientIds)}::text[])`);
    if (query.valueFilter !== undefined) terms.push(`h.signature = ${bind(jsonSignature(query.valueFilter))}`);

    const from = `
      FROM ${schema}.web_path AS p
      CROSS JOIN LATERAL unnest(p.config_ids, p.kinds, p.signatures) AS h(config_id, kind, signature)
      JOIN ${schema}.web_reference AS r ON r.version = p.version AND r.config_id = h.config_id
      WHERE ${terms.join(' AND ')}
    `;
    const select = 'SELECT p.path, h.kind, r.*';
    const order = `ORDER BY ${sortColumns[query.sort]} COLLATE "C" ${query.direction === 'desc' ? 'DESC' : 'ASC'},
      r.target_id COLLATE "C", p.path COLLATE "C", r.config_id`;
    return { from, select, order, values };
  }

  async search(query: SearchQuery): Promise<SearchResponse> {
    return this.store.readTransaction(async connection => {
      const state = await this.store.data(connection);
      const base = { coverage: state.manifest?.coverage ?? emptyCoverage, indexVersion: state.version, pageSize: query.pageSize };
      if (!state.version || !query.query) return { ...base, results: [], counts: noHits, page: 1 };
      const sql = await this.sql(connection, state.version, query);
      const { rows: [counts] } = await connection.query<Counts>(`
        SELECT count(DISTINCT r.client_id)::int AS clients, count(DISTINCT (r.client_id, r.platform))::int AS "clientPlatforms",
          count(DISTINCT r.target_id)::int AS targets, count(*)::int AS occurrences
        ${sql.from}
      `, sql.values);
      const page = Math.min(query.page, Math.max(1, Math.ceil(counts.occurrences / query.pageSize)));
      if (!counts.occurrences) return { ...base, results: [], counts, page };
      const { rows } = await connection.query<Hit>(
        `${sql.select} ${sql.from} ${sql.order} LIMIT $${sql.values.length + 1} OFFSET $${sql.values.length + 2}`,
        [...sql.values, query.pageSize, (page - 1) * query.pageSize]
      );
      const configs = query.includeValues ? await this.configs(connection, state.version, rows.map(row => row.config_id)) : undefined;
      return { ...base, page, counts, results: rows.map(row => {
        const config = configs?.get(row.config_id);
        return result(row, config && valueAtPath(config.tree, row.path));
      }) };
    });
  }

  async detail(id: string): Promise<ResultDetail | undefined> {
    let parts: unknown;
    try { parts = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')); } catch { return undefined; }
    if (!Array.isArray(parts) || parts.length !== 3 || parts.some(value => typeof value !== 'string' || value.includes('\0'))) return undefined;
    const [targetId, url, path] = parts as string[];
    return this.store.readTransaction(async connection => {
      const { version } = await this.store.data(connection);
      if (!version) return undefined;
      const schema = this.store.schema;
      const { rows: [hit] } = await connection.query<Hit>(`
        SELECT p.path, p.kinds[array_position(p.config_ids, r.config_id)] AS kind, r.*
        FROM ${schema}.web_reference AS r JOIN ${schema}.web_path AS p
          ON p.version = r.version AND r.config_id = ANY(p.config_ids)
        WHERE r.version = $1 AND r.target_id = $2 AND r.url = $3 AND md5(p.path) = md5($4::text) AND p.path = $4
      `, [version, targetId, url, path]);
      if (!hit) return undefined;
      const config = (await this.configs(connection, version, [hit.config_id])).get(hit.config_id);
      const node = config && valueAtPath(config.tree, hit.path);
      if (!node || !config) return undefined;
      return {
        ...result(hit), value: formatValue(node, true), mjosUrl: hit.mjos_url, originalUrls: hit.original_urls,
        fetchedAt: config.fetched_at, checkedAt: config.checked_at
      };
    });
  }

  async suggestions(query: string, limit: number, offset: number): Promise<{ entries: CatalogEntry[]; total: number }> {
    return this.store.readTransaction(async connection => {
      const { version, manifest } = await this.store.data(connection);
      if (!version) return { entries: [], total: 0 };
      const term = databaseKey(query.toLowerCase());
      const where = `FROM ${this.store.schema}.web_catalog AS c WHERE version = $1 AND (
        $2 = '' OR strpos(lower(path), $2) > 0 OR strpos(key, $2) > 0
        OR EXISTS (SELECT FROM unnest(aliases) AS alias WHERE strpos(lower(alias), $2) > 0)
      )`;
      const total = term ? (await connection.query<{ n: number }>(`SELECT count(*)::int AS n ${where}`, [version, term])).rows[0].n
        : manifest?.catalogSize ?? 0;
      const { rows } = await connection.query<{ data: string }>(`
        SELECT data ${where} ORDER BY CASE
          WHEN $2 = '' THEN preferred
          WHEN EXISTS (SELECT FROM unnest(aliases) AS alias WHERE lower(alias) = $2) THEN -1
          WHEN key = $2 OR lower(path) = $2 THEN 0
          WHEN strpos(key, $2) = 1 THEN 1
          WHEN strpos(lower(path), $2) = 1 THEN 2
          ELSE 3
        END, frequency DESC, path COLLATE "C" LIMIT $3 OFFSET $4
      `, [version, term, limit, offset]);
      return { entries: rows.map(row => JSON.parse(row.data) as CatalogEntry), total };
    });
  }

  async export(query: SearchQuery): Promise<ReadableStream<Uint8Array>> {
    // Open the cursor before returning a response, so validation errors can still return an HTTP error.
    const connection = await this.store.pool.connect();
    try {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { version } = await this.store.data(connection);
      if (version && query.query) {
        const sql = await this.sql(connection, version, query);
        await connection.query(`DECLARE hyperlens_csv NO SCROLL CURSOR FOR ${sql.select} ${sql.from} ${sql.order}`, sql.values);
      }
      return this.csvStream(connection, query, version);
    } catch (error) {
      await this.finishExport(connection, 'ROLLBACK');
      throw error;
    }
  }

  private csvStream(connection: PoolClient, query: SearchQuery, version: string | null): ReadableStream<Uint8Array> {
    const encode = new TextEncoder();
    let closed = false;
    let cancelled = false;
    let pending = Promise.resolve();
    const close = async (statement: 'COMMIT' | 'ROLLBACK') => {
      if (closed) return;
      closed = true;
      await this.finishExport(connection, statement);
    };
    return new ReadableStream<Uint8Array>({
      start: controller => { controller.enqueue(encode.encode(csvHeader(query.includeValues))); },
      pull: controller => pending = (async () => {
        try {
          const rows = version && query.query ? (await connection.query<Hit>('FETCH FORWARD 100 FROM hyperlens_csv')).rows : [];
          if (!rows.length) {
            await close('COMMIT');
            if (!cancelled) controller.close();
            return;
          }
          const configs = query.includeValues ? await this.configs(connection, version!, rows.map(row => row.config_id)) : undefined;
          for (const row of rows) {
            const config = configs?.get(row.config_id);
            const node = config && valueAtPath(config.tree, row.path);
            if (cancelled) break;
            controller.enqueue(encode.encode(csvLine([
              row.client_id, row.platform, row.environment, row.path, row.kind,
              ...(query.includeValues ? [node ? formatValue(node, true) : ''] : []),
              row.url, row.owner, row.revision, String(row.stale)
            ])));
          }
        } catch (error) {
          await close('ROLLBACK');
          if (!cancelled) controller.error(error);
        }
      })(),
      cancel: async () => { cancelled = true; await pending; await close('ROLLBACK'); }
    });
  }

  private async finishExport(connection: PoolClient, statement: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    let discard = false;
    try { await connection.query(statement); }
    catch { discard = true; }
    finally { connection.release(discard); }
  }

  private async configs(connection: PoolClient, version: string, ids: number[]): Promise<Map<number, Config>> {
    const { rows } = await connection.query<ConfigRow>(`
      SELECT id, compressed, fetched_at, checked_at FROM ${this.store.schema}.web_config
      WHERE version = $1 AND id = ANY($2::integer[])
    `, [version, [...new Set(ids)]]);
    return new Map(rows.map(row => [row.id, { ...row, tree: JSON.parse(gunzipSync(Uint8Array.from(row.compressed)).toString('utf8')) }]));
  }
}
