import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../src/claude.js';
import { getConfig } from '../src/config.js';
const fake = fileURLToPath(new URL('./fake-cli.js', import.meta.url));
const request = { model: 'sonnet', messages: [{ role: 'system', content: '角色卡' }, { role: 'user', content: '世界书' }], maxTokens: 256 };

function harness(checkOptions = () => {}) {
  let dir;
  let child;
  return {
    deps: { spawnProcess(_bin, args, options) {
      dir = options.cwd;
      assert.equal(options.shell, false);
      assert.equal(args[args.indexOf('--tools') + 1], '');
      assert.equal(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '256');
      checkOptions(args, options.env);
      child = spawn(process.execPath, [fake, ...args], options);
      return child;
    } },
    check() { assert.ok(!existsSync(dir)); assert.ok(child.exitCode !== null || child.signalCode !== null); },
  };
}
test('CLI stream avoids duplicates, reports cached usage and removes temporary prompts', async () => {
  for (const model of ['sonnet', 'fallback']) {
    const h = harness();
    const events = [];
    for await (const event of runClaude({ ...request, model }, getConfig({}, null), new AbortController().signal, h.deps)) events.push(event);
    assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), '你好😺');
    assert.equal(events.at(-1).usage.prompt_tokens, 60);
    assert.equal(events.at(-1).usage.total_tokens, 65);
    assert.equal(events.at(-1).finishReason, 'length');
    h.check();
  }
});
test('invalid output, errors and missing result fail with cleanup', async () => {
  for (const model of ['bad-json', 'failed', 'no-result']) {
    const h = harness();
    await assert.rejects(async () => {
      for await (const _event of runClaude({ ...request, model }, getConfig({}, null), new AbortController().signal, h.deps)) { /* drain */ }
    }, error => !error.message.includes('PRIVATE_SECRET'));
    h.check();
  }
});
test('aborting or closing iterator kills child and deletes prompt files', async () => {
  for (const mode of ['abort', 'return']) {
    const h = harness();
    const abort = new AbortController();
    const iter = runClaude({ ...request, model: 'hang' }, getConfig({}, null), abort.signal, h.deps);
    await iter.next();
    if (mode === 'abort') { abort.abort(); await assert.rejects(iter.next(), /cancelled/); }
    else await iter.return();
    h.check();
  }
});
test('missing Claude executable returns actionable error', async () => {
  await assert.rejects(async () => {
    for await (const _event of runClaude(request, { ...getConfig({}, null), claudeBin: 'definitely-missing-claudebridge-executable' }, new AbortController().signal)) { /* drain */ }
  }, /Cannot start Claude Code/);
});

test('thinking display is passed to the CLI and empty omitted thinking is never forwarded', async () => {
  const run = async (thinkingDisplay, thinking) => {
    let flag;
    const h = harness(args => { flag = args.includes('--thinking-display') ? args[args.indexOf('--thinking-display') + 1] : undefined; });
    const reasoning = [];
    for await (const event of runClaude({ ...request, model: 'thinking', thinkingDisplay, thinking }, getConfig({}, null), new AbortController().signal, h.deps)) {
      if (event.type === 'reasoning') reasoning.push(event.text);
    }
    h.check();
    return { flag, reasoning };
  };
  assert.deepEqual(await run('summarized'), { flag: 'summarized', reasoning: ['先化简', '再计数'] });
  assert.deepEqual(await run('omitted'), { flag: 'omitted', reasoning: [] });
  assert.deepEqual(await run(undefined, 'disabled'), { flag: undefined, reasoning: [] });
});

test('real spawn boundary receives effort and thinking environment independently', async () => {
  for (const control of [{ effort: 'max' }, { thinking: 'disabled' }, { thinking: 'enabled', thinkingBudget: 2048 }]) {
    const h = harness((args, env) => {
      if (control.effort) {
        assert.equal(args[args.indexOf('--effort') + 1], 'max');
        assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
      } else assert.ok(!args.includes('--effort'));
      if (control.thinking === 'disabled') assert.equal(env.MAX_THINKING_TOKENS, '0');
      if (control.thinkingBudget) {
        assert.equal(env.MAX_THINKING_TOKENS, '2048');
        assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { alwaysThinkingEnabled: true });
      }
    });
    for await (const _event of runClaude({ ...request, ...control }, getConfig({}, null), new AbortController().signal, h.deps)) { /* drain */ }
    h.check();
  }
});

test('provider content rejection is identified without echoing private diagnostics', async () => {
  const h = harness();
  await assert.rejects(async () => {
    for await (const _event of runClaude({ ...request, model: 'filtered' }, getConfig({}, null), new AbortController().signal, h.deps)) { /* drain */ }
  }, error => error.code === 'content_filter' && !error.message.includes('PRIVATE_SECRET'));
  h.check();
});
