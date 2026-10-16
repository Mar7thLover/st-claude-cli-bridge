import assert from 'node:assert/strict';
import { getConfig, loadEnv, localUrl } from '../src/config.js';
loadEnv();
const config = getConfig();
const headers = { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) };
const tests = [
  { model: 'sonnet', effort: 'low' },
  { model: 'sonnet', effort: 'none' },
  { model: 'opus', thinking: false },
  { model: 'haiku', thinking: { type: 'disabled' } },
  { model: 'fable', effort: 'low' },
];
let failures = 0;
for (const control of tests) {
  try {
  const response = await fetch(`${localUrl(config)}/v1/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify({ ...control, max_tokens: 1024, messages: [{ role: 'user', content: '请只回复：OK' }] }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.ok(result.choices?.[0]?.message?.content.includes('OK'), JSON.stringify(result));
  if (control.effort === 'none' || control.thinking === false || control.thinking?.type === 'disabled') {
    assert.ok(!result.choices[0].message.reasoning_content, 'Thinking should not be returned in off mode');
    assert.equal(result.usage?.completion_tokens_details?.reasoning_tokens ?? 0, 0);
  }
  console.log(`PASS ${JSON.stringify(control)} → ${result.choices[0].message.content.trim()}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${JSON.stringify(control)}: ${error.message}`);
  }
}
process.exitCode = failures ? 1 : 0;
for (const control of [{ model: 'fable', effort: 'off' }, { model: 'opus', effort: 'max', thinking: false }, { model: 'haiku', effort: 'high' }]) {
  const response = await fetch(`${localUrl(config)}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...control, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(response.status, 400);
  console.log(`PASS unsupported combination rejected: ${JSON.stringify(control)}`);
}
