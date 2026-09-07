# Janus CLI TUI 实施文档（类 opencode 常驻终端）

> 位置：`packages/cli/doc/TUI-IMPLEMENTATION.md`
> 目标：`janus` 无参（或 `janus tui`）进入常驻交互终端，多轮可用；保留 `janus chat -- "prompt"` 单轮 headless 不变。
> 现状基线：Node v24.14.1 / npm 11.11.0 / `ai@3.4.33` + `@ai-sdk/openai@3` / `dist/cli.js` 已可 `build` 通过。
> 约束（v2 新增）：本 TUI 必须能以**原生终端形态**迁入 JanusX chat，且 JanusX 能**灵活复用 janus-agentX 能力**（既能 PTY spawn `janus tui`，也能进程内 `import runChatTurn/session`）。

---

## 0. 顶层原则（JanusX 迁移前置，不可违背）

1. **library-first，CLI 是薄客户端**：`agent-core / chat-core / janus-agent` 保持零 Electron、零 Ink、零 React（现状 `PORTS.md` 已保证），TUI 只依赖 facade + ports，不反向污染。JanusX 主进程直接 `import @janus-agent/janus-agent`，不经过 CLI 二进制。
2. **双消费设计**：
   - (a) **PTY 消费**：JanusX 原生终端（`node-pty` + `xterm.js`）`spawn janus tui`，与 `claude/codex/opencode` 同等地位；
   - (b) **进程内消费**：JanusX Chat UI（`ChatContent.tsx` + `llm-handlers/chat-orchestrator`）经 ports 适配器直调 `runChatTurn`，不走 PTY。
   - `session.ts + store.ts + commands.ts + config.ts` 必须写成**纯逻辑+可注入 IO**，两边复用同一份；只有 `App.tsx/renderers.tsx` 是 Ink 专属。
3. **契约冻结**：工具名（`workspace.* / project.* / git.* / command.run`，见 `agent-core/.../PORTS.md` 工具名契约）、`ChatAgentEvent` 红字规则（参数值不出 UI，只出 `argumentKeys`）、`chat` 单轮 JSONL 输出，三者都不因 TUI 而改。

---

## 1. 现状分析

| 位置 | 现状 | 结论 |
|---|---|---|
| `packages/cli/src/cli.ts:37 runChat` | 每次新建 `createAgentRuntime` + `createSession(approvalMode:auto-run)`，`messages=[单条user]`，跑完 `return 0` 进程退出，`stdout=JSON.stringify({requestId,event})` | 单轮 headless，无历史、无常驻、无人读渲染 |
| `packages/cli/src/args.ts:9` | 仅 `chat/version/help`，`prompt` 必填（`124-126`），无 `tui`/无参分支 | 入口层就不支持常驻 |
| `packages/janus-agent/src/orchestrator/chat-turn.ts:52,112,185` | `runChatTurn(request: ChatTurnRequest, ports, {onEvent}, signal)` 已支持 `messages[] + toolTraces + chatSession(ChatSessionRuntime) + conversationId` 多轮；`ports.streamTextFn` 可注入 | 引擎侧已就绪，TUI 只需“复用 session + 累积历史 + 换渲染器” |
| JanusX `src/main/janus-agent/chat-orchestrator.ts`（约 700 行） | 自有 `abortControllers + chatSessions(LRU 32) + 40ms delta 合批 + knowledge recall/capture + workspace 工具装配`，与 `runChatTurn` 行为对等但实现独立 | 迁移时做“壳适配 + 双测”，不直接删 |
| JanusX `src/main/terminal/manager.ts + src/main/ipc/terminal-handlers.ts + src/shared/terminalLaunch.ts + src/shared/ipc/terminal.ts` | `node-pty` spawn、16ms 输出合批、resize/replay/kill、preset 目前仅 `shell/claude/codex/opencode`、状态 `wait/running/error` 经 hooks 判定 | `janus tui` 以新 preset 接入，须满足同一套 PTY 生命周期 |

---

## 2. 目标形态（MVP 即 opencode 最小闭环，两种宿主都要能跑）

