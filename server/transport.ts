import { setTimeout as delay } from 'node:timers/promises';
import type { CacheMetadata } from '../shared/model.js';
import { assertAssetUrl } from './urls.js';

const maxBytes = 12 * 1024 * 1024;
const retryable = new Set([429, 500, 502, 503, 504]);
const pause = (value: string | null, attempt: number) => {
  const seconds = value && (/^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now());
  return Math.max(400 * 2 ** attempt, typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0);
};

export class AssetClient {
  private rateLimitedUntil = 0;
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async get(url: string, cached?: CacheMetadata): Promise<{ text?: string; metadata: CacheMetadata }> {
    assertAssetUrl(url);
    const headers = new Headers();
    if (cached?.etag) headers.set('If-None-Match', cached.etag);
    if (cached?.lastModified) headers.set('If-Modified-Since', cached.lastModified);
    for (let attempt = 0; attempt < 3; attempt++) {
      while (this.rateLimitedUntil > Date.now()) {
        const wait = this.rateLimitedUntil - Date.now();
        if (wait > 20_000) throw new Error('Juspay assets returned HTTP 429 with an extended Retry-After.');
        await delay(wait);
      }
      let response: Response;
      try {
        response = await this.fetcher(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        if (attempt === 2) {
          const code = (error as { cause?: { code?: string } }).cause?.code;
          throw new Error(code ? `Network request failed (${code}).` : 'Network request failed or timed out.');
        }
        await delay(400 * 2 ** attempt);
        continue;
      }
      const now = new Date().toISOString();
      if (response.status === 304 && cached) return { metadata: { ...selectMetadata(cached), checkedAt: now } };
      if (response.status === 200) {
        const text = await readText(response);
        return { text, metadata: {
          fetchedAt: now, checkedAt: now, etag: response.headers.get('etag') ?? undefined,
          lastModified: response.headers.get('last-modified') ?? undefined
        }};
      }
      await response.body?.cancel();
      const wait = pause(response.headers.get('retry-after'), attempt);
      // Finish the refresh with a reported failure on a long Retry-After.
      if (response.status === 429) this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + wait);
      if (!retryable.has(response.status) || attempt === 2 || wait > 20_000) throw new Error(`HTTP ${response.status}.`);
      await delay(wait);
    }
    throw new Error('Fetch retry limit reached.');
  }
}

function selectMetadata({ fetchedAt, checkedAt, etag, lastModified }: CacheMetadata): CacheMetadata {
  return { fetchedAt, checkedAt, etag, lastModified };
}

async function readText(response: Response): Promise<string> {
  if (/text\/html|application\/zip/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new Error('Unexpected HTML or archive response.');
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response exceeds the configured size limit.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  const parts: string[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) throw new Error('Response exceeds the configured size limit.');
      try { parts.push(decoder.decode(result.value, { stream: true })); }
      catch { throw new Error('Response is not valid UTF-8 text.'); }
    }
    try { parts.push(decoder.decode()); }
    catch { throw new Error('Response is not valid UTF-8 text.'); }
    return parts.join('');
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}
