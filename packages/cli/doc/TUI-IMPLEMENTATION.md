# Janus CLI TUI 实施文档（类 opencode 常驻终端）

> 位置：`packages/cli/doc/TUI-IMPLEMENTATION.md`
> 目标：`janus` 无参（或 `janus tui`）进入常驻交互终端，多轮可用；保留 `janus chat -- "prompt"` 单轮 headless 不变。
> 基线：Node v24.14.1 / `ai@3.4.33` + `@ai-sdk/openai@3` / Ink 7.1.1 + React 19.2.8 + ink-text-input + ink-testing-library。
> 状态：M0 地基、M1（plain 循环 + 多会话）、M2（配置商 + 审批）、Ink 全屏、M3（JanusX preset + 编排器适配）全部落地；
> `typecheck` + `strict-unused` + `build` + **104 单测**全绿。剩余只有 JanusX 面板真机实跑与镜像删除。
> 约束：本 TUI 必须能以**原生终端形态**迁入 JanusX chat，且 JanusX 能**灵活复用 janus-agentX 能力**（既能 PTY spawn `janus tui`，也能进程内 `import runChatTurn/session`）。

---

## 流式输出展示更新（2026-09-09）

- CLI 的实时传输使用 `ai-stream`（`ai@6` 的 npm 别名）直接消费现有 spec-v3 模型，`model-stream.ts` 转换核心的消息、工具 schema 和流事件契约。旧 `model-compat.ts` 保留为历史适配参考，不再用于默认传输；它会丢弃 reasoning 事件，旧 ai@3 也不支持该事件。
- 思考只显示服务商实际返回的 reasoning 内容。黄色摘要与正文分开，显示独立耗时；`Ctrl+T` 展开完整内容。无 reasoning 的模型不会生成虚构思考。
- 正文通过 `marked` 解析，分别渲染标题、强调、行内代码、带行号代码块、引用、任务列表和表格；窄终端自动换行或将表格转为字段行。
- 工具具有 preparing / ready / running / completed / failed / cancelled 状态；读取、搜索、修改、命令、Git、项目操作使用不同类别与颜色。目标、脱敏结果和耗时按调用实时更新；命令非零退出码按失败展示。`Ctrl+O` 展开或收起已捕获的工具输出。
- 修改预览来自本次成功调用的 replacements / unifiedDiff / content，不混入原有工作区 diff。输出有大小上限和截断标记；失败或拒绝的写入不会显示为已应用的修改。
- 整轮活动指示持续到工具和后续回答完成，结束后显示耗时和服务商提供的 token 用量；`--plain` 保持思考、工具、正文的输出顺序。
- `runChatTurn.onStreamEvent` 是可选的进程内宿主回调。CLI 的 `tool-display.ts` 将其投影为有界、脱敏的展示数据；现有 `ChatAgentEvent` IPC 与单轮 JSONL 契约保持原样。

实现参考：[Codex message cells](https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/messages.rs)、[Codex execution cells](https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/exec.rs)、[opencode session parts](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/routes/session/index.tsx)。

## 0. 顶层原则（JanusX 迁移前置，不可违背）

1. **library-first，CLI 是薄客户端**：`agent-core / chat-core / janus-agent` 保持零 Electron、零 Ink、零 React（`PORTS.md` 保证 + `strict-unused` 守门），TUI 只依赖 facade + ports，不反向污染。JanusX 主进程直接 `import @janus-agent/janus-agent`，不经过 CLI 二进制。
2. **双消费设计**：
   - (a) **PTY 消费**：JanusX 原生终端（`node-pty` + `xterm.js`）`spawn janus tui`，与 `claude/codex/opencode` 同等地位；
   - (b) **进程内消费**：JanusX Chat UI 经 ports 适配器直调 `runChatTurn`，不走 PTY。
   - `session/conversations/providers/commands/tui{store,exec}` 写成**纯逻辑+可注入 IO**，两边复用同一份；只有 `tui/App/run + repl` 是宿主专属。