```text
# 宿主 A：独立终端
$ janus                    # 无参 = 进 TUI（等价 janus tui）
janus v0.2.0 · workspace E:\xxx · model gpt-4o-mini · Ctrl+C 取消当轮 · /help
you> 帮我看看这个仓库结构
janus▸ …[workspace_read . (completed)] …流式正文…

# 宿主 B：JanusX 原生终端（同 preset 体验）
JanusX 终端面板 → 新建 janus → PTY spawn `janus tui -C <workspaceRoot>` → 同上 UI
# 宿主 C（无 PTY）：JanusX Chat 面板 → 直调 runChatTurn，同一 ports/session 逻辑
```

MVP 必须有：

1. 常驻循环 + 流式正文渲染（`text_delta` 增量拼行，不是 JSONL）。
2. 工具调用卡（`tool_call_ready → execution_start → execution_end(completed/failed)` 三态）。
3. 多轮记忆（同一 `conversationId` + `messages[]` 累积 + `toolTraces` 回放 + 同一 `ChatSessionRuntime`）。
4. 中断与错误（`Ctrl+C` 只取消当轮不退进程；`model_error/stream_error` 红字 + `retryable` 提示）。
5. 命令（MVP 全量）：`/help /model /workspace /clear /exit` + `/new /list /switch /rename /delete`（多会话，见 §4.6）+ `/provider`（配置商切换，见 §4.6）+ `/approval`（权限只读显示，切换 M3）。
6. 配置免重复输入（`JANUS_MODEL/BASE_URL/API_KEY` 或 `~/.janus/config.json`，flags 优先级最高；多 provider 形态见 §4.6）。

非 MVP（M3 再做）：多 workspace attach（当前 `CLI_WORKSPACE_ID='cli'` 单目录，§4.6 先做单会话多资源，M3 做 attach 持久化）、文件 `@引用` 补全、主题/分栏、knowledge 回忆面板。`per-action` 不再是非 MVP——§4.6 将其升为 M2 必做（终端 `y/n` 版）。

### 2.1 视觉对齐（与 JanusX chat 同源，TUI 必须照抄）

对标实现：`JanusX/src/renderer/src/components/janus/JanusChat.tsx` + `components/chat/ChatContent.tsx` + `janus/styles/05`。终端无 CSS，用 Ink 还原骨架语义，不自创布局：

```text
┌ janus · <workspaceName> · <provider/model> · <approval> ─────┐
│                                                               │
│  JANUSX（ASCII pixel logo，见下）                              │
│  空态 hint：输入消息开始 · /help 查看命令                       │
│                                                               │
│  you 12:01                                                    │
│  帮我看看这个仓库结构                                          │
│                                                               │
│  janus 12:01                                                  │
│  正在思考… [◐ workspace.list .]                                │
│  流式正文…▍                                                    │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│ > [输入框常驻聚焦，Enter 发送，Esc/Ctrl+C 取消当轮]            │
│ model: gpt-4o-mini · tab provider · ctrl+p model · /clear     │
└───────────────────────────────────────────────────────────────┘
```

1. **logo 默认显示**：chat 空态（`messages.length===0`，`JanusChat.tsx:1105-1109`）中央即 `JanusXTerminalBanner`（`PIXEL_WORDMARK`，`JanusChat.tsx:144-189`：J/A/N/U/S 5x4 点阵 + X 双色）。TUI 启动无参进场 + `/clear` 后空态都必须打印 ASCII 版 logo（`█` 画点阵，X 用 orange/gray 双色，`--plain` 降级为纯文本 `JANUSX`）；有消息后顶部 header 保留 mini `janus` 字样，不整屏消失。
2. **输入框常驻**：对标 `janus-chat-input-wrapper + composer-row`（`JanusChat.tsx:1297-1346`：textarea 自增高 + send/stop 双按钮）。TUI 底部输入框永远可见、永远聚焦；`isStreaming` 时输入框 placeholder 切为 queue 文案、右侧按钮切为 `■ stop + ➤ send`（排队语义先只做“stop 可点、send 禁止”，steering 的 queued badge M3 再做）。
3. **状态栏常驻**：对标 `janus-chat-status-bar`（`1347-1399`：model-tag + `tab providers / ctrl+p models / ctrl+f permission` + clear）。TUI 底栏同三段：`model: <provider/model>`（`/model` 或 `ctrl+p` 切换）、`workspace: <name>`（`/workspace`）、`approval: auto-run`（`ctrl+f` 预留，MVP 只读）。
4. **消息与卡片**：user 气泡 + `HH:mm`（`formatMessageTime`）；assistant  author `janus` + markdown 透传 + 流式光标 `▍`（对标 `StreamingText`）；工具卡照 `ToolCallGroup` 三态（`◇ ready → ◐ running → ✔/✘`）；reasoning 照 `ThinkingRegion` 默认折叠。
5. **i18n/文案**：复用 `janus:chat.*` key 语义（inputPlaceholder/queue.*/model.*），MVP 可先硬编码中文，`config.ts` 留 `locale` 透传位。

