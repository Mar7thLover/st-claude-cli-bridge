/**
 * 会话续接（sessionMode）：让 CLI 以 --resume 只接收「新增的那一轮」，
 * 从而把整段历史留在 Anthropic 的前缀缓存里。
 *
 * 为什么不按文本前缀匹配：
 *   session 里存的是模型的原始输出，而 ST 回传的是被 OutputSanitizer 清理、
 *   被停止序列截断之后的正文，两者对不上，文本前缀会永远 miss 并静默退化。
 *   所以这里按「每条渲染后的对话行」的哈希链匹配——既免疫渲染差异，
 *   又能让「用户编辑了历史消息」直接表现为链断裂，自动回退到全量重放。
 *
 * 状态机（每轮都 fork，父节点保持干净，这正是 swipe 需要的语义）：
 *   chain = [h(第1行) … h(第N行)]，是这次请求发出去的全部对话行
 *   命中条件：systemHash 相同，且某个已存状态的 chain 是本次 chain 的真前缀
 *   delta   = 本次 chain 里多出来的那几行
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const hash = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 24);

/** Claude Code 把 cwd 里的非字母数字全部换成 '-' 作为 projects 下的目录名 */
function slugify(dir) {
    return String(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

function projectsRoot() {
    return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * 会话文件的清理策略。默认什么都不删——它们是可读的对话记录，
 * 也能用 `claude --resume <id>` 直接接着聊，该不该留是用户自己的事。
 *   off（默认）：全部保留，自行清理
 *   gc        ：只回收被淘汰的、以及无法续接的那些 fork，退出时保留
 *   all       ：gc 的基础上，启动和退出时清空本桥接产生的全部会话
 */
const recycles = cfg => cfg.sessionCleanup === 'gc' || cfg.sessionCleanup === 'all';

/** sessionMode 下固定的工作目录：所有 session 文件因此落在同一个 slug 里，便于回收 */
export function sessionCwd(cfg) {
    return path.join(cfg.workDir, 'session');
}

function isPrefix(a, b) {
    if (a.length >= b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export class SessionStore {
    constructor(cfg) {
        this.cfg = cfg;
        this.states = [];   // {sessionId, systemHash, chain, lastUsed}
        this.hits = 0;
        this.misses = 0;
    }

    /**
     * 找出可以续接的最长状态。
     * @returns {{sessionId:string, from:number}|null} from = delta 的起始行号
     */
    plan(systemHash, chain) {
        let best = null;
        for (const s of this.states) {
            if (s.systemHash !== systemHash) continue;
            if (!isPrefix(s.chain, chain)) continue;
            if (!best || s.chain.length > best.chain.length) best = s;
        }
        if (!best) {
            this.misses++;
            return null;
        }
        this.hits++;
        best.lastUsed = Date.now();
        return { sessionId: best.sessionId, from: best.chain.length };
    }

    /** 本轮成功且可续接：把「请求的对话行 + 本次回复行」记成新状态 */
    commit({ sessionId, systemHash, chain }) {
        if (!sessionId) return;
        this.states.push({ sessionId, systemHash, chain, lastUsed: Date.now() });
        this.gc();
    }

    /** 本轮不可续接（prefill / 带图 / 被截断 / 中断）：fork 出来的会话不会再被用到 */
    drop(sessionId) {
        if (!sessionId || !recycles(this.cfg)) return;
        removeSessionFile(this.cfg, sessionId);
    }

    gc() {
        const ttl = Math.max(60000, Number(this.cfg.sessionTtlMs) || 7200000);
        const max = Math.max(2, Number(this.cfg.sessionMaxStates) || 12);
        const now = Date.now();

        const alive = [];
        const dead = [];
        for (const s of this.states) (now - s.lastUsed > ttl ? dead : alive).push(s);

        // 超出上限时淘汰最久未用的
        alive.sort((a, b) => a.lastUsed - b.lastUsed);
        while (alive.length > max) dead.push(alive.shift());

        // 状态表本身始终有上限（否则内存和匹配开销无界），只有「要不要连文件一起删」看配置
        this.states = alive;
        if (recycles(this.cfg)) for (const s of dead) removeSessionFile(this.cfg, s.sessionId);
    }

    stats() {
        return { states: this.states.length, hits: this.hits, misses: this.misses };
    }
}

/** 找到某个 session 的 jsonl：先按 slug 直取，取不到再扫一遍 projects */
function findSessionFile(cfg, sessionId) {
    const direct = path.join(projectsRoot(), slugify(sessionCwd(cfg)), `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) return direct;

    try {
        for (const dir of fs.readdirSync(projectsRoot())) {
            const p = path.join(projectsRoot(), dir, `${sessionId}.jsonl`);
            if (fs.existsSync(p)) return p;
        }
    } catch { /* 没有 projects 目录就算了 */ }
    return null;
}

function removeSessionFile(cfg, sessionId) {
    const file = findSessionFile(cfg, sessionId);
    if (file) fs.rm(file, { force: true }, () => {});
}

/**
 * 清空本桥接自己产生的全部会话文件，仅在 sessionCleanup="all" 时执行。
 * 状态只存在内存里，进程重启后旧文件不会再被续接，所以启动和退出时各扫一次。
 */
export function sweepSessions(cfg) {
    if (!cfg.sessionMode) return;

    // 本地工作目录里只有 system.txt 和图片这类一次性文件，崩溃残留没有保留价值，始终清
    const dirs = [sessionCwd(cfg)];
    if (cfg.sessionCleanup === 'all') dirs.push(path.join(projectsRoot(), slugify(sessionCwd(cfg))));

    for (const dir of dirs) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* 删不掉不影响运行 */ }
    }
}
