# SillyTavern ⇄ Claude CLI 桥接

把本机的 **Claude Code CLI（`claude -p`）** 包装成一个 OpenAI 兼容端点，
让 SillyTavern 通过 **Custom (OpenAI-compatible)** 源直接用上 Claude，
同时完整保留 ST 的预设、角色卡、世界书、深度注入和助手预填充。

- 零依赖，纯 Node（>= 20），不需要 `npm install`
- 不需要 API Key：直接复用 `claude` 已登录的账号
- 支持流式、停止序列、预填充、图片附件、思考过程

---

## 快速开始

1. 确认 CLI 可用（已安装并登录 Claude Code）：

   ```powershell
   claude --version
   ```

2. 拉下仓库并启动桥接：双击 `start.bat`，或

   ```powershell
   git clone https://github.com/Mar7thLover/st-claude-cli-bridge.git
   cd st-claude-cli-bridge
   node src\server.js
   ```

   看到 `端点: http://127.0.0.1:5599/v1` 即为就绪。

3. 在 SillyTavern 里：

   | 位置 | 填什么 |
   | --- | --- |
   | API | **Chat Completion** |
   | Chat Completion Source | **Custom (OpenAI-compatible)** |
   | Custom Endpoint (Base URL) | `http://127.0.0.1:5599/v1` |
   | Custom API Key | 留空（除非在 `config.json` 里设了 `apiKey`） |
   | Available Models | 点 **Connect** 后从下拉里选，例如 `claude-sonnet-5` |

4. 点 Connect，正常聊天即可。

---

## 它到底做了什么

ST 会把预设、角色卡、世界书、聊天记录组装成一个 OpenAI 风格的 `messages` 数组发过来。
桥接按下面的规则把它翻译成一次 `claude -p` 调用：

| ST 送来的东西 | 桥接的处理 |
| --- | --- |
| 开头连续的 `system` 消息（预设 + 角色卡 + 世界书主体） | 写成临时文件，通过 `--system-prompt-file` 完整替换掉 Claude Code 自带的「编程助手」人设 |
| 对话中间的 `system` 消息（深度注入、作者注释） | **保持原位**，以 `System:` 的形式渲染进对话记录，不破坏注入深度 |
| `user` / `assistant` 消息 | 渲染成 `Human:` / `Assistant:` 的对话记录，带 `name` 时渲染为 `Human (旅人):` |
| 末尾的 `assistant` 消息（助手预填充） | CLI 无法直接下发 prefill，转成「从断点无缝续写」的指令；若模型仍然复述了开头，桥接会自动裁掉 |
| 正文（可能上百 KB） | 走 **stdin**，绕开 Windows 32K 命令行长度限制 |
| `stop` 停止序列 | 由桥接在流里做匹配，命中即截断并立刻杀掉子进程（CLI 本身没有这个参数） |
| 图片附件 | 落盘到临时目录，仅开放 `Read` 工具让模型读取，用完即删 |
| 工具调用 / function calling | 不支持，会被忽略 |

生成侧固定使用 `--tools ""`（禁用全部工具）、`--setting-sources ""`、`--no-session-persistence`、
`--disable-slash-commands`，并关闭遥测与非必要后台请求，让它老老实实只做一次文本生成。

---

## 关于「扩展思考」

`config.json` 里是 **`"thinking": false`**（关闭）。原因见下面的实测表：Claude 5 家族
的思维内容全部加密，开着只是白花 token 和时间，ST 那边什么也看不到。

想临时开启，用模型名后缀，无需改配置：

- `claude-opus-5:think`、`claude-opus-5:think:xhigh` —— 这次思考，可叠加 effort
- `claude-sonnet-5:nothink` —— 全局开启时用来单次关闭

后缀支持 `:think` / `:nothink` / `:low` / `:medium` / `:high` / `:xhigh` / `:max`，
写不认识的后缀时整串会原样当模型名下发。想在 ST 下拉里直接选到，
把带后缀的名字加进 `config.json` 的 `models` 数组即可（已预置了几个 `:think`）。

### 各模型的思维内容暴露程度（实测）

同一个解谜任务，抓 `thinking_delta` 事件：

| 模型 | 有 thinking 块 | 明文内容 | `estimated_tokens` |
| --- | --- | --- | --- |
| `claude-opus-5` | 有 | **0 字（加密）** | 50 |
| `claude-fable-5` | 有 | **0 字（加密）** | 50 |
| `claude-sonnet-5` | 有 | **0 字（加密）** | 50 |
| `claude-haiku-4-5-20251001` | 有 | **347 字明文摘要** | null |

Claude 5 家族只返回签名和 token 估计，思维正文由 Anthropic 加密，不对外给明文——
思考**确实在跑**（计入 output_tokens），但 ST 的思维折叠块拿不到内容。
只有上一代的 Haiku 4.5 还会返回梳理后的明文摘要。

因此桥接在「有思考块但没有明文」时会推一条回执，免得思维块空空如也看起来像没生效：

> （模型已进行扩展思考，约 50 tokens。Claude 5 系列的思维内容由 Anthropic 加密，不对外返回明文。）

不想要这条回执就设 `"reasoningPlaceholder": false`。

### 两个需要预期管理的点

1. **Sonnet 5 是自适应思考**：角色扮演这类创作任务，它经常直接跳过思考块，
   即使 `thinking` 开着也是 0 思考。这不是桥接失效，是模型自己判断不需要。
2. **思考很贵**。早期用 Haiku 4.5 实测一条 80 字场景描写：思考开 6638 output tokens / 51 秒，
   思考关 154 tokens / 2.5 秒。Claude 5 家族的自适应策略要克制得多，但开启前仍要有心理准备。
   嫌慢嫌贵就用 `:nothink` 后缀，或把 `config.json` 的 `thinking` 改回 `false`。