3. **契约冻结**：工具名（`workspace.* / project.* / git.* / command.run`，`PORTS.md` 工具名契约；注意模型侧工具名是下划线式如 `workspace_create`，运行时侧是点式）、`ChatAgentEvent` 红字规则（参数值不出 UI，只出 `argumentKeys`）、`chat` 单轮 JSONL 输出，三者都不因 TUI 而改。

---

## 1. 落点对照（as-built）

| 位置 | 实现 | 说明 |
|---|---|---|
| `src/cli.ts` | `chat` 走 `CliSession` 单轮（行为不变）；`tui`/无参按 TTY 路由 | TTY→Ink，管道/`--plain`/非 TTY→plain；`--fullscreen` 非 TTY 时提示后降级 |
| `src/args.ts` | `chat/tui/version/help` 纯解析 | `tui` 无 prompt、`--plain/--fullscreen`、`tui` 允许 `per-action`，`chat` 保持 `auto-run` |
| `src/session.ts` | `CliSession`：单 runtime+agent session+transport，多会话注册表 | transport 按 flags > env > file > provider 链重建；`setModel/setProvider/setApprovalMode` 热切 |
| `src/conversations.ts` | `ConversationRegistry` + `ConversationStorePort`（memory/file） | 每会话独立 `messages/toolTraces/ChatSessionRuntime`；`~/.janus/history/<id>.jsonl`；单调时钟保证排序确定 |
| `src/providers.ts` | `ProviderCatalog`（字段照抄 llm-core `ProviderSettings`，`apiKey` 永不落盘） | `~/.janus/config.json`；closed-world 强校验，open-world 单端点放行 |
| `src/repl.ts` | plain 常驻循环（readline 行队列 + 可注入 lines） | 管道/测试/降级路径；y/N 审批行 |
| `src/tui/store.ts` | 纯 reducer（§4.3 全事件覆盖） | Ink 与 plain 语义同源 |
| `src/tui/composer-state.ts` | 纯输入框逻辑（补全/多行缓冲/滚动窗口） | Ink 专属；plain（readline 单行，管道安全）不跟进 |
| `src/tui/tool-card.ts` | 纯工具卡展示（字形/字色/单行文本，底色带常量） | Ink 讨论区整幅渲染；plain 沿用 `◇/→` 文本行 |
| `src/tui/exec.ts` | 双宿主共享命令执行器 | plain 与 Ink 输出逐字一致 |
| `src/tui/App.tsx` + `run.tsx` | Ink 三段式（header/讨论区/composer+状态栏）+ 内联 y/n 审批框 | `jsx: react-jsx`，`moduleResolution: bundler`（只为读 Ink 的 exports 映射，emit 不变） |
| JanusX `chat-orchestrator.ts` | 未动（M3 才收薄为 ports 适配器） | twin test 随 M3 做 |

---

## 2. 目标形态（已落地，两种 plain/Ink 宿主 + 预留 JanusX 双宿主）

```text
# 宿主 A：独立终端（TTY 默认 Ink，--plain/管道走 readline）
$ janus
╭─ janus · myws · openai-compatible/gpt-4o-mini · auto-run ─╮
│  ████ … (ASCII JANUSX)  Type a message …                   │
│  you › …  janus › …▍  ◇/◐/✔/✘ 工具卡                        │
├─ [> message (/help)] ──────────────────────────────────────┤
│ conv-title · /help · ctrl+p                                 │
# 宿主 B（M3）：JanusX 终端面板 spawn `janus tui -C <ws>` → 同上 Ink UI
# 宿主 C（M3）：JanusX Chat 面板直调 runChatTurn，同一 ports/session 逻辑
```

