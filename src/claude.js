import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { BridgeError, buildPrompt } from './prompt.js';
import { thinkingEnvironment } from './thinking.js';

export function toUsage(raw = {}) {
  const cached = raw.cache_read_input_tokens || 0;
  const prompt = (raw.input_tokens || 0) + cached + (raw.cache_creation_input_tokens || 0);
  const completion = raw.output_tokens || 0;
  return {
    prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
    ...(raw.output_tokens_details?.thinking_tokens !== undefined ? { completion_tokens_details: { reasoning_tokens: raw.output_tokens_details.thinking_tokens } } : {}),
  };
}

export async function* runClaude(request, config, signal, { spawnProcess = spawn } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'claudebridge-'));
  let child;
  let lines;
  let closed;
  let onAbort;
  try {
    const { system, prompt } = buildPrompt(request.messages);
    const systemFile = path.join(dir, 'system.txt');
    await writeFile(systemFile, system, { encoding: 'utf8', mode: 0o600 });
    if (signal.aborted) throw new BridgeError('Request cancelled', 499, 'cancelled');
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--safe-mode', '--disable-slash-commands', '--tools', '', '--strict-mcp-config',
      '--no-session-persistence', '--permission-mode', 'dontAsk', '--no-chrome',
      '--system-prompt-file', systemFile, '--model', request.model,
    ];
    if (request.effort) args.push('--effort', request.effort);
    if (request.thinking && request.thinking !== 'disabled') args.push('--settings', JSON.stringify({ alwaysThinkingEnabled: true }));
    // Claude 5 models omit thinking text unless a display mode is requested explicitly.
    if (request.thinkingDisplay) args.push('--thinking-display', request.thinkingDisplay);
    const env = thinkingEnvironment(request, { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    delete env.CLAUDECODE;
    if (request.maxTokens !== undefined) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(request.maxTokens);
    child = spawnProcess(config.claudeBin, args, { cwd: dir, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    // EPIPE is expected if authentication/startup fails before consuming stdin.
    child.stdin.on('error', () => {});
    closed = new Promise(resolve => child.once('close', (code, exitSignal) => resolve({ code, exitSignal })));
    const terminate = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
    onAbort = terminate;
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) terminate();
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stdin.end(prompt, 'utf8');
    let result;
    let actualModel;
    let sawTextDelta = false;
    let sawThinkingDelta = false;
    let sawAssistantText = false;
    let finishReason = 'stop';
    for await (const line of lines) {
      if (!line.trim()) continue;
      let item;
      try { item = JSON.parse(line); } catch { throw new BridgeError('Claude Code returned invalid stream JSON', 502, 'invalid_cli_output'); }
      if (item.parent_tool_use_id) continue;
      if (item.type === 'stream_event') {
        const event = item.event;
        if (event?.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta') {
            sawTextDelta = true;
            yield { type: 'text', text: event.delta.text };
          } else if (event.delta?.type === 'thinking_delta') {
            sawThinkingDelta = true;
            // Omitted thinking streams empty deltas; forwarding them shows an empty placeholder.
            if (event.delta.thinking) yield { type: 'reasoning', text: event.delta.thinking };
          }
        } else if (event?.type === 'message_delta' && event.delta?.stop_reason === 'max_tokens') finishReason = 'length';
      } else if (item.type === 'assistant') {
        if (typeof item.message?.model === 'string') actualModel = item.message.model;
        if (item.error) {
          const detail = (item.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
          if (/safeguards flagged|content.filter|reasoning_extraction/i.test(detail)) {
            throw new BridgeError('The model provider rejected this prompt under its content policy; generation was not completed', 400, 'content_filter');
          }
          throw new BridgeError('Claude Code rejected the request; check login, quota and model availability with npm run doctor', 502, 'claude_error');
        }
        for (const block of item.message?.content || []) {
          if (block.type === 'text' && !sawTextDelta) {
            sawAssistantText = true;
            yield { type: 'text', text: block.text };
          } else if (block.type === 'thinking' && block.thinking && !sawThinkingDelta) yield { type: 'reasoning', text: block.thinking };
        }
      } else if (item.type === 'result') {
        result = item;
        if (item.is_error || item.subtype !== 'success') {
          const status = item.api_error_status;
          throw new BridgeError('Claude Code generation failed; check login, quota, model and context length with npm run doctor', status === 429 ? 429 : 502, status === 429 ? 'rate_limit_error' : 'claude_error');
        }
        if (!sawTextDelta && !sawAssistantText && typeof item.result === 'string') yield { type: 'text', text: item.result };
        if (item.stop_reason === 'max_tokens') finishReason = 'length';
      }
    }
    const exit = await closed;
    if (signal.aborted) throw new BridgeError('Request cancelled', 499, 'cancelled');
    if (spawnError) throw new BridgeError(`Cannot start Claude Code (${spawnError.code || 'spawn failed'}); check CLAUDE_BIN`, 503, 'cli_unavailable');
    if (exit.code !== 0 || !result) {
      // Do not expose CLI diagnostics: they may include credentials or prompts.
      const hint = /unknown option|unknown argument/i.test(stderr) ? '; update Claude Code to support the required CLI flags' : '';
      throw new BridgeError(`Claude Code exited without a successful result (exit ${exit.code})${hint}; run npm run doctor`, 502, 'cli_failed');
    }
    yield { type: 'result', usage: toUsage(result.usage), finishReason, actualModel };
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    lines?.close();
    if (closed) await closed;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
