import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest } from '../src/prompt.js';
import { getConfig } from '../src/config.js';
import { buildModelCatalog, capabilitiesFor, validModel } from '../src/models.js';
import { thinkingEnvironment } from '../src/thinking.js';
const rows = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
];
const catalog = buildModelCatalog(rows, ['custom-model']);
const config = { ...getConfig({}, null), modelCatalog: catalog, models: catalog.map(m => m.id) };
const request = (patch = {}) => normalizeRequest({ model: 'sonnet', messages: [{ role: 'user', content: 'hi' }], ...patch }, config);

test('discovers menu entries, resolved IDs and aliases with per-model capabilities', () => {
  assert.ok(catalog.some(m => m.id === 'claude-opus-5[1m]'));
  assert.equal(catalog.find(m => m.id === 'default').resolvedModel, 'claude-opus-5[1m]');
  assert.equal(catalog.find(m => m.id === 'best').canDisableThinking, false);
  assert.equal(catalog.find(m => m.id === 'haiku').supportsEffort, false);
  assert.equal(catalog.find(m => m.id === 'custom-model').source, 'configured');
  assert.equal(catalog.find(m => m.id === 'custom-model').canDisableThinking, false);
  assert.equal(new Set(catalog.map(m => m.id)).size, catalog.length);
  assert.equal(capabilitiesFor('claude-sonnet-5', 'bedrock').canDisableThinking, false);
  assert.ok(validModel('sonnet[1m]'));
  for (const value of ['sonnet[2m]', '--effort', 'sonnet;whoami', 'x\n']) assert.ok(!validModel(value));
  assert.deepEqual(capabilitiesFor('claude-opus-4-6').effortLevels, ['low', 'medium', 'high', 'max']);
});

test('effort and reasoning_effort accept every supported level and detect conflicts', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(request({ effort }).effort, effort);
    assert.equal(request({ reasoning_effort: effort }).effort, effort);
    assert.equal(request({ effort, reasoning_effort: effort }).effort, effort);
  }
  assert.equal(request({ effort: 'auto' }).effort, undefined);
  assert.throws(() => request({ effort: 'low', reasoning_effort: 'high' }), /conflict/);
  assert.throws(() => request({ effort: 1 }), /effort must/);
  assert.throws(() => request({ model: 'haiku', effort: 'high' }), /not supported/);
});

test('thinking can be disabled only where it actually works through Claude Code', () => {
  for (const patch of [{ effort: 'none' }, { effort: 'off' }, { reasoning_effort: 'none' }, { thinking: false }, { thinking: { type: 'disabled' } }, { thinking: { enabled: false } }]) {
    assert.equal(request(patch).thinking, 'disabled');
    assert.equal(request({ ...patch, model: 'haiku' }).thinking, 'disabled');
    assert.throws(() => request({ ...patch, model: 'fable' }), /requires thinking/);
  }
  assert.throws(() => request({ effort: 'off', thinking: true }), /conflict/);
  assert.throws(() => request({ thinking: { enabled: true, type: 'disabled' } }), /conflict/);
  // Opus 5 can turn thinking off in the CLI, but upstream safeguards reject it under the bridge prompt.
  for (const model of ['opus', 'default', 'claude-opus-5[1m]']) {
    assert.equal(request({ model, effort: 'high' }).effort, 'high');
    assert.throws(() => request({ model, effort: 'high', thinking: false }), /safeguards/);
  }
  assert.throws(() => request({ model: 'custom-model', thinking: false }), /not been verified/);
});

test('fixed Haiku budget is validated instead of being treated as an effort level', () => {
  assert.equal(request({ model: 'haiku', thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: 4096 }).thinkingBudget, 2048);
  for (const thinking of [{ budget_tokens: 5 }, { budget_tokens: 2048, type: 'disabled' }, { type: 'adaptive' }, { type: 'enabled', typo: true }]) assert.throws(() => request({ model: 'haiku', thinking }));
  assert.throws(() => request({ model: 'haiku', thinking: { budget_tokens: 2048 }, max_tokens: 1024 }), /less than/);
  assert.throws(() => request({ thinking: { budget_tokens: 2048 } }), /non-adaptive/);
});