已落地：常驻循环 + 流式正文 + 工具卡三态 + 多轮记忆 + `Ctrl+C` 断当轮 + `/help /model /provider /workspace /clear /new /list /switch /rename /delete /approval /exit` + 空态 logo + 状态栏 + 多行输入框（默认 3 行，`Enter` 发送/`Shift+Enter` 换行，`/` 前缀 Tab 补全）。

未做（M3 或更后）：多 workspace attach（仍单 `cli` 资源）、文件 `@引用` 补全、主题/分栏、knowledge 回忆面板、steering/rewrite/retry（island 专属，不引入 CLI）。

### 2.1 视觉对齐（与 JanusX chat 同源，终端还原骨架语义）

对标：`JanusX/.../janus/JanusChat.tsx`（`PIXEL_WORDMARK:144-189`、空态 banner`:1105-1109`、composer`:1297-1346`、status-bar`:1347-1399`）。

1. **logo 默认显示**：空态 ASCII 点阵（`█`/`░░`，单测逐格锁定与 chat 点阵一致），`--plain`/管道降级 `JANUSX`；有消息后 header 留 mini `janus`。
2. **输入框常驻**：底部多行实心黑面板（默认 3 行、上限 6 行滚动跟随光标；逐 cell 全黑含边框字形，CJK 按双倍宽对齐截断；常驻呼吸块光标，busy/审批时置灰 steady）；`Enter` 发送，`Shift+Enter` 换行（kitty `return+shift` 与 ConPTY LF 双通道），`/` 开头弹命令补全（Up/Down 选、Tab 应用、Esc 关、Enter 照常发送）；`isStreaming` 显示 `working…`。
3. **状态栏**（极简）：`conversation · statusText · /help · ctrl+p`；完整按键见 `/help`；header 另有 workspace·provider/model·approval。
4. **消息与卡片**（灰橙主题，对齐 JanusX chat：橙 `#ff7830` / 次灰 `#8a8f98` / 正文 `#e8e8e8`）：`you ›` 灰 / `janus ›` 橙 + 流式 `▍`；单条时间线按流顺序交错 — thinking（`▸ thinking` 灰字，`/thinking` 可藏）→ 工具卡（`◇/◐/✔/✘` 整幅深暖底色 `#241c12`）→ 后续思考/正文；空态为双色 JANUSX 点阵；输入框常驻橙边框（busy 置灰），审批框橙边；无 `HH:mm` 时间戳（终端暂省）。
5. 文案硬编码中文；i18n key 对齐以后再做。

---

## 3. 技术选型（已锁定并验证）

| 方案 | 结论 |
|---|---|
| Ink 7.1.1 + React 19.2.8 + ink-text-input（TTY 全屏） | **已用**：与 JanusX renderer 同为 React，心智一致；ConPTY 实测待 M3 在 JanusX 面板里回归 |
| `node:readline` 行队列（plain） | **已用**：管道/测试/`--plain`/降级路径；常驻 `line` 监听 + 队列，粘贴/管道不丢行（修过 `question()` 丢行 bug） |
| `@opentui/core` | M3 可选迁移，不阻塞 |
| ink-testing-library 4.0（dev） | **已用**：App 真渲染冒烟（输入→回答→命令→退出） |

`ink/react` 只进 `@janus-agent/cli`；`tsconfig` 增 `jsx: react-jsx` + `moduleResolution: bundler`。

---

## 4. 总体设计

### 4.1 分层与模块（as-built，JanusX 可复用边界）

