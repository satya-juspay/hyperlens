import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfiguration, toJson } from '../dist/server/parser.js';
import { formatPath, parsePath } from '../dist/server/paths.js';
import { assertAssetUrl, createTargets, extractConfigRefs, loadClients, normalizeConfigUrl } from '../dist/server/urls.js';
import { ConfigurationIndex } from '../dist/server/index.js';
import { repositoryCatalog } from '../dist/server/catalog.js';
import { AssetClient } from '../dist/server/transport.js';
import { DiskCache } from '../dist/server/cache.js';
import { RefreshService } from '../dist/server/refresh.js';

const asset = 'https://assets.juspay.in';
const mjosBase = asset + '/hyper/bundles/in.juspay.merchants';
const url = (owner, version, file = 'configuration.js') =>
  `${asset}/hyper/configs/${owner}/in.juspay.hyperpay/${version}/${file}`;
const shared = url('owner', 'next.7');
const different = url('owner', '1.10');
const timestamp = '2025-01-02T12:00:00.000Z';
const query = (overrides = {}) => ({
  query: 'enabled', mode: 'exact-key', platforms: [], environments: [], clientIds: [],
  includeValues: true, page: 1, pageSize: 25, sort: 'clientId', direction: 'asc', ...overrides
});
const wrapper = `window.hyperpay_configuration_version = 'next.7';
if (window.JOS) window.JOS.registerVersion();
globalThis.__fixtureExecuted = true;
const options = { enabled: false };
window.getMerchantConfig = function () {
  const configuration = {
    context: [""],
    componentMapping: { "*.FlowConfig": "flowConfig" },
    mainConfig: {
      flowConfig: { checkout: options, retry: 0, title: '', limit: null, noEntries: [], blank: {} },
      screenConfig: { buttons: [{ enabled: true }, , { "a.b": [false] }], "layout.title": "UPI" },
      enabled: "true",
      runtime: calculateValue(),
      reference: { "#ref": ["flowConfig.checkout.enabled"] },
      preset: { "#override": ["screenConfig", { "buttons.primary": { enabled: false } }] }
    }
  };
  return JSON.stringify(configuration);
};`;

test('master CSV validates platforms and duplicates without coercing numeric IDs', () => {
  const source = '\uFEFFclient_id,platform\r\n"0012",android\r\n0012,android\n0012,ios\nnope,tv\n,web\nfoo,web,extra\nsite_x,web';
  const { clients, failures } = loadClients(source);
  assert.deepEqual(clients, [
    { clientId: '0012', platform: 'android' }, { clientId: '0012', platform: 'ios' }, { clientId: 'site_x', platform: 'web' }
  ]);
  assert.equal(failures.length, 4);
  const targets = createTargets(clients);
  assert.equal(targets.length, 6);
  assert.deepEqual(targets.slice(0, 2).map(item => item.mjosUrl), [
    mjosBase + '/0012/android/release/config.json', mjosBase + '/0012/android/cug/config.json'
  ]);
  assert.throws(() => loadClients('client,platform\na,ios'), /columns/);
  assert.throws(() => loadClients('platform,client_id\nios,../escape'), /no valid/);
});

test('recursively extracts all URLs and groups ZIP, JSA, and JS by normalized URL', () => {
  const zip = url('owner', 'next.7', 'v1-configuration.zip');
  const jsa = url('owner', 'next.7', 'v1-configuration.jsa');
  const mjos = { nested: [{ [zip]: [{ note: `assets: (${shared})` }, jsa, zip] }], other: different };
  const { refs, invalid } = extractConfigRefs(mjos);
  assert.equal(invalid, 0);
  assert.equal(refs.length, 2);
  const found = refs.find(ref => ref.normalizedUrl === shared);
  assert.equal(found.owner, 'owner');
  assert.equal(found.version, 'next.7');
  assert.deepEqual(new Set(found.originalUrls), new Set([zip, jsa, shared]));
  assert.deepEqual(extractConfigRefs({ no: ['url'] }), { refs: [], invalid: 0 });
  assert.equal(extractConfigRefs({ bad: shared.replace('assets.juspay.in', 'example.com') }).invalid, 1);
});

