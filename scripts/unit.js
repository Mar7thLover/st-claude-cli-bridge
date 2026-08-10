/** 纯函数单测（不调用 API）: node scripts/unit.js */
import assert from 'node:assert/strict';
import { buildPrompt, StopWatcher, OutputSanitizer, normalizeContent } from '../src/messages.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
let n = 0;
const test = (name, fn) => {
    try {
        fn();
        n++;
        console.log(`  ✔ ${name}`);
    } catch (err) {
        console.log(`  ✘ ${name}\n     ${err.message}`);
        process.exitCode = 1;
    }
};

console.log('\nmessages.js:');

test('开头的 system 段被提升为 system prompt', () => {
    const r = buildPrompt([
        { role: 'system', content: '角色卡A' },
        { role: 'system', content: '预设B' },
        { role: 'user', content: '你好' },
    ], cfg);
    assert.ok(r.system.includes('角色卡A') && r.system.includes('预设B'));
    assert.ok(!r.prompt.includes('角色卡A'));
    assert.ok(r.prompt.includes('你好'));
});

test('对话中间的 system（深度注入）保持原位', () => {
    const r = buildPrompt([
        { role: 'system', content: '预设' },
        { role: 'user', content: '第一句' },
        { role: 'system', content: '[OOC: 请写长一点]' },
        { role: 'user', content: '第二句' },
    ], cfg);
    assert.ok(!r.system.includes('OOC'));
    const iA = r.prompt.indexOf('第一句');
    const iB = r.prompt.indexOf('OOC');
    const iC = r.prompt.indexOf('第二句');
    assert.ok(iA < iB && iB < iC, '注入位置被打乱');
});

test('末尾 assistant 被识别为 prefill', () => {
    const r = buildPrompt([
        { role: 'system', content: '预设' },
        { role: 'user', content: '在？' },
        { role: 'assistant', content: '她抬起头，' },
    ], cfg);
    assert.equal(r.prefill, '她抬起头，');
    assert.ok(r.prompt.includes('<partial_response>'));
});

test('中间的 assistant 不算 prefill', () => {
    const r = buildPrompt([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
    ], cfg);
    assert.equal(r.prefill, '');
    assert.ok(r.prompt.includes('Assistant:'));
});

test('name 字段渲染进说话人标签', () => {
    const r = buildPrompt([
        { role: 'user', name: '旅人', content: '嗨' },
        { role: 'assistant', name: '小雾', content: '嗯' },
        { role: 'user', name: '旅人', content: '走吧' },
    ], cfg);
    assert.ok(r.prompt.includes('Human (旅人):'));
    assert.ok(r.assistantLabels.includes('小雾'));
});

test('对话示例还原成正确的说话人', () => {
    const r = buildPrompt([
        { role: 'system', content: '角色卡' },
        { role: 'system', name: 'example_user', content: '示例提问' },
        { role: 'system', name: 'example_assistant', content: '示例回答' },
        { role: 'user', content: '正式提问' },
    ], cfg);
    assert.ok(r.prompt.includes('Human (示例):'), '示例 user 未还原');
    assert.ok(r.prompt.includes('Assistant (示例):'), '示例 assistant 未还原');
    assert.ok(!r.prompt.includes('example_assistant'), '仍然带着原始 name');
});

test('分段 content 与图片被正确拆分', () => {
    const png = 'iVBORw0KGgo=';
    const r = normalizeContent([
        { type: 'text', text: '看这个' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    ]);
    assert.equal(r.text, '看这个');
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0].mime, 'image/png');
});

console.log('\nStopWatcher:');

test('命中停止序列时截断', () => {
    const w = new StopWatcher(['<END>']);
    let out = '';
    let stopped = false;
    for (const c of '你好世界<END>后面不要') {
        const r = w.push(c);
        out += r.emit;
        if (r.stopped) { stopped = true; break; }
    }
    assert.equal(stopped, true);
    assert.equal(out, '你好世界');
});

test('不会提前吐出停止序列的前缀', () => {
    const w = new StopWatcher(['<END>']);
    const a = w.push('abc<EN');
    assert.equal(a.emit, 'abc');       // '<EN' 被扣在缓冲里
    const b = w.push('D>xx');
    assert.equal(b.stopped, true);
    assert.equal(b.emit, '');
});

test('无停止序列时完全透传', () => {
    const w = new StopWatcher([]);
    assert.equal(w.push('随便什么').emit, '随便什么');
});

console.log('\nOutputSanitizer:');

test('去掉重复吐出的 prefill', () => {
    const s = new OutputSanitizer({ prefill: '她抬起头，' });
    let out = s.push('她抬起头，') + s.push('灰瞳一闪。');
    out += s.flush();
    assert.equal(out, '灰瞳一闪。');
});

test('模型没重复 prefill 时原样保留', () => {
    const s = new OutputSanitizer({ prefill: '她抬起头，' });
    let out = s.push('灰瞳一闪，') + s.push('然后转身。');
    out += s.flush();
    assert.equal(out, '灰瞳一闪，然后转身。');
});

test('去掉「小雾：」这类说话人前缀', () => {
    const s = new OutputSanitizer({ labels: ['小雾', 'Assistant'] });
    let out = s.push('小雾：') + s.push('「走吧。」');
    out += s.flush();
    assert.equal(out, '「走吧。」');
});

test('正文里的冒号不受影响', () => {
    const s = new OutputSanitizer({ labels: ['小雾'] });
    let out = s.push('她说：「小雾：这名字真怪。」');
    out += s.flush();
    assert.equal(out, '她说：「小雾：这名字真怪。」');
});

console.log(`\n${n} 项通过${process.exitCode ? '，有失败 ❌' : ' ✅'}\n`);
