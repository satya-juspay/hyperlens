import { cp } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: ['client/main.tsx'],
  outdir: 'dist/public',
  bundle: true,
  minify: true,
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' }
});
await cp('public', 'dist/public', { recursive: true });