test('request controls override inherited thinking env without mutating it', () => {
  const parent = { CLAUDE_CODE_EFFORT_LEVEL: 'max', MAX_THINKING_TOKENS: '99', CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1' };
  const off = thinkingEnvironment(request({ effort: 'off' }), parent);
  assert.equal(off.MAX_THINKING_TOKENS, '0');
  assert.equal(off.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  const low = thinkingEnvironment(request({ effort: 'low' }), parent);
  assert.equal(low.MAX_THINKING_TOKENS, undefined);
  assert.equal(low.CLAUDE_CODE_EFFORT_LEVEL, 'low');
  assert.equal(low.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING, undefined);
  assert.equal(thinkingEnvironment(request({ effort: 'auto' }), parent).CLAUDE_CODE_EFFORT_LEVEL, 'auto');
  assert.equal(parent.MAX_THINKING_TOKENS, '99');
});

test('catalog exposes full effort levels, model-specific off switch and Haiku budgets', () => {
  const caps = id => catalog.find(m => m.id === id);
  assert.deepEqual(caps('sonnet').effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(caps('sonnet').canDisableThinking, true);
  assert.equal(caps('fable').canDisableThinking, false);
  assert.equal(caps('haiku').supportsThinking, true);
  assert.deepEqual(caps('haiku').effortLevels, []);
  assert.equal(caps('claude-opus-5[1m]').maxContext, 1000000);
});

test('Opus 5.5 keeps thinking on at every effort; Opus 5 thinking-off is not offered', () => {
  const opus55 = buildModelCatalog([
    { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ]);
  const cfg = { ...getConfig({}, null), modelCatalog: opus55, models: opus55.map(m => m.id) };
  assert.equal(opus55.find(m => m.id === 'opus').resolvedModel, 'claude-opus-5-5');
  assert.equal(opus55.find(m => m.id === 'claude-opus-5').lifecycle, 'active');
  for (const model of ['opus', 'default', 'claude-opus-5-5']) {
    assert.equal(normalizeRequest({ model, effort: 'low', messages: [{ role: 'user', content: 'hi' }] }, cfg).effort, 'low');
    assert.throws(() => normalizeRequest({ model, effort: 'low', thinking: false, messages: [{ role: 'user', content: 'hi' }] }, cfg), /requires thinking/);
  }
  assert.equal(capabilitiesFor('claude-opus-5-5').maxContext, 1000000);
  assert.deepEqual(capabilitiesFor('claude-opus-5-5').thinkingOffUnavailableAt, []);
  assert.equal(capabilitiesFor('claude-opus-5').canDisableThinking, false);
  // Opus 5 is only reliable through the bridge with an explicit effort.
  const opus5 = { ...getConfig({}, null), modelCatalog: buildModelCatalog(), models: [] };
  const opus5Request = patch => normalizeRequest({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], ...patch }, opus5);
  assert.equal(opus5Request({}).effort, 'high');
  assert.equal(opus5Request({ effort: 'auto' }).effort, 'high');
  assert.equal(opus5Request({ effort: 'low' }).effort, 'low');
  assert.equal(normalizeRequest({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] }, opus5).effort, undefined);
});

test('Sonnet 5.5 and Haiku 5.5 match the live CLI menu and measured thinking behaviour', () => {
  const menu = ['sonnet', 'haiku'].map(value => ({ value, resolvedModel: `claude-${value}-5-5`, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true }));
  const catalog55 = buildModelCatalog(menu);
  const cfg = { ...getConfig({}, null), modelCatalog: catalog55, models: catalog55.map(m => m.id) };
  const send = patch => normalizeRequest({ messages: [{ role: 'user', content: 'hi' }], ...patch }, cfg);
  for (const model of ['sonnet', 'haiku', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    const caps = catalog55.find(m => m.id === model);
    assert.deepEqual(caps.effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(caps.maxContext, 1000000);
    assert.equal(caps.canDisableThinking, false);
    assert.equal(send({ model, effort: 'xhigh' }).effort, 'xhigh');
    assert.throws(() => send({ model, effort: 'low', thinking: false }), /does not turn thinking off/);
    // Manual budgets are rejected by the API from the 4.6 generation on.
    assert.throws(() => send({ model, max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 } }), /Fixed thinking budget/);
  }
  // Older models still turn thinking off for real.
  for (const id of ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8']) assert.equal(capabilitiesFor(id).canDisableThinking, true);
});
