import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { buildPrompt, composePrompt, renderAssistantLine } from './messages.js';
import { runClaude, probeClaude, sweepRuns } from './claude.js';
import { SessionStore, sweepSessions, hash } from './session.js';

const cfg = loadConfig();
const sessions = new SessionStore(cfg);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/* ---------------------------------- 工具 ---------------------------------- */

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const debug = (...a) => cfg.debug && console.log(`[${ts()}] [debug]`, ...a);

function json(res, code, body) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Access-Control-Allow-Origin': '*',
    });
    res.end(payload);
}

function errorBody(message, type = 'bridge_error', code = null) {
    return { error: { message, type, code, param: null } };
}

function readBody(req, limitBytes = 64 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > limitBytes) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new Error(`JSON 解析失败: ${err.message}`));
            }
        });
        req.on('error', reject);
    });
}

/**
 * 解析模型名里的可选后缀：
 *   claude-opus-5:think        开启扩展思考
 *   claude-opus-5:nothink      关闭扩展思考
 *   claude-opus-5:high         effort=high（low/medium/high/xhigh/max）
 *   claude-opus-5:think:xhigh  可叠加
 * 出现无法识别的后缀时，整串当作模型名原样下发。
 */
function parseModel(raw) {
    const input = String(raw || '').trim() || cfg.defaultModel;
    const parts = input.split(':');
    const out = { model: input, effort: cfg.defaultEffort || '', thinking: Boolean(cfg.thinking) };

    if (parts.length > 1) {
        const flags = parts.slice(1).map(s => s.trim().toLowerCase());
        if (flags.every(f => EFFORTS.has(f) || f === 'think' || f === 'nothink')) {
            out.model = parts[0];
            for (const f of flags) {
                if (f === 'think') out.thinking = true;
                else if (f === 'nothink') out.thinking = false;
                else out.effort = f;
            }
        }
    }

    out.model = out.model || cfg.defaultModel;
    if (!EFFORTS.has(out.effort)) out.effort = '';
    return out;
}

