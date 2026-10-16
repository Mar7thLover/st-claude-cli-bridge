import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HISTORICAL_MODELS, RETIRED_MODELS } from './model-history.js';

export const modelChecksFile = new URL('../.runtime/model-checks.json', import.meta.url);

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const validModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}(?:\[1m\])?$/.test(value);
const stripContext = value => value.replace(/\[1m\]$/, '');
const fallbackAliases = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };

// Model capability rules from Claude Code model-config and Claude API thinking
// docs, checked 2026-10-16. CLI effort differs from the raw Anthropic API.
export function capabilitiesFor(model, provider = 'firstParty', cli) {
  const id = stripContext(model);
  let levels = [];
  if (/^claude-(?:fable-5(?:-1)?|mythos-5(?:-1)?|opus-(?:5|4-[78])|sonnet-5|haiku-5)(?:-|$)/.test(id)) levels = EFFORT_LEVELS;
  else if (/^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(id)) levels = ['low', 'medium', 'high', 'max'];
  if (cli) levels = cli.supportsEffort ? (cli.supportedEffortLevels || levels).filter(level => EFFORT_LEVELS.includes(level)) : [];
  const knownThinking = /^claude-(?:haiku-(?:4-5|5)|sonnet-(?:4|5)|opus-(?:4|5)|3-7-sonnet|fable-5|mythos-)/.test(id);
  // Opus 5.5 rejects thinking disabled at every effort level, like Fable/Mythos.
  const alwaysOn = /^claude-(?:fable-|mythos-|opus-5-5(?:-|$))/.test(id);
  // Measured 2026-10-16 with Claude Code 2.1.301 on a reasoning prompt: Sonnet/Haiku 5.5
  // keep thinking under every CLI off switch.
  const cliIgnoresOff = /^claude-(?:sonnet|haiku)-5-5(?:-|$)/.test(id);
  const canDisable = provider === 'firstParty' && knownThinking && !alwaysOn && !cliIgnoresOff;
  // The API rejects Opus 5 thinking-off above high, and at high its safeguards classifier
  // flags most bridge requests (1/6 passed; low and medium passed 12/12).
  const restrictedOffLevels = /^claude-opus-5(?!-5)(?:-|$)/.test(id) ? ['high', 'xhigh', 'max'] : [];
  return {
    supportsEffort: levels.length > 0,
    effortLevels: [...levels],
    supportsThinking: knownThinking || cli?.supportsAdaptiveThinking === true,
    canDisableThinking: canDisable,
    thinkingOffUnavailableAt: restrictedOffLevels,
    maxContext: /\[1m\]$/.test(model) || /^claude-(?:fable-5|sonnet-5|haiku-5|opus-(?:5|4-[78]))/.test(id) ? 1000000 : 200000,
    thinkingOffReason: canDisable ? null : alwaysOn ? 'This model requires thinking'
      : cliIgnoresOff ? 'Claude Code does not turn thinking off for this model'
      : provider !== 'firstParty' ? 'Claude Code cannot guarantee thinking is disabled on this provider' : 'Thinking-off support has not been verified for this model',
  };
}

