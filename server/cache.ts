import { createReadStream, createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { ConfigRecord, Coverage, Failure, MjosRecord } from '../shared/model.js';

export interface Snapshot {
  version: string;
  lastSuccess: string | null;
  attempt: string;
  clients: string[];
  mjos: MjosRecord[];
  configs: ConfigRecord[];
  staleMjos: string[];
  staleConfigs: string[];
  coverage: Coverage;
  failures: Failure[];
  failed: boolean;
}

const gzipText = promisify(gzip);
const schema = 1;

export class DiskCache {
  constructor(private readonly dir: string) {}

  async prepare(): Promise<void> {
    await mkdir(join(this.dir, 'raw'), { recursive: true, mode: 0o700 });
  }

  async putRaw(hash: string, text: string): Promise<void> {
    const destination = join(this.dir, 'raw', hash + '.js.gz');
    try { await access(destination); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temp = destination + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, Uint8Array.from(await gzipText(text)), { mode: 0o600 });
      await rename(temp, destination);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async read(): Promise<Snapshot | undefined> {
    const mjos: MjosRecord[] = [];
    const configs: ConfigRecord[] = [];
    let manifest: Omit<Snapshot, 'mjos' | 'configs'> | undefined;
    const source = createReadStream(join(this.dir, 'snapshot.ndjson.gz'));
    const gunzip = createGunzip();
    const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
    const done = pipeline(source, gunzip).catch(error => error as NodeJS.ErrnoException);
    let invalid: unknown;
    try {
      for await (const line of lines) {
        const [kind, value] = JSON.parse(line);
        if (kind === 'snapshot' && value.schema === schema) manifest = value;
        else if (kind === 'mjos') mjos.push(value);
        else if (kind === 'config') configs.push(value);
        else throw new Error('Cache format is unsupported.');
      }
    } catch (error) {
      invalid = error;
      source.destroy();
      gunzip.destroy();
    }
    const streamError = await done;
    if (streamError?.code === 'ENOENT') return undefined;
    if (invalid) throw invalid;
    if (streamError) throw streamError;
    if (!manifest) throw new Error('Cache manifest is missing.');
    return { ...manifest, mjos, configs };
  }

  async write(snapshot: Snapshot): Promise<void> {
    const destination = join(this.dir, 'snapshot.ndjson.gz');
    const temp = destination + '.' + process.pid + '.tmp';
    const { mjos, configs, ...state } = snapshot;
    function* lines() {
      yield JSON.stringify(['snapshot', { ...state, schema }]) + '\n';
      for (const row of mjos) yield JSON.stringify(['mjos', row]) + '\n';
      for (const config of configs) yield JSON.stringify(['config', config]) + '\n';
    }
    try {
      await pipeline(Readable.from(lines()), createGzip({ level: 3 }), createWriteStream(temp, { mode: 0o600 }));
      await rename(temp, destination);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
