import assert from 'node:assert/strict';
import { getConfig, loadEnv, localUrl } from '../src/config.js';
loadEnv();
const config = getConfig();
const headers = { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) };
// A trivial prompt never makes the model think, so thinking-off checks need a real reasoning task.
const reasoningPrompt = 'How many positive integers n <= 2000 have the property that n^2 + n + 41 is divisible by 43? Give only the final number.';
const tests = [
  { control: { model: 'sonnet', effort: 'low' }, prompt: '请只回复：OK', expect: 'OK' },
  { control: { model: 'haiku', effort: 'xhigh' }, prompt: '请只回复：OK', expect: 'OK' },
  { control: { model: 'opus', effort: 'low' }, prompt: '请只回复：OK', expect: 'OK' },
  { control: { model: 'fable', effort: 'low' }, prompt: '请只回复：OK', expect: 'OK' },
  { control: { model: 'claude-sonnet-5', effort: 'none' }, prompt: reasoningPrompt, expect: '93', off: true },
  { control: { model: 'claude-haiku-4-5-20251001', thinking: { type: 'disabled' } }, prompt: reasoningPrompt, expect: '93', off: true },
  { control: { model: 'claude-opus-5', effort: 'none' }, prompt: reasoningPrompt, expect: '93', off: true },
];
let failures = 0;
for (const { control, prompt, expect, off } of tests) {
  try {
    const response = await fetch(`${localUrl(config)}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ ...control, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(result.choices?.[0]?.message?.content.includes(expect), JSON.stringify(result));
    if (off) {
      assert.ok(!result.choices[0].message.reasoning_content, 'Thinking should not be returned in off mode');
      assert.equal(result.usage?.completion_tokens_details?.reasoning_tokens ?? 0, 0, 'Reasoning tokens should be 0 in off mode');
    }
    console.log(`PASS ${JSON.stringify(control)} → ${result.choices[0].message.content.trim().slice(0, 40)}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${JSON.stringify(control)}: ${error.message}`);
  }
}
for (const control of [
  { model: 'fable', effort: 'off' },
  { model: 'opus', thinking: false },
  { model: 'claude-opus-5', effort: 'high', thinking: false },
  { model: 'sonnet', thinking: false },
  { model: 'haiku', effort: 'none' },
  { model: 'haiku', max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 } },
]) {
  const response = await fetch(`${localUrl(config)}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...control, messages: [{ role: 'user', content: 'hi' }] }) });
  if (response.status === 400) console.log(`PASS unsupported combination rejected: ${JSON.stringify(control)}`);
  else { failures++; console.error(`FAIL expected 400 for ${JSON.stringify(control)}, got ${response.status}`); }
}
process.exitCode = failures ? 1 : 0;