/** logPrompts 打开时，把 ST 的原始请求和转换结果整份落盘，方便排查「设定没进去」这类问题 */
function dumpRequest(id, body, built, meta) {
    const roles = (body.messages || []).map((m, i) => {
        const c = m.content;
        const len = typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length;
        return `  [${String(i).padStart(3)}] role=${String(m.role).padEnd(9)} name=${m.name ?? '-'} 长度=${len}`;
    }).join('\n');

    const text = [
        `# 时间: ${new Date().toISOString()}`,
        `# 请求ID: ${id}`,
        `# 转换后的参数: ${JSON.stringify(meta)}`,
        '',
        `===== ST 发来的 messages 概览（共 ${(body.messages || []).length} 条）=====`,
        roles,
        '',
        `===== ST 发来的其它字段 =====`,
        JSON.stringify({ ...body, messages: undefined }, null, 2),
        '',
        `===== 转换后的 SYSTEM（${built.system.length} 字，走 --system-prompt-file）=====`,
        built.system,
        '',
        `===== 转换后的 PROMPT（${built.prompt.length} 字，走 stdin）=====`,
        built.prompt,
        '',
        '===== ST 发来的 messages 原文 =====',
        JSON.stringify(body.messages, null, 2),
    ].join('\n');

    const file = path.join(cfg.logDir, `req-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    fs.writeFile(file, text, err => err && log('✗ 写日志失败:', err.message));
    log(`  已转储请求到 ${file}`);
}

function authorized(req) {
    if (!cfg.apiKey) return true;
    const header = req.headers.authorization || '';
    return header.replace(/^Bearer\s+/i, '').trim() === cfg.apiKey;
}

/* ------------------------------- 并发闸门 ------------------------------- */

let running = 0;
const waiters = [];

function acquire() {
    if (running < Math.max(1, cfg.maxConcurrent)) {
        running++;
        return Promise.resolve();
    }
    return new Promise(resolve => waiters.push(resolve));
}

function release() {
    const next = waiters.shift();
    if (next) next();
    else running = Math.max(0, running - 1);
}

/* -------------------------------- 路由处理 -------------------------------- */

function listModels() {
    const created = Math.floor(Date.now() / 1000);
    return {
        object: 'list',
        data: (cfg.models || []).map(id => ({
            id,
            object: 'model',
            created,
            owned_by: 'claude-cli-bridge',
        })),
    };
}

async function handleChatCompletions(req, res) {
    let body;
    try {
        body = await readBody(req);
    } catch (err) {
        return json(res, 400, errorBody(err.message, 'invalid_request_error'));
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json(res, 400, errorBody('messages 不能为空', 'invalid_request_error'));
    }

    const { model, effort, thinking } = parseModel(body.model);
    const built = buildPrompt(body.messages, cfg);
    const stream = Boolean(body.stream);
    const maxTokens = Number(body.max_completion_tokens || body.max_tokens || 0) || 0;
    const stop = Array.isArray(body.stop) ? body.stop : body.stop ? [String(body.stop)] : [];

    // ST 的 reasoning_effort 若被转发过来，优先级高于模型名后缀
    const reqEffort = String(body.reasoning_effort || '').toLowerCase();
    const finalEffort = EFFORTS.has(reqEffort) ? reqEffort : effort;

    const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    const plan = planSession(built);
    const prompt = plan
        ? composePrompt({ lines: built.lines, from: plan.from, prefill: built.prefill, cfg })
        : built.prompt;

    const sessionNote = !plan ? ''
        : plan.resumeFrom ? ` | 续接 +${built.lines.length - plan.from} 行`
        : ' | 新会话';

    log(`→ ${model}${finalEffort ? ` (effort=${finalEffort})` : ''}${thinking ? ' (thinking)' : ''} | ${body.messages.length} msgs | system ${built.system.length} 字 | prompt ${prompt.length} 字` +
        `${built.prefill ? ' | prefill' : ''}${built.images.length ? ` | ${built.images.length} 图` : ''}${stream ? ' | stream' : ''}${sessionNote}`);
    debug('system 开头:', built.system.slice(0, 300).replace(/\n/g, '⏎'));
    debug('prompt 结尾:', built.prompt.slice(-300).replace(/\n/g, '⏎'));
    if (cfg.logPrompts) dumpRequest(id, body, { ...built, prompt }, { model, effort: finalEffort, thinking, maxTokens, stop });

    // 客户端（ST）中断时终止子进程。用 res 的 close 事件：req 的 close 在正常读完 body 后也会触发
    const controller = new AbortController();
    let clientGone = false;
    const onClose = () => {
        if (res.writableEnded) return;
        clientGone = true;
        controller.abort();
    };
    res.on('close', onClose);

    await acquire();
    const started = Date.now();

    if (clientGone) {
        release();
        return;
    }

    // ---- 流式 ----
    if (stream) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        });

        const send = delta => {
            if (res.writableEnded) return;
            res.write(`data: ${JSON.stringify({
                id, object: 'chat.completion.chunk', created, model,
                choices: [{ index: 0, delta, finish_reason: null }],
            })}\n\n`);
        };

        send({ role: 'assistant', content: '' });

        try {
            const result = await runClaude({
                system: built.system,
                prompt,
                model, effort: finalEffort, thinking, maxTokens, stop,
                images: built.images,
                prefill: built.prefill,
                assistantLabels: built.assistantLabels,
                sessionId: plan?.sessionId,
                resumeFrom: plan?.resumeFrom,
                signal: controller.signal,
                onText: t => send({ content: t }),
                onReasoning: t => send({ reasoning_content: t }),
            }, cfg);

            settleSession(plan, result);

            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{ index: 0, delta: {}, finish_reason: result.finishReason || 'stop' }],
                    usage: toUsage(result.usage),
                })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
            log(`← ${result.text.length} 字 / ${Date.now() - started}ms${usageNote(result.usage)}`);
        } catch (err) {
            log('✗ 生成失败:', err.message);
            if (!res.writableEnded) {
                // 用 SSE 里的 error 字段告知 ST，避免前端卡在“生成中”
                res.write(`data: ${JSON.stringify(errorBody(err.message))}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
        } finally {
            res.off("close", onClose);
            release();
        }
        return;
    }

    // ---- 非流式 ----
    try {
        const result = await runClaude({
            system: built.system,
            prompt,
            model, effort: finalEffort, thinking, maxTokens, stop,
            images: built.images,
            prefill: built.prefill,
            assistantLabels: built.assistantLabels,
            sessionId: plan?.sessionId,
            resumeFrom: plan?.resumeFrom,
            signal: controller.signal,
        }, cfg);

        settleSession(plan, result);

        if (clientGone) return;

        const message = { role: 'assistant', content: result.text };
        if (result.reasoning) message.reasoning_content = result.reasoning;

        log(`← ${result.text.length} 字 / ${Date.now() - started}ms${usageNote(result.usage)}`);
        json(res, 200, {
            id, object: 'chat.completion', created, model,
            choices: [{ index: 0, message, logprobs: null, finish_reason: result.finishReason || 'stop' }],
            usage: toUsage(result.usage),
        });
    } catch (err) {
        log('✗ 生成失败:', err.message);
        if (!res.writableEnded) json(res, 500, errorBody(err.message));
    } finally {
        res.off("close", onClose);
        release();
    }
}

/* ------------------------------- 会话续接 ------------------------------- */

