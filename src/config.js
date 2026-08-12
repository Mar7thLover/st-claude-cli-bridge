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

    // 会话续接：只把新增的一轮发给 CLI，靠 --resume 让历史留在前缀缓存里。
    // 省 token 很可观，但会话会明文落盘到 ~/.claude/projects，且 prefill / 带图 /
    // 被截断的轮次无法续接，与 ST 的贴合度略降，所以默认关闭。
    sessionMode: false,
    sessionMaxStates: 12,
    sessionTtlMs: 7200000,
    sessionCleanup: 'off',   // off | gc | all，见 README

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
    if (env.BRIDGE_SESSION_MODE) cfg.sessionMode = /^(1|true|yes|on)$/i.test(env.BRIDGE_SESSION_MODE);
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

    if (!['off', 'gc', 'all'].includes(cfg.sessionCleanup)) {
        console.warn(`[config] sessionCleanup 取值无效（${cfg.sessionCleanup}），已按 "off" 处理`);
        cfg.sessionCleanup = 'off';
    }

    cfg.workDir = path.resolve(ROOT, cfg.workDir);
    cfg.logDir = path.resolve(ROOT, cfg.logDir);
    fs.mkdirSync(cfg.workDir, { recursive: true });
    if (cfg.debug || cfg.logPrompts) fs.mkdirSync(cfg.logDir, { recursive: true });

    return cfg;
}
