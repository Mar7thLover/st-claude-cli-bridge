import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createBridge } from '../src/server.js';
import { getConfig } from '../src/config.js';
import { BridgeError } from '../src/prompt.js';

const baseRequest = { model: 'sonnet', messages: [{ role: 'user', content: '你好' }] };
const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
async function* fake() {
  yield { type: 'reasoning', text: '思考' };
  yield { type: 'text', text: '你' };
  yield { type: 'text', text: '好<END>不要显示' };
  yield { type: 'result', finishReason: 'stop', usage };
}
async function setup(t, options = {}, overrides = {}) {
  const server = createBridge({ ...getConfig({}, null), ...overrides }, { generate: fake, log: () => {}, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body = baseRequest, options = {}) => fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options });
  return { server, url, post };
}

test('model discovery, nonstream response, reasoning and usage', async t => {
  const { url, post } = await setup(t);
  const models = await fetch(`${url}/v1/models`).then(r => r.json());
  assert.ok(models.data.some(m => m.id === 'sonnet'));
  const res = await post({ ...baseRequest, temperature: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-claude-bridge-ignored-parameters'), 'temperature');
  const body = await res.json();
  assert.equal(body.choices[0].message.content, '你好<END>不要显示');
  assert.equal(body.choices[0].message.reasoning_content, '思考');
  assert.deepEqual(body.usage, usage);
});

test('SSE has deltas, finish reason, usage and DONE', async t => {
  const { post } = await setup(t);
  const res = await post({ ...baseRequest, stream: true, stream_options: { include_usage: true } });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const raw = await res.text();
  const events = raw.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
  assert.equal(events[0].choices[0].delta.role, 'assistant');
  assert.deepEqual(events.at(-1).usage, usage);
  assert.equal(events.at(-2).choices[0].finish_reason, 'stop');
  assert.ok(raw.endsWith('data: [DONE]\n\n'));
});

test('stop terminates upstream iteration without returning stop marker or fabricated usage', async t => {
  let cleaned = false;
  const { post } = await setup(t, { generate: async function* () {
    try { yield { type: 'text', text: '好<EN' }; yield { type: 'text', text: 'D>错' }; throw new Error('must not advance'); }
    finally { cleaned = true; }
  } });
  const body = await (await post({ ...baseRequest, stop: ['<END>'] })).json();
  assert.equal(body.choices[0].message.content, '好');
  assert.equal(body.bridge.usage_available, false);
  assert.ok(cleaned);
});

test('upstream errors appear as JSON or SSE errors, never normal completion', async t => {
  const { post } = await setup(t, { generate: async function* () { throw new BridgeError('Claude Code failed', 502, 'claude_error'); } });
  assert.equal((await post()).status, 502);
  const stream = await (await post({ ...baseRequest, stream: true })).text();
  assert.ok(stream.includes('"error"'));
  assert.ok(!stream.includes('"finish_reason":"stop"'));
});

test('authentication, origin, body size and invalid input checks', async t => {
  const { post, url } = await setup(t, {}, { apiKey: 'secret', maxBodyBytes: 1024 });
  assert.equal((await post()).status, 401);
  const headers = { 'content-type': 'application/json', authorization: 'Bearer secret' };
  assert.equal((await post(baseRequest, { headers })).status, 200);
  assert.equal((await post(baseRequest, { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await post({ messages: [{ role: 'user', content: 'a'.repeat(2000) }] }, { headers })).status, 413);
  assert.equal((await post({}, { headers })).status, 400);
  assert.equal((await post(baseRequest, { headers, body: '{bad' })).status, 400);
  assert.equal((await fetch(`${url}/health`)).status, 200);
});

test('configured origins, Retry-After, request logging and malformed Host headers', async t => {
  const logs = [];
  const { post, url, server } = await setup(t, { log: line => logs.push(line) }, { allowedOrigins: ['http://127.0.0.1:9100'], logRequests: false, maxConcurrent: 0, retryAfterSeconds: 9 });
  assert.equal((await fetch(`${url}/health`, { headers: { origin: 'http://127.0.0.1:9100' } })).headers.get('access-control-allow-origin'), 'http://127.0.0.1:9100');
  assert.equal((await fetch(`${url}/health`, { headers: { origin: 'http://127.0.0.1:8787' } })).status, 403);
  const busy = await post();
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '9');
  assert.deepEqual(logs, []);
  const status = await new Promise((resolve, reject) => {
    http.get({ port: server.address().port, host: '127.0.0.1', path: '/health', headers: { host: 'bad host' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('disconnect cancels generation, releases concurrency slot and leaves health responsive', async t => {
  let cancelled;
  const didCancel = new Promise(resolve => { cancelled = resolve; });
  const { post, url } = await setup(t, { generate: async function* (_request, _config, signal) {
    try {
      yield { type: 'text', text: '开始' };
      if (!signal.aborted) await once(signal, 'abort');
    } finally { cancelled(); }
  } }, { maxConcurrent: 1 });
  const abort = new AbortController();
  const response = await post({ ...baseRequest, stream: true }, { signal: abort.signal });
  const busy = await post();
  assert.equal(busy.status, 429);
  assert.equal((await fetch(`${url}/health`).then(r => r.json())).activeRequests, 1);
  await response.body.getReader().read();
  abort.abort();
  await didCancel;
  for (let i = 0; i < 50; i++) {
    if ((await fetch(`${url}/health`).then(r => r.json())).activeRequests === 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Slot was not released');
});
