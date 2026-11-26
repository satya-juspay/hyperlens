import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryCatalog } from './catalog.js';
import { HostedStore } from './hosted/store.js';
import { readMasterCsv } from './refresh.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL before preparing the hosted dataset.');
const [csv, catalog] = await Promise.all([
  readMasterCsv(process.env.HYPERLENS_CSV ?? resolve(project, 'mjos_client_list_cleaned.csv')),
  repositoryCatalog(
    process.env.HYPERLENS_WIDGET_ROOT ?? resolve(project, '../hyper-widget'),
    process.env.HYPERLENS_READER_ROOT ?? resolve(project, '../config-reader')
  )
]);
const store = new HostedStore(url);
try {
  await store.prepare();
  const snapshot = await store.seed({ csv, ...catalog });
  console.log(`Prepared the hosted index for ${snapshot.coverage.targets} client environments and ${snapshot.configs.length} configurations.`);
} finally {
  await store.cache.close();
}