```text
@janus-agent/agent-core   # 不动：runtime/registry/loop/tools，零 Electron
@janus-agent/chat-core    # 不动：ChatSessionRuntime/事件映射/system-prompt
@janus-agent/janus-agent  # 不动：runChatTurn + ChatTurnPorts（唯一跨宿主契约）
@janus-agent/cli/src/
  cli.ts                  # chat 单轮（经 CliSession）/ tui 路由（TTY→Ink，否则 plain）
  args.ts                 # 纯 argv 解析（含 tui，无参默认 tui）
  session.ts              # ★CliSession：transport+registry+审批监听，可被 JanusX import
  conversations.ts        # ★注册表 + memory/file store（纯 TS）
  providers.ts            # ★catalog 解析/合成/校验（纯 TS + 薄文件 IO）
  commands.ts             # ★纯 `/` 解析 + 帮助文案
  logo.ts                 # ★ASCII 点阵（转写 chat PIXEL_WORDMARK）
  repl.ts                 # plain 宿主：行队列源 + y/N 审批行
  tui/
    store.ts              # ★纯 reducer（事件→UI 状态）
    exec.ts               # ★双宿主共享命令执行器
    App.tsx               # Ink 专属三段式 + 内联审批框
    run.tsx               # Ink 宿主装配（store/catalog/session）
```

分层检查：core 三包禁 `ink/react`；`session/conversations/providers/commands/store/exec/logo` 禁 `ink`（`strict-unused` 常开验证）。

### 4.2 数据流（每轮）

```text
输入 →（plain: lines.next / Ink: TextInput 提交）→ dispatches user-message + turn-start
  → CliSession.sendTurn：registry 取活跃会话 {messages, toolTraces, chatSession}
  → runChatTurn(全量历史回放，TOOL_TRACE_MAX_ENTRIES=24)
  → onEvent → store reducer（Ink）/ 行渲染（plain）
  → result 落库 + registry.persist → refreshContext（标题/模型/会话名）
  → Ctrl+C → controller.abort() → cancelled（历史保留用户句，不记半截 assistant）
```

`/workspace` 重建 transport + registry（同 store/catalog 跨实例共享，历史按 workspace 隔离）。

### 4.3 事件→UI 映射（CLI 双宿主与 JanusX Chat 共用同一张表）

| `ChatAgentEvent.type` | Ink | plain | JanusX Chat（M3 映射方向） |
|---|---|---|---|
| `agent_start` | `thinking…` | `janus▸ ` 前缀 | 等待态 |
| `text_delta` | 气泡追加 + `▍` | 原样直写 | 流式 markdown（壳侧保留 40ms 合批） |
| `reasoning_delta` | 时间线 thinking 块（默认折叠首行+字数，`ctrl+t` 展开） | 回合末折叠一行 `▸ thinking · …` | 折叠 + 4k 截断 |
| `tool_call_start/delta` | 忽略 | 忽略 | 同 |
| `tool_call_ready` | 建卡 `◇ name (keys)` | `◇ name (keys)` 行 | 卡片创建 |
| `tool_execution_start/update` | `◐ running` | — | 同 |
| `tool_execution_end` | `✔/✘` + turn 末 `└ summary` 回填 + edit/create 的 git diff 预览 | 同（`└` 行） | 同 |
| `model_finish(length)` | `output truncated (length)` | — | 同 |
| `model_error/stream_error` | 红字 `code (+retryable)` | stderr 红字 | 同 |
| `stream_end(cancelled)` | `cancelled — history kept` | `■ cancelled — history kept` | 静默中断不记错 |

### 4.4 JanusX 原生终端接入（M3 未做，约束先行）

TUI 将跑在 `TerminalManager(node-pty) → TERMINAL_* IPC → xterm.js` 管道里（16ms 合批、`terminal-output-scheduler`、`terminal-geometry`、`terminal-input-transaction`）：

1. Ink 侧只渲染 `ready/start/end` 关键事件（`delta` 不逐帧刷），避免与 16ms flush 共振。
2. 默认不用 alt-screen 独占；`--plain` 保留给 replay/日志/管道。
3. `SIGWINCH` + `resize` 重排；`Ctrl+C(\x03)` 断当轮，`Ctrl+D`/`/exit` 退出。
4. `terminal:create{id, cwd, command: janus, args:[tui,-C,ws]}` → `data/exit/kill/replay` 同 preset 生命周期。
5. Windows ConPTY/中文宽度/颜色查询按 xterm 降级，缺失即红字指引。

