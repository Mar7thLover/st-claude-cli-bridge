import assert from 'node:assert/strict';
import { getConfig, loadEnv, localUrl } from '../src/config.js';

loadEnv();
const config = getConfig();
const response = await fetch(`${localUrl(config)}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
  body: JSON.stringify({ model: process.env.SMOKE_MODEL || config.defaultModel, ...(process.env.SMOKE_EFFORT ? { effort: process.env.SMOKE_EFFORT } : {}), stream: true, max_tokens: 256, stream_options: { include_usage: true }, messages: [
    { role: 'system', content: '角色卡：你叫星璃，是一名图书管理员。预设：用中文回复，只输出请求的内容，不加解释。' },
    { role: 'user', content: '记住，我叫旅人。' },
    { role: 'assistant', content: '记住了，旅人。' },
    { role: 'system', content: '世界书：月之城的图书馆名为银叶馆。当前作者注释：校验码是青鸟42。' },
    { role: 'user', content: '请只回复：你的名字|我的名字|图书馆名称|校验码' },
  ] }),
});
assert.equal(response.status, 200);
const raw = await response.text();
let content = '';
let usage;
for (const line of raw.split('\n')) {
  if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
  const event = JSON.parse(line.slice(6));
  assert.ok(!event.error, JSON.stringify(event.error));
  content += event.choices?.[0]?.delta?.content || '';
  if (event.usage) usage = event.usage;
}
for (const value of ['星璃', '旅人', '银叶馆', '青鸟42']) assert.ok(content.includes(value), `Missing ${value}: ${content}`);
assert.ok(raw.includes('data: [DONE]'));
assert.ok(usage?.total_tokens > 0);
console.log(`真实 Claude Code 流式对话通过：${content}`);
console.log(`Token usage: ${JSON.stringify(usage)}`);