---

## 3. 技术选型（只定一个）

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. `Ink@5 + React` | 成熟、Windows PowerShell/ConPTY 兼容最好、文档多、与现有 ESM+TS (`ES2022/ESNext`, `tsconfig.base.json`) 冲突最小；JanusX renderer 本就是 React，心智一致 | 需引入 `react`，包体积大 | **MVP 选用** |
| B. `@opentui/core` | 渲染性能高 | 新、Windows/ConPTY 稳定性不如 Ink | M3 可选迁移 |
| C. 纯 `node:readline` | 零依赖 | 做不出 opencode 观感，后期重写 | 仅 M0 冒烟 |

锁定：**MVP = Ink@5（`react@19`）**，先单行输入，后多行。`ink/react` 只进 `@janus-agent/cli` 的 `dependencies`，绝不进 `agent-core/chat-core/janus-agent`。

---

## 4. 总体设计

### 4.1 分层与模块（JanusX 可复用边界）

```text
@janus-agent/agent-core   # 不动：runtime/registry/loop/tools，零 Electron（PORTS.md）
@janus-agent/chat-core    # 不动：ChatSessionRuntime/事件映射/system-prompt
@janus-agent/janus-agent  # 不动（只加单测）：runChatTurn + ChatTurnPorts（唯一跨宿主契约）
@janus-agent/cli/src/
  cli.ts                  # 扩展 main：无参→tui；chat/version/help 不动
  args.ts                 # 新增 tui 解析（纯函数）
  session.ts              # ★新增跨宿主复用：createTuiPorts/createTuiSession/sendTurn
                          #   JanusX 主进程适配器可 import 此模块（或按其模式抄 ports 组装）
  tui/
    App.tsx               # Ink 专属（不可被 JanusX import）：三段式骨架 header/messages/composer+statusbar
    logo.ts               # ★ASCII pixel logo（转写 JanusChat.tsx:144-189 PIXEL_WORDMARK，--plain 输出 JANUSX）
    store.ts              # ★纯 reducer：事件→UI状态（两边复用思想，JanusX 可映射到 zustand）
    renderers.tsx         # Ink 专属；消息气泡/工具卡/reasoning/光标▍，规则与 §4.3 同表
    commands.ts           # ★纯函数：/命令解析（复用）
    config.ts             # ★纯函数+薄IO：env→file→flags 合并（复用，见 §5.3）
```

分层检查（CI 可加）：`agent-core/chat-core/janus-agent` 禁止 `import ink/react`；`session/store/commands/config` 禁止 `import ink`、禁止直接读 `process.stdout`（经注入的 `onEvent/render` 回调输出）。

### 4.2 数据流（每轮，CLI 与 JanusX 同构）

```text
用户输入 → App(append user msg) → session.turn(userText)
  → new requestId + AbortController(单轮)
  → runChatTurn({messages: 全量历史, toolTraces: 累积, chatSession: 同一实例,
                 conversationId: 稳定, workspaceResources:[cli单资源]}, ports, {onEvent}, signal)
  → onEvent → store reducer → Ink 增量渲染（JanusX Chat：同 reducer 思想→React 卡片；JanusX PTY：走 PTY data 通道）
  → result.text → append assistant msg；result.toolTraces → 累积（上限 TOOL_TRACE_MAX_ENTRIES=24 对齐两侧）
  → Ctrl+C → controller.abort() → stream_end(cancelled:true) → 保留已流式文本，不退进程
```

