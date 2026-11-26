import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const hosted = process.argv.includes('--vercel');
const outdir = hosted ? 'dist/vercel' : 'dist/public';
const appDocument = resolve('public/index.html');

await build({
  entryPoints: ['client/main.tsx'],
  outdir,
  bundle: true,
  minify: true,
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' }
});
await cp('public', outdir, {
  recursive: true,
  filter: source => !hosted || resolve(source) !== appDocument
});
