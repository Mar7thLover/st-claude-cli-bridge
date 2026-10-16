import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { buildModelCatalog, applyModelChecks } from '../src/models.js';
import { HISTORICAL_MODELS, RETIRED_MODELS } from '../src/model-history.js';
import { getConfig } from '../src/config.js';
import { createBridge } from '../src/server.js';

test('latest menu is supplemented with active historical IDs without advertising retired models', () => {
  const menu = [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }];
  const catalog = buildModelCatalog(menu, ['claude-opus-4-6']);
  for (const model of HISTORICAL_MODELS) {
    assert.equal(catalog.filter(row => row.id === model.id).length, 1);
    assert.equal(catalog.find(row => row.id === model.id).lifecycle, 'active');
  }
  for (const retired of RETIRED_MODELS) assert.ok(!catalog.some(row => row.id === retired.id));
  const all = buildModelCatalog(menu, [], 'firstParty', { includeRetired: true });
  for (const retired of RETIRED_MODELS) assert.equal(all.find(row => row.id === retired.id).availability, 'retired');
  const thirdParty = buildModelCatalog(menu, [], 'bedrock');
  assert.ok(!thirdParty.some(row => row.source === 'historical-catalog'));
});

test('a successful check must be recent and from the same provider; failures stay distinct from retirement', () => {
  const now = Date.parse('2026-09-17T04:00:00Z');
  const checks = [
    { model: 'claude-opus-4-8', checkedAt: new Date(now - 1000).toISOString(), status: 'verified', actualModel: 'claude-opus-4-8' },
    { model: 'claude-opus-4-7', checkedAt: new Date(now - 1000).toISOString(), status: 'failed', errorCode: 'content_filter' },
    { model: 'claude-opus-4-6', checkedAt: new Date(now - 86400001).toISOString(), status: 'verified' },
    { model: 'claude-fable-5', checkedAt: new Date(now + 1000).toISOString(), status: 'verified' },
  ];
  const catalog = buildModelCatalog();
  applyModelChecks(catalog, { provider: 'bedrock', checks }, 'firstParty', now);
  assert.ok(catalog.every(row => row.availability === 'unverified'));
  applyModelChecks(catalog, { provider: 'firstParty', checks }, 'firstParty', now);
  assert.equal(catalog.find(row => row.id === 'claude-opus-4-8').availability, 'verified');
  assert.equal(catalog.find(row => row.id === 'claude-opus-4-7').availability, 'failed');
  assert.equal(catalog.find(row => row.id === 'claude-opus-4-7').lifecycle, 'active');
  assert.equal(catalog.find(row => row.id === 'claude-opus-4-6').availability, 'unverified');
  assert.equal(catalog.find(row => row.id === 'claude-fable-5').availability, 'unverified');
});

test('historical model capabilities stay model specific', () => {
  const modelCatalog = buildModelCatalog();
  const caps = id => modelCatalog.find(row => row.id === id);
  assert.deepEqual(caps('claude-opus-4-8').effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(caps('claude-opus-4-6').effortLevels, ['low', 'medium', 'high', 'max']);
  for (const id of ['claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101']) {
    assert.equal(caps(id).supportsEffort, false);
    assert.equal(caps(id).supportsThinking, true);
  }
  assert.equal(caps('claude-fable-5').canDisableThinking, false);
});

test('models endpoint shows historical status and only includes retired IDs on explicit request', async t => {
  const modelCatalog = buildModelCatalog();
  const config = { ...getConfig({}, null), apiProvider: 'firstParty', modelCatalog, models: modelCatalog.map(row => row.id) };
  const server = createBridge(config, { log: () => {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}/v1/models`;
  const ordinary = await fetch(url).then(r => r.json());
  assert.ok(ordinary.data.find(row => row.id === 'claude-opus-4-6').name.includes('未验证'));
  assert.ok(!ordinary.data.some(row => row.lifecycle === 'retired'));
  const all = await fetch(`${url}?include_retired=1`).then(r => r.json());
  const retired = all.data.find(row => row.id === 'claude-opus-4-1-20250805');
  assert.equal(retired.retired_at, '2026-08-05');
  assert.equal(retired.availability, 'retired');
  assert.ok(retired.name.includes('已停用'));
});
