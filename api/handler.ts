import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { waitUntil } from '@vercel/functions';
import { createHostedHandler } from '../server/hosted/api.js';
import { HostedStore } from '../server/hosted/store.js';

let handler: ReturnType<typeof createHostedHandler> | undefined;
let page: Promise<string> | undefined;

export default {
  fetch(request: Request): Promise<Response> | Response {
    if (!handler) {
      const { DATABASE_URL, HYPERLENS_AUTH } = process.env;
      const parallelism = Number(process.env.HYPERLENS_CONCURRENCY ?? 15);
      if (!DATABASE_URL) {
        return Response.json({ error: 'Set DATABASE_URL to connect to Postgres.' }, { status: 503 });
      }
      if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 30) {
        return Response.json({ error: 'Set HYPERLENS_CONCURRENCY to a whole number between 1 and 30.' }, { status: 503 });
      }
      try {
        handler = createHostedHandler(new HostedStore(DATABASE_URL), {
          auth: HYPERLENS_AUTH, parallelism, schedule: waitUntil,
          html: () => page ??= readFile(join(process.cwd(), 'public', 'index.html'), 'utf8')
        });
      } catch {
        return Response.json({ error: 'Check the hosted database URL and any configured login credentials.' }, { status: 503 });
      }
    }
    return handler(request);
  }
};
