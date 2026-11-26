import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiskCache } from './cache.js';
import { repositoryCatalog } from './catalog.js';
import { applicationServer } from './http.js';
import { RefreshService } from './refresh.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
const value = (name: string, fallback: string) => process.env[name] ?? fallback;
const host = value('HYPERLENS_HOST', '127.0.0.1');
const port = Number(value('HYPERLENS_PORT', '4173'));
const parallelism = Number(value('HYPERLENS_CONCURRENCY', '15'));
const requiredAuth = process.env.HYPERLENS_AUTH;
const localMode = ['127.0.0.1', '::1', 'localhost'].includes(host);
if ((!localMode && !requiredAuth) || (requiredAuth !== undefined && !/^[^:]+:.+$/.test(requiredAuth))) {
  throw new Error('Non-loopback binding requires HYPERLENS_AUTH in the form username:password.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a port between 1 and 65535.');
if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 30) throw new Error('Use ingestion concurrency between 1 and 30.');

const { definitions, notes } = await repositoryCatalog(
  value('HYPERLENS_WIDGET_ROOT', resolve(project, '../hyper-widget')),
  value('HYPERLENS_READER_ROOT', resolve(project, '../config-reader'))
);
const refresh = new RefreshService({
  csvPath: value('HYPERLENS_CSV', resolve(project, 'mjos_client_list_cleaned.csv')),
  cache: new DiskCache(value('HYPERLENS_CACHE', resolve(project, '.hyperlens'))),
  parallelism, definitions, localMode
});
await refresh.open();
const server = applicationServer({ refresh, publicDir: resolve(project, 'dist/public'), localMode, requiredAuth, catalogNotes: notes });
server.listen(port, host, () => {
  console.log(`HyperLens is available at http://${host.includes(':') ? '[' + host + ']' : host}:${port}`);
  if (!refresh.snapshot && value('HYPERLENS_AUTO_REFRESH', '1') === '1') refresh.start();
});
