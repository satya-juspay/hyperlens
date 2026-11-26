import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import pg from 'pg';
import { PostgresCache } from '../dist/server/postgres.js';
import { emptyCoverage } from '../dist/shared/model.js';

const url = process.env.HYPERLENS_TEST_DATABASE_URL;

test('Postgres keeps snapshots atomic, round-trips multipart data, and deduplicates raw content', { skip: !url }, async t => {
  const namespace = 'hyperlens_test_' + randomUUID().replaceAll('-', '');
  const cache = new PostgresCache(url, namespace);
  const inspection = new pg.Pool({ connectionString: url });
  t.after(async () => {
    try { await cache.close(); }
    finally {
      try { await inspection.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); }
      finally { await inspection.end(); }
    }
  });
  const source = 'module.exports = { enabled: false };';
  const hash = createHash('sha256').update(source).digest('hex');
  const now = new Date().toISOString();
  const sample = {
    version: randomUUID(), lastSuccess: now, attempt: now, clients: ['001'],
    mjos: [], staleMjos: [], staleConfigs: [], coverage: emptyCoverage, failures: [], failed: false,
    configs: [{
      hash, url: 'https://assets.juspay.in/hyper/configs/example/in.juspay.hyperpay/1/configuration.js',
      fetchedAt: now, checkedAt: now, structuralWarnings: 0,
      tree: { type: 'object', entries: {
        enabled: { type: 'boolean', value: false },
        long: { type: 'string', value: 'x'.repeat(2 * 1024 * 1024) }
      }}
    }]
  };
  async function* raw() { yield { hash, compressed: gzipSync(source) }; }

  await cache.prepare();
  assert.equal(await cache.read(), undefined);
  assert.equal(await cache.importSnapshot(sample, raw()), true);
  assert.equal(await cache.importSnapshot(sample, raw()), false);
  const loaded = await cache.read();
  assert.equal(loaded.version, sample.version);
  assert.deepEqual(loaded.configs, sample.configs);
  assert.equal(loaded.clients[0], '001');

  await cache.putRaw(hash, source);
  const rawRows = await inspection.query(`SELECT compressed FROM "${namespace}".raw_config`);
  assert.equal(rawRows.rowCount, 1);
  assert.equal(gunzipSync(rawRows.rows[0].compressed).toString(), source);

  const candidates = [randomUUID(), randomUUID()].map(version => ({ ...sample, version }));
  const attempts = await Promise.allSettled(candidates.map(candidate => cache.write(candidate, sample.version)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = attempts.find(result => result.status === 'rejected');
  assert.match(rejected.reason.message, /updated by another process/);

  const active = await cache.read();
  assert.equal(active.version, candidates[attempts.findIndex(result => result.status === 'fulfilled')].version);
  const parts = await inspection.query(`SELECT DISTINCT version FROM "${namespace}".snapshot_part`);
  assert.deepEqual(parts.rows, [{ version: active.version }]);
  await assert.rejects(cache.importSnapshot(sample, raw()), /already has an active snapshot/);
  assert.equal((await cache.read()).version, active.version);
});
