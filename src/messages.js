/**
 * 把 SillyTavern 送来的 OpenAI 风格 messages，转换成 Claude CLI 需要的
 * 「一段 system prompt + 一段 stdin 正文」。
 *
 * 设计要点：
 *  - 只把「开头连续的 system 消息」提升为 --system-prompt-file 的内容
 *    （ST 的预设、角色卡、世界书主体都在这里）；
 *  - 出现在对话中间的 system 消息（ST 的深度注入、作者注释等）保持原位，
 *    以 [System] 形式渲染进对话记录，避免破坏注入深度的语义；
 *  - 末尾的 assistant 消息识别为 prefill（ST 的「助手预填充」），
 *    转成「续写指令」，因为 CLI 无法直接下发 prefill。
 */

/** 把 content（string | 分段数组）拆成纯文本 + 图片列表 */
export function normalizeContent(content) {
    if (content == null) return { text: '', images: [] };
    if (typeof content === 'string') return { text: content, images: [] };

    const texts = [];
    const images = [];

    for (const part of Array.isArray(content) ? content : [content]) {
        if (typeof part === 'string') {
            texts.push(part);
            continue;
        }
        if (!part || typeof part !== 'object') continue;

        if (part.type === 'text' && typeof part.text === 'string') {
            texts.push(part.text);
        } else if (part.type === 'image_url' && part.image_url?.url) {
            const parsed = parseDataUrl(part.image_url.url);
            if (parsed) images.push(parsed);
        } else if (part.type === 'image' && part.source?.data) {
            // Anthropic 风格分段，顺手兼容
            images.push({ mime: part.source.media_type || 'image/png', data: part.source.data });
        } else if (typeof part.text === 'string') {
            texts.push(part.text);
        }
    }

    return { text: texts.join('\n'), images };
}

function parseDataUrl(url) {
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(url));
    if (!m) return null;
    return { mime: m[1], data: m[2] };
}

function extFromMime(mime) {
    const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
    return map[String(mime).toLowerCase()] || 'png';
}

/**
 * @param {Array} messages ST 发来的 messages
 * @param {object} cfg 配置
 * @returns {{system:string, prompt:string, images:Array<{name:string,mime:string,data:string}>, prefill:string}}
 */
export function buildPrompt(messages, cfg) {
    const list = (Array.isArray(messages) ? messages : []).filter(m => m && typeof m === 'object');

    const systemParts = [];
    let i = 0;
    // 1) 抽取开头连续的 system 段。对话示例虽然也是 role=system，但必须留在对话记录里
    //    按说话人渲染，否则角色卡的示例对话会退化成一坨没有轮次的旁白。
    while (i < list.length && list[i].role === 'system' && !isExample(list[i])) {
        const { text } = normalizeContent(list[i].content);
        if (text.trim()) systemParts.push(text.trim());
        i++;
    }

    const rest = list.slice(i);

    // 2) 末尾 assistant 视为 prefill
    let prefill = '';
    let body = rest;
    if (rest.length && rest[rest.length - 1].role === 'assistant') {
        const { text } = normalizeContent(rest[rest.length - 1].content);
        if (text.trim()) {
            prefill = text.replace(/\s+$/, '');
            body = rest.slice(0, -1);
        }
    }

    // 3) 渲染对话记录
    const images = [];
    const lines = [];
    for (const msg of body) {
        const { text, images: imgs } = normalizeContent(msg.content);
        const label = labelFor(msg, cfg);

        const refs = [];
        for (const img of imgs) {
            if (!cfg.images) continue;
            const name = `image_${images.length + 1}.${extFromMime(img.mime)}`;
            images.push({ name, ...img });
            refs.push(`[附带图片: ${name}]`);
        }

        const content = [text.trim(), refs.join(' ')].filter(Boolean).join('\n');
        if (!content) continue;
        lines.push(`${label}:\n${content}`);
    }

    const transcript = lines.join('\n\n');

    // 4) 拼装
    const system = [cfg.systemPreamble, systemParts.join('\n\n')]
        .map(s => (s || '').trim())
        .filter(Boolean)
        .join('\n\n');

    const promptChunks = [];
    if (cfg.transcriptHeader) promptChunks.push(cfg.transcriptHeader.trim());
    promptChunks.push(transcript || '(空对话)');
    if (prefill) {
        promptChunks.push(String(cfg.prefillInstruction || '').replace('{{prefill}}', prefill).trim());
    } else if (cfg.finalInstruction) {
        promptChunks.push(cfg.finalInstruction.trim());
    }

    return {
        system: system || '你是一个专业的创意写作助手。',
        prompt: promptChunks.filter(Boolean).join('\n\n'),
        images,
        prefill,
        assistantLabels: assistantLabels(body, cfg),
    };
}

