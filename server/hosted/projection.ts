import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import type { PoolClient } from 'pg';
import type { CatalogEntry, Json, StaticValue } from '../../shared/model.js';
import type { Snapshot } from '../cache.js';
import { category, entries, parsePath } from '../paths.js';
import { asConfigReaderValue } from '../parser.js';

export interface HostedSource { csv: string; definitions: CatalogEntry[]; notes: string[] }
export interface HostedManifest {
  coverage: Snapshot['coverage'];
  lastSuccess: string | null;
  attempt: string;
  clients: string[];
  failures: Snapshot['failures'];
  failed: boolean;
  catalogSize: number;
  knownSize: number;
}

type ValueKind = StaticValue['type'];
type PathRow = {
  id: number; path: string; key: string; logical_key: string; logical_path: string; unwrapped_path: string | null;
  config_ids: number[]; kinds: ValueKind[]; signatures: (string | null)[];
};
type CatalogRow = { entry: CatalogEntry; frequency: number };
type Projection = { paths: Map<string, PathRow>; catalog: Map<string, CatalogRow> };

// Text parameters in PostgreSQL cannot contain the NUL character.
export const databaseKey = (key: string) => key.replaceAll('\\', '\\\\').replaceAll('\0', '\\0');

function digest(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
}

export function jsonSignature(value: Json): string {
  if (Array.isArray(value)) return digest(['array', value.map(jsonSignature)]);
  if (value !== null && typeof value === 'object') {
    return digest(['object', Object.keys(value).sort().map(key => [key, jsonSignature(value[key])])]);
  }
  return digest(['literal', value]);
}

function signatures() {
  const known = new WeakMap<StaticValue, string | null>();
  function signature(value: StaticValue): string | null {
    const existing = known.get(value);
    if (existing !== undefined) return existing;
    let result: string | null;
    if (value.type === 'object') {
      const pairs = Object.keys(value.entries).sort().map(key => [key, signature(value.entries[key])]);
      result = pairs.some(([, hash]) => hash === null) ? null : digest(['object', pairs]);
    } else if (value.type === 'array') {
      const items = value.items.map(signature);
      result = items.includes(null) ? null : digest(['array', items]);
    } else if (value.type === 'unresolved' || value.type === 'hole') result = null;
    else result = digest(['literal', value.value]);
    known.set(value, result);
    return result;
  }
  return signature;
}

export function valueAtPath(tree: StaticValue, path: string): StaticValue | undefined {
  const segments = parsePath(path);
  let node: StaticValue | undefined = tree;
  for (const segment of segments) {
    if (typeof segment === 'number' && node?.type === 'array') node = node.items[segment];
    else if (typeof segment === 'string' && node?.type === 'object' && Object.hasOwn(node.entries, segment)) node = node.entries[segment];
    else return undefined;
  }
  if (!node || node.type === 'hole') return undefined;
  return segments.length > 1 && segments[0] === 'mainConfig' ? asConfigReaderValue(node) : node;
}

export async function buildProjection(snapshot: Snapshot, source: HostedSource): Promise<Projection> {
  const paths = new Map<string, PathRow>();
  const catalog = new Map<string, CatalogRow>(source.definitions.map(entry => [
    entry.path, { entry: { ...entry, types: [...entry.types] }, frequency: 0 }
  ]));
  let unresolved = 0;
  for (const [configId, { tree }] of snapshot.configs.entries()) {
    const signature = signatures();
    for (const item of entries(tree)) {
      let path = paths.get(item.path);
      if (!path) {
        path = {
          id: paths.size, path: item.path, key: databaseKey(item.key), logical_key: databaseKey(item.logicalKey),
          logical_path: item.logicalPath, unwrapped_path: item.unwrappedPath ?? null,
          config_ids: [], kinds: [], signatures: []
        };
        paths.set(item.path, path);
      }
      path.config_ids.push(configId);
      path.kinds.push(item.value.type);
      path.signatures.push(signature(item.value));
      if (item.value.type === 'unresolved') unresolved++;

      const known = catalog.get(item.logicalPath);
      if (known) {
        known.frequency++;
        if (!known.entry.types.includes(item.value.type)) known.entry.types.push(item.value.type);
        if (known.entry.source === 'repository') known.entry.source = 'both';
      } else {
        catalog.set(item.logicalPath, {
          frequency: 1,
          entry: { key: item.logicalKey, path: item.logicalPath, category: category(item.logicalPath), types: [item.value.type], source: 'observed' }
        });
      }
    }
    if (configId % 8 === 0) await setImmediate();
  }
  snapshot.coverage.unresolved = unresolved;
  return { paths, catalog };
}

