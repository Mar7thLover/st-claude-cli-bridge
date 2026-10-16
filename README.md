# Claude CLI Bridge

把本机已登录的 **Claude Code CLI** 包装成 **OpenAI Chat Completions 兼容接口**，供各类聊天／角色扮演前端（如 SillyTavern 的 Custom (OpenAI-compatible) 源）直接调用。Node.js 22+，无第三方运行时依赖，不需要填写 Anthropic API Key，也不读取或复制登录凭据。

## 使用

```powershell
git clone https://github.com/Mar7thLover/st-claude-cli-bridge.git
cd st-claude-cli-bridge
npm run doctor
npm start
```

Windows 下也可以双击 `start.cmd`。桥接地址：`http://127.0.0.1:8788/v1`。Claude Code 未登录时，先在自己的终端运行 `claude auth login`。

Windows 后台运行可使用 `./start-background.ps1`，停止使用 `./stop-background.ps1`。停止前先取消正在进行的生成；日志和 PID 存于 `.runtime`。前台和后台两种启动方式选一种，避免重复占用端口。

在前端中按 OpenAI Chat Completions 接口配置：

| 配置 | 值 |
| --- | --- |
| 接口类型 | OpenAI Chat Completions 兼容（SillyTavern：API 选 Chat Completion，Source 选 Custom (OpenAI-compatible)） |
| Base URL | `http://127.0.0.1:8788/v1` |
| API Key | 默认留空；设置 `server.apiKey`（或 `BRIDGE_API_KEY`）后填相同值 |
| 模型 | 从 `/v1/models` 列表中选择，如 `sonnet`；也可指定 Claude Code 支持的完整模型 ID |

角色卡、预设、Persona、世界书、作者注释等由前端负责组装（宏展开、世界书触发、深度注入、正则和历史分支选择）；桥接器只接收组装后的完整消息，不再次拼接，避免重复注入。

## 模型和思考控制

桥接器每次启动，通过 Claude Code SDK 的 `initialize` 控制消息读取当前账号的模型菜单和 effort 能力；发现菜单不发起模型生成，也不保存账号身份信息。由于 CLI 菜单只列最新模型，桥接器另外补充官方仍在服务的历史模型目录。`GET /v1/models` 返回菜单项、完整 ID、常用别名及旧版模型。`npm run models` 可随时重新查询，`npm run models -- --json` 输出详细能力。菜单随 Claude Code 版本、账号与提供商变化；用户额外配置的模型标记为 `configured`。