复用点（对照现有 `cli.ts:62-111`）：`createAgentRuntime + registerWorkspaceTools + createSession` 从“每轮一次”改为“会话生命周期一次”；`/workspace` 切换才重建 agentSession；`model.resolve` 读 store 当前 `modelId`，支持 `/model` 热切换；`chatSession` 单例传入 `request.chatSession`。

### 4.3 事件→UI 映射（CLI TUI 与 JanusX Chat 共用同一张表）

| `ChatAgentEvent.type` | TUI（Ink） | JanusX Chat（映射方向） |
|---|---|---|
| `agent_start` | 状态栏 `● thinking…` | 同：等待态 |
| `text_delta` | assistant 气泡追加 | 同：流式 markdown（ JanusX 侧保留 40ms 合批，facade 侧不合批） |
| `reasoning_delta` | 折叠灰字，默认折叠，超 8k 截断（对齐 `REASONING_FORWARD_CAP_CHARS` 思想） | 同：折叠 + 4k 渲染截断 |
| `tool_call_start/delta` | spinner，不刷屏 | 同 |
| `tool_call_ready` | 建卡 `◇ toolName(workspaceId) args: keys…` | 同：卡片创建 |
| `tool_execution_start/update` | `◐ running` | 同 |
| `tool_execution_end` | `✔ completed / ✘ failed`（只用 `status`） | 同：只用 `status+summary+digest`，不用原始输出 |
| `model_finish(length)` | 黄字超长提示 | 同 |
| `model_error/stream_error` | 红字 `code + retryable` | 同 |
| `stream_end(cancelled)` | 灰字 `■ 已取消，历史已保留` | 同：静默中断不记错 |

### 4.4 JanusX 原生终端接入（PTY 约束，TUI 必须满足）

TUI 跑在 `TerminalManager(node-pty) → TERMINAL_* IPC → xterm.js` 管道里（`terminal-handlers.ts` 16ms 合批、`terminal-output-scheduler`、`terminal-geometry`、`terminal-input-transaction`），因此：

1. **渲染节流对齐**：Ink 侧状态栏/工具卡合批 ≥100ms，只渲染 `ready/start/end`，`tool_call_delta` 不逐帧刷；避免与 JanusX 16ms flush 共振闪烁。
2. **全屏与降级**：默认不用 alt-screen 全屏独占（嵌入面板高度有限）；提供 `--fullscreen` 可选。`--no-ansi/--plain` 降级开关必须有（供 replay/日志/管道场景）。
3. **尺寸与输入**：监听 `SIGWINCH` + `TERMINAL_SEND_CHANNELS.resize(cols/rows)` 重排；输入经 `submitLine/input` 事务进 PTY，`Ctrl+C(\x03)` 只 abort 当轮（`MainProcessTerminalControl.interrupt` 写 `\x03` 即此语义），`Ctrl+D`/`/exit` 才退出（exit 0）。
4. **生命周期**：`terminal:create{id, cwd, command: janus, args:[tui,-C,workspace]}` → `data/exit(status)/telemetry`；非零退出 → 面板 `error` 态保留；`kill` → 当轮 abort 后退出；`replay` 须可重放（故 `--plain` 日志友好）。
5. **Windows/ConPTY**：中文宽度、换行、颜色查询（`terminalColorQuery`）按 xterm 能力降级；ConPTY 缺失时启动即红字指引，不白屏。

### 4.6 janus-agentX 自持会话/配置商/权限（新增：TUI 不是“只要输入框”）

结论：多会话机制要在 JanusX 留一份（pane/registry/持久化），但 janus-agentX 必须自持一套对等的**无 Electron 版**，否则 TUI 独立跑就残废。做法不是抄 `useJanusChat.ts`，而是把三类能力下沉为 ports + 纯逻辑，JanusX 与 TUI 各实现一个宿主适配：

1. **多会话（ConversationRegistry，下沉到 `chat-core` 或 `janus-agent`，TUI M1 必做）**
   - 对标 JanusX：`useJanusChat.ts:201`（`conversations + runtimeStates per conversationId + handles{generation/abort/pendingBuffer} + islandConversationId`）+ `workspace.ts:380` pane tabs + `janusChat save/load` 持久化。
   - janus-agentX 形态：`conversations.ts`（纯 TS，无 React）：`createConversation/list/switch/rename/delete` + 每会话独立 `messages/toolTraces/chatSession/AbortController` + `activeConversationId`；持久化经 `ConversationStorePort` 注入——CLI 走 `~/.janus/history/<id>.jsonl`，JanusX 将来走现有 `janusChat` IPC（不替换）。命令：`/new /list /switch <id|index> /rename <t> /delete <id>`；`store.ts` 按 `conversationId` 分片，切换会话即换分片渲染。