/** 收集所有可能被模型误当成前缀吐出来的「说话人标签」 */
function assistantLabels(body, cfg) {
    const set = new Set([cfg.roleLabels.assistant || 'Assistant']);
    for (const msg of body) {
        if (msg.role !== 'assistant') continue;
        set.add(labelFor(msg, cfg));
        if (typeof msg.name === 'string' && msg.name.trim()) set.add(msg.name.trim());
    }
    return [...set].filter(Boolean);
}

/** ST 的对话示例：role=system 且 name=example_user / example_assistant */
function isExample(msg) {
    const name = typeof msg.name === 'string' ? msg.name.trim() : '';
    return name === 'example_user' || name === 'example_assistant';
}

function labelFor(msg, cfg) {
    const name = typeof msg.name === 'string' ? msg.name.trim() : '';

    // ST 的「对话示例」是以 role=system + name=example_user/example_assistant 发过来的，
    // 按 system 渲染会把角色卡的示例对话变成旁白，这里还原成正确的说话人。
    if (name === 'example_user') return `${cfg.roleLabels.user || 'Human'} (示例)`;
    if (name === 'example_assistant') return `${cfg.roleLabels.assistant || 'Assistant'} (示例)`;

    const base = cfg.roleLabels[msg.role] || msg.role || 'Human';
    return name && name.toLowerCase() !== msg.role ? `${base} (${name})` : base;
}

/**
 * 开头清理器：只作用于回复的最前面，用来
 *   1) 去掉模型重复吐出的 prefill；
 *   2) 去掉「小雾：」「Assistant:」这类被模型带出来的说话人前缀。
 * 一旦判定完成就完全透传，不再有任何开销。
 */
export class OutputSanitizer {
    constructor({ prefill = '', labels = [], stripLabel = true } = {}) {
        this.candidates = [];
        if (prefill) this.candidates.push(prefill);
        if (stripLabel) {
            for (const l of labels) {
                for (const sep of [':', '：', ': ', '：']) this.candidates.push(`${l}${sep}`);
            }
        }
        this.buf = '';
        this.done = this.candidates.length === 0;
    }

    push(chunk) {
        if (this.done) return chunk;
        this.buf += chunk;
        return this.#decide(false);
    }

    flush() {
        if (this.done) return '';
        return this.#decide(true);
    }

    #decide(ended) {
        const lead = this.buf.replace(/^\s+/, '');
        if (!lead) return ended ? this.#finish('') : '';

        for (const c of this.candidates) {
            if (lead.startsWith(c)) return this.#finish(lead.slice(c.length).replace(/^[\s:：]+/, ''));
        }
        if (!ended && this.candidates.some(c => c.startsWith(lead))) return ''; // 还可能是前缀，继续攒
        return this.#finish(lead);
    }

    #finish(out) {
        this.done = true;
        this.buf = '';
        return out;
    }
}

/** 停止序列匹配：带回退缓冲，避免把停止串的前缀先吐给前端 */
export class StopWatcher {
    constructor(stops) {
        this.stops = (Array.isArray(stops) ? stops : stops ? [stops] : [])
            .filter(s => typeof s === 'string' && s.length > 0);
        this.max = this.stops.reduce((a, s) => Math.max(a, s.length), 0);
        this.buf = '';
    }

    /** @returns {{emit:string, stopped:boolean}} */
    push(chunk) {
        if (!this.stops.length) return { emit: chunk, stopped: false };
        this.buf += chunk;

        let hit = -1;
        for (const s of this.stops) {
            const idx = this.buf.indexOf(s);
            if (idx >= 0 && (hit < 0 || idx < hit)) hit = idx;
        }
        if (hit >= 0) {
            const emit = this.buf.slice(0, hit);
            this.buf = '';
            return { emit, stopped: true };
        }

        // 只扣住「有可能是某个停止序列开头」的那段结尾，其余立刻放行
        let keep = 0;
        const maxKeep = Math.min(this.max - 1, this.buf.length);
        for (let k = maxKeep; k > 0; k--) {
            const tail = this.buf.slice(-k);
            if (this.stops.some(s => s.startsWith(tail))) {
                keep = k;
                break;
            }
        }
        const cut = this.buf.length - keep;
        const emit = this.buf.slice(0, cut);
        this.buf = this.buf.slice(cut);
        return { emit, stopped: false };
    }

    flush() {
        const out = this.buf;
        this.buf = '';
        return out;
    }
}
