import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { StopWatcher, OutputSanitizer } from './messages.js';
import { sessionCwd } from './session.js';

/** 解析 claude 可执行文件：优先 .exe / 无扩展名的原生二进制，退化到 .cmd 时走 shell */
let resolved = null;
export function resolveClaude(claudePath) {
    if (resolved && resolved.input === claudePath) return resolved;

    let file = claudePath;
    if (!path.isAbsolute(claudePath) && !claudePath.includes(path.sep)) {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        const out = spawnSync(finder, [claudePath], { encoding: 'utf8', windowsHide: true });
        const candidates = String(out.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        file = candidates.find(c => /\.exe$/i.test(c)) || candidates[0] || claudePath;
    }

    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    resolved = { input: claudePath, file, needsShell };
    return resolved;
}

function quoteWin(arg) {
    const s = String(arg);
    if (s === '') return '""';
    return /[\s"^&|<>()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function killTree(child) {
    if (!child || child.killed || child.exitCode !== null) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
            child.kill('SIGTERM');
        }
    } catch { /* 进程可能已退出 */ }
}

/**
 * 调用一次 claude -p，流式解析 stream-json。
 *
 * @param {object} opts
 * @param {string} opts.system            system prompt 全文
 * @param {string} opts.prompt            用户侧正文（走 stdin，不受命令行长度限制）
 * @param {string} [opts.model]
 * @param {string} [opts.effort]          low|medium|high|xhigh|max
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.thinkingTokens]
 * @param {string[]} [opts.stop]
 * @param {Array} [opts.images]           [{name, mime, data(base64)}]
 * @param {AbortSignal} [opts.signal]
 * @param {(t:string)=>void} [opts.onText]
 * @param {(t:string)=>void} [opts.onReasoning]
 * @param {object} cfg
 */
/** 老版本 CLI 可能没有 --system-prompt-file，探测到就降级为「system 并入 stdin」 */
let supportsSystemPromptFile = true;

export async function runClaude(opts, cfg) {
    try {
        return await runOnce(opts, cfg);
    } catch (err) {
        if (err?.code === 'NO_SYSTEM_PROMPT_FILE') {
            supportsSystemPromptFile = false;
            console.warn('[claude] 当前 CLI 不支持 --system-prompt-file，已降级为把 system 并入正文');
            return await runOnce(opts, cfg);
        }
        throw err;
    }
}