2. **切换配置商（ProviderCatalogPort，下沉为 port + `config.ts`，TUI M2 必做）**
   - 对标 JanusX：`llm-core/core/types.ts:84 ProviderSettings`（`id/name/authType/enabled/baseURL/apiKey/modelId/models/defaultModelId`）+ `ModelInfo`（`contextWindow/supportsFunctionCalling` 门禁）+ `LlmService/ModelCatalogService`（多 provider 列表、默认 provider、`/model` 热切换）。
   - janus-agentX 形态：`config.json` 从单模型升级为 `{ providers: ProviderSettings[], defaultProvider, defaultModel }`（字段名照抄 llm-core，`apiKey` 仍永不落盘，只走 env/flags）；`ModelResolverPort.resolve(providerId, modelId)` 保持不变，CLI 的实现从“单 endpoint”换成“查 catalog 再 `createChatModel`”；无 function-calling 模型沿用 `chat-turn.ts:181` 门禁阻断。命令：`/provider`（列出/切换 provider）+ `/model`（列出/切换该 provider 下 models，`tab/ctrl+p` 同义）。JanusX 下发当前 provider/model 给 PTY 时仍走同名 env，TUI 无需读 `ConfigStore`。
3. **权限（ApprovalPort，`session.ts` 参数化 + 终端 UI，TUI M2 必做）**
   - 对标 JanusX：`shared/ipc/agent-runtime.ts:30 AgentApprovalMode='per-action'|'auto-run'` + `ApprovalRequest/resolveApproval` + `renderer-authorization` + `useJanusChat: resolveApproval/setApprovalMode`（`ctrl+f` 切换）。
   - janus-agentX 形态：`approvalMode` 从写死 `auto-run`（`cli.ts` 现状）改为每会话可设（默认仍 `auto-run` 保 MVP 可用）；`per-action` 在终端的 UI 是阻塞式 `y/n` 确认行（`IoPort.promptApproval(preview)` 注入，单测用 stub，JanusX 将来注入富卡片版）；`policy-gate` 仍在 `agent-core` 内，TUI 只负责把 `tool_call_ready` 的 `argumentKeys/preview` 展示 + 收 `y/n`。命令/键：`/approval [per-action|auto-run]` + `ctrl+f` 只读显示 MVP、M2 可切。`args.ts:107-112` 的“只许 auto-run”限制相应改为“`chat` 单轮保持 auto-run，`tui` 允许双模式”。

不做这三块的后果：TUI 只能单会话单模型 auto-run，和 chat“一直用”的体验对不上，JanusX 也复用不到任何东西。

### 4.7 JanusX 灵活复用 janus-agentX（迁移路径，不在本包内改 JanusX，只定契约）

* **(a) PTY preset（JanusX 侧改动清单）**：`src/shared/terminalLaunch.ts` 加 `janus` preset（`command: janus, args: [tui]`）；`terminal-handlers.ts` 的 `resolveTerminalLaunchProgram + resolveCLIPath` 加 janus 解析（参考 `WIN_SPAWN_EXTS`：优先 `.exe`，npm shim 跟 `resolveSameNamedExe` 同逻辑）；`checkpointManager` 按 terminal 建 `cwd/.janusX/checkpoints` 初始化；`AgentHookBridge/Coordinator/Sentinel + agent-turn-recorder` 把 `janus` 纳入与 claude/codex/opencode 同等的 turn 感知（`TerminalAgentEngine` 加 `'janus'`）。
* **(b) 进程内直调（JanusX 侧改动方向）**：`chat-orchestrator.ts` 逐步变薄为 `ChatTurnPorts` 适配器（`model: LlmService/ai-runtime`，`sessions: workspaceAgentRuntime`，`tools: registry+executeTool`，`knowledgeSearch/Capture: context/observation/processing-queue`），`getChatSession(LRU 32)` 与 CLI 单例语义对齐（CLI 传单例，JanusX 传 LRU 取出的实例）；40ms 合批与窗口销毁 guard 留在壳适配器，不进 facade（与 `chat-turn.ts` 头注记一致）。每次改动配 twin test：同一 stub 序列下两侧 `ChatAgentEvent` 序列一致。
* **ports 差异矩阵**（`session.ts` 以参数注入，不写死）：

