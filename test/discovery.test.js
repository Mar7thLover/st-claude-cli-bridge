import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoverModels } from '../src/models.js';
import { getConfig } from '../src/config.js';

test('CLI initialize discovers models without user prompt, redacts identity and cleans up', async () => {
  let child;
  let cwd;
  const result = await discoverModels(getConfig({}, null), { spawnProcess(_bin, args, options) {
    assert.ok(args.includes('--input-format'));
    assert.equal(args.at(-1), '--disable-slash-commands');
    cwd = options.cwd;
    child = spawn(process.execPath, [fileURLToPath(new URL('./fake-discovery.js', import.meta.url))], options);
    return child;
  } });
  assert.equal(result.models[0].resolvedModel, 'claude-sonnet-5');
  assert.equal(result.provider, 'firstParty');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.ok(!existsSync(cwd));
});

test('discovery timeout kills the CLI and deletes its temporary directory', async () => {
  let child;
  let cwd;
  await assert.rejects(discoverModels(getConfig({}, null), { timeoutMs: 200, spawnProcess(_bin, _args, options) {
    cwd = options.cwd;
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options);
    return child;
  } }), /timed out/);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.ok(!existsSync(cwd));
});