2026-10-16，Claude Code 2.1.301、firstParty 登录发现以下 13 个 ID／别名（归属于 4 个模型）。effort 档位取自 CLI 菜单，上下文和默认值取自[官方模型概览](https://platform.claude.com/docs/en/about-claude/models/overview)，「关闭思考」一栏是经桥接器实测的结果：

| 模型 | 可传入的 model 值 | effort（API 默认） | 关闭思考 |
| --- | --- | --- | --- |
| Opus 5.5 | `default`、`opus`、`opus[1m]`、`claude-opus-5-5` | `low`～`max` 五档（`medium`） | 不允许：模型始终思考 |
| Fable 5.1 | `fable`、`best`、`claude-fable-5-1`、`claude-fable-5-1[1m]` | 五档（`high`） | 不允许：模型始终思考 |
| Sonnet 5.5 | `sonnet`、`sonnet[1m]`、`claude-sonnet-5-5` | 五档（`high`） | 不允许：CLI 的关闭设置对它不生效 |
| Haiku 5.5 | `haiku`、`claude-haiku-5-5` | 五档（`medium`） | 不允许：同上 |

四个模型都是 1M 上下文、128K 最大输出。`default` 当前解析为 `claude-opus-5-5`，`best` 解析为 Fable 5.1。完整 ID 可用于固定版本，别名会随 CLI 升级变化（例如 `sonnet`／`haiku` 在 2026-10 从 Sonnet 5／Haiku 4.5 切换到了 5.5）。

关于 Sonnet 5.5 和 Haiku 5.5 的关闭思考：API 层面 Haiku 5.5 允许在 `high` 及以下档位关闭，Sonnet 5.5 也有最低档的 `between_tools`。但实测中，Claude Code 的 `MAX_THINKING_TOKENS=0`、`alwaysThinkingEnabled:false`、`CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` 都没能让它们停止思考：在推理题上仍会产生 250～800 个推理 token。所以桥接器不对它们开放关闭选项。想少思考，可以把 effort 降到 `low`。

模型菜单可见不等于每个请求都会通过上游服务；配额、服务错误和内容拒绝仍会原样作为失败处理。

此外，默认列表补充了以下 **10 个旧版模型**，合计 **23 个名称／别名**。2026-10-16 已用 `npm run models:check` 逐个真实生成校验，全部通过，实际返回的模型 ID 与请求一致。标为「支持」关闭思考的模型，也已用推理题实测确认关闭后推理 token 为 0：

| 旧版模型 ID | CLI effort | 关闭思考 | 状态 |
| --- | --- | --- | --- |
| `claude-fable-5` | 五档 | 不支持（始终思考） | 在服务 |
| `claude-opus-5` | 五档 | 支持，仅 `low`／`medium` 档 | 在服务 |
| `claude-opus-4-8` | 五档 | 支持 | 在服务 |
| `claude-opus-4-7` | 五档 | 支持 | 在服务 |
| `claude-opus-4-6` | `low/medium/high/max` | 支持 | 在服务 |
| `claude-opus-4-5-20251101` | CLI 不提供 effort；可用固定预算 | 支持 | 在服务 |
| `claude-sonnet-5` | 五档 | 支持 | 在服务 |
| `claude-sonnet-4-6` | `low/medium/high/max` | 支持 | 在服务 |
| `claude-sonnet-4-5-20250929` | 固定预算 | 支持 | **已弃用，2026-11-30 停用** |
| `claude-haiku-4-5-20251001` | 固定预算 | 支持 | 在服务 |

Opus 5 的特殊情况：API 只允许 Opus 5 在 `high` 及以下档位关闭思考。经桥接器实测，`high` 档关闭思考时，安全分类器仍会误报大部分请求（6 次通过 1 次），`low`／`medium` 档则 12/12 通过，推理 token 为 0。所以只开放这两档关闭思考。请求关闭思考但没指定 effort 时，自动使用 `medium`。

`npm run models:check` 会对这 10 个模型分别执行一次简短的真实桥接生成，消耗当前账户额度；只保存模型 ID、实际 ID、校验状态、错误分类和时间。结果存于 `.runtime/model-checks.json`，启动和查询命令读取时，只采纳相同提供商下最近 24 小时（`claude.modelCheckMaxAgeHours`）的记录作为 `[已验证]` 标记，过期记录按 `[未验证]` 处理。这是最近调用记录，不保证配额或账号切换后仍可用；换账号后应重新校验。校验失败只标记“最近验证失败”，不直接认定模型已停用。

以下模型已被 Anthropic 官方停用，默认不加入模型列表：Opus 4.1（2026-08-05），Opus 4／Sonnet 4（2026-06-15），Sonnet 3.7／Haiku 3.5（2026-02-19），Haiku 3（2026-04-20），Sonnet 3.5（2025-10-28），Opus 3（2026-01-05），Sonnet 3／Claude 2.x（2025-07-21），Claude 1.x／Instant（2024-11-06）。`npm run models -- --all` 或 `GET /v1/models?include_retired=1` 可查看包含这些模型完整 ID 和停用日期的目录。日期来源：[Anthropic 模型停用公告](https://platform.claude.com/docs/en/about-claude/model-deprecations)。这些生命周期规则仅用于 firstParty，第三方平台的停用时间可能不同。

直接请求示例：

```json
{
  "model": "sonnet",
  "effort": "high",
  "stream": true,
  "messages": [{ "role": "user", "content": "继续我们的故事。" }]
}
```

控制字段可采用下列方式：

| 目的 | 请求字段 |
| --- | --- |
| 调整强度 | `"effort":"low"`，也接受 `medium/high/xhigh/max` |
| 兼容 OpenAI 字段 | `"reasoning_effort":"high"`，与 `effort` 等价 |
| 使用 CLI 默认强度 | `"effort":"auto"` |
| 关闭思考 | `"effort":"none"`、`"effort":"off"`、`"thinking":false` 或 `"thinking":{"type":"disabled"}` |
| 显式开启思考 | `"thinking":true` 或 `"thinking":{"type":"enabled"}` |
| 固定思考预算（仅 `claude-haiku-4-5-20251001`、`claude-sonnet-4-5-20250929`、`claude-opus-4-5-20251101`） | `"thinking":{"type":"enabled","budget_tokens":2048}`，同时确保 `max_tokens` 大于预算；4.6 及之后的模型 API 不再接受 |
| 关闭思考但保留较低 effort | 如 `claude-sonnet-5`：`"effort":"low","thinking":false` |
| 返回思维链总结 | `"thinking_display":"summarized"`（默认），也接受 `"thinking":{"display":"summarized"}` |
| 不返回思维文本 | `"thinking_display":"omitted"` |

思维链以 `reasoning_content` 输出（流式在 delta 中，非流式在 message 中）。Claude 5 系列在 CLI 中默认不返回思维文本，只给出空的 thinking 块，前端会显示成空的「思考中」占位。桥接器默认通过 CLI 的 `--thinking-display summarized` 请求模型返回思维的**总结**（不是完整原文；这是 API 对 Claude 4 以来模型的统一做法），各模型实测都能返回。设为 `omitted` 时不返回思维文本，首个正文 token 会更快；无论哪种设置，空的思维片段都不会转发给前端。默认值可在 `config.json` 的 `claude.thinkingDisplay` 中修改。关闭思考时不能同时指定 display。

`effort` 与 `reasoning_effort` 同传时必须一致。关闭思考会向 CLI 子进程设置 `MAX_THINKING_TOKENS=0`；`none/off` 不是 CLI effort 档位，不会错误地传给 `--effort`。未指定 effort 的关闭请求使用 `high`，避免继承不兼容的高档位。显式参数会覆盖进程环境中的思考设置；所有子进程参数均按请求隔离，不修改全局 Claude 配置。

不支持的档位、对上表标为「不允许／不支持」的模型关闭思考、对 5.5 系列使用固定预算、不合法预算或冲突参数，都返回 HTTP 400，不会偷偷降级。`MAX_THINKING_TOKENS=0` 在第三方提供商上不能保证真正关闭，因此只有已核实支持的 firstParty 模型开放关闭选项。

前端可读取 `/v1/models` 中每个模型的 `effort_levels`、`can_disable_thinking` 等字段来决定显示哪些档位和开关。

能力依据：[Claude Code 模型配置](https://code.claude.com/docs/en/model-config)、[Claude API effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[Claude API thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)。本机 CLI 模型菜单中的 effort 列表优先于静态规则。

## 上下文与能力

- 支持流式 SSE、非流式 JSON、推理文本、Token 用量、取消生成、并发限制和错误返回。桥接器不对生成设置超时，请求会一直运行到 CLI 结束或客户端断开。
- 每次使用当前请求的完整上下文启动独立 Claude Code 进程，不复用 CLI 会话；修改预设、切换角色、重生成、swipe 和回退分支不会带入上次隐藏历史。
- 桥接器用 `--system-prompt-file` **替换** Claude Code 的默认系统提示，而不是追加，所以不会带入编码助手的指令和工具说明。实测替换后输入从约 2300 token 降到约 770 token。CLI 仍会在最前面固定加上一句 Claude Code 身份声明和一小段运行环境信息（工作目录为空的临时目录），这部分无法通过参数去掉。未命名的开头 system/developer 消息与桥接器的格式说明一起放进这份 system prompt；示例名称、后续 system/developer 深度注入及所有历史消息保留顺序，以 JSON 对话记录通过 stdin 传入。中文、换行、长世界书不会受 Windows 命令行长度限制。
- **这是提示词语义转换，不是原生多角色 API 透传**：CLI 只接收一次用户输入；后续 system 角色、示例角色与 assistant 前缀由说明引导模型理解。内容和顺序可验证，但指令优先级与续写效果不能保证与原生 Messages API 完全一致。
- 格式说明里刻意没有写「对话记录中的 system 条目必须在原位置生效」这类话。实测这类表述会让 Opus 5 的安全分类器把整个请求当成提示词注入而拒绝，换任何措辞都一样。去掉后，中途插入的世界书和作者注释在 8 种模型和模式组合下仍被正确遵守（`npm run smoke` 的校验码检查）。
- 末尾的 assistant 消息视为预填充前缀，通过提示要求续写、不重复，属于上述语义模拟。
- `max_tokens` / `max_completion_tokens` 映射到 CLI 的 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`；实际限制仍取决于 Claude Code 版本、模型和推理开销。`effort` / `reasoning_effort` 映射到 `--effort` 与同值环境变量，按模型校验档位。
- `stop` 在桥接层跨流式块匹配，命中后立即终止 CLI；这种提前终止拿不到最终用量，不伪造 usage。
- **temperature、top_p、top_k、min_p、惩罚、seed、logprobs、logit_bias 不受 CLI 支持**。忽略项列在 `x-claude-bridge-ignored-parameters` 响应头，非流式还返回 `bridge.ignored_parameters`。
- 当前只支持文本；图片、PDF、工具调用和结构化输出请求明确报错。
- `/v1/models` 返回 CLI 当前账号菜单、别名、完整 ID 与仍在服务的旧版模型，包含 `context_length`、`resolved_model`、`source`、`lifecycle`、`availability`、`verified_at`、`actual_model`、`effort_levels`、`can_disable_thinking`、`thinking_off_unavailable_at`。前端的「测试连接」通常只请求模型列表，真正验证生成请运行 smoke 或 `models:check`。

## 配置

所有设置集中在项目根目录的 `config.json`，直接用编辑器修改后重启桥接器生效。文件引用了 `config.schema.json`，在 VS Code 中编辑时有字段说明、补全和类型检查。启动时会严格校验：拼错的字段名、错误的类型或越界的数值都会直接报错并指出具体字段，不会被静默忽略。

取值优先级：**环境变量（含 `.env`）> `config.json` > 内置默认值**。环境变量覆盖了 `config.json` 中已写的值时，启动日志和 `npm run doctor` 会提示。`.env.example` 中的变量默认全部注释，只在需要临时覆盖时使用；空值视为未设置。`BRIDGE_CONFIG` 可指向另一份配置文件（相对路径以项目目录为基准）。

```powershell
npm run config                # 查看生效配置与来源（API Key 打码）
npm run config -- --init      # config.json 丢失时按默认值重建（不会覆盖已有文件）
npm run config -- --schema    # 修改 src/config.js 的 SETTINGS 后重新生成 schema
```

| config.json 字段 | 环境变量 | 默认值 / 用途 |
| --- | --- | --- |
| `server.host` | `BRIDGE_HOST` | `127.0.0.1`，默认仅本机；非回环地址必须设置 `apiKey` |
| `server.port` | `BRIDGE_PORT` | `8788` |
| `server.apiKey` | `BRIDGE_API_KEY` | 空；可选桥接 Bearer token，前端连接中填相同值 |
| `server.maxConcurrent` | `BRIDGE_MAX_CONCURRENT` | `2`（1–16）；满载返回 429 |
| `server.maxBodyBytes` | `BRIDGE_MAX_BODY_BYTES` | `8388608`，超过返回 413 |
| `server.allowedOrigins` | — | `[]`；允许浏览器页面直接跨域访问的 Origin，精确匹配，如 `http://127.0.0.1:8000`。前端经自己的服务端转发时不需要 |
| `server.heartbeatSeconds` | — | `10`，流式 keep-alive 间隔 |
| `server.retryAfterSeconds` | — | `3`，429 响应的 Retry-After |
| `server.logRequests` | — | `true`，记录请求 ID、模型、状态和耗时（从不记录正文） |
| `claude.bin` | `CLAUDE_BIN` | 空 = 自动寻找 `~/.local/bin/claude.exe` 或 PATH 中的 claude |
| `claude.defaultModel` | `CLAUDE_MODEL` | `sonnet`，请求未指定 model 时使用 |
| `claude.extraModels` | `BRIDGE_MODELS`（逗号分隔） | `["sonnet","opus","haiku"]`；在自动发现列表之外追加，不验证账户权限 |
| `claude.discoveryTimeoutSeconds` | — | `15`，启动时读取模型菜单的超时 |
| `claude.modelCheckMaxAgeHours` | — | `24`，`models:check` 结果视为「已验证」的有效期 |
| `claude.thinkingDisplay` | — | `summarized`；思维链返回方式，`summarized` 返回总结，`omitted` 不返回。请求中的 `thinking_display` 优先 |

`config.json` 默认不含任何密钥；如果在其中填写了 `server.apiKey`，不要把它提交到公开仓库，或改用 `.env` 中的 `BRIDGE_API_KEY`。

在 Claude Code 2.1.274～2.1.301 上实测。CLI 须支持 `--safe-mode`、`--system-prompt-file`、`--include-partial-messages`、`--thinking-display` 等参数；旧版本需升级。Windows 下 `claude.bin` 应指向原生 `.exe`，本项目不通过 shell 执行 `.cmd` 或拼接命令。

## 验证

```powershell
npm test                         # 无模型调用，单元/HTTP/进程生命周期测试
npm run doctor                   # 配置文件、本机 CLI 安装与登录状态，不打印邮箱或凭据
npm run models                   # 实时读取 CLI 菜单和 effort/关闭思考能力
npm run models -- --all          # 同时列出已停用模型完整 ID
npm run models:check             # 对 10 个仍在服务的旧版逐个真实生成校验
npm run smoke                    # 真实 Claude Code 流式生成，需要桥接器已启动；可用环境变量 SMOKE_MODEL／SMOKE_EFFORT 指定模型和档位
npm run smoke:thinking           # 真实模型 effort/关闭验证；任一生成失败返回非零
```

`smoke` 会校验角色名、用户身份、世界书地点和作者注释校验码是否都被模型正确使用。`smoke`、`smoke:thinking` 和 `models:check` 都会消耗当前登录账户的额度。`smoke:thinking` 用推理题检查关闭思考后推理 token 是否为 0（简单问题模型本来就不思考，测不出来）。

接口：`GET /health`、`GET /v1/models`、`POST /v1/chat/completions`（同时支持无 `/v1` 前缀）。`/health` 表示桥接进程存活，不代表 Claude 登录有效。

## 进程与隐私

CLI 在独立临时目录运行，关闭工具、MCP、自定义技能及会话持久化，使用 safe mode 隔离本机项目指令。桥接器不记录提示词、正文或凭据；只记录请求 ID、模型、耗时和状态。临时 system prompt 文件在完成、取消或错误后删除；突然断电或强杀整个桥接进程可能留下系统临时文件。

每次回复仍会把上下文发送到 Claude Code 当前登录的模型服务，遵循该账户的配额与模型可用性。停止桥接器可在运行终端按 Ctrl+C。默认只允许本机访问；不必将桥接器暴露到局域网。

## 许可证

MIT
