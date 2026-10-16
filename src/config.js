import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validModel, buildModelCatalog } from './models.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const configFile = path.join(root, 'config.json');
export function loadEnv() {
  const file = path.join(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

// Every user-editable setting. Precedence: environment (including .env) >
// config.json > default. config.schema.json is generated from this table.
export const SETTINGS = [
  { key: 'server.host', env: 'BRIDGE_HOST', type: 'string', default: '127.0.0.1', description: '监听地址。默认仅本机；绑定非回环地址（如 0.0.0.0）时必须设置 server.apiKey。' },
  { key: 'server.port', env: 'BRIDGE_PORT', type: 'integer', min: 1, max: 65535, default: 8788, description: '监听端口。' },
  { key: 'server.apiKey', env: 'BRIDGE_API_KEY', type: 'string', default: '', description: '可选的桥接 Bearer token；留空则不校验。前端连接中填相同值。填写后不要把本文件提交到公开仓库。' },
  { key: 'server.maxConcurrent', env: 'BRIDGE_MAX_CONCURRENT', type: 'integer', min: 1, max: 16, default: 2, description: '同时运行的 Claude Code 生成数；满载返回 429。' },
  { key: 'server.maxBodyBytes', env: 'BRIDGE_MAX_BODY_BYTES', type: 'integer', min: 1024, max: 67108864, default: 8388608, description: '请求体上限（字节），超过返回 413。' },
  { key: 'server.allowedOrigins', type: 'string[]', default: [], description: '允许浏览器页面直接跨域访问的 Origin（协议+主机+端口，精确匹配），如 http://127.0.0.1:8000。前端经自己的服务端转发请求时不需要；默认不允许任何浏览器直连。' },
  { key: 'server.heartbeatSeconds', type: 'integer', min: 1, max: 300, default: 10, description: '流式响应空闲时发送 SSE keep-alive 注释的间隔（秒）。' },
  { key: 'server.retryAfterSeconds', type: 'integer', min: 1, max: 3600, default: 3, description: '并发满载时 Retry-After 响应头的秒数。' },
  { key: 'server.logRequests', type: 'boolean', default: true, description: '是否在控制台记录每个请求的 ID、模型、状态和耗时（从不记录提示词或正文）。' },
  { key: 'claude.bin', env: 'CLAUDE_BIN', type: 'string', default: '', description: 'Claude Code 可执行文件。留空自动寻找 ~/.local/bin/claude.exe 或 PATH 中的 claude；相对路径以项目目录为基准。Windows 下应指向原生 .exe。' },
  { key: 'claude.defaultModel', env: 'CLAUDE_MODEL', type: 'string', default: 'sonnet', description: '请求未指定 model 时使用的模型。' },
  { key: 'claude.extraModels', env: 'BRIDGE_MODELS', type: 'string[]', default: ['sonnet', 'opus', 'haiku'], description: '在自动发现的模型菜单之外追加的模型 ID；追加项不验证账户权限。环境变量形式用逗号分隔。' },
  { key: 'claude.discoveryTimeoutSeconds', type: 'integer', min: 1, max: 300, default: 15, description: '启动时向 Claude Code 读取模型菜单的超时（秒）。' },
  { key: 'claude.modelCheckMaxAgeHours', type: 'integer', min: 1, max: 8760, default: 24, description: 'npm run models:check 结果作为「已验证」的有效期（小时）。' },
];

export class ConfigError extends Error {}

function typeHint(setting) {
  if (setting.type === 'integer') return `an integer between ${setting.min} and ${setting.max}`;
  return { string: 'a string', boolean: 'true or false', 'string[]': 'an array of strings' }[setting.type];
}

function checkValue(setting, value) {
  if (setting.type === 'integer') return Number.isSafeInteger(value) && value >= setting.min && value <= setting.max;
  if (setting.type === 'string[]') return Array.isArray(value) && value.every(item => typeof item === 'string');
  return typeof value === setting.type;
}

function parseEnv(setting, raw) {
  if (setting.type === 'integer') return /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (setting.type === 'string[]') return raw.split(',');
  return raw;
}

// Returns { path, data } or null when the default config.json does not exist.
export function readConfigFile(env = process.env) {
  const file = env.BRIDGE_CONFIG ? path.resolve(root, env.BRIDGE_CONFIG) : configFile;
  if (!existsSync(file)) {
    if (env.BRIDGE_CONFIG) throw new ConfigError(`BRIDGE_CONFIG points to a missing file: ${file}`);
    return null;
  }
  // Notepad may save UTF-8 with a BOM, which JSON.parse rejects.
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try { return { path: file, data: JSON.parse(text) }; }
  catch (error) { throw new ConfigError(`${file} is not valid JSON: ${error.message}`); }
}

function fileValues(file) {
  const values = new Map();
  if (!file) return values;
  const name = path.basename(file.path);
  const { data } = file;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError(`${name} must contain a JSON object`);
  const known = new Map(SETTINGS.map(setting => [setting.key, setting]));
  const sections = new Set(SETTINGS.map(setting => setting.key.split('.')[0]));
  const errors = [];
  for (const [section, group] of Object.entries(data)) {
    if (section === '$schema') continue;
    if (!sections.has(section)) { errors.push(`unknown section "${section}" (expected ${[...sections].join(', ')})`); continue; }
    if (!group || typeof group !== 'object' || Array.isArray(group)) { errors.push(`"${section}" must be an object`); continue; }
    for (const [name, value] of Object.entries(group)) {
      const key = `${section}.${name}`;
      const setting = known.get(key);
      if (!setting) errors.push(`unknown setting "${key}"`);
      else if (!checkValue(setting, value)) errors.push(`${key} must be ${typeHint(setting)}`);
      else values.set(key, value);
    }
  }
  if (errors.length) throw new ConfigError(`${name}: ${errors.join('; ')}`);
  return values;
}

function resolveSettings(env, file) {
  const fromFile = fileValues(file);
  const values = {};
  const envOverrides = [];
  const errors = [];
  for (const setting of SETTINGS) {
    // Empty variables (as in .env.example) mean "unset", not "empty value".
    const raw = setting.env ? env[setting.env] : undefined;
    if (raw !== undefined && raw !== '') {
      const value = parseEnv(setting, raw);
      if (!checkValue(setting, value)) { errors.push(`${setting.env} must be ${typeHint(setting)}`); continue; }
      values[setting.key] = value;
      if (fromFile.has(setting.key)) envOverrides.push({ key: setting.key, env: setting.env });
    } else values[setting.key] = fromFile.has(setting.key) ? fromFile.get(setting.key) : structuredClone(setting.default);
  }
  if (errors.length) throw new ConfigError(errors.join('; '));
  return { values, envOverrides };
}

const fromRoot = value => path.isAbsolute(value) ? value : path.resolve(root, value);

export function findClaude(bin = '') {
  // A bare command name is looked up on PATH; anything with a separator is a path.
  if (bin) return /[\\/]/.test(bin) ? fromRoot(bin) : bin;
  const native = path.join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return existsSync(native) ? native : 'claude';
}

export function getConfig(env = process.env, file = readConfigFile(env)) {
  const { values: v, envOverrides } = resolveSettings(env, file);
  const host = v['server.host'].trim();
  const apiKey = v['server.apiKey'];
  if (!host) throw new ConfigError('server.host must not be empty');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !apiKey) {
    throw new ConfigError('Binding outside loopback requires server.apiKey (or BRIDGE_API_KEY)');
  }
  const defaultModel = v['claude.defaultModel'].trim();
  const models = [...new Set([defaultModel, ...v['claude.extraModels']].map(s => s.trim()).filter(Boolean))];
  for (const model of models) {
    if (!validModel(model)) throw new ConfigError(`Invalid model: ${model || '(empty claude.defaultModel)'}`);
  }
  const allowedOrigins = v['server.allowedOrigins'].map(origin => origin.trim().replace(/\/+$/, ''));
  for (const origin of allowedOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { /* reported below */ }
    if (!parsed || parsed.origin !== origin) throw new ConfigError(`server.allowedOrigins: "${origin}" must be an origin such as http://127.0.0.1:8787`);
  }
  return {
    host, apiKey, defaultModel, models, modelCatalog: buildModelCatalog([], models),
    port: v['server.port'],
    claudeBin: findClaude(v['claude.bin'].trim()),
    maxConcurrent: v['server.maxConcurrent'],
    maxBodyBytes: v['server.maxBodyBytes'],
    allowedOrigins,
    heartbeatMs: v['server.heartbeatSeconds'] * 1000,
    retryAfterSeconds: v['server.retryAfterSeconds'],
    logRequests: v['server.logRequests'],
    discoveryTimeoutMs: v['claude.discoveryTimeoutSeconds'] * 1000,
    modelCheckMaxAgeMs: v['claude.modelCheckMaxAgeHours'] * 3600000,
    configFile: file?.path || null,
    envOverrides,
  };
}

// Startup lines shared by the server and CLI scripts.
export function describeConfig(config) {
  const lines = [config.configFile ? `Config: ${config.configFile}` : `Config: defaults (${path.basename(configFile)} not found)`];
  for (const { key, env } of config.envOverrides) lines.push(`Config: ${key} in config.json is overridden by environment variable ${env}`);
  return lines;
}

// Nested default values, in the same layout as config.json.
export function defaultConfigData() {
  const data = { $schema: './config.schema.json' };
  for (const setting of SETTINGS) {
    const [section, name] = setting.key.split('.');
    (data[section] ??= {})[name] = structuredClone(setting.default);
  }
  return data;
}

export function configSchema() {
  const properties = { $schema: { type: 'string' } };
  for (const setting of SETTINGS) {
    const [section, name] = setting.key.split('.');
    properties[section] ??= { type: 'object', additionalProperties: false, properties: {} };
    const description = setting.env ? `${setting.description}\n环境变量 ${setting.env} 优先于此项。` : setting.description;
    const type = setting.type === 'string[]' ? { type: 'array', items: { type: 'string' } } : { type: setting.type };
    const range = setting.type === 'integer' ? { minimum: setting.min, maximum: setting.max } : {};
    properties[section].properties[name] = { ...type, ...range, default: setting.default, description };
  }
  return { $schema: 'http://json-schema.org/draft-07/schema#', title: 'ClaudeBridge config.json', type: 'object', additionalProperties: false, properties };
}

export function localUrl(config) {
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host.includes(':') ? `[${config.host}]` : config.host;
  return `http://${host}:${config.port}`;
}
