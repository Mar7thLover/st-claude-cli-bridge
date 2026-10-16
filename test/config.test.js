import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema, defaultConfigData, getConfig, readConfigFile, root, SETTINGS } from '../src/config.js';

const file = data => ({ path: 'config.json', data });

test('defaults apply without config.json and match the generated default file', () => {
  const config = getConfig({}, null);
  assert.equal(config.port, 8788);
  assert.equal(config.host, '127.0.0.1');
  assert.deepEqual(config.models, ['sonnet', 'opus', 'haiku']);
  assert.equal(config.heartbeatMs, 10000);
  assert.equal(config.configFile, null);
  const fromDefaults = getConfig({}, file(defaultConfigData()));
  assert.deepEqual({ ...fromDefaults, configFile: null }, config);
});

test('config.json values reach the runtime config', () => {
  const config = getConfig({}, file({
    server: { port: 9000, maxConcurrent: 4, allowedOrigins: ['http://127.0.0.1:9100/'], heartbeatSeconds: 5, retryAfterSeconds: 7, logRequests: false },
    claude: { bin: 'bin/claude.exe', defaultModel: 'opus', extraModels: [], discoveryTimeoutSeconds: 30, modelCheckMaxAgeHours: 48 },
  }));
  assert.equal(config.port, 9000);
  assert.equal(config.maxConcurrent, 4);
  assert.deepEqual(config.allowedOrigins, ['http://127.0.0.1:9100']);
  assert.equal(config.heartbeatMs, 5000);
  assert.equal(config.retryAfterSeconds, 7);
  assert.equal(config.logRequests, false);
  assert.equal(config.claudeBin, path.resolve(root, 'bin/claude.exe'));
  assert.deepEqual(config.models, ['opus']);
  assert.equal(config.discoveryTimeoutMs, 30000);
  assert.equal(config.modelCheckMaxAgeMs, 48 * 3600000);
  assert.equal(getConfig({}, file({ claude: { bin: 'claude' } })).claudeBin, 'claude');
});

test('environment variables override config.json and are reported; empty ones are ignored', () => {
  const config = getConfig({ BRIDGE_PORT: '9001', BRIDGE_MODELS: 'haiku, fable', CLAUDE_BIN: '' }, file({ server: { port: 9000 }, claude: { bin: 'C:/x/claude.exe' } }));
  assert.equal(config.port, 9001);
  assert.deepEqual(config.models, ['sonnet', 'haiku', 'fable']);
  assert.equal(config.claudeBin, 'C:/x/claude.exe');
  assert.deepEqual(config.envOverrides, [{ key: 'server.port', env: 'BRIDGE_PORT' }]);
  assert.throws(() => getConfig({ BRIDGE_PORT: '80abc' }, null), /BRIDGE_PORT must be an integer/);
});

test('invalid config.json content is rejected with the offending key', () => {
  const cases = [
    [{ server: { prot: 1 } }, /unknown setting "server\.prot"/],
    [{ sever: {} }, /unknown section "sever"/],
    [{ server: [] }, /"server" must be an object/],
    [{ server: { port: '8788' } }, /server\.port must be an integer between 1 and 65535/],
    [{ server: { port: 70000 } }, /server\.port/],
    [{ server: { logRequests: 'yes' } }, /server\.logRequests must be true or false/],
    [{ claude: { extraModels: 'sonnet' } }, /claude\.extraModels must be an array/],
    [{ claude: { defaultModel: 'bad model' } }, /Invalid model/],
    [{ server: { allowedOrigins: ['127.0.0.1:8787'] } }, /allowedOrigins/],
    [{ server: { allowedOrigins: ['http://127.0.0.1:8787/path'] } }, /allowedOrigins/],
    [{ server: { host: '0.0.0.0' } }, /requires server\.apiKey/],
    [[], /must contain a JSON object/],
  ];
  for (const [data, pattern] of cases) assert.throws(() => getConfig({}, file(data)), pattern, JSON.stringify(data));
  assert.equal(getConfig({}, file({ server: { host: '0.0.0.0', apiKey: 'k' } })).host, '0.0.0.0');
});

test('readConfigFile handles BOM, invalid JSON and a missing BRIDGE_CONFIG target', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'claudebridge-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const good = path.join(dir, 'good.json');
  await writeFile(good, '\uFEFF{"server":{"port":9002}}');
  const loaded = readConfigFile({ BRIDGE_CONFIG: good });
  assert.equal(loaded.path, good);
  assert.equal(getConfig({ BRIDGE_CONFIG: good }).port, 9002);
  const bad = path.join(dir, 'bad.json');
  await writeFile(bad, '{"server":{"port":9002,}}');
  assert.throws(() => readConfigFile({ BRIDGE_CONFIG: bad }), /not valid JSON/);
  assert.throws(() => readConfigFile({ BRIDGE_CONFIG: path.join(dir, 'missing.json') }), /missing file/);
});

test('config.schema.json is generated from the settings table', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'config.schema.json'), 'utf8'));
  assert.deepEqual(schema, configSchema(), 'Run npm run config -- --schema after changing SETTINGS');
  for (const setting of SETTINGS) {
    const [section, name] = setting.key.split('.');
    assert.deepEqual(schema.properties[section].properties[name].default, setting.default);
  }
});