function runOnce(opts, cfg) {
    return new Promise((resolve, reject) => {
        const runId = randomUUID();

        // sessionMode 下 cwd 必须稳定：否则每次请求都会在 ~/.claude/projects 下新开一个目录，
        // session 文件散得到处都是没法回收。此时用文件名前缀区分并发请求。
        const useSession = Boolean(opts.sessionId || opts.resumeFrom);
        const runDir = useSession ? sessionCwd(cfg) : path.join(cfg.workDir, 'runs', runId);
        const prefix = useSession ? `${runId}-` : '';
        const fileOf = name => path.join(runDir, prefix + name);
        fs.mkdirSync(runDir, { recursive: true });

        const cleanup = () => {
            if (cfg.debug) return; // debug 模式保留现场
            // Windows 上子进程刚退出时仍会短暂持有 cwd 句柄，删不掉就退避重试
            const delays = [0, 250, 1000, 3000];
            const attempt = i => {
                const done = err => {
                    if (err && i + 1 < delays.length) setTimeout(() => attempt(i + 1), delays[i + 1]).unref();
                };
                if (useSession) {
                    // 目录是共用的，只能删本次请求自己落的那几个文件
                    let pending = 1 + images.length;
                    const tick = err => { if (err) done(err); else if (--pending === 0) done(null); };
                    fs.rm(sysFile, { force: true }, tick);
                    for (const img of images) fs.rm(fileOf(img.name), { force: true }, tick);
                } else {
                    fs.rm(runDir, { recursive: true, force: true }, done);
                }
            };
            attempt(0);
        };

        const sysFile = fileOf('system.txt');
        fs.writeFileSync(sysFile, opts.system ?? '', 'utf8');

        const images = (opts.images || []).filter(Boolean);
        for (const img of images) {
            fs.writeFileSync(fileOf(img.name), Buffer.from(img.data, 'base64'));
        }

        const args = [
            '-p',
            '--output-format', 'stream-json',
            '--include-partial-messages',
            '--verbose',
            '--disable-slash-commands',
            '--setting-sources', '',
        ];

        // 会话续接：--resume 复用历史（--fork-session 保住父节点，swipe 才能反复从同一处重开），
        // 新开一条链时用 --session-id 直接指定 id。两者都不给就退回「不落盘」的老行为。
        if (opts.resumeFrom) args.push('--resume', opts.resumeFrom, '--fork-session');
        else if (opts.sessionId) args.push('--session-id', opts.sessionId);
        else args.push('--no-session-persistence');

        let stdinPrompt = opts.prompt ?? '';
        if (images.length) {
            // Read 工具只认绝对路径，这里把落盘位置明确告诉模型
            const list = images.map(img => fileOf(img.name)).join('\n');
            stdinPrompt += `\n\n---\n本条对话附带的图片已保存到本地，请先用 Read 工具读取它们，再据此作答：\n${list}`;
        }
        if (supportsSystemPromptFile) {
            args.push('--system-prompt-file', sysFile);
        } else {
            // 降级路径：system 全文放进 stdin 顶部
            stdinPrompt = `${opts.system ?? ''}\n\n${stdinPrompt}`;
        }

        if (opts.model) args.push('--model', opts.model);
        if (opts.effort) args.push('--effort', opts.effort);

        if (images.length) {
            // 仅开放 Read，让模型能看图；工作目录就是本次 run 目录
            args.push('--tools', 'Read', '--allowedTools', 'Read');
        } else {
            args.push('--tools', '');
        }

        if (Array.isArray(cfg.extraArgs)) args.push(...cfg.extraArgs.map(String));

        const env = {
            ...process.env,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_AUTOUPDATER: '1',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
            DISABLE_BUG_COMMAND: '1',
            DISABLE_COST_WARNINGS: '1',
            CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
        };
        // 扩展思考默认关闭：开着会让一条普通角色扮演回复多烧十几倍 token、慢十几倍
        const thinkBudget = opts.thinking ? Math.max(1024, Number(opts.thinkingTokens || cfg.thinkingTokens) || 4000) : 0;
        env.MAX_THINKING_TOKENS = String(thinkBudget);

        // max_tokens：CLI 把它当硬上限，一旦撞上就会重发/续写、最后直接报错，
        // 所以默认只在数值足够大时才下发（小值反而会毁掉整条回复）。
        const capMode = cfg.maxTokensMode || 'auto';
        let cap = Number(opts.maxTokens) || 0;
        if (cap > 0 && capMode !== 'off') {
            const floor = Number(cfg.minHardMaxTokens ?? 2048);
            if (thinkBudget > 0) cap = Math.max(cap, thinkBudget + 1024);
            if (capMode === 'always' || cap >= floor) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(cap));
        }

        const { file, needsShell } = resolveClaude(cfg.claudePath);
        const child = needsShell
            ? spawn([quoteWin(file), ...args.map(quoteWin)].join(' '), { shell: true, windowsHide: true, cwd: runDir, env })
            : spawn(file, args, { windowsHide: true, cwd: runDir, env });


        const newSanitizer = () => new OutputSanitizer({
            prefill: opts.prefill || '',
            labels: opts.assistantLabels || [],
            stripLabel: cfg.stripLeadingLabel !== false,
        });
        let sanitizer = newSanitizer();
        let stopper = new StopWatcher(cfg.applyStop ? opts.stop : []);
        let text = '';
        let reasoning = '';
        let finishReason = 'stop';
        let usage = null;
        let sessionId = '';
        let stderr = '';
        let stdoutTail = '';
        let settled = false;
        let stoppedBySequence = false;
        let apiError = null;
        // --- 多次 message_start 的处理 ---
        // CLI 在撞到 max_tokens 或网络重试时会再开一条消息，可能是「重发同一段」也可能是「接着往下写」，
        // 靠比对新消息开头与上一段的前缀来区分。
        // Claude 5 家族的思维内容是加密的（只给签名和 token 估计），
        // 记下来好在结束时给出一条「思考确实跑了」的回执。
        const thinkingBlocks = new Set();
        let thinkingPlaintext = 0;
        let thinkingEstimated = 0;
        let placeholderSent = false;

        let messageStarts = 0;
        let attemptText = '';   // 当前这次生成已收到的原始文本
        let prevText = '';      // 上一次生成的原始文本
        let mode = 'pass';      // pass | probe | skip
        let probeBuf = '';
        let skipRemaining = 0;

        const timer = setTimeout(() => {
            finishReason = 'length';
            stoppedBySequence = true; // 走「主动结束」分支而非报错
            apiError = apiError || `超时 ${cfg.timeoutMs}ms`;
            killTree(child);
        }, Math.max(10000, cfg.timeoutMs));

        const onAbort = () => {
            stoppedBySequence = true;
            finishReason = 'stop';
            killTree(child);
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });

        const finish = (err, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
            cleanup();
            err ? reject(err) : resolve(value);
        };

        let buf = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                stdoutTail = line.slice(0, 2000);
                let evt;
                try {
                    evt = JSON.parse(line);
                } catch {
                    continue;
                }
                handleEvent(evt);
            }
        });

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', d => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-8000); });

        child.on('error', err => finish(new Error(`无法启动 Claude CLI (${file}): ${err.message}`)));

        child.on('close', code => {
            if (!stoppedBySequence) {
                // 还卡在重发判定里的样本：是重复就丢弃，不是就放行
                if (mode === 'probe' && probeBuf) {
                    const duplicate = prevText.startsWith(probeBuf);
                    const pending = probeBuf;
                    probeBuf = '';
                    mode = 'pass';
                    if (!duplicate) pushDownstream(sanitizer.push(pending));
                }
                // 先把开头清理器里攒着的内容放行，再吐停止序列缓冲区的尾巴
                pushDownstream(sanitizer.flush());
                const tail = stopper.flush();
                if (tail) {
                    text += tail;
                    opts.onText?.(tail);
                }
            }

            if (!text && !reasoning && code !== 0 && !stoppedBySequence) {
                if (supportsSystemPromptFile && /unknown option[^\n]*system-prompt-file/i.test(stderr)) {
                    const err = new Error('CLI 不支持 --system-prompt-file');
                    err.code = 'NO_SYSTEM_PROMPT_FILE';
                    return finish(err);
                }
                const msg = (apiError || stderr.trim() || stdoutTail || `claude 退出码 ${code}`).slice(0, 1500);
                return finish(new Error(msg));
            }
            const aborted = Boolean(opts.signal?.aborted);
            finish(null, {
                text, reasoning, finishReason, usage, sessionId, aborted,
                // 被停止序列砍掉 / 撞上 max_tokens / 被中断时，session 里存的正文
                // 和回给 ST 的不一致，这一轮不能作为续接起点
                truncated: stoppedBySequence || finishReason === 'length' || aborted,
            });
        });

        /** 收到新一段原始文本：先过重发/续写判定，再过开头清理与停止序列 */
        function emitText(raw) {
            if (!raw) return;
            attemptText += raw;

            if (mode === 'probe') {
                probeBuf += raw;
                const need = Math.min(24, prevText.length);
                if (probeBuf.length < need) return;      // 样本还不够，继续攒
                if (prevText.startsWith(probeBuf)) {
                    // 开头一模一样 → 这是重发，跳过与上一段等长的内容后再续上
                    mode = 'skip';
                    skipRemaining = prevText.length - probeBuf.length;
                    probeBuf = '';
                    return;
                }
                // 开头不同 → 这是接着往下写；CLI 续写时常常会重叠几个字，这里削掉
                mode = 'pass';
                raw = probeBuf;
                probeBuf = '';
                const tail = prevText.slice(-40);
                for (let k = Math.min(tail.length, raw.length); k > 0; k--) {
                    if (tail.endsWith(raw.slice(0, k))) {
                        raw = raw.slice(k);
                        break;
                    }
                }
                if (!raw) return;
            } else if (mode === 'skip') {
                if (raw.length <= skipRemaining) {
                    skipRemaining -= raw.length;
                    return;
                }
                raw = raw.slice(skipRemaining);
                skipRemaining = 0;
                mode = 'pass';
            }

            pushDownstream(sanitizer.push(raw));
        }

        /**
         * Claude 5 家族的思维内容是加密的：thinking 字段为空，只有签名和 estimated_tokens。
         * 这种情况下给一条回执，否则前端的思维块空空如也，看起来像是没生效。
         */
        function emitThinkingReceipt() {
            if (placeholderSent || thinkingPlaintext > 0) return;
            if (!cfg.streamReasoning || cfg.reasoningPlaceholder === false) return;
            placeholderSent = true;
            const n = thinkingEstimated ? `约 ${thinkingEstimated} tokens` : '内容不可见';
            const note = `（模型已进行扩展思考，${n}。Claude 5 系列的思维内容由 Anthropic 加密，不对外返回明文。）`;
            reasoning += note;
            opts.onReasoning?.(note);
        }

        function pushDownstream(t) {
            if (!t) return;
            const { emit, stopped } = stopper.push(t);
            if (emit) {
                text += emit;
                opts.onText?.(emit);
            }
            if (stopped) {
                stoppedBySequence = true;
                finishReason = 'stop';
                killTree(child);
            }
        }

        function handleEvent(evt) {
            switch (evt.type) {
                case 'system':
                    if (evt.subtype === 'init') sessionId = evt.session_id || sessionId;
                    break;

                case 'stream_event': {
                    const e = evt.event;
                    if (!e) break;
                    if (e.type === 'message_start') {
                        messageStarts++;
                        if (messageStarts > 1 && attemptText) {
                            prevText = attemptText;
                            attemptText = '';
                            probeBuf = '';
                            mode = 'probe';
                            console.warn(`[claude] CLI 开始第 ${messageStarts} 段生成（重发或续写），正在重同步输出`);
                        }
                    } else if (e.type === 'content_block_start') {
                        if (e.content_block?.type === 'thinking') thinkingBlocks.add(e.index);
                    } else if (e.type === 'content_block_delta') {
                        const d = e.delta || {};
                        if (d.type === 'text_delta') emitText(d.text || '');
                        else if (d.type === 'thinking_delta') {
                            thinkingEstimated = Math.max(thinkingEstimated, Number(d.estimated_tokens) || 0);
                            thinkingPlaintext += (d.thinking || '').length;
                            if (d.thinking && cfg.streamReasoning) {
                                reasoning += d.thinking;
                                opts.onReasoning?.(d.thinking);
                            }
                        }
                    } else if (e.type === 'content_block_stop' && thinkingBlocks.has(e.index)) {
                        emitThinkingReceipt();
                    } else if (e.type === 'message_delta' && e.delta?.stop_reason) {
                        if (!stoppedBySequence) {
                            finishReason = e.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
                        }
                    }
                    break;
                }

                case 'result':
                    usage = evt.usage || null;
                    sessionId = evt.session_id || sessionId;
                    if (evt.is_error) apiError = evt.result || evt.api_error_status || 'Claude CLI 返回错误';
                    // 兜底：极少数情况下没有收到 partial deltas
                    if (!text && !stoppedBySequence && typeof evt.result === 'string' && evt.result && !evt.is_error) {
                        emitText(evt.result);
                    }
                    break;

                default:
                    break;
            }
        }

        // prompt 走 stdin，绕开 Windows 32K 命令行长度限制
        child.stdin.on('error', () => {});
        child.stdin.end(stdinPrompt, 'utf8');
    });
}

/** 启动时清掉上次残留的临时目录 */
export function sweepRuns(cfg) {
    const dir = path.join(cfg.workDir, 'runs');
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* 有残留也不影响运行 */ }
}

/** 起服务时做一次可用性自检 */
export function probeClaude(cfg) {
    const { file, needsShell } = resolveClaude(cfg.claudePath);
    const res = needsShell
        ? spawnSync(`${quoteWin(file)} --version`, { shell: true, encoding: 'utf8', windowsHide: true })
        : spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (res.error || res.status !== 0) {
        return { ok: false, file, message: res.error?.message || res.stderr || `退出码 ${res.status}` };
    }
    return { ok: true, file, version: String(res.stdout || '').trim(), os: `${os.platform()} ${os.release()}` };
}