### 4.5 janus-agentX 自持会话/配置商/权限（已落地）

1. **多会话**：`conversations.ts`（`create/list/switch/rename/delete`，`resolveRef` 支持完整 id/唯一前缀/序号——纯数字优先按序号，避免 uuid 数字前缀抢占；单调时钟保证同毫秒排序确定；删除永不留空）。持久化经 `ConversationStorePort`：CLI 用 `~/.janus/history/<id>.jsonl`，损坏文件跳过。**每次 TUI 启动（plain/Ink）默认 fresh start：开新空会话并删掉旧会话落盘，还原空态 banner；显式 `--conversation <id>` 则恢复指定会话。**`chat` 单轮不受影响。
2. **配置商**：`providers.ts` + `~/.janus/config.json`（`{providers, defaultProvider, defaultModel}`，`apiKey` 解析即剥离）。优先级 flags > env > file > provider 链；`defaultModel` 只跟 `defaultProvider` 配对（切商不串味）；切商清空 model 覆盖跟随新商默认链并写回配对；closed-world（`models` 非空）打错模型直接拒，open-world 单端点放行。`ModelResolverPort` 形状不变，CLI 内部查 catalog 再 `createChatModel`。
3. **权限**：`approvalMode` 每会话可设（默认 `auto-run`，`chat` 单轮恒为 auto-run）；`per-action` 经运行时 `approval-requested` 事件 + 同 callerId（`janus-agent`，与执行侧一致）`resolveApproval`；终端 UI 为阻塞式 y/N（空/EOF/中断一律 fail-closed deny）；`setApprovalMode` 热切实时生效；Ctrl+C 在审批等待中转 deny，不断轮不挂死。

### 4.6 JanusX 灵活复用（M3，只定契约，本包不动 JanusX）

* **(a) PTY preset**：`terminalLaunch.ts` 加 `janus` preset；`terminal-handlers + resolveCLIPath` 加 janus 解析（`WIN_SPAWN_EXTS` 优先 `.exe`）；`checkpointManager` 按 terminal 初始化；hooks/turn 感知加 `'janus'` engine。
* **(b) 进程内直调**：`chat-orchestrator.ts` 收薄为 `ChatTurnPorts` 适配器（model/sessions/tools/knowledge），LRU/40ms 合批/窗口 guard 留壳里；每次改动配 twin test。
* **ports 差异矩阵**：model（CLI: OpenAI 兼容单 transport；JanusX: LlmService 多 provider）/ sessions（CLI: cwd 单资源；JanusX: office registry 多资源 ≤12）/ tools（CLI: workspace 子集；JanusX: 全量插件）/ knowledge（CLI: 无；JanusX: context/observation/queue）/ audit（CLI: 内存或隔离目录；JanusX: knowledge-root）/ approval（CLI: y/N 行；JanusX: 富卡片 + renderer-authorization）。

---

## 5. CLI 参数与配置

```text
janus                                   # = janus tui（TTY→Ink，否则 plain）
janus tui [-C <dir>] [-m <id>] [--base-url <u>] [--api-key <k>]
          [--max-turns <n>] [--timeout-ms <ms>] [--conversation <id>]
          [--approval-mode auto-run|per-action] [--fullscreen] [--plain]
janus chat ...                          # 单轮 JSONL（CI/脚本用）
janus version / janus help              # 不变
```

* 优先级：`flags > env(JANUS_MODEL/BASE_URL/API_KEY) > ~/.janus/config.json > provider 链`；`apiKey` 永不落盘。
* 退出码：`0` 完成 / `1` agent 错误 / `2` 用法配置错 / `130` 中断（REPL 内单轮错误不退进程）。

---

## 6. 里程碑（as-built + 剩余）