test('URL validation rejects foreign hosts, credentials, redirects by path, and archive GETs', () => {
  assert.doesNotThrow(() => assertAssetUrl(shared));
  assert.throws(() => assertAssetUrl(url('owner', 'next.7', 'v1-configuration.zip')), /permitted/);
  for (const bad of [
    shared.replace('assets.juspay.in', 'assets.juspay.in.example.com'),
    shared.replace('assets.juspay.in', 'assets.juspay.in:443'),
    shared.replace('assets.juspay.in', 'user@assets.juspay.in'),
    shared.replace('next.7', '..'),
    shared.replace('next.7', '%2fescape'),
    shared + '?redirect=https://example.com',
    shared + '/trailing',
    shared.replace('https', 'http')
  ]) assert.equal(normalizeConfigUrl(bad), undefined, bad);
});

test('statically reads the live getMerchantConfig shape and preserves literal values', () => {
  const { tree, structuralWarnings } = parseConfiguration(wrapper);
  const value = toJson(tree);
  assert.equal(structuralWarnings, 0);
  assert.deepEqual(value.mainConfig.flowConfig, {
    checkout: { enabled: false }, retry: 0, title: '', limit: null, noEntries: [], blank: {}
  });
  assert.equal(value.mainConfig.screenConfig.buttons[0].enabled, true);
  assert.deepEqual(value.mainConfig.screenConfig.buttons[2]['a.b'], [false]);
  assert.equal(tree.entries.mainConfig.entries.runtime.type, 'unresolved');
  assert.equal(globalThis.__fixtureExecuted, undefined);
});

test('supports JSON, bare object literals, CommonJS, ES exports, and local binding composition', () => {
  assert.deepEqual(toJson(parseConfiguration(' { key: -2, label: `available` }; ').tree), { key: -2, label: 'available' });
  assert.deepEqual(toJson(parseConfiguration('{"__proto__":null,"0":false}').tree), JSON.parse('{"__proto__":null,"0":false}'));
  assert.deepEqual(toJson(parseConfiguration('const first = {x: true}; module.exports = {...first, y: [0, ...[2]]};').tree),
    { x: true, y: [0, 2] });
  assert.deepEqual(toJson(parseConfiguration('const data = {a: []}; export { data as default };').tree), { a: [] });
  assert.deepEqual(toJson(parseConfiguration('export default [{a: true}, 0];').tree), [{ a: true }, 0]);
  assert.deepEqual(toJson(parseConfiguration('[{a: true}, 0]').tree), [{ a: true }, 0]);
});

test('reports unsupported roots, malformed JavaScript, and unknown structure', () => {
  assert.throws(() => parseConfiguration('window.getMerchantConfig = () => fetchSomething()'), /supported static/);
  assert.throws(() => parseConfiguration("export default {x: '"), /Invalid JavaScript at line/);
  assert.throws(() => parseConfiguration(' '), /Empty/);
  assert.throws(() => parseConfiguration('module.exports = { enabled: true }; module.exports.enabled = false;'), /Incremental/);
  const out = parseConfiguration('export default { fixed: false, [getKey()]: true, ...fromRuntime(), rows: [0, ...fromRuntime()] };');
  assert.equal(out.structuralWarnings, 3);
  assert.equal(out.tree.entries.fixed.value, false);
  assert.equal(out.tree.entries.rows.type, 'unresolved');
});