/**
 * 决定这一轮是「续接已有会话」还是「另起一条链」。
 * prefill 的续写指令、图片的绝对路径都会永久留在会话历史里污染后续轮次，
 * 所以这两种请求仍然可以读缓存，但不能被记成新的续接起点。
 */
function planSession(built) {
    if (!cfg.sessionMode) return null;

    const systemHash = hash(built.system);
    const chain = built.lines.map(hash);
    const found = sessions.plan(systemHash, chain);

    return {
        systemHash,
        chain,
        assistantLabel: built.assistantLabel,
        committable: !built.prefill && built.images.length === 0,
        resumeFrom: found ? found.sessionId : '',
        from: found ? found.from : 0,
        sessionId: found ? '' : randomUUID(),
    };
}

function settleSession(plan, result) {
    if (!plan) return;
    if (!plan.committable || result.truncated || !result.text) {
        sessions.drop(result.sessionId);
        return;
    }
    sessions.commit({
        sessionId: result.sessionId,
        systemHash: plan.systemHash,
        chain: [...plan.chain, hash(renderAssistantLine(result.text, plan.assistantLabel))],
    });
}

/** 缓存命中情况直接打在日志里，方便确认 sessionMode 到底有没有生效 */
function usageNote(u) {
    if (!u) return '';
    const read = u.cache_read_input_tokens || 0;
    const write = u.cache_creation_input_tokens || 0;
    return ` / in ${u.input_tokens || 0} 缓存读 ${read} 写 ${write} out ${u.output_tokens || 0}`;
}

function toUsage(u) {
    if (!u) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const prompt = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const completion = u.output_tokens || 0;
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/* --------------------------------- 服务器 --------------------------------- */

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        });
        return res.end();
    }

    if (p === '/health' || p === '/') {
        return json(res, 200, {
            status: 'ok', bridge: 'st-claude-cli-bridge', model: cfg.defaultModel,
            running, queued: waiters.length,
            session: cfg.sessionMode ? sessions.stats() : null,
        });
    }

    if (!authorized(req)) {
        return json(res, 401, errorBody('API key 不正确', 'invalid_request_error'));
    }

    if (req.method === 'GET' && p.endsWith('/models')) {
        return json(res, 200, listModels());
    }

    if (req.method === 'POST' && (p.endsWith('/chat/completions') || p.endsWith('/completions'))) {
        return handleChatCompletions(req, res).catch(err => {
            log('✗ 未捕获异常:', err);
            if (!res.headersSent) json(res, 500, errorBody(String(err?.message || err)));
            else if (!res.writableEnded) res.end();
        });
    }

    json(res, 404, errorBody(`未知路径: ${p}`, 'invalid_request_error'));
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 75000;

// Windows 控制台默认是 GBK 代码页，会把 Node 输出的 UTF-8 中文日志显示成乱码。
// 只在真的连着控制台时切换，管道/重定向场景不受影响。
if (process.platform === 'win32' && process.stdout.isTTY) {
    try {
        spawnSync('chcp', ['65001'], { shell: true, stdio: 'ignore', windowsHide: true });
    } catch { /* 切不了就算了，不影响功能 */ }
}

sweepRuns(cfg);
sweepSessions(cfg);
const probe = probeClaude(cfg);
if (!probe.ok) {
    console.error(`\n[启动失败] 找不到可用的 Claude CLI（claudePath = "${cfg.claudePath}"）`);
    console.error(`  ${probe.message}`);
    console.error('  请确认已安装并登录 Claude Code，或在 config.json 里把 claudePath 指向 claude.exe 绝对路径。\n');
    process.exit(1);
}

server.listen(cfg.port, cfg.host, () => {
    const base = `http://${cfg.host}:${cfg.port}/v1`;
    console.log('');
    console.log('  SillyTavern ⇄ Claude CLI 桥接已启动');
    console.log(`  CLI        : ${probe.file}  (${probe.version})`);
    console.log(`  端点       : ${base}`);
    console.log(`  默认模型   : ${cfg.defaultModel}`);
    console.log(`  API Key    : ${cfg.apiKey ? '已启用' : '未设置（留空即可连接）'}`);
    console.log(`  并发上限   : ${cfg.maxConcurrent}`);
    if (cfg.sessionMode) {
        const CLEANUP = {
            off: '会话文件保留，需自行清理',
            gc: '回收淘汰的会话，退出时保留',
            all: '启动与退出时清空全部会话',
        };
        console.log(`  会话续接   : 已开启（落盘到 ~/.claude/projects；${CLEANUP[cfg.sessionCleanup]}）`);
    } else {
        console.log('  会话续接   : 关闭');
    }
    console.log('');
    console.log('  在 ST 里选 Chat Completion → Custom (OpenAI-compatible)，');
    console.log(`  Custom Endpoint 填 ${base}，然后点 Connect。`);
    console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        log('正在关闭…');
        sweepSessions(cfg);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    });
}
