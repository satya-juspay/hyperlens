import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parse } from 'csv-parse/sync';
import { createHostedHandler } from '../dist/server/hosted/api.js';
import { HostedStore } from '../dist/server/hosted/store.js';
import { ConfigurationIndex } from '../dist/server/index.js';
import { ingestSnapshot } from '../dist/server/refresh.js';
import { searchParams } from '../dist/server/search-params.js';

const connection = process.env.HYPERLENS_TEST_DATABASE_URL;
const csv = 'client_id,platform\n0012,android\n0012,ios\nother,web';
const base = 'https://assets.juspay.in';
const configUrl = base + '/hyper/configs/group/in.juspay.hyperpay/';
const definitions = [
  { key: 'flowConfig', path: 'flowConfig', types: ['object'], source: 'repository', category: 'Flow', aliases: ['*.FlowConfig'] },
  { key: 'defaultOnly', path: 'flowConfig.defaultOnly', types: ['boolean'], defaultValue: true, source: 'repository', category: 'Flow' }
];

test('Vercel entry point allows access with login unset and prompts when credentials are set', async t => {
  const names = ['DATABASE_URL', 'HYPERLENS_AUTH', 'HYPERLENS_CONCURRENCY'];
  const original = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => {
    if (original[index] === undefined) delete process.env[name];
    else process.env[name] = original[index];
  }));
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
  delete process.env.HYPERLENS_AUTH;
  delete process.env.HYPERLENS_CONCURRENCY;
  const address = 'https://preview.example.com/api/handler?__hl_endpoint=home';
  const { default: open } = await import('../dist/api/handler.js?access=open');
  const page = await open.fetch(new Request(address));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('WWW-Authenticate'), null);
  assert.match(await page.text(), /<title>HyperLens/);

  process.env.HYPERLENS_AUTH = 'tester:test-password';
  const { default: locked } = await import('../dist/api/handler.js?access=locked');
  const denied = await locked.fetch(new Request(address));
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('WWW-Authenticate'), /^Basic /);
  const authorization = 'Basic ' + Buffer.from(process.env.HYPERLENS_AUTH).toString('base64');
  assert.equal((await locked.fetch(new Request(address, { headers: { Authorization: authorization } }))).status, 200);
});