test('path syntax round-trips dotted literals, escaped keys, array indices, and numeric properties', () => {
  const path = ['root', 'π', 'a.b', 2, '0', '"x"', ''];
  assert.equal(formatPath(path), 'root.π["a.b"][2]["0"]["\\"x\\""][""]');
  assert.deepEqual(parsePath(formatPath(path)), path);
  assert.deepEqual(parsePath('["a.b"][0].nested'), ['a.b', 0, 'nested']);
  assert.throws(() => parsePath('foo..bar'));
  assert.throws(() => parsePath('x[9007199254740992]'));
});

async function createIndex() {
  const targets = createTargets([{ clientId: '0012', platform: 'android' }, { clientId: 'another', platform: 'web' }]);
  const configs = [
    { url: shared, ...parseConfiguration(wrapper), fetchedAt: timestamp, checkedAt: timestamp, hash: 'a' },
    { url: different, ...parseConfiguration('module.exports = {enabled: true, unknownKey: 0};'), fetchedAt: timestamp, checkedAt: timestamp, hash: 'b' }
  ];
  const mjos = targets.map((target, index) => ({ ...target, mjos: {}, fetchedAt: timestamp, checkedAt: timestamp,
    refs: index === 0
      ? extractConfigRefs({ a: url('owner', 'next.7', 'v1-configuration.zip'), b: shared, c: different }).refs
      : [normalizeConfigUrl(shared)]
  }));
  const definitions = [
    { path: 'repositoryOnly', key: 'repositoryOnly', category: 'Other', types: ['boolean'], source: 'repository', defaultValue: true },
    { path: 'flowConfig', key: 'flowConfig', category: 'Flow', types: ['object'], source: 'repository', aliases: ['*.FlowConfig'] }
  ];
  const index = new ConfigurationIndex(configs, mjos, ['0012', 'another'], definitions, new Set([targets[1].id]), new Set());
  await index.build();
  return index;
}

test('reverse index expands shared references and retains matches for separate config URLs', async () => {
  const index = await createIndex();
  const { hits, counts } = index.search(query());
  assert.deepEqual(counts, { clients: 2, clientPlatforms: 2, targets: 4, occurrences: 17 });
  const rows = hits.map(hit => index.result(hit, true));
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.equal(rows.filter(row => row.clientId === '0012' && row.environment === 'release').length, 5);
  assert.equal(rows.filter(row => row.clientId === 'another').length, 8);
  const target = rows.find(row => row.clientId === '0012' && row.environment === 'release' && row.path.endsWith('.checkout.enabled'));
  assert.equal(target.preview, 'false');
  assert.equal(target.owner, 'owner');
  assert.notEqual(target.owner, target.clientId);
  const detail = index.detail(target.id);
  assert.equal(detail.value, 'false');
  assert.equal(detail.originalUrls.length, 2);
  assert.ok(detail.mjosUrl.endsWith('/0012/android/release/config.json'));
  assert.equal(index.detail('not-an-id'), undefined);
});

test('supports raw and logical exact paths, partial matching, aliases and arbitrary observed keys', async () => {
  const index = await createIndex();
  const searchPath = text => index.search(query({ query: text, mode: 'exact-path' })).counts.occurrences;
  assert.equal(searchPath('screenConfig.buttons[2]["a.b"][0]'), 4);
  assert.equal(searchPath('mainConfig.screenConfig["layout.title"]'), 4);
  assert.equal(searchPath('screenConfig.layout.title'), 4);
  assert.equal(searchPath('preset.buttons.primary.enabled'), 4);
  assert.equal(searchPath('*.FlowConfig'), 4);
  assert.equal(searchPath('screenConfig.buttons[1]'), 0);
  assert.equal(index.search(query({ query: 'UNKNOWN', mode: 'partial' })).counts.occurrences, 1);
  assert.equal(index.search(query({ query: 'unknownKey' })).counts.occurrences, 1);
  assert.equal(index.search(query({ query: 'repositoryOnly' })).counts.occurrences, 0);
  assert.equal(index.suggestions('repositoryOnly', 10).entries[0].source, 'repository');
  assert.equal(index.suggestions('*.FlowConfig', 10).entries[0].source, 'both');
  assert.equal(index.suggestions('unknownKey', 10).entries[0].source, 'observed');
});

