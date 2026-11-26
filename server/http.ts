import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { environments, modes, platforms, sortFields } from '../shared/model.js';
import type { Json, SearchQuery } from '../shared/model.js';
import type { RefreshService } from './refresh.js';
import { BadRequest, number, searchParams } from './search-params.js';

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/main.js': ['main.js', 'text/javascript; charset=utf-8'],
  '/main.css': ['main.css', 'text/css; charset=utf-8'],
  '/favicon.ico': ['favicon.ico', 'image/vnd.microsoft.icon'],
  '/branding/apple-touch-icon.png': ['branding/apple-touch-icon.png', 'image/png'],
  '/branding/hyperlens-wordmark-light.png': ['branding/hyperlens-wordmark-light.png', 'image/png'],
  '/branding/hyperlens-wordmark-dark.png': ['branding/hyperlens-wordmark-dark.png', 'image/png']
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function applicationServer(options: {
  refresh: RefreshService; publicDir: string; localMode: boolean; requiredAuth?: string; catalogNotes: string[];
}) {
  const secret = options.requiredAuth ? hash('Basic ' + Buffer.from(options.requiredAuth).toString('base64')) : undefined;
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host = request.headers.host ?? '';
    if (options.localMode && !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) {
      return json(response, 403, { error: 'Use the loopback URL to access HyperLens.' });
    }
    if (secret && !timingSafeEqual(new TextEncoder().encode(secret), new TextEncoder().encode(hash(request.headers.authorization ?? '')))) {
      response.setHeader('WWW-Authenticate', 'Basic realm="HyperLens", charset="UTF-8"');
      return json(response, 401, { error: 'Authentication is required.' });
    }

    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const { pathname, searchParams: params } = url;
      const { refresh } = options;
      if (pathname === '/api/refresh' && request.method === 'POST') {
        const origin = request.headers.origin;
        if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== host)
          || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
          return json(response, 403, { error: 'Refresh accepts same-origin JSON requests.' });
        }
        request.resume();
        const started = refresh.start();
        return json(response, started ? 202 : 409, { started, status: refresh.status() });
      }
      if (request.method !== 'GET') return json(response, 405, { error: 'Method is unavailable.' });
      const index = refresh.index;
      if (pathname === '/api/status') return json(response, 200, refresh.status());
      if (pathname === '/api/health') {
        const failures = refresh.snapshot?.failures ?? [];
        const offset = number(params.get('offset'), 0, 1_000_000, 0);
        return json(response, 200, {
          failures: failures.slice(offset, offset + 100), total: failures.length, catalogNotes: options.catalogNotes
        });
      }
      if (pathname === '/api/clients') return json(response, 200, { clients: index.clients });
      if (pathname === '/api/configurations' || pathname === '/api/configurations/suggestions') {
        const query = params.get('q') ?? '';
        if (query.length > 1024) throw new BadRequest('Catalog searches must be at most 1,024 characters.');
        const limit = number(params.get('limit'), 12, 100);
        const offset = number(params.get('offset'), 0, 1_000_000, 0);
        return json(response, 200, index.suggestions(query.trim(), limit, offset));
      }
      if (pathname === '/api/search' || pathname === '/api/search.csv') {
        const query = searchParams(params);
        let result: ReturnType<typeof index.search>;
        try { result = index.search(query, !pathname.endsWith('.csv')); } catch (error) {
          throw new BadRequest(error instanceof Error ? error.message : 'Search query is invalid.');
        }
        if (pathname.endsWith('.csv')) {
          response.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="hyperlens-results.csv"'
          });
          await pipeline(Readable.from(index.export(result.hits, query.includeValues)), response);
          return;
        }
        const { coverage, indexVersion } = refresh.status();
        const { pageSize } = query;
        const page = Math.min(query.page, Math.max(1, Math.ceil(result.counts.occurrences / pageSize)));
        return json(response, 200, {
          results: result.hits.slice((page - 1) * pageSize, page * pageSize).map(hit => index.result(hit, query.includeValues)),
          counts: result.counts, page, pageSize, coverage, indexVersion
        });
      }
      if (pathname.startsWith('/api/results/')) {
        const id = pathname.slice('/api/results/'.length);
        const detail = id.length <= 4096 && index.detail(id);
        return detail ? json(response, 200, detail) : json(response, 404, { error: 'Result is unavailable in the current index.' });
      }
      if (Object.hasOwn(assets, pathname)) {
        const [file, mime] = assets[pathname];
        const stream = createReadStream(join(options.publicDir, file));
        await new Promise<void>((resolve, reject) => {
          stream.once('open', () => {
            response.setHeader('Content-Type', mime);
            stream.pipe(response);
          });
          stream.once('error', reject);
          response.once('finish', resolve);
          response.once('close', resolve);
        });
        return;
      }
      return json(response, 404, { error: 'Not found.' });
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      if (error instanceof BadRequest || error instanceof TypeError && (error as NodeJS.ErrnoException).code === 'ERR_INVALID_URL') {
        return json(response, 400, { error: error.message });
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json(response, 404, { error: 'Asset is unavailable.' });
      return json(response, 500, { error: 'HyperLens could not complete this request.' });
    }
  });
}