* [x] **M0 地基**（`39a34c0`）：`tui` 解析 + `CliSession` + stub 双轮历史/toolTraces/abort 单测。
* [x] **M1 plain + 多会话**（`54bcb8c`）：readline 行队列循环 + 注册表 + 文件历史 + `/new/list/switch/rename/delete`；附带修 `question()` 管道丢行 bug。
* [x] **M2 配置商 + 权限**（`8ae8b64`）：catalog + `/provider /model` + 终端 y/N 审批 + `/approval`；附带修 transport 重建丢 env/file 解析、defaultModel 跨商串味。
* [x] **Ink 全屏**（`f5ecffe`）：`store/exec` 双宿主共享 + `App/run` + TTY 路由；附带修命令输出被 hydrate 清掉、provider 切换卡死。
* [x] **M3-preset（JanusX 侧已落地）**：`janus` preset（`janus tui` 直启）+ warmup/resolveCLIPath（PATH 查找，npm link 即可）+ hooks 无操作短路（不装 hook、不进 runner 注册表）+ checkpoint/遥测/i18n/图标链路；`AgentEngine`（runner）与 hooks 域刻意未动——janus 不发 hooks、不进子进程 runner。
* [x] **M3-编排器（JanusX 侧已落地）**：`chat-orchestrator` 收薄为 `ChatTurnPorts` 适配器（`src/main/llm/janus-agent-ports.ts`，twin tests 锁定与旧内联逻辑一致）；40ms 合批/reasoning 上限/LRU/窗口守卫/IPC 扇出留壳；recallTrace 通道改为整轮结束后发送（同 requestId）。

DoD（M3）：`build/typecheck/test` 全绿 + 双宿主实跑（独立终端与 JanusX 面板各一遍：多轮→工具→审批→取消→切模型→resize→kill→退出）。剩余：JanusX 终端面板真机实跑；JanusX 删除镜像文件改直引包（待全仓绿后做）。

---

## 7. 测试（14 文件，104 用例，全绿；单测即契约）

| 文件 | 覆盖 |
|---|---|
| `cli.test.ts` | 单轮回归（JSONL/缺配置/工具穿透） |
| `tui-args/commands/logo` | 参数/命令/点阵几何（逐格对齐 chat `PIXEL_WORDMARK`） |
| `tui-session` | 双轮历史回放、`hello.txt` tool-trace 回放、abort 不丢历史、切模型/清历史 |
| `tui-conversations` | 注册表生命周期/前缀歧义/文件回环/会话隔离/跨进程恢复/repl 全流程 |
| `tui-providers` | catalog 解析消毒/优先级/切商切模型/持久化配对/repl 流程 |
| `tui-approval` | 真 policy 链：auto 放行无提示、y 放行/n 拒绝、热切、审批中 abort 转 deny、repl y/N |
| `tui-store` | reducer 全事件覆盖 |
| `tui-exec` | 双宿主命令一致性（help/会话/模型/商/审批/workspace/未知） |
| `tui-app` | ink-testing-library 真渲染：空态→问答→命令→退出 + Shift+Enter 多行发送 + Tab 补全 + 工具调用卡片行 |
| `tui-tool-card` | 卡片字形/字色映射、单行文本格式、整幅底色带宽度 |
| `tui-composer-state` | 补全过滤/应用、粘贴换行归一、光标行列换算、滚动窗口、行尾光标预留、显示宽度与截断、补全覆盖全部已知命令 |

铁律：单测 hermetic——默认 memory store + `configPath: null` + tmp 目录；跑完 `~/.janus` 必须为空（曾泄漏一次，[`8ae8b64`] 修好）。另：`stdin.write` 文本与 `\r` 必须分两次写（单次写入 `\r` 被当字面量，测试环境 quirk，TTY 不受影响）。

---

## 8. 构建/运行/验证