async function insertRows<T>(
  connection: PoolClient, statement: string, version: string, rows: Iterable<T>
): Promise<void> {
  let batch: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const json = JSON.stringify(row);
    batch.push(json);
    bytes += Buffer.byteLength(json);
    if (bytes < 1024 * 1024 && batch.length < 5_000) continue;
    await connection.query(statement, [version, '[' + batch.join(',') + ']']);
    batch = [];
    bytes = 0;
  }
  if (batch.length) await connection.query(statement, [version, '[' + batch.join(',') + ']']);
}

export async function writeProjection(
  connection: PoolClient, schema: string, snapshot: Snapshot, source: HostedSource, projection: Projection
): Promise<HostedManifest> {
  const version = snapshot.version;
  await insertRows(connection, `
    INSERT INTO ${schema}.web_path
    SELECT $1::uuid, id, path, key, logical_key, logical_path, unwrapped_path, config_ids, kinds, signatures
    FROM jsonb_to_recordset($2::jsonb) AS x(id integer, path text, key text, logical_key text, logical_path text,
      unwrapped_path text, config_ids integer[], kinds text[], signatures text[])
  `, version, projection.paths.values());

  function* catalogRows() {
    for (const { entry, frequency } of projection.catalog.values()) {
      yield {
        path: entry.path, key: databaseKey(entry.key).toLowerCase(), data: JSON.stringify(entry), frequency,
        preferred: frequency > 0 && entry.path.split('.').length === 2
          ? (['Flow', 'Screen'].includes(entry.category) && entry.types.includes('boolean') ? 0 : 1) : 2,
        aliases: entry.aliases?.map(databaseKey) ?? []
      };
    }
  }
  await insertRows(connection, `
    INSERT INTO ${schema}.web_catalog
    SELECT $1::uuid, path, key, data, frequency, preferred, aliases
    FROM jsonb_to_recordset($2::jsonb) AS x(path text, key text, data text, frequency integer, preferred integer, aliases text[])
  `, version, catalogRows());

  const configIds = new Map(snapshot.configs.map((config, id) => [config.url, id]));
  const staleTargets = new Set(snapshot.staleMjos);
  const staleConfigs = new Set(snapshot.staleConfigs);
  function* references() {
    for (const row of snapshot.mjos) {
      for (const ref of row.fallbackRefs ?? row.refs) {
        const id = configIds.get(ref.normalizedUrl);
        if (id === undefined) continue;
        yield {
          config_id: id, target_id: row.id, client_id: row.clientId, platform: row.platform, environment: row.environment,
          owner: ref.owner, revision: ref.version, url: ref.normalizedUrl, original_urls: ref.originalUrls, mjos_url: row.mjosUrl,
          stale: !!row.fallbackRefs || staleTargets.has(row.id) || staleConfigs.has(ref.normalizedUrl)
        };
      }
    }
  }
  await insertRows(connection, `
    INSERT INTO ${schema}.web_reference
    SELECT $1::uuid, config_id, target_id, client_id, platform, environment, owner, revision, url, original_urls, mjos_url, stale
    FROM jsonb_to_recordset($2::jsonb) AS x(config_id integer, target_id text, client_id text, platform text,
      environment text, owner text, revision text, url text, original_urls text[], mjos_url text, stale boolean)
  `, version, references());

  function* configRows() {
    for (const [id, config] of snapshot.configs.entries()) {
      yield {
        id, fetched_at: config.fetchedAt, checked_at: config.checkedAt,
        compressed: gzipSync(JSON.stringify(config.tree), { level: 3 }).toString('base64')
      };
    }
  }
  await insertRows(connection, `
    INSERT INTO ${schema}.web_config
    SELECT $1::uuid, id, fetched_at, checked_at, decode(compressed, 'base64')
    FROM jsonb_to_recordset($2::jsonb) AS x(id integer, fetched_at text, checked_at text, compressed text)
  `, version, configRows());

  return {
    coverage: snapshot.coverage, lastSuccess: snapshot.lastSuccess, attempt: snapshot.attempt,
    clients: [...new Set(snapshot.clients)].sort(), failures: snapshot.failures, failed: snapshot.failed,
    catalogSize: projection.catalog.size, knownSize: source.definitions.length
  };
}