| port | CLI TUI | JanusX 进程内 |
|---|---|---|
| `model.resolve/streamTextFn` | `createChatModel(OpenAI兼容)` | `LlmService + ai-runtime.streamText`（多 provider/catalog） |
| `sessions` | cwd resolver，单 `cli` 资源 | office workspace registry，多资源（≤12，去重，id 匹配） |
| `tools` | `registerWorkspaceTools` 本地子集 | 全量 registry（含 project/git/command 插件） |
| `knowledgeSearch/Capture` | 无（MVP） | context-service / observation-service + queue |
| `audit` | 隔离目录或内存（`JANUSX_AUDIT_ROOT` 覆盖） | knowledge-root audit dir（`PORTS.md` 布局） |
| `approval` | `auto-run` | `auto-run/per-action` + 渲染器授权（`renderer-authorization`） |

---

## 5. CLI 参数与配置

### 5.1 命令（`args.ts` 扩展，保持纯函数）

```text
janus                                   # = janus tui（默认 workspace=cwd）
janus tui [-C <dir>] [-m <id>] [--base-url <u>] [--api-key <k>]
          [--max-turns <n>] [--timeout-ms <ms>] [--conversation <id>]
          [--fullscreen] [--plain]
janus chat ...                          # 不变（CI/脚本/JanusX 非交互调用用）
janus version / janus help              # 不变
```

### 5.2 配置优先级：`flags > env > ~/.janus/config.json > 默认`

* `~/.janus/config.json`：`{ model, baseUrl, workspace?, maxTurns? }`；`apiKey` 永不落盘。
* `~/.janus/history/<conversationId>.jsonl`（M2）：存 `messages+toolTraces`，`/resume` 用。

### 5.3 与 JanusX 配置统一（新增）

* `config.ts` 的字段名对齐 JanusX `ProviderSettings/ModelInfo`（`providerId/modelId/baseURL`），鉴权类型沿用 JanusX `authType` 语义，TUI 只实现 `api-key`，预留 `oauth/token` 透传位。
* 将来 JanusX 可把当前 provider/model 下发为 `janus tui` 的 env（`JANUS_MODEL/BASE_URL/API_KEY` 同名），TUI 无需知道 JanusX 内部 `ConfigStore` 路径。

---

## 6. 实现步骤

1. **M0 地基（不碰 UI，可被 JanusX 直接复用）**：`args.ts` 加 `tui(+--fullscreen/--plain)` 解析 + 单测；`session.ts` 抽出 `createTuiPorts/createTuiSession/sendTurn`（复用 `cli.ts:62-111` ports 组装，`approvalMode` 参数化）；stub `streamTextFn` 跑通“两轮历史+toolTraces 累积”+“abort 保留历史”单测。本步即 JanusX (b) 的端口原型。
2. **M1 TUI 壳 + 多会话（Ink 最小闭环 + PTY 安全 + §4.6-1）**：`App/store/renderers/commands` 最小件 + `conversations.ts` 注册表（`/new /list /switch /rename /delete`，切换分片渲染，`~/.janus/history` 落盘）；`Ctrl+C` 取消当轮；`--plain` 直通；PowerShell + JanusX 终端面板双宿主冒烟。
3. **M2 配置商+权限+完整态（§4.6-2/3）**：`config.json` providers 化（照抄 `ProviderSettings` 字段，`apiKey` 不落盘）+ `/provider /model` + `ModelInfo` 门禁；`approvalMode` 每会话可设 + 终端 `y/n` 确认行 + `/approval`；工具卡三态 + reasoning 折叠 + 错误/取消 + 状态栏。
4. **M3 JanusX 对接**：JanusX 侧加 `janus` preset + cli-resolver + hooks/turn 感知 + checkpoint；`chat-orchestrator` 适配器化（twin tests）；ConPTY/宽字符/长输出回归。