```powershell
cd "E:\Tree Workspace\JanusX\janus-agentX"
npm run typecheck --workspace=@janus-agent/cli
npx tsc --noEmit --noUnusedLocals --noUnusedParameters -p packages/cli/tsconfig.json
npm run build; npm run test --workspace=@janus-agent/cli
node packages/cli/dist/cli.js version
$env:JANUS_MODEL="gpt-4o-mini"; $env:JANUS_API_KEY="sk-..."
node packages/cli/dist/cli.js tui -C . --plain   # plain
node packages/cli/dist/cli.js tui -C .           # TTY→Ink
# JanusX 面板：等 M3 preset 落地后同上操作一遍
```

回归：`chat` JSONL 契约、退出码、`chat` 恒 `auto-run` 不变。

---

### 8.1 全屏历史滚动

滚轮启用必须写入 `useStdout().stdout`，而不是 `useStdout()` 上下文对象；后者没有 `isTTY`，会让鼠标模式初始化静默跳过。挂载时启用 SGR，卸载时恢复；`JANUS_NO_MOUSE=1` 可关闭鼠标捕获。

讨论区通过 `measureElement` 读取实际内容高度与视口高度，在固定视口中移动并裁剪完整内容。自动换行、工具预览和输入区域变化均使用 Ink 的实际布局，不再依赖文本行数估算。`scrollTop=null` 表示跟随末尾，上滚后固定绝对行位置，继续生成和任务完成不会把视图推走；滚回底部、Ctrl+End 或提交新输入恢复跟随。

参考源码（2026-09-09 读取）：

* [OpenCode session](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/routes/session/index.tsx)：`scrollbox`、`stickyScroll`、`stickyStart="bottom"`。
* [pi-agent ScrollView](https://github.com/badlogic/pi-mono/blob/main/packages/tui/src/components/scroll-view.ts)：`currentScrollTop`、`followingEnd`、内容与视口高度分别维护。

回归覆盖：真实 Ink TTY 流上的鼠标启停、分段 SGR 输入、流式生成时固定历史位置、完成后的逐行可达性、翻页及回到底部。物理鼠标在 Windows Terminal / JanusX 面板中的手动验收仍需在对应宿主执行。

## 9. 风险与对策（含已踩坑）

| 风险 | 对策/状态 |
|---|---|
| Ink 在 node-pty+xterm+ConPTY 下闪烁/宽字符错位 | 只渲染关键事件 + `--plain` 兜底；M3 在 JanusX 面板实测 |
| Ink/React 污染 library 层 | `strict-unused` + import 禁令；core 三包零 React（已验证） |
| 两侧编排漂移 | M3 twin test；合批/LRU/窗口 guard 留壳 |
| readline 管道/粘贴丢行 | 已修：常驻 `line` 监听 + 队列 |
| transport 重建丢解析（env/file model） | 已修：`resolveModelId` 单一优先级链 |
| 单测写穿 `~/.janus` | 已修：全注入 + 跑后断言为空 |
| 上下文超限/无 function-calling 模型 | `SYSTEM_CONTEXT_EXCEEDS_BUDGET` 黄字 + `/clear` 建议；门禁沿用 |

---

## 10. 验收（MVP，含 JanusX 约束）

* [x] 无参进 TUI，多轮不退，第二轮引用首轮；`Ctrl+C` 只断当轮；`/model /workspace /clear /exit` 全可用。
* [x] 工具卡终态正确，失败不崩；无配置红字指引（exit 2）。
* [x] `session/conversations/providers/commands/store/exec/logo` 无 Ink 依赖，可被 JanusX 主进程直接 import。
* [x] 空态 ASCII logo + hint，输入框与状态栏常驻；`/clear` 回空态。
* [x] `build/typecheck/test` 全绿，`chat` 单轮回归通过。
* [x] JanusX 原生终端 preset 落地（`be7be3a`，spawn + 生命周期 + i18n）。
* [ ] JanusX 终端面板同跑一遍（真机 `janus` 在 PATH 时）。