test('hosted API serves versioned SQL search, details and CSV, and coordinates refreshes across handlers', { skip: !connection }, async t => {
  const schema = 'hyperlens_host_' + randomUUID().replaceAll('-', '');
  const store = new HostedStore(connection, schema);
  const other = new HostedStore(connection, schema);
  t.after(async () => {
    try { await store.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await Promise.all([store.cache.close(), other.cache.close()]); }
  });
  let revision = 1;
  let waitForFetch = Promise.resolve();
  const fetcher = async url => {
    await waitForFetch;
    if (url.endsWith('/config.json')) {
      return Response.json({ nested: [
        configUrl + revision + '/configuration.js', configUrl + revision + '/v1-configuration.zip',
        ...(url.includes('/other/') ? [configUrl + 'extra/configuration.js'] : [])
      ] });
    }
    return new Response(`window.getMerchantConfig = function() {
      const configuration = { mainConfig: {
        flowConfig: { checkout: { enabled: ${url.includes('/extra/') ? '"true"' : revision === 2}, retry: 0 }, nullValue: null },
        screenConfig: { cards: [{ "a.b": [false] }], "legacy.name": true },
        preset: {"#override": ["screenConfig", {"a.b": false}]}, expression: {"#ref": ["screen"]},
        plain: { n: 2, list: [true, null] }, unresolved: runtime()
      }};
      return JSON.stringify(configuration);
    }`);
  };

  await store.prepare();
  const snapshot = await ingestSnapshot({
    csv, cache: store.cache, parallelism: 4, onProgress() {}, attempt: new Date().toISOString(), fetcher
  });
  await store.cache.write(snapshot);
  await store.seed({ csv, definitions, notes: ['Test repository catalog'] });
  const memory = new ConfigurationIndex(snapshot.configs, snapshot.mjos, snapshot.clients, definitions, new Set(), new Set());
  await memory.build();
  const tasks = [];
  const options = {
    auth: 'tester:test-password', html: async () => '<title>HyperLens</title>', parallelism: 4, fetcher,
    schedule: task => { tasks.push(task); }
  };
  const handler = createHostedHandler(store, options);
  const independent = createHostedHandler(other, options);
  const request = (path, init = {}, authenticate = true) => new Request('https://preview.example.com' + path, {
    ...init, headers: { ...(authenticate && { Authorization: 'Basic ' + Buffer.from(options.auth).toString('base64') }), ...init.headers }
  });
  assert.equal((await handler(request('/', {}, false))).status, 401);
  assert.match(await (await handler(request('/api/handler?__hl_endpoint=home'))).text(), /HyperLens/);
  const status = await (await handler(request('/api/status'))).json();
  assert.equal(status.state, 'ready');
  assert.equal(status.coverage.current, 6);
  assert.equal(status.indexVersion, snapshot.version);
  assert.equal(status.coverage.unresolved, memory.unresolved);
  const health = await (await handler(request('/api/health'))).json();
  assert.deepEqual(health.catalogNotes, ['Test repository catalog']);
  assert.deepEqual((await (await handler(request('/api/clients'))).json()).clients, ['0012', 'other']);

  const queries = [
    'q=enabled&value=false', 'q=enabled&value=%22true%22', 'q=flowConfig.checkout.enabled&mode=exact-path',
    'q=*.FlowConfig&mode=exact-path', 'q=screenConfig.cards%5B0%5D%5B%22a.b%22%5D%5B0%5D&mode=exact-path',
    'q=preset.a.b&mode=exact-path', 'q=screenConfig.legacy.name&mode=exact-path', 'q=flowConfig.defaultOnly&mode=exact-path',
    'q=PLAIN&mode=partial&value=%7B%22list%22%3A%5Btrue%2Cnull%5D%2C%22n%22%3A2%7D',
    'q=enabled&platform=android&environment=cug&clientId=0012&includeValues=false',
    'q=enabled&sort=hyperpayConfigUrl&direction=desc&page=2&pageSize=2', 'q=expression'
  ];
  for (const text of queries) {
    const requestQuery = searchParams(new URLSearchParams(text));
    const expected = memory.search(requestQuery);
    const expectedPage = Math.min(requestQuery.page, Math.max(1, Math.ceil(expected.hits.length / requestQuery.pageSize)));
    const offset = (expectedPage - 1) * requestQuery.pageSize;
    const response = await handler(request('/api/handler?__hl_endpoint=search&' + text));
    assert.equal(response.status, 200, text);
    const actual = await response.json();
    assert.deepEqual(actual.counts, expected.counts, text);
    assert.equal(actual.page, expectedPage, text);
    assert.deepEqual(actual.results, expected.hits.slice(offset, offset + requestQuery.pageSize)
      .map(hit => memory.result(hit, requestQuery.includeValues)), text);
  }
  assert.equal((await handler(request('/api/search?q=not..valid&mode=exact-path'))).status, 400);

  const results = await (await handler(request('/api/search?q=expression'))).json();
  const expectedDetail = memory.detail(results.results[0].id);
  const row = await (await handler(request('/api/handler?__hl_endpoint=result&__hl_id=' + results.results[0].id))).json();
  assert.deepEqual(row, expectedDetail);
  const suggestions = await (await handler(request('/api/configurations/suggestions?q=*.FlowConfig'))).json();
  assert.equal(suggestions.entries[0].path, 'flowConfig');
  assert.equal(suggestions.entries[0].source, 'both');
  const exported = await handler(request('/api/search.csv?q=enabled&value=false'));
  assert.equal(exported.status, 200);
  const csvText = await exported.text();
  assert.equal(parse(csvText).length, 7);
  assert.match(csvText, /"false"/);

  const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  assert.equal((await handler(request('/api/refresh', { ...post, headers: { ...post.headers, Origin: 'https://foreign.example' } }))).status, 403);
  revision = 2;
  let allow;
  waitForFetch = new Promise(resolve => { allow = resolve; });
  try {
    assert.equal((await handler(request('/api/refresh', post))).status, 202);
    assert.equal((await independent(request('/api/refresh', post))).status, 409);
    const during = await (await independent(request('/api/status'))).json();
    assert.equal(during.state, 'refreshing');
    assert.equal(during.indexVersion, snapshot.version);
    const previous = await (await independent(request('/api/search?q=enabled&value=false'))).json();
    assert.ok(previous.counts.occurrences > 0);
  } finally { allow(); }
  assert.equal(tasks.length, 1);
  await tasks[0];
  const refreshed = await (await independent(request('/api/status'))).json();
  assert.equal(refreshed.state, 'ready');
  assert.notEqual(refreshed.indexVersion, snapshot.version);
  assert.equal((await (await independent(request('/api/search?q=enabled&value=false'))).json()).counts.occurrences, 0);
  assert.equal((await store.cache.read()).version, refreshed.indexVersion);

  const interrupted = await store.claim();
  await store.pool.query(`UPDATE "${schema}".web_state SET job_expires = now() - interval '1 second' WHERE job_id = $1`, [interrupted.id]);
  const expired = await (await independent(request('/api/status'))).json();
  assert.equal(expired.state, 'failed');
  assert.equal(expired.indexVersion, refreshed.indexVersion);
  assert.notEqual((await other.claim()).id, interrupted.id);
});