export function buildModelCatalog(rows = [], configured = [], provider = 'firstParty', { includeRetired = false } = {}) {
  const entries = new Map();
  const add = (id, resolved, source, cli) => {
    if (!validModel(id) || !validModel(resolved) || entries.has(id)) return;
    entries.set(id, {
      id, resolvedModel: resolved, name: cli?.displayName || resolved,
      description: cli?.description || '', source, provider, availability: source.startsWith('cli-') ? 'menu-listed' : 'unverified',
      ...capabilitiesFor(resolved, provider, cli),
    });
  };
  for (const row of rows) {
    if (!validModel(row.value) || !validModel(row.resolvedModel)) continue;
    add(row.value, row.resolvedModel, 'cli-menu', row);
    add(row.resolvedModel, row.resolvedModel, 'cli-resolved', row);
    add(stripContext(row.resolvedModel), stripContext(row.resolvedModel), 'cli-resolved', row);
  }
  for (const [alias, family] of Object.entries({ opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', fable: 'fable' })) {
    const row = rows.find(row => stripContext(row.resolvedModel || '').startsWith(`claude-${family}-`));
    if (!row) continue;
    // The CLI menu establishes the current family version, including account restrictions.
    add(alias, stripContext(row.resolvedModel), 'cli-alias', row);
    if (['sonnet', 'opus'].includes(alias) && capabilitiesFor(row.resolvedModel).maxContext === 1000000) {
      add(`${alias}[1m]`, `${stripContext(row.resolvedModel)}[1m]`, 'cli-alias', row);
    }
  }
  const best = entries.get('fable') || entries.get('opus');
  if (best) add('best', best.resolvedModel, 'cli-alias', { displayName: 'Best', supportsEffort: best.supportsEffort, supportedEffortLevels: best.effortLevels });
  for (const id of configured) {
    const alias = stripContext(id);
    const resolved = rows.length ? id : (fallbackAliases[alias] || id) + (id.endsWith('[1m]') && fallbackAliases[alias] ? '[1m]' : '');
    add(id, resolved, rows.length ? 'configured' : 'fallback');
  }
  if (provider === 'firstParty') {
    for (const historical of [...HISTORICAL_MODELS, ...(includeRetired ? RETIRED_MODELS : [])]) {
      add(historical.id, historical.id, 'historical-catalog');
      Object.assign(entries.get(historical.id), historical);
    }
    // Even explicitly configured retired IDs must carry their true lifecycle.
    for (const retired of RETIRED_MODELS) {
      const entry = entries.get(retired.id);
      if (entry) Object.assign(entry, retired, { availability: 'retired' });
    }
  }
  return [...entries.values()];
}

export function modelInfo(model, config) {
  return config.modelCatalog?.find(row => row.id === model) || buildModelCatalog([], [model], config.apiProvider || 'firstParty').find(row => row.id === model);
}

// The CLI SDK initialize control message returns the account's model picker
// without generating a reply. Never expose the account identity in that response.
export async function discoverModels(config, { spawnProcess = spawn, timeoutMs = config.discoveryTimeoutMs ?? 15000 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'claudebridge-models-'));
  let child;
  let closed;
  let timer;
  try {
    const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    delete env.CLAUDECODE;
    child = spawnProcess(config.claudeBin, [
      '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
    ], { cwd: dir, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    closed = new Promise(resolve => child.once('close', resolve));
    child.stderr.resume();
    child.stdin.on('error', () => {});
    return await new Promise((resolve, reject) => {
      let buffer = '';
      child.once('error', error => reject(new Error(`Model discovery could not start Claude Code (${error.code || 'spawn error'})`)));
      child.once('close', () => reject(new Error('Claude Code exited before model discovery completed')));
      timer = setTimeout(() => reject(new Error('Claude Code model discovery timed out')), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) { reject(new Error('Model discovery response is too large')); return; }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          let item;
          try { item = JSON.parse(line); } catch { continue; }
          if (item.type !== 'control_response' || item.response?.request_id !== 'bridge-models') continue;
          const result = item.response?.response;
          if (item.response?.subtype !== 'success' || !Array.isArray(result?.models) || !result.models.length) {
            reject(new Error('Claude Code did not return a model menu')); return;
          }
          const models = result.models.filter(row => validModel(row.value) && validModel(row.resolvedModel)).map(row => ({
            value: row.value, resolvedModel: row.resolvedModel, displayName: row.displayName,
            description: row.description, supportsEffort: row.supportsEffort === true,
            supportedEffortLevels: Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels : [],
            supportsAdaptiveThinking: row.supportsAdaptiveThinking === true,
          }));
          if (!models.length) { reject(new Error('Claude Code model menu contained no valid model IDs')); return; }
          resolve({ models, provider: result.account?.apiProvider || 'unknown', discoveredAt: new Date().toISOString() });
        }
      });
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'bridge-models', request: { subtype: 'initialize' } }) + '\n');
    });
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (closed) await closed;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export async function withDiscoveredModels(config, options) {
  const discovery = await discoverModels(config, options);
  const catalog = buildModelCatalog(discovery.models, config.models, discovery.provider, { includeRetired: options?.includeRetired === true });
  try {
    const report = JSON.parse(await readFile(modelChecksFile, 'utf8'));
    applyModelChecks(catalog, report, discovery.provider, Date.now(), config.modelCheckMaxAgeMs);
  } catch { /* No current validation report; keep availability explicitly unverified. */ }
  return { ...config, apiProvider: discovery.provider, modelCatalog: catalog, models: catalog.map(row => row.id), modelsDiscoveredAt: discovery.discoveredAt };
}

export function applyModelChecks(catalog, report, provider, now = Date.now(), maxAgeMs = 86400000) {
  if (report?.provider !== provider || !Array.isArray(report.checks)) return;
  for (const row of catalog) {
    if (row.lifecycle === 'retired') continue;
    const check = report.checks.find(check => check.model === row.id);
    const age = now - Date.parse(check?.checkedAt);
    if (!check || !Number.isFinite(age) || age < 0 || age > maxAgeMs || !['verified', 'failed', 'model-mismatch'].includes(check.status)) continue;
    row.availability = check.status;
    row.verifiedAt = check.checkedAt;
    row.actualModel = check.actualModel;
    row.verificationError = check.errorCode;
  }
}