test('typed value filters distinguish present falsey values from absent values', async () => {
  const index = await createIndex();
  for (const [key, value] of [['retry', 0], ['title', ''], ['limit', null], ['noEntries', []], ['blank', {}]]) {
    assert.ok(index.search(query({ query: key, valueFilter: value })).counts.occurrences > 0);
  }
  assert.equal(index.search(query({ valueFilter: true })).counts.occurrences, 5);
  assert.equal(index.search(query({ valueFilter: 'true' })).counts.occurrences, 4);
  assert.equal(index.search(query({ valueFilter: false })).counts.occurrences, 8);
  assert.equal(index.search(query({ query: 'runtime', valueFilter: null })).counts.occurrences, 0);
  const unresolved = index.search(query({ query: 'reference' })).hits[0];
  const row = index.result(unresolved, true);
  assert.equal(row.valueType, 'unresolved');
  assert.match(index.detail(row.id).value, /"#ref"/);
});

test('client, environment and platform filters compose and stale matches are marked', async () => {
  const index = await createIndex();
  const result = index.search(query({ platforms: ['android', 'ios'], environments: ['cug'], clientIds: ['0012'] }));
  assert.deepEqual(result.counts, { clients: 1, clientPlatforms: 1, targets: 1, occurrences: 4 });
  assert.ok(result.hits.every(hit => index.result(hit, false).stale));
  const csv = [...index.export(result.hits, false)].join('');
  assert.match(csv, /"0012","android","cug"/);
  assert.doesNotMatch(csv, /"Config value"/);
  assert.doesNotMatch(csv, /"another"/);
});

test('paginated search keeps the same ordering and full counts as CSV search', async () => {
  const index = await createIndex();
  for (const sort of ['clientId', 'platform', 'environment', 'path', 'hyperpayConfigUrl']) {
    for (const direction of ['asc', 'desc']) {
      const params = query({ page: 2, pageSize: 2, sort, direction });
      const full = index.search(params);
      const paged = index.search(params, true);
      assert.deepEqual(paged.counts, full.counts);
      assert.deepEqual(paged.hits, full.hits.slice(0, 4));
    }
  }
});

test('repository catalog statically joins definitions, defaults, feature descriptions, and aliases', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hyperlens-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'));
  await mkdir(join(root, 'constants'));
  await writeFile(join(root, 'config/flow.js'), 'export const Flow = { someFeature: false, legacy: 0, // deprecated\n };');
  await writeFile(join(root, 'config/config.js'),
    "import { Flow } from './flow.js'; export const Config = { mainConfig: { flowConfig: Flow }, componentMapping: {'*.FlowConfig':'flowConfig'} };");
  await writeFile(join(root, 'constants/rules.js'), `export default { a: {description: "Feature description",
    keys: {mandatory: {"flowConfig.someFeature": {type: "Boolean", defaultValue: false}}}}};`);
  await writeFile(join(root, 'example.json'), '{"mainConfig": {}, "context": [], "componentMapping": {}}');
  const { definitions, notes } = await repositoryCatalog(root, root);
  const map = new Map(definitions.map(entry => [entry.path, entry]));
  assert.deepEqual(notes, []);
  assert.equal(map.get('flowConfig.someFeature').description, 'Feature description');
  assert.equal(map.get('flowConfig.someFeature').defaultValue, false);
  assert.equal(map.get('flowConfig.legacy').deprecated, true);
  assert.deepEqual(map.get('flowConfig').aliases, ['*.FlowConfig']);
  assert.deepEqual(map.get('context').types, ['array']);
});

