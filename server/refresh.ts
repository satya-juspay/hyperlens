import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CatalogEntry, ConfigRecord, Coverage, Failure, Json, MjosRecord, Progress, Status } from '../shared/model.js';
import { emptyCoverage } from '../shared/model.js';
import type { Snapshot, SnapshotCache } from './cache.js';
import { ConfigurationIndex } from './index.js';
import { parseConfiguration } from './parser.js';
import { AssetClient } from './transport.js';
import { createTargets, extractConfigRefs, loadClients } from './urls.js';

interface Options {
  csvPath: string;
  cache: SnapshotCache;
  definitions: CatalogEntry[];
  parallelism: number;
  localMode: boolean;
  fetcher?: typeof fetch;
}

const message = (error: unknown) => error instanceof Error ? error.message : 'Unknown error.';

export class RefreshService {
  snapshot?: Snapshot;
  index: ConfigurationIndex;
  private pending?: Promise<void>;
  private attempt: string | null = null;
  private progress: Progress | null = null;
  private error: string | null = null;

  constructor(private readonly options: Options) {
    this.index = new ConfigurationIndex([], [], [], options.definitions, new Set(), new Set());
  }

  async open(): Promise<void> {
    await this.options.cache.prepare();
    try {
      const snapshot = await this.options.cache.read();
      if (snapshot) {
        this.index = await this.build(snapshot);
        this.snapshot = snapshot;
      }
    } catch {
      this.error = 'Saved index could not be loaded. Refresh the dataset to rebuild it.';
    }
  }

  private async build(snapshot: Snapshot): Promise<ConfigurationIndex> {
    const index = new ConfigurationIndex(snapshot.configs, snapshot.mjos, snapshot.clients,
      this.options.definitions, new Set(snapshot.staleMjos), new Set(snapshot.staleConfigs));
    await index.build();
    return index;
  }

  status(): Status {
    const data = this.snapshot;
    const coverage = data?.coverage ?? emptyCoverage;
    let state: Status['state'] = 'idle';
    if (this.pending) state = 'refreshing';
    else if (this.error || data?.failed) state = 'failed';
    else if (data) state = coverage.failures || coverage.current < coverage.targets ? 'partial' : 'ready';
    return {
      state, lastSuccessfulRefresh: data?.lastSuccess ?? null, lastAttempt: this.attempt ?? data?.attempt ?? null,
      indexVersion: data?.version ?? null, coverage, progress: this.progress,
      error: this.error ?? (data?.failed ? 'Refresh could not validate any current client-environment combinations.' : null),
      catalogSize: this.index.catalogSize, knownSize: this.options.definitions.length, localMode: this.options.localMode
    };
  }

  start(): boolean {
    if (this.pending) return false;
    this.attempt = new Date().toISOString();
    this.error = null;
    this.pending = this.refresh(this.attempt).catch(error => {
      this.error = `Refresh failed. ${message(error)}`;
    }).finally(() => {
      this.progress = null;
      this.pending = undefined;
    });
    return true;
  }

  async wait(): Promise<void> { await this.pending; }

  private async refresh(attempt: string): Promise<void> {
    const csv = await readMasterCsv(this.options.csvPath);
    const snapshot = await ingestSnapshot({
      ...this.options, csv, attempt, previous: this.snapshot,
      onProgress: progress => { this.progress = progress; }
    });
    this.progress = { phase: 'indexing', completed: 0, total: 1 };
    const index = await this.build(snapshot);
    snapshot.coverage.unresolved = index.unresolved;
    await this.options.cache.write(snapshot, this.snapshot?.version);
    this.snapshot = snapshot;
    this.index = index;
  }
}

export async function readMasterCsv(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Master CSV was not found. Check HYPERLENS_CSV.');
    throw new Error('Master CSV could not be read.');
  }
}

interface IngestionOptions {
  csv: string;
  cache: Pick<SnapshotCache, 'putRaw'>;
  previous?: Snapshot;
  attempt: string;
  parallelism: number;
  onProgress: (progress: Progress) => void;
  fetcher?: typeof fetch;
}

