import { setImmediate } from 'node:timers/promises';
import type {
  CatalogEntry, ConfigRecord, ConfigurationRef, Counts, Json, MjosRecord, ResultDetail,
  SearchQuery, SearchResult, StaticValue
} from '../shared/model.js';
import { category, entries, formatPath, parsePath } from './paths.js';
import { toJson } from './parser.js';

type Reference = { mjos: MjosRecord; ref: ConfigurationRef; stale: boolean };
type Posting = { config: number; value: StaticValue };
type IndexedPath = { path: string; key: string; postings: Posting[] };
type Hit = { reference: Reference; path: IndexedPath; posting: Posting };
type CatalogRecord = { entry: CatalogEntry; frequency: number };


// Keep only the rows needed for the requested page, with the worst retained row at the heap root.
class BestHits {
  private readonly hits: Hit[] = [];

  constructor(private readonly compare: (a: Hit, b: Hit) => number, private readonly limit: number) {}

  add(hit: Hit): void {
    const hits = this.hits;
    if (this.limit === Infinity) { hits.push(hit); return; }
    if (hits.length < this.limit) {
      let child = hits.push(hit) - 1;
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (this.compare(hits[parent], hit) >= 0) break;
        hits[child] = hits[parent];
        child = parent;
      }
      hits[child] = hit;
    } else if (this.compare(hit, hits[0]) < 0) {
      let parent = 0;
      for (;;) {
        const left = 2 * parent + 1;
        if (left >= hits.length) break;
        const right = left + 1;
        const worst = right < hits.length && this.compare(hits[left], hits[right]) < 0 ? right : left;
        if (this.compare(hit, hits[worst]) >= 0) break;
        hits[parent] = hits[worst];
        parent = worst;
      }
      hits[parent] = hit;
    }
  }

  sorted(): Hit[] { return this.hits.sort(this.compare); }
}

export function formatValue(node: StaticValue, detailed = false): string {
  if (node.type === 'unresolved') {
    if (!detailed) return node.syntax === 'config-reader' ? node.expression : 'Unresolved JavaScript';
    return node.literal === undefined ? node.expression : JSON.stringify(node.literal, null, 2);
  }
  return JSON.stringify(toJson(node), null, detailed ? 2 : undefined);
}

function matchesValue(node: StaticValue, wanted: Json): boolean {
  if (node.type === 'unresolved' || node.type === 'hole') return false;
  if (node.type === 'array') {
    return Array.isArray(wanted) && wanted.length === node.items.length
      && node.items.every((value, index) => matchesValue(value, wanted[index]));
  }
  if (node.type === 'object') {
    if (wanted === null || Array.isArray(wanted) || typeof wanted !== 'object') return false;
    const keys = Object.keys(wanted);
    return keys.length === Object.keys(node.entries).length
      && keys.every(key => Object.hasOwn(node.entries, key) && matchesValue(node.entries[key], wanted[key]));
  }
  return node.value === wanted;
}

function abbreviate(value: StaticValue): string {
  if (value.type === 'array' && value.items.length > 5) return `[… ${value.items.length} items]`;
  if (value.type === 'object' && Object.keys(value.entries).length > 3) {
    return `{… ${Object.keys(value.entries).length} keys}`;
  }
  const text = formatValue(value);
  return text.length > 130 ? text.slice(0, 127) + '…' : text;
}

export class ConfigurationIndex {
  private readonly byKey = new Map<string, Set<IndexedPath>>();
  private readonly byPath = new Map<string, Set<IndexedPath>>();
  private readonly canonicalPaths = new Map<string, IndexedPath>();
  private readonly catalog = new Map<string, CatalogRecord>();
  private readonly aliases = new Map<string, string>();
  private readonly references: Reference[][];
  private readonly configIds: Map<string, number>;
  readonly clients: string[];
  unresolved = 0;

