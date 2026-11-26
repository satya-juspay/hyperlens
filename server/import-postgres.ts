import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiskCache } from './cache.js';
import { PostgresCache } from './postgres.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL before importing the local snapshot.');
const disk = new DiskCache(process.env.HYPERLENS_CACHE ?? resolve(project, '.hyperlens'));
const snapshot = await disk.read();
if (!snapshot) throw new Error('No local snapshot is available. Build the local index before importing.');

const postgres = new PostgresCache(databaseUrl);
try {
  await postgres.prepare();
  const hashes = new Set(snapshot.configs.map(config => config.hash));
  async function* rawConfigs() {
    for (const hash of hashes) yield { hash, compressed: await disk.readCompressedRaw(hash) };
  }
  const imported = await postgres.importSnapshot(snapshot, rawConfigs());
  if (imported) {
    console.log(`Imported ${snapshot.coverage.targets} client environments and ${snapshot.configs.length} configurations to Postgres.`);
  } else {
    console.log('This snapshot is already active in Postgres.');
  }
} finally {
  await postgres.close();
}