export async function ingestSnapshot(options: IngestionOptions): Promise<Snapshot> {
  async function runPhase<T>(phase: Progress['phase'], tasks: T[], work: (task: T) => Promise<void>): Promise<void> {
    const progress = { phase, completed: 0, total: tasks.length };
    options.onProgress(progress);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const task = tasks[next++];
        await work(task);
        progress.completed++;
        options.onProgress(progress);
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.parallelism, tasks.length) }, worker));
  }

  const { clients, failures } = loadClients(options.csv);
  const oldMjos = new Map(options.previous?.mjos.map(row => [row.id, row]));
  const oldConfigs = new Map(options.previous?.configs.map(row => [row.url, row]));
  const rows = new Map<string, MjosRecord>();
  const configs = new Map<string, ConfigRecord>();
  const staleMjos = new Set<string>();
  const staleConfigs = new Set<string>();
  const invalidMjos = new Set<string>();
  const urls = new Set<string>();
  const targets = createTargets(clients);
  const asset = new AssetClient(options.fetcher);

  await runPhase('mjos', targets, async target => {
    const previous = oldMjos.get(target.id);
    try {
      const { text, metadata } = await asset.get(target.mjosUrl, previous);
      let mjos = previous?.mjos;
      if (text !== undefined) {
        try {
          mjos = JSON.parse(text);
        } catch {
          throw new Error('Invalid MJOS JSON.');
        }
      }
      if (!mjos || typeof mjos !== 'object' || Array.isArray(mjos) || !Object.keys(mjos).length) {
        throw new Error('Expected a non-empty MJOS JSON object.');
      }
      const { refs, invalid } = extractConfigRefs(mjos as Record<string, Json>);
      if (invalid) {
        invalidMjos.add(target.id);
        failures.push({ stage: 'url', message: `${invalid} invalid hyperpay-config URL candidates.`, targetId: target.id, url: target.mjosUrl });
      }
      if (!refs.length) {
        failures.push({ stage: 'url', message: 'MJOS contains no supported hyperpay-config URLs.', targetId: target.id, url: target.mjosUrl });
        if (previous) {
          rows.set(target.id, previous);
          staleMjos.add(target.id);
        }
        return;
      }
      rows.set(target.id, { ...target, ...metadata, mjos, refs });
    } catch (error) {
      failures.push({ stage: 'mjos', message: message(error), targetId: target.id, url: target.mjosUrl });
      if (previous) {
        rows.set(target.id, previous);
        staleMjos.add(target.id);
      }
    }
  });

  for (const row of rows.values()) for (const ref of row.refs) urls.add(ref.normalizedUrl);
  await runPhase('hyperpay-config', [...urls], async url => {
    const previous = oldConfigs.get(url);
    let stage: Failure['stage'] = 'fetch';
    try {
      const { text, metadata } = await asset.get(url, previous);
      if (text !== undefined) {
        if (!text.trim()) throw new Error('Empty hyperpay-config response.');
        if (/^\s*</.test(text) || text.includes('\0')) throw new Error('Unexpected markup or binary hyperpay-config response.');
      }
      const hash = text === undefined ? previous?.hash : createHash('sha256').update(text).digest('hex');
      let current: ConfigRecord;
      if (previous && previous.hash === hash) {
        current = { ...previous, ...metadata };
      } else {
        if (text === undefined || !hash) throw new Error('No cached configuration was available for HTTP 304.');
        stage = 'parse';
        const parsed = parseConfiguration(text);
        stage = 'index';
        await options.cache.putRaw(hash, text);
        current = { ...parsed, ...metadata, hash, url };
      }
      if (current.structuralWarnings) {
        failures.push({ stage: 'index', message: `${current.structuralWarnings} declarations have unknown keys or array positions.`, url });
      }
      configs.set(url, current);
    } catch (error) {
      failures.push({ stage, message: message(error), url });
      if (previous) {
        configs.set(url, previous);
        staleConfigs.add(url);
      }
    }
  });

  const coverage: Coverage = { ...emptyCoverage, clientPlatforms: clients.length, targets: targets.length,
    configs: urls.size, parsed: [...configs.keys()].filter(url => !staleConfigs.has(url)).length };
  for (const target of targets) {
    const row = rows.get(target.id);
    if (!row) {
      coverage.unavailable++;
      continue;
    }
    const currentRefs = row.refs.filter(ref => configs.has(ref.normalizedUrl));
    if (!currentRefs.length) {
      const previous = oldMjos.get(row.id);
      const fallback = (previous?.fallbackRefs ?? previous?.refs ?? []).filter(ref => oldConfigs.has(ref.normalizedUrl));
      if (fallback.length) {
        rows.set(row.id, { ...row, fallbackRefs: fallback });
        for (const { normalizedUrl } of fallback) {
          if (!configs.has(normalizedUrl)) {
            configs.set(normalizedUrl, oldConfigs.get(normalizedUrl)!);
            staleConfigs.add(normalizedUrl);
          }
        }
        coverage.stale++;
      } else coverage.unavailable++;
      continue;
    }
    if (row.fallbackRefs) rows.set(row.id, { ...row, fallbackRefs: undefined });
    if (staleMjos.has(row.id) || currentRefs.every(ref => staleConfigs.has(ref.normalizedUrl))) coverage.stale++;
    else if (invalidMjos.has(row.id) || currentRefs.length !== row.refs.length
      || currentRefs.some(ref => staleConfigs.has(ref.normalizedUrl) || !!configs.get(ref.normalizedUrl)?.structuralWarnings)) coverage.partial++;
    else coverage.current++;
  }

  const failed = coverage.current + coverage.partial === 0;
  const fullySuccessful = !failed && coverage.current === coverage.targets && !failures.length;
  const done = new Date().toISOString();
  coverage.failures = failures.length;
  return {
    version: randomUUID(), lastSuccess: fullySuccessful ? done : options.previous?.lastSuccess ?? null,
    attempt: options.attempt, clients: clients.map(client => client.clientId), configs: [...configs.values()], mjos: [...rows.values()],
    coverage, failures, staleMjos: [...staleMjos], staleConfigs: [...staleConfigs], failed
  };
}