DoD：`npm run build/typecheck/test --workspace=@janus-agent/cli` 全绿 + 双宿主实跑（独立 PowerShell 与 JanusX 终端面板各一遍：多轮→工具→取消→切模型→resize→kill→退出）。

---

## 7. 测试计划

* 现有：`packages/cli/tests/cli.test.ts`。
* 新增：`tui-args.test.ts`（无参→tui、`--fullscreen/--plain`、`chat` 缺 prompt 仍错）；`tui-commands.test.ts`；`tui-session.test.ts`（核心：两轮历史+toolTraces 回放+abort 保留；approval 参数透传）；`tui-store.test.ts`（事件序列→卡终态/取消横幅/红字）；`tui-pty.test.ts`（resize/plain 降级纯逻辑）。
* 新增：`tui-conversations.test.ts`（§4.6-1：建/切/删会话隔离历史，切换分片，落盘重载）；`tui-providers.test.ts`（§4.6-2：catalog 解析 + `/provider /model` 切换 + 无 function-calling 阻断）；`tui-approval.test.ts`（§4.6-3：`per-action y/n` 放行/拒绝，`auto-run` 不打断）。
* 新增：`tui-logo.test.ts`：ASCII 点阵与 `PIXEL_WORDMARK` 点位一致（J/A/N/U/S/X），`--plain` 输出 `JANUSX`；空态渲染含 logo + hint，输入框与状态栏常驻（快照或行断言）。

---

## 8. 构建/运行/验证

```powershell
cd "E:\Tree Workspace\JanusX\janus-agentX\packages\cli"
npm install
npm run typecheck; npm run build; npm run test
node ..\cli\dist\cli.js version; node ..\cli\dist\cli.js help
$env:JANUS_MODEL="gpt-4o-mini"; $env:JANUS_API_KEY="sk-..."
node ..\cli\dist\cli.js tui -C . --plain   # 先 plain 跑通，再默认 Ink
# JanusX 面板：新建 janus 终端（cwd=workspace，等 preset 落地后），同上操作一遍
```

回归：`janus chat` JSONL 契约、退出码 `0/1/2/130` 不变；`chat` 单轮保持 `auto-run`，仅 `tui` 允许双模式（`args.ts:107-112` 按此放宽）。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| Ink 在 node-pty+xterm+ConPTY 下闪烁/宽字符错位 | 默认非全屏+≥100ms 合批+只渲染关键事件；`--plain` 兜底；xterm `fit` 尺寸透传 |
| Ink/React 污染 library 层，JanusX 无法轻量复用 | 分层检查：core 三包禁 `ink/react`，`session/store/commands/config` 禁 `ink` |
| 两侧编排漂移（`chat-orchestrator` vs `runChatTurn`） | 改动配 twin test；合批/LRU/窗口 guard 留壳里，不进 facade |
| 工具名/蓝图白名单漂移 | 沿用 `PORTS.md` 契约，改名双仓同步 + contract tests |
| 上下文超限/无 function-calling 模型 | 沿用 `SYSTEM_CONTEXT_EXCEEDS_BUDGET` 黄字+`/clear` 建议；TUI 启动即做 function-calling 门禁 |

---

## 10. 验收标准（MVP，含 JanusX 约束）

* [ ] `janus` 无参进 TUI，连续 5 轮不退，第二轮引用首轮结论；`Ctrl+C` 只断当轮；`/model /workspace /clear /exit` 全可用。
* [ ] 工具卡终态正确，失败不崩；无配置时红字指引（对齐 exit 2 语义）。
* [ ] `session/store/commands/config` 无 Ink 依赖，可被 JanusX 主进程直接 import（`npx tsc --noEmit` + 禁止 import 规则通过）。
* [ ] 同一 `janus tui -C <ws>` 在独立 PowerShell 与 JanusX 终端面板均可跑通：输入→流式→工具→resize→kill→退出。
* [ ] 启动空态默认显示 ASCII `JANUSX` logo + hint，输入框与 `model/workspace` 状态栏常驻；`/clear` 后回到同一空态（与 `JanusChat.tsx:1105` 空态语义一致）。
* [ ] `build/typecheck/test` 全绿，`chat` 单轮回归通过。