  constructor(
    private readonly configs: ConfigRecord[],
    mjos: MjosRecord[],
    clientIds: string[],
    definitions: CatalogEntry[],
    staleMjos: Set<string>,
    staleConfigs: Set<string>
  ) {
    this.clients = [...new Set(clientIds)].sort();
    this.configIds = new Map(configs.map(({ url }, index) => [url, index]));
    this.references = configs.map(() => []);
    for (const item of mjos) {
      for (const ref of item.fallbackRefs ?? item.refs) {
        const config = this.configIds.get(ref.normalizedUrl);
        if (config === undefined) continue;
        this.references[config].push({ mjos: item, ref, stale: !!item.fallbackRefs || staleMjos.has(item.id) || staleConfigs.has(ref.normalizedUrl) });
      }
    }
    for (const entry of definitions) {
      this.catalog.set(entry.path, { entry: { ...entry }, frequency: 0 });
      for (const alias of entry.aliases ?? []) this.aliases.set(alias, entry.path);
    }
  }

  private register(map: Map<string, Set<IndexedPath>>, key: string, path: IndexedPath): void {
    let matches = map.get(key);
    if (!matches) map.set(key, matches = new Set());
    matches.add(path);
  }

  async build(): Promise<void> {
    for (const [config, { tree }] of this.configs.entries()) {
      for (const occurrence of entries(tree)) {
        const { path, key, logicalPath, logicalKey, unwrappedPath, value } = occurrence;
        let indexed = this.canonicalPaths.get(path);
        if (!indexed) {
          indexed = { path, key, postings: [] };
          this.canonicalPaths.set(path, indexed);
          this.register(this.byKey, key, indexed);
          this.register(this.byKey, logicalKey, indexed);
          this.register(this.byPath, path, indexed);
          this.register(this.byPath, logicalPath, indexed);
          if (unwrappedPath) this.register(this.byPath, unwrappedPath, indexed);
        }
        indexed.postings.push({ config, value });
        if (value.type === 'unresolved') this.unresolved++;
        const record = this.catalog.get(logicalPath);
        if (record) {
          record.frequency++;
          if (!record.entry.types.includes(value.type)) record.entry.types.push(value.type);
          if (record.entry.source === 'repository') record.entry.source = 'both';
        } else {
          this.catalog.set(logicalPath, {
            frequency: 1, entry: {
              key: logicalKey, path: logicalPath, category: category(logicalPath),
              types: [value.type], source: 'observed'
            }
          });
        }
      }
      if (config % 8 === 0) await setImmediate();
    }
  }

  get catalogSize(): number { return this.catalog.size; }

  suggestions(text: string, limit: number, offset = 0): { entries: CatalogEntry[]; total: number } {
    const term = text.toLowerCase();
    const matches: { record: CatalogRecord; rank: number }[] = [];
    for (const record of this.catalog.values()) {
      const { entry, frequency } = record;
      const key = entry.key.toLowerCase();
      const path = entry.path.toLowerCase();
      const aliases = entry.aliases?.map(value => value.toLowerCase()) ?? [];
      if (!path.includes(term) && !key.includes(term) && !aliases.some(alias => alias.includes(term))) continue;
      let rank = aliases.includes(term) ? -1 : key === term || path === term ? 0 : key.startsWith(term) ? 1 : path.startsWith(term) ? 2 : 3;
      if (!term) {
        const commonSetting = frequency && entry.path.split('.').length === 2;
        const flowOrScreen = entry.category === 'Flow' || entry.category === 'Screen';
        rank = commonSetting && flowOrScreen && entry.types.includes('boolean') ? 0 : commonSetting ? 1 : 2;
      }
      matches.push({ record, rank });
    }
    matches.sort((a, b) => a.rank - b.rank || b.record.frequency - a.record.frequency
      || a.record.entry.path.localeCompare(b.record.entry.path));
    return { entries: matches.slice(offset, offset + limit).map(({ record }) => record.entry), total: matches.length };
  }

