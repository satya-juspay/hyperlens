import { createHash, timingSafeEqual } from 'node:crypto';
import { HostedSearch } from './search.js';
import type { HostedStore } from './store.js';
import { BadRequest, number, searchParams } from '../search-params.js';

interface Options {
  auth?: string;
  parallelism: number;
  html: () => Promise<string>;
  schedule: (task: Promise<void>) => void;
  fetcher?: typeof fetch;
}

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

const paths: Record<string, string> = {
  '/': 'home', '/index.html': 'home', '/api/status': 'status', '/api/health': 'health',
  '/api/clients': 'clients', '/api/configurations': 'configurations', '/api/configurations/suggestions': 'configurations',
  '/api/search': 'search', '/api/search.csv': 'export', '/api/refresh': 'refresh'
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const body = JSON.stringify(data);
  const response = { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra } };
  if (Buffer.byteLength(body) < 4 * 1024 * 1024) return new Response(body, response);
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = Math.min(offset + 64 * 1024, bytes.length);
      controller.enqueue(bytes.subarray(offset, next));
      offset = next;
      if (offset === bytes.length) controller.close();
    }
  }), response);
}

function digest(value: string): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(value).digest());
}

export function createHostedHandler(store: HostedStore, options: Options): (request: Request) => Promise<Response> {
  if (options.auth && !/^[^:]+:.+$/.test(options.auth)) throw new Error('Set HYPERLENS_AUTH in the form username:password.');
  const expected = options.auth ? digest('Basic ' + Buffer.from(options.auth).toString('base64')) : undefined;
  const search = new HostedSearch(store);

  return async request => {
    if (expected && !timingSafeEqual(expected, digest(request.headers.get('authorization') ?? ''))) {
      return json({ error: 'Authentication is required.' }, 401, { 'WWW-Authenticate': 'Basic realm="HyperLens", charset="UTF-8"' });
    }

    try {
      const url = new URL(request.url);
      const params = url.searchParams;
      const detail = url.pathname.startsWith('/api/results/') ? url.pathname.slice('/api/results/'.length) : null;
      const endpoint = detail !== null ? 'result' : Object.hasOwn(paths, url.pathname) ? paths[url.pathname]
        : url.pathname === '/api/handler' ? params.get('__hl_endpoint') : null;
      if (!endpoint) return json({ error: 'Not found.' }, 404);
      if (endpoint === 'refresh' && request.method === 'POST') {
        const origin = request.headers.get('origin');
        if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin)
          || !/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
          return json({ error: 'Refresh accepts same-origin JSON requests.' }, 403);
        }
        const job = await store.claim();
        if (job) options.schedule(store.run(job, options.parallelism, options.fetcher));
        const status = await store.status();
        if (!job && !status.indexVersion && status.state === 'idle') {
          return json({ error: 'Prepare the hosted index with npm run db:prepare-vercel first.' }, 503);
        }
        return json({ started: Boolean(job), status }, job ? 202 : 409);
      }
      if (request.method !== 'GET') return json({ error: 'Method is unavailable.' }, 405);
      if (endpoint === 'home') return new Response(await options.html(), {
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' }
      });
      if (endpoint === 'status') return json(await store.status());
      if (endpoint === 'health' || endpoint === 'clients') {
        const { manifest, notes } = await store.data();
        if (endpoint === 'clients') return json({ clients: manifest?.clients ?? [] });
        const failures = manifest?.failures ?? [];
        const offset = number(params.get('offset'), 0, 1_000_000, 0);
        return json({ failures: failures.slice(offset, offset + 100), total: failures.length, catalogNotes: notes });
      }
      if (endpoint === 'configurations') {
        const query = params.get('q') ?? '';
        if (query.length > 1024) throw new BadRequest('Catalog searches must be at most 1,024 characters.');
        return json(await search.suggestions(query.trim(), number(params.get('limit'), 12, 100), number(params.get('offset'), 0, 1_000_000, 0)));
      }
      if (endpoint === 'search') return json(await search.search(searchParams(params)));
      if (endpoint === 'export') {
        return new Response(await search.export(searchParams(params)), { headers: {
          ...headers, 'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="hyperlens-results.csv"'
        } });
      }
      if (endpoint === 'result') {
        const id = detail ?? params.get('__hl_id') ?? '';
        const row = id.length <= 4096 ? await search.detail(id) : undefined;
        return row ? json(row) : json({ error: 'Result is unavailable in the current index.' }, 404);
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      if (typeof error === 'object' && error && 'code' in error && error.code === '42P01') {
        return json({ error: 'Prepare the hosted index with npm run db:prepare-vercel first.' }, 503);
      }
      return json({ error: 'HyperLens could not complete this request.' }, 500);
    }
  };
}
