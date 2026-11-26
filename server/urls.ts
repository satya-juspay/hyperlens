import { parse } from 'csv-parse/sync';
import { environments, platforms } from '../shared/model.js';
import type { Client, ConfigurationRef, Failure, Json, Platform, Target } from '../shared/model.js';

const origin = 'https://assets.juspay.in';
const mjosBase = `${origin}/hyper/bundles/in.juspay.merchants`;
const segment = '[A-Za-z0-9_~.-]+';
const filename = '(?:configuration\\.js|v1-configuration\\.(?:zip|jsa))';
const configPattern = new RegExp(
  `^/hyper/configs/(${segment})/in\\.juspay\\.hyperpay/(${segment})/${filename}$`
);
const mjosPattern = new RegExp(
  `^/hyper/bundles/in\\.juspay\\.merchants/${segment}/(?:${platforms.join('|')})/(?:${environments.join('|')})/config\\.json$`
);
const allowedId = /^(?!\.{1,2}$)[a-z0-9_.-]+$/;

export function loadClients(source: string): { clients: Client[]; failures: Failure[] } {
  let malformed = 0;

  const rows = parse(source, {
    bom: true, trim: true, record_delimiter: ['\r\n', '\n', '\r'], skip_empty_lines: true, relax_column_count: true,
    skip_records_with_error: true, on_skip: () => { malformed++; return undefined; }
  }) as string[][];
  const [header, ...records] = rows;
  if (!header || header.length !== 2 || !header.includes('client_id') || !header.includes('platform')) {
    throw new Error('Master CSV must contain client_id and platform columns.');
  }
  const failures: Failure[] = [];
  if (malformed) failures.push({ stage: 'csv', message: `${malformed} malformed CSV rows skipped.` });
  const clients: Client[] = [];
  const seen = new Set<string>();
  for (const [index, row] of records.entries()) {
    const clientId = row[header.indexOf('client_id')];
    const platform = row[header.indexOf('platform')] as Platform;
    const id = JSON.stringify([clientId, platform]);
    let message: string | undefined;
    if (row.length !== 2 || !allowedId.test(clientId ?? '')) message = 'Invalid client ID or column count';
    else if (!platforms.includes(platform)) message = 'Unsupported platform';
    else if (seen.has(id)) message = 'Duplicate client-platform combination';
    if (message) {
      failures.push({ stage: 'csv', message: `CSV record ${index + 2}: ${message}.` });
      continue;
    }
    seen.add(id);
    clients.push({ clientId, platform });
  }
  if (!clients.length) throw new Error('Master CSV has no valid client-platform combinations.');
  return { clients, failures };
}

export function createTargets(clients: Client[]): Target[] {
  return clients.flatMap(client => environments.map(environment => ({
    ...client,
    environment,
    id: JSON.stringify([client.clientId, client.platform, environment]),
    mjosUrl: `${mjosBase}/${encodeURIComponent(client.clientId)}/${client.platform}/${environment}/config.json`
  })));
}

function checkedUrl(input: string): URL | undefined {
  try {
    const url = new URL(input);
    if (url.origin === origin && url.href === input && !url.username && !url.password && !url.search && !url.hash) {
      return url;
    }
  } catch {
    return undefined;
  }
}

export function assertAssetUrl(input: string): void {
  const url = checkedUrl(input);
  if (!url || !(mjosPattern.test(url.pathname) || configPattern.test(url.pathname) && url.pathname.endsWith('/configuration.js'))) {
    throw new Error('URL is outside the permitted Juspay asset paths.');
  }
}

export function normalizeConfigUrl(originalUrl: string): ConfigurationRef | undefined {
  const url = checkedUrl(originalUrl);
  const match = url && configPattern.exec(url.pathname);
  if (!url || !match) return undefined;
  const [, owner, version] = match;
  return {
    owner, version,
    normalizedUrl: `${origin}/hyper/configs/${owner}/in.juspay.hyperpay/${version}/configuration.js`,
    originalUrls: [originalUrl]
  };
}

export function extractConfigRefs(mjos: Record<string, Json>): { refs: ConfigurationRef[]; invalid: number } {
  const pending: Json[] = [mjos];
  const refs = new Map<string, ConfigurationRef>();
  const invalid = new Set<string>();
  const seen = new Set<string>();
  const candidates = new RegExp(
    `https?://[^\\s"'<>\\x60/]+/[^\\s"'<>\\x60]*?/in\\.juspay\\.hyperpay/[^\\s"'<>\\x60/]+/${filename}(?:[?%#/\\w.@:-][^\\s"'<>\\x60,;)\\]]*)?`, 'gi'
  );
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      for (const [candidate] of item.replaceAll('\\/', '/').matchAll(candidates)) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const ref = normalizeConfigUrl(candidate);
        if (!ref) {
          invalid.add(candidate);
          continue;
        }
        const previous = refs.get(ref.normalizedUrl);
        if (previous) previous.originalUrls.push(candidate);
        else refs.set(ref.normalizedUrl, ref);
      }
    } else if (Array.isArray(item)) {
      for (const child of item) pending.push(child);
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) pending.push(key, child);
    }
  }
  return { refs: [...refs.values()], invalid: invalid.size };
}
