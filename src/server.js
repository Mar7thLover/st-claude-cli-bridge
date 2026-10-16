import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BridgeError, normalizeRequest, StopFilter } from './prompt.js';
import { runClaude } from './claude.js';
import { modelInfo } from './models.js';
import { RETIRED_MODELS } from './model-history.js';

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let chunks = [];
    let failed = false;
    req.on('data', chunk => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > limit) {
        failed = true; chunks = [];
        reject(new BridgeError('Request body is too large', 413, 'request_too_large'));
      } else chunks.push(chunk);
    });
    req.once('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new BridgeError('Invalid JSON request body')); }
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new BridgeError('Request cancelled', 499, 'cancelled')));
  });
}

function authorized(req, key) {
  if (!key) return true;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function write(res, value) {
  if (res.destroyed) throw new BridgeError('Client disconnected', 499, 'cancelled');
  if (res.write(value)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', drained); res.off('close', closed); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new BridgeError('Client disconnected', 499, 'cancelled')); };
    res.once('drain', drained); res.once('close', closed);
  });
}

export function createBridge(config, { generate = runClaude, log = console.log } = {}) {
  const active = new Set();
  const server = http.createServer(async (req, res) => {
    const id = `chatcmpl-${randomUUID()}`;
    const started = Date.now();
    let controller;
    let heartbeat;
    let request;
    let outcome = 'ok';
    res.setHeader('x-request-id', id);
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!config.apiKey) {
        // Without a key, only loopback Host headers are accepted (DNS rebinding guard).
        const host = URL.canParse(`http://${req.headers.host || ''}`) ? new URL(`http://${req.headers.host}`).hostname : '';
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new BridgeError('Invalid Host header', 403, 'forbidden');
      }
      const origin = req.headers.origin;
      if (origin) {
        if (!config.allowedOrigins.includes(origin)) throw new BridgeError('Browser origin is not allowed; add it to server.allowedOrigins or forward requests server-side', 403, 'forbidden');
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'Origin');
        res.setHeader('access-control-allow-headers', 'content-type, authorization');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true, name: 'claude-cli-bridge', activeRequests: active.size, maxConcurrent: config.maxConcurrent });
        return;
      }
      if (!authorized(req, config.apiKey)) throw new BridgeError('Invalid bridge API key', 401, 'authentication_error');
      if (req.method === 'GET' && url.pathname === '/') {
        json(res, 200, { name: 'ClaudeBridge', baseUrl: '/v1', provider: 'openai-chat', health: '/health', contextMode: 'ordered-transcript', textOnly: true, unsupportedSampling: ['temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed'] });
        return;
      }
      if (req.method === 'GET' && ['/v1/models', '/models'].includes(url.pathname)) {
        const models = [...config.models];
        if (url.searchParams.get('include_retired') === '1' && config.apiProvider === 'firstParty') {
          for (const row of RETIRED_MODELS) if (!models.includes(row.id)) models.push(row.id);
        }
        json(res, 200, { object: 'list', discovered_at: config.modelsDiscoveredAt || null, data: models.map(model => {
          const info = modelInfo(model, config);
          const labels = { verified: '已验证', failed: '最近验证失败', 'model-mismatch': '模型发生替换', retired: '已停用', unverified: '未验证' };
          const label = info.source === 'historical-catalog' || info.lifecycle === 'retired' ? ` [${labels[info.availability] || '未验证'}]` : '';
          return { id: model, object: 'model', created: 0, owned_by: 'local-claude-code', name: `Claude Code · ${info.name}${label}`, context_length: info.maxContext,
            lifecycle: info.lifecycle || 'unknown', availability: info.availability, verified_at: info.verifiedAt || null, actual_model: info.actualModel || null, retired_at: info.retiredAt || null,
            resolved_model: info.resolvedModel, source: info.source, supports_effort: info.supportsEffort, effort_levels: info.effortLevels,
            can_disable_thinking: info.canDisableThinking, thinking_off_unavailable_at: info.thinkingOffUnavailableAt, thinking_off_reason: info.thinkingOffReason };
        }) });
        return;
      }
      if (req.method !== 'POST' || !['/v1/chat/completions', '/chat/completions'].includes(url.pathname)) throw new BridgeError('Route not found', 404, 'not_found');
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new BridgeError('Content-Type must be application/json', 415);
      if (active.size >= config.maxConcurrent) { res.setHeader('retry-after', String(config.retryAfterSeconds)); throw new BridgeError('All Claude Code slots are busy; retry shortly', 429, 'rate_limit_error'); }
      // Reserve before reading the body so simultaneous uploads cannot oversubscribe.
      controller = new AbortController();
      active.add(controller);
      res.once('close', () => controller.abort());
      const body = await readBody(req, config.maxBodyBytes);
      request = normalizeRequest(body, config);
      if (controller.signal.aborted) throw new BridgeError('Client disconnected', 499, 'cancelled');
      if (request.ignored.length) res.setHeader('x-claude-bridge-ignored-parameters', request.ignored.join(','));
      res.setHeader('x-claude-bridge-context-mode', 'ordered-transcript');
      const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model };
      const chunk = (delta, finish = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
      const send = value => write(res, `data: ${JSON.stringify(value)}\n\n`);
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        await send(chunk({ role: 'assistant', content: '' }));
        heartbeat = setInterval(() => { if (!res.destroyed && res.writableLength === 0) res.write(': keep-alive\n\n'); }, config.heartbeatMs);
        heartbeat.unref();
      }
      let text = '';
      let reasoning = '';
      let usage;
      let actualModel;
      let finish = 'stop';
      let completed = false;
      const filter = new StopFilter(request.stop);
      const emitText = async value => {
        if (!value) return;
        text += value;
        if (request.stream) await send(chunk({ content: value }));
      };
      for await (const event of generate(request, config, controller.signal)) {
        if (controller.signal.aborted) throw new BridgeError('Request cancelled', 499, 'cancelled');
        if (event.type === 'text') {
          await emitText(filter.push(event.text));
          if (filter.stopped) { completed = true; break; }
        } else if (event.type === 'reasoning') {
          reasoning += event.text;
          if (request.stream) await send(chunk({ reasoning_content: event.text }));
        } else if (event.type === 'result') {
          usage = event.usage; actualModel = event.actualModel; finish = event.finishReason; completed = true;
        }
      }
      if (!completed) throw new BridgeError('Claude Code stream ended before completion', 502, 'incomplete_stream');
      await emitText(filter.flush());
      if (request.stream) {
        await send(chunk({}, finish));
        if (request.includeUsage && usage) await send({ ...base, choices: [], usage });
        await write(res, 'data: [DONE]\n\n');
        res.end();
      } else {
        json(res, 200, {
          ...base, object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finish }],
          ...(usage ? { usage } : {}),
          bridge: { context_mode: 'ordered-transcript', ignored_parameters: request.ignored, usage_available: Boolean(usage), actual_model: actualModel || null },
        });
      }
    } catch (error) {
      outcome = error.code || 'internal_error';
      const known = error instanceof BridgeError;
      const payload = { error: { message: known ? error.message : 'Internal bridge error', type: known ? error.code : 'internal_error', code: known ? error.code : 'internal_error' } };
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
        else json(res, known ? error.status : 500, payload);
      }
    } finally {
      clearInterval(heartbeat);
      if (controller) {
        controller.abort(); active.delete(controller);
        if (config.logRequests) log(JSON.stringify({ requestId: id, model: request?.model, stream: request?.stream, outcome, durationMs: Date.now() - started }));
      }
    }
  });
  server.shutdown = async () => {
    for (const controller of active) controller.abort();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    // close() only waits for HTTP sockets; allow subprocess cleanup to finish too.
    while (active.size) await new Promise(resolve => setTimeout(resolve, 20));
  };
  return server;
}
