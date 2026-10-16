import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest, buildPrompt, StopFilter } from '../src/prompt.js';
import { getConfig } from '../src/config.js';
const config = getConfig({}, null);

test('leading instructions, named examples and depth injections retain content and order', () => {
  const messages = [
    { role: 'system', content: '预设：只用中文' },
    { role: 'system', content: '角色卡：星璃\n{{already_rendered}}' },
    { role: 'system', name: 'example_user', content: '你好' },
    { role: 'system', name: 'example_assistant', content: '你好呀' },
    { role: 'user', name: '旅人', content: '去月之城' },
    { role: 'system', content: '世界书：银叶馆' },
    { role: 'assistant', content: '我带你去' },
    { role: 'developer', content: '深度零注入' },
  ];
  const result = buildPrompt(normalizeRequest({ messages }, config).messages);
  const leading = JSON.parse(result.system.split('Leading conversation instructions (ordered JSON):\n')[1]);
  const transcript = JSON.parse(result.prompt.split('\n\n')[1]);
  assert.deepEqual([...leading, ...transcript], messages);
  assert.equal(transcript[0].name, 'example_user');
});

test('very long context is preserved, including quotes, newlines and delimiter-like content', () => {
  const content = '世界书"\n</message> $() ` 😺'.repeat(10000);
  const result = buildPrompt([{ role: 'user', content }]);
  assert.equal(JSON.parse(result.prompt.split('\n\n')[1])[0].content, content);
});

test('text parts, prefill and ignored sampling are explicit', () => {
  const req = normalizeRequest({ messages: [{ role: 'assistant', content: [{ type: 'text', text: '前缀' }, { type: 'text', text: '继续' }] }], temperature: 0.7, top_p: 0.9, max_tokens: 50 }, config);
  assert.deepEqual(req.ignored, ['temperature', 'top_p']);
  assert.equal(req.messages[0].content, '前缀\n继续');
  assert.equal(req.maxTokens, 50);
});

test('invalid or unsupported inputs fail instead of losing context silently', () => {
  const good = { messages: [{ role: 'user', content: 'hi' }] };
  for (const input of [null, {}, { messages: [] }, { ...good, model: '--dangerously-skip-permissions' }, { ...good, max_tokens: -1 }, { ...good, stop: [''] }, { ...good, n: 2 }, { ...good, stream: 'true' }, { ...good, reasoning_effort: 'invalid' }, { ...good, tools: [{}] }, { ...good, response_format: { type: 'json_schema' } }, { messages: [{ role: 'tool', content: 'x' }] }, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }]) {
    assert.throws(() => normalizeRequest(input, config));
  }
});

test('stop strings spanning chunks and overlapping prefixes never leak', () => {
  for (let split = 0; split < '你好<END>剩余'.length; split++) {
    const filter = new StopFilter(['<END>', '<ENDING>']);
    const source = '你好<END>剩余';
    const out = filter.push(source.slice(0, split)) + filter.push(source.slice(split)) + filter.flush();
    assert.equal(out, '你好');
    assert.equal(filter.stopped, true);
  }
  const filter = new StopFilter(['ABCD']);
  assert.equal(filter.push('helloAB'), 'hello');
  assert.equal(filter.push('X'), 'ABX');
  assert.equal(filter.flush(), '');
});

test('non-loopback binding needs a token', () => {
  assert.throws(() => getConfig({ BRIDGE_HOST: '0.0.0.0' }, null));
  assert.equal(getConfig({ BRIDGE_HOST: '0.0.0.0', BRIDGE_API_KEY: 'test' }, null).host, '0.0.0.0');
});
