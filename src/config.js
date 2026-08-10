import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
    host: '127.0.0.1',
    port: 5599,
    apiKey: '',

    claudePath: 'claude',
    workDir: '.sandbox',
    defaultModel: 'claude-sonnet-5',
    defaultEffort: '',
    maxConcurrent: 2,
    timeoutMs: 600000,
    extraArgs: [],

    thinking: false,
    reasoningPlaceholder: true,
    thinkingTokens: 4000,
    maxTokensMode: 'auto',
    minHardMaxTokens: 2048,
    applyStop: true,
    images: true,
    streamReasoning: true,
    stripLeadingLabel: true,

    debug: false,
    logPrompts: false,
    logDir: 'logs',

    models: ['claude-sonnet-5'],

    systemPreamble: '',
    finalInstruction: '',
    prefillInstruction: '',
    transcriptHeader: '',
    roleLabels: { user: 'Human', assistant: 'Assistant', system: 'System' },
};

/** 环境变量覆盖：BRIDGE_PORT / BRIDGE_HOST / BRIDGE_API_KEY / BRIDGE_MODEL / BRIDGE_CLAUDE_PATH / BRIDGE_DEBUG */
function applyEnv(cfg) {
    const env = process.env;
    if (env.BRIDGE_HOST) cfg.host = env.BRIDGE_HOST;
    if (env.BRIDGE_PORT) cfg.port = Number(env.BRIDGE_PORT);
    if (env.BRIDGE_API_KEY) cfg.apiKey = env.BRIDGE_API_KEY;
    if (env.BRIDGE_MODEL) cfg.defaultModel = env.BRIDGE_MODEL;
    if (env.BRIDGE_CLAUDE_PATH) cfg.claudePath = env.BRIDGE_CLAUDE_PATH;
    if (env.BRIDGE_DEBUG) cfg.debug = /^(1|true|yes|on)$/i.test(env.BRIDGE_DEBUG);
    return cfg;
}

export function loadConfig(file = path.join(ROOT, 'config.json')) {
    let user = {};
    if (fs.existsSync(file)) {
        try {
            // 允许配置文件里带 // 行注释
            const raw = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
            user = JSON.parse(raw);
        } catch (err) {
            console.error(`[config] 解析 ${file} 失败，改用默认配置：`, err.message);
        }
    }
    delete user.$schema;

    const cfg = applyEnv({ ...DEFAULTS, ...user, roleLabels: { ...DEFAULTS.roleLabels, ...(user.roleLabels || {}) } });

    cfg.workDir = path.resolve(ROOT, cfg.workDir);
    cfg.logDir = path.resolve(ROOT, cfg.logDir);
    fs.mkdirSync(cfg.workDir, { recursive: true });
    if (cfg.debug || cfg.logPrompts) fs.mkdirSync(cfg.logDir, { recursive: true });

    return cfg;
}
