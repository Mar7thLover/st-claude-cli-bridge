/**
 * 端到端自检：拉起桥接服务，模拟 SillyTavern 的三种请求
 *   1) GET  /v1/models          —— ST 点 Connect 时的探测
 *   2) POST /v1/chat/completions (非流式)
 *   3) POST /v1/chat/completions (流式 + prefill + stop 序列)
 *
 * 用法: node scripts/selftest.js
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SELFTEST_PORT || 5601);
const BASE = `http://127.0.0.1:${PORT}/v1`;

const SYSTEM = [
    '你正在扮演角色「小雾」。',
    '外貌：银发灰瞳的少女，总是抱着一台旧收音机。',
    '性格：话少、直白，偶尔冷幽默。',
    '写作要求：中文；使用第三人称叙述加引号对话；每次回复 2 段以内；不要写用户的行动。',
].join('\n');

const HISTORY = [
    { role: 'system', content: SYSTEM },
    { role: 'assistant', name: '小雾', content: '「你来了。」她没抬头，手指还在收音机的旋钮上。' },
    { role: 'user', name: '旅人', content: '我在门口站了一会儿。「这台破收音机还能响？」' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer() {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
        cwd: ROOT,
        env: { ...process.env, BRIDGE_PORT: String(PORT), BRIDGE_HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => process.stdout.write(`  │ ${d}`));
    child.stderr.on('data', d => process.stderr.write(`  │ ${d}`));
    return child;
}

async function waitReady(timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/health`);
            if (r.ok) return true;
        } catch { /* 还没起来 */ }
        await sleep(300);
    }
    throw new Error('服务未在预期时间内就绪');
}

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

async function testModels() {
    const r = await fetch(`${BASE}/models`);
    const j = await r.json();
    check('GET /v1/models', r.ok && Array.isArray(j.data) && j.data.length > 0, `${j.data?.length ?? 0} 个模型`);
}

async function testNonStream() {
    const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: HISTORY, stream: false, max_tokens: 400 }),
    });
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content || '';
    check('非流式生成', r.ok && content.length > 0, `${content.length} 字, usage=${JSON.stringify(j.usage)}`);
    if (content) console.log(`  │ ${content.slice(0, 160).replace(/\n/g, ' ⏎ ')}…`);
}

async function testStreamWithPrefill() {
    const messages = [...HISTORY, { role: 'assistant', name: '小雾', content: '她终于抬起眼，' }];
    const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            messages, stream: true, max_tokens: 400,
            stop: ['\n旅人:', '<END>'],
        }),
    });
    check('流式响应头', r.ok && (r.headers.get('content-type') || '').includes('text/event-stream'));

    let text = '';
    let chunks = 0;
    let done = false;
    let finish = null;
    let error = null;

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 2);
            if (!raw.startsWith('data:')) continue;
            const payload = raw.slice(5).trim();
            if (payload === '[DONE]') { done = true; continue; }
            const j = JSON.parse(payload);
            if (j.error) { error = j.error.message; continue; }
            const delta = j.choices?.[0]?.delta || {};
            if (typeof delta.content === 'string' && delta.content) { text += delta.content; chunks++; }
            if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
        }
    }

    check('流式 [DONE]', done);
    check('流式分片', chunks > 1, `${chunks} 个分片 / ${text.length} 字`);
    check('finish_reason', Boolean(finish), String(finish));
    check('无错误', !error, error || '');
    check('prefill 未被重复吐出', !text.trimStart().startsWith('她终于抬起眼，'));
    if (text) console.log(`  │ 她终于抬起眼，${text.slice(0, 160).replace(/\n/g, ' ⏎ ')}…`);
}

async function main() {
    console.log('\n拉起桥接服务…');
    const child = startServer();
    try {
        await waitReady();
        console.log('\n开始自检：');
        await testModels();
        await testNonStream();
        await testStreamWithPrefill();
    } finally {
        child.kill();
    }
    console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('自检异常:', err);
    process.exit(1);
});