test('transport uses GET, disables redirects and respects failure status', async () => {
  const called = [];
  const http = new AssetClient(async (request, options) => {
    called.push({ request, options });
    return new Response('', { status: 302, headers: { Location: 'https://example.com/conf' } });
  });
  await assert.rejects(http.get(shared), /HTTP 302/);
  await assert.rejects(http.get('https://example.com/conf'), /permitted/);
  assert.equal(called.length, 1);
  assert.equal(called[0].options.method, 'GET');
  assert.equal(called[0].options.redirect, 'manual');
});

test('refresh revalidates shared configs, preserves stale data, and recovers to a new version', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hyperlens-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const csvPath = join(dir, 'clients.csv');
  await writeFile(csvPath, 'client_id,platform\n0012,android\nanother,ios');
  let version = 'next.7';
  let error = null;
  let missingCug = false;
  const calls = [];
  const cache = new DiskCache(join(dir, '.cache'));
  const options = { csvPath, cache, definitions: [], parallelism: 2, localMode: true, fetcher: async (request, init) => {
    calls.push({ request, auth: init.headers.get('If-None-Match') });
    if (request.includes('/bundles/')) {
      if (missingCug && request.endsWith('/cug/config.json')) return new Response('[]');
      const tag = `"mjos-${version}"`;
      if (init.headers.get('If-None-Match') === tag) return new Response(null, { status: 304 });
      return Response.json({ nested: [url('owner', version, 'v1-configuration.zip'), url('owner', version, 'v1-configuration.jsa')] },
        { headers: { ETag: tag } });
    }
    if (error === 'parse') return new Response('export default {');
    if (error === 'fetch') return new Response('', { status: 404 });
    const tag = `"config-${version}"`;
    if (init.headers.get('If-None-Match') === tag) return new Response(null, { status: 304 });
    return new Response(`module.exports = { enabled: ${version !== 'next.7'} }`, { headers: { ETag: tag } });
  }};
  const service = new RefreshService(options);
  await service.open();
  assert.equal(service.status().state, 'idle');
  assert.equal(service.start(), true);
  assert.equal(service.start(), false);
  await service.wait();
  const first = service.status();
  assert.equal(first.state, 'ready');
  assert.ok(first.lastSuccessfulRefresh);
  assert.equal(calls.filter(call => call.request.includes('/configs/')).length, 1);
  assert.equal(first.coverage.current, 4);
  assert.equal(service.index.search(query({ valueFilter: false })).counts.occurrences, 4);

  calls.length = 0;
  service.start();
  await service.wait();
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.auth));
  const validated = service.status();
  assert.equal(validated.state, 'ready');

  version = 'next.8';
  error = 'parse';
  service.start();
  await service.wait();
  const failed = service.status();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.coverage.stale, 4);
  assert.equal(failed.lastSuccessfulRefresh, validated.lastSuccessfulRefresh);
  const stale = service.index.search(query()).hits.map(hit => service.index.result(hit, true));
  assert.ok(stale.every(row => row.stale && row.version === 'next.7'));
  assert.equal(service.snapshot.failures[0].stage, 'parse');

  error = null;
  missingCug = true;
  service.start();
  await service.wait();
  assert.equal(service.status().state, 'partial');
  assert.equal(service.status().coverage.current, 2);
  assert.equal(service.status().coverage.stale, 2);

  missingCug = false;
  service.start();
  await service.wait();
  assert.equal(service.status().state, 'ready');
  assert.equal(service.index.search(query({ valueFilter: true })).counts.occurrences, 4);
  assert.equal(service.index.search(query({ valueFilter: false })).counts.occurrences, 0);
  const reopened = new RefreshService(options);
  await reopened.open();
  assert.equal(reopened.status().state, 'ready');
  assert.equal(reopened.index.search(query()).counts.occurrences, 4);

  error = 'fetch';
  version = 'next.9';
  await writeFile(csvPath, 'client_id,platform\nnew,web');
  reopened.start();
  await reopened.wait();
  assert.equal(reopened.status().coverage.unavailable, 2);
  assert.equal(reopened.index.search(query()).counts.occurrences, 0);
});