---

## 关于 max_tokens——默认不硬下发

CLI 把输出上限当成**硬错误**：一旦撞上，它会先重发一遍同样的内容、再自动续写，最后直接报
`API Error: Claude's response exceeded the N output token maximum`。ST 的默认值（常见 300~1000）
几乎必然撞上，所以桥接默认只在 `max_tokens >= 2048` 时才真的下发。

| `maxTokensMode` | 行为 |
| --- | --- |
| `"auto"`（默认） | 仅当 `max_tokens >= minHardMaxTokens`（默认 2048）时下发 |
| `"always"` | 总是下发。桥接会识别 CLI 的重发/续写并做重同步去重，但接缝处仍可能不自然 |
| `"off"` | 完全不下发 |

想控制回复长度，更可靠的做法是写进 ST 预设里（「每次回复 2 段以内」这类），而不是靠 `max_tokens`。

---

## 配置

编辑 `config.json` 后重启生效。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `host` / `port` | `127.0.0.1` / `5599` | 监听地址。要让局域网内其它设备连，改成 `0.0.0.0` |
| `apiKey` | `""` | 设了就要求 `Authorization: Bearer <key>`，ST 里填到 Custom API Key |
| `claudePath` | `"claude"` | 找不到时填 `claude.exe` 绝对路径 |
| `defaultModel` | `claude-sonnet-5` | ST 没传模型时用它 |
| `defaultEffort` | `""` | `low`/`medium`/`high`/`xhigh`/`max` |
| `thinking` / `thinkingTokens` | `false` / `4000` | 扩展思考开关与预算 |
| `reasoningPlaceholder` | `true` | 思维内容被加密时，推一条「思考已执行」的回执给 ST |
| `maxTokensMode` / `minHardMaxTokens` | `auto` / `2048` | 见上一节 |
| `applyStop` | `true` | 是否处理 ST 的停止序列 |
| `images` | `true` | 是否支持图片附件 |
| `streamReasoning` | `true` | 思考过程作为 `reasoning_content` 推给 ST（ST 会显示在思维折叠块里） |
| `stripLeadingLabel` | `true` | 自动裁掉模型带出的 `小雾：` / `Assistant:` 前缀 |
| `maxConcurrent` | `2` | 同时允许几个 `claude` 进程，超出的排队 |
| `timeoutMs` | `600000` | 单次生成超时 |
| `workDir` | `".sandbox"` | 子进程的工作目录，每次请求在其下建临时目录，用完删除 |
| `extraArgs` | `[]` | 追加给 `claude` 的原始参数 |
| `debug` / `logPrompts` / `logDir` | `false` | `debug` 会保留临时目录与打印摘要；`logPrompts` 把每次的 system/prompt 全文落盘到 `logs/` |
| `systemPreamble` | 见文件 | 拼在 ST 预设**前面**的一段话，用来抹掉「编程助手」身份 |
| `finalInstruction` / `prefillInstruction` / `transcriptHeader` / `roleLabels` | 见文件 | 对话记录的渲染模板，想改提示词风格改这里 |

环境变量可覆盖：`BRIDGE_HOST`、`BRIDGE_PORT`、`BRIDGE_API_KEY`、`BRIDGE_MODEL`、`BRIDGE_CLAUDE_PATH`、`BRIDGE_DEBUG`。

---

## 已知限制

- **`temperature` / `top_p` / `top_k` / `presence_penalty` / `frequency_penalty` / `seed` / `logit_bias` 全部无效**——
  `claude -p` 没有对应参数，ST 里调了也不会有任何作用。这是 CLI 的能力边界，不是桥接的取舍。
- **不支持工具调用 / function calling**，ST 送来的 `tools` 会被忽略。
- **计费与额度走 Claude Code 账号**，不是 API Key 计费；额度耗尽时 CLI 会报错，桥接原样透传给 ST。
- 每次请求都是全新会话（不用 `--resume`），因为 ST 每轮都会重发完整上下文，复用会话反而会重复注入。
- 子进程的工作目录在 `workDir` 下。如果你在仓库根目录里放了 `CLAUDE.md`，它会被 CLI 自动读入并污染人设——别放。

---

## 自检

```powershell
node scripts\unit.js      # 纯逻辑单测，不花钱
node scripts\selftest.js  # 端到端：拉起服务，跑 /models + 非流式 + 流式(带预填充和停止序列)
```

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| ST 点 Connect 报错 | 先浏览器打开 `http://127.0.0.1:5599/health`，能出 JSON 说明服务活着；确认 Base URL 结尾是 `/v1` |
| 启动就退出，说找不到 CLI | `config.json` 的 `claudePath` 填 `claude.exe` 绝对路径（`(Get-Command claude).Source` 可查） |
| 回复里带「Assistant:」前缀 | 应该已被自动裁掉；若是别的标签，把它加进 `roleLabels` 或角色卡的 name |
| 回复被莫名截断 | 检查 ST 的停止序列（Custom 源里可自定义），以及 `max_tokens` 是否被设成了很小的值 |
| 回复很慢、烧 token 很多 | 确认没打开 `thinking`，也没在模型名里带 `:think` |
| 想看到底发了什么给模型 | `config.json` 里 `"logPrompts": true`，然后看 `logs/prompt-*.txt` |

---

## 许可

MIT，见 [LICENSE](LICENSE)。

本项目是个人自用的非官方小工具，与 Anthropic 和 SillyTavern 均无关联。
它只是在本机调用你自己已登录的 `claude` CLI，用量与计费都走你自己的 Claude Code 账号，
请自行确认符合你所用服务的条款。