  search(query: SearchQuery, paginate = false): { hits: Hit[]; counts: Counts } {
    const { mode, query: text, clientIds, platforms, environments, valueFilter } = query;
    let paths: Iterable<IndexedPath>;
    if (!text.length) paths = [];
    else if (mode === 'exact-path') {
      const path = this.aliases.get(text) ?? formatPath(parsePath(text));
      paths = this.byPath.get(path) ?? [];
    } else if (mode === 'exact-key') paths = this.byKey.get(text) ?? [];
    else {
      const term = text.toLowerCase();
      const found = new Set<IndexedPath>();
      for (const [path, entries] of this.byPath) {
        if (path.toLowerCase().includes(term)) for (const entry of entries) found.add(entry);
      }
      paths = found;
    }

    const sortValue = (hit: Hit) => {
      if (query.sort === 'path') return hit.path.path;
      if (query.sort === 'hyperpayConfigUrl') return hit.reference.ref.normalizedUrl;
      return hit.reference.mjos[query.sort];
    };
    const compare = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
    const order = query.direction === 'asc' ? 1 : -1;
    const compareHits = (a: Hit, b: Hit) => order * compare(sortValue(a), sortValue(b))
      || compare(a.reference.mjos.id, b.reference.mjos.id)
      || compare(a.path.path, b.path.path) || a.posting.config - b.posting.config;
    const limit = paginate ? query.page * query.pageSize : Infinity;
    const selected = new BestHits(compareHits, limit);
    let occurrences = 0;
    const clients = new Set<string>();
    const clientPlatforms = new Set<string>();
    const targets = new Set<string>();
    for (const path of paths) {
      for (const posting of path.postings) {
        if (valueFilter !== undefined && !matchesValue(posting.value, valueFilter)) continue;
        for (const reference of this.references[posting.config]) {
          const { id, clientId, platform, environment } = reference.mjos;
          if (clientIds.length && !clientIds.includes(clientId)) continue;
          if (platforms.length && !platforms.includes(platform)) continue;
          if (environments.length && !environments.includes(environment)) continue;
          selected.add({ reference, path, posting });
          occurrences++;
          clients.add(clientId);
          clientPlatforms.add(`${clientId}/${platform}`);
          targets.add(id);
        }
      }
    }

    return { hits: selected.sorted(), counts: { clients: clients.size, clientPlatforms: clientPlatforms.size, targets: targets.size, occurrences } };
  }

  result({ reference, path, posting }: Hit, includeValues: boolean): SearchResult {
    const { mjos, ref, stale } = reference;
    return {
      id: Buffer.from(JSON.stringify([mjos.id, ref.normalizedUrl, path.path])).toString('base64url'),
      clientId: mjos.clientId, platform: mjos.platform, environment: mjos.environment,
      key: path.key, path: path.path, valueType: posting.value.type,
      ...(includeValues && { preview: abbreviate(posting.value) }),
      owner: ref.owner, version: ref.version, hyperpayConfigUrl: ref.normalizedUrl, stale
    };
  }

  private resultDetail(hit: Hit): ResultDetail {
    const { reference, posting } = hit;
    const { fetchedAt, checkedAt } = this.configs[posting.config];
    return {
      ...this.result(hit, false), value: formatValue(posting.value, true), mjosUrl: reference.mjos.mjosUrl,
      originalUrls: reference.ref.originalUrls, fetchedAt, checkedAt
    };
  }

  detail(id: string): ResultDetail | undefined {
    let parts: unknown;
    try { parts = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')); } catch { return undefined; }
    if (!Array.isArray(parts) || parts.length !== 3 || parts.some(value => typeof value !== 'string')) return undefined;
    const [targetId, url, path] = parts as string[];
    const config = this.configIds.get(url);
    const indexed = this.canonicalPaths.get(path);
    if (config === undefined || !indexed) return undefined;
    const reference = this.references[config].find(item => item.mjos.id === targetId);
    const posting = indexed.postings.find(item => item.config === config);
    if (reference && posting) return this.resultDetail({ reference, posting, path: indexed });
  }

  *export(hits: Iterable<Hit>, includeValues: boolean): Generator<string> {
    const cell = (value: string) => {
      const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value);
      const safe = !numeric && /^\s*[=+@-]|^[\t\r\n]/u.test(value) ? "'" + value : value;
      return '"' + safe.replaceAll('"', '""') + '"';
    };
    yield ['Client ID', 'Platform', 'Environment', 'Config path', 'Value type', ...(includeValues ? ['Config value'] : []),
      'Hyperpay-config URL', 'Configuration owner', 'Version', 'Stale'].map(cell).join(',') + '\r\n';
    for (const { reference, path, posting } of hits) {
      const { mjos, ref, stale } = reference;
      yield [
        mjos.clientId, mjos.platform, mjos.environment, path.path, posting.value.type,
        ...(includeValues ? [formatValue(posting.value, true)] : []), ref.normalizedUrl, ref.owner, ref.version, String(stale)
      ].map(cell).join(',') + '\r\n';
    }
  }
}
