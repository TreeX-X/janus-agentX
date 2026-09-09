# JanusX-Agent 优化实施方案书

> 原文：`docs/idea/JanusX-Pi-Agent原生工具调用与SSE流式重构方案.md`（阶段 A–E 已完成，已归档删除，以本文为准）
>
> 状态：P0、P1、P2、P3-0、P4（含尾巴）、P5、P6 已落地（2026-09-06；2026-09-05 UTC 按工作区实测复核确认，见 §11 剩余项）；R1、R2、R3、R4、R5、R6-lite、R6-full 已落地（xdo 直接执行，见 §11 修订；R6-lite 已被 R6-full 取代，见 R6 行）；R7 已落地（xdo，2026-09-05 UTC：手动 /compact 确定性折叠，会话树分支仍按需再议，见 §11 R7 行）
>
> 创建日期：2026-09-06
>
> 复核日期：2026-09-06（按实际实现复核，修正 L1/L2/L6 与 P3 落地状态；新增 §10.7 最优先项；P3-0 已实施）→ 2026-09-05 UTC 二次复核：P0–P6 均在工作区代码中存在（行号有漂移，见各节备注；L1/L2 表中“仍卡旧值/缺失/仍旧值”三行已过期，P3-0 落地后已补齐，见 §10.1 修订与 §11）→ R1+R2 落地复核（xdo）：面板步数接线 + 安全编译总开关接线，回归 34 文件 391 通过，tsc/eslint/i18n 全绿 → R3 落地复核（xdo）：Runner 后台可配超时 kill，回归 34 文件 393 通过，tsc/eslint 全绿 → R4 落地复核（xdo）：command.run env allowlist 透传，回归 34 文件 397 通过，tsc/eslint 全绿 → R5 落地复核（xdo）：消费期可重试错误有限重试（零可见进度边界），回归 34 文件 401 通过，tsc/eslint 全绿 → R6-lite 落地复核（xdo）：流式中发送排队 + 边界自动投递（纯渲染侧），队列单测 6 通过 + agent 34 文件 401 通过 + tsc/eslint/i18n 全绿（全量套件另有 9 文件失败，经 stash 对照实验证实为历史失败/flaky，与本轮改动无关）→ R6-full 落地复核（xdo）：loop 抢占端口 + 主侧 steer 队列/IPC/消费事件 + 渲染改道，loop 8/8 + steering 4/4 + agent 34 文件全绿 + tsc/eslint/i18n 全绿（全量套件失败文件经文件级举证全部排除：改动 20 文件零 knowledge/office/roundtable 交集，`data-turn` 断言早已过期，fs 类为负载 flaky）
>
> 参考：`earendil-works/pi` 的 Agent Runtime、事件模型与 thinking 机制；JanusX 当前 `llm-core`、Agent Loop 与 Workspace Agent Runtime。

## 1. 背景与目标

前期已按 `pi` 设计完成两轮优化（`xdo` 直接实施，已合入）：

- **P0**：空回复兜底同时走 `agentEvent text_delta` 通道，修复“有工具调用+思考，随后无返回”（`chat-orchestrator.ts:564-571`；原文记 `:528`，实为 `getFollowUpMessages` 恢复提示行，兜底本体已下移）。
- **P1**：循环语义对齐 `pi`（整批全 `terminate` 才停；新增 `shouldStopAfterTurn` 预算守卫，用真实 token 估算含刚追加的工具结果，补 `pi #5512` 缺口）；上下文剪枝时注入确定性 `handoff` 摘要（保留 `path/sha256/query` 原文，不改写 hash，`workspace.edit` 的 `expectedHash` 不失效）。

本文目标（**P2**）：让 `janus-agent` 显示思维链，但**不全文展开**——只在对话的加载效果区域内收纳展示（流式时可见思考进度，结束后收起为一行）。

> 落地状态（2026-09-06 复核）：P2 已落地（`ThinkingRegion.tsx` + `janusReasoning.ts` + `useJanusChat.ts:287-309,616-625` + `JanusChat.tsx:1184,1203`）。下文 §2–§9 保留为实现档案，新需求看 §10.7。

## 2. 现状：思维链链路只差渲染端最后一米

| 层 | 现状 | 结论 |
|---|---|---|
| Provider/Adapter | `vercel-stream-adapter.ts:215-216` 收到 `reasoning-delta` 即 `emit reasoning_update`（原文记 `:195`，该行现为 `INVALID_TOOL_CALL`，已漂移） | 推理增量已进入 Loop 事件 |
| Agent Loop | `janus-agent-loop.ts:49` 定义 `reasoning_update` 事件 | Loop 透出正常 |
| 事件映射 | `event-mapper.ts:11` → `AgentStreamEvent reasoning_delta`；`chat-agent-events.ts:21` → `ChatAgentEvent reasoning_delta` | IPC 契约已有 `shared/ipc/llm.ts:44` |
| 渲染传输 | `services/llm.ts:205-212` 经 `onAgentEvent` 透传所有 agent 事件（无 `reasoning_delta` 专支，靠通用透传给 `useJanusChat:616-620`） | 事件能到达 `useJanusChat` |
| 渲染状态 | `useJanusChat.ts:560 onAgentEvent` 只 `reduceChatAgentEvent`（仅处理工具类事件），`reasoning_delta` 被忽略 | **缺口①：无 reasoning 缓冲** |
| 渲染视图 | `JanusChat.tsx:1182` 流式块只渲染 `pendingContent` + `janus-chat-loading` 三点 + `ToolCallGroup` | **缺口②：无思考展示区** |
| 回复判定 | `chat-orchestrator.ts` 仅 `message_update` 累加 `streamedText` | 正确（思考不计入正文，空正文走 P0 兜底），保持不动 |

结论：主进程零改动（可选加截断上限，见 §5.4），工作量集中在渲染端状态 + 展示区。

## 3. `pi` 的思维链机制对照（抄什么、改什么）

| `pi` 机制 | 位置 | JanusX 取舍 |
|---|---|---|
| `ThinkingContent{thinking, thinkingSignature, redacted}` 一等内容块 | `packages/ai/src/types.ts` | 抄思想： reasoning 独立于 `pendingContent` 的缓冲，不混入正文 |
| `thinking_start/delta/end` 流事件 | 同上 `AssistantMessageEvent` | 已有对等物（`reasoning_update/delta`），直接用 |
| `thinkingLevel off/minimal…max` + `thinkingBudgets` | `packages/agent/src/types.ts` | 暂不做：JanusX 不透传 effort 参数，第一版只做“显示”，不做“控制” |
| TUI thinking 块 `Ctrl+T` 折叠、流式展开→结束自动收起 | TUI/`#8171` | 抄交互：流式区内收纳展示，结束后收起为一行，可点开展示全文 |
| `serializeConversation` 输出 `[Assistant thinking]: …` 参与压缩 | `compaction.md` | 暂不做：思考不进模型上下文，避免污染预算与 prompt 缓存；只做 UI 展示 |
| 打码块仅回传不可见 | 同上 | 直接继承：收不到原文就不显示，不报错 |

## 4. 展示设计：加载效果区内的收纳式思考

### 4.1 交互规范（核心要求：不展开全部显示）

```text
流式中（isStreaming）：
┌ assistant 气泡 ─────────────────────┐
│ ▸ 思考中…（145字） ⌄        ← 收纳行：单行、呼吸点动画、字数实时涨 │
│ …正文流式内容（pendingContent）…                                    │
│ …工具卡（ToolCallGroup）…                                            │
└─────────────────────────────────────┘
  └ 点击收纳行 → 展开为限定高度滚动区（默认仍收起；流式中默认收起，只露进度）

流式结束：
┌ assistant 气泡 ─────────────────────┐
│ ▸ 已思考 320 字                     ← 收起为一行，点击可展开回看      │
│ …正文… + 工具卡…                                                  │
└─────────────────────────────────────┘

无 reasoning 的模型：收纳行不出现，视图与现状完全一致（零回归面）。
```

规则：

1. 思考区只活在**对话加载效果区域内**（`JanusChat.tsx:1182` 流式块及其提交后的同气泡延续），不另开面板、不弹窗。
2. 默认收起：流式中显示进度行（`思考中… N字` + 省略号动画），**不自动展开全文**；用户点开展示限定高度（建议 `max-height 120px`）内部滚动区。
3. 结束后收起为 `已思考 N 字` 一行，点击展开回看；`N` 来自实际收到字数。
4. 有界：缓冲上限（如 `4000` 字符，超限截**头**留尾——尾部通常是最新结论方向；或截尾留头，二选一后写死进验收），超限行尾显示 `…已截断`。
5. 不计入 `streamedText`：推理型模型“长思考+短正文/空正文”时，回复判定与 P0 兜底逻辑不变。

### 4.2 视觉

- 复用 `janus-chat-loading` 的三点动画语言 + `ToolCallGroup` 卡片描边语义，新增 `janus-chat-thinking` 收纳行样式（`08-janus-workspace-chat.css`），与现有空态/加载态同色系。
- 展开区用等宽或弱化字色，与正文 `MarkdownContent` 拉开层级，明确“过程，非结论”。

## 5. 技术方案

### 5.1 渲染状态（`useJanusChat.ts`，仿 `pendingContent` 成对实现）

- `ConversationRuntime` 新增 `pendingReasoning: string`；`RuntimeHandles` 新增 `reasoningBuffer: string`（与 `pendingBuffer` 同 `16ms` 合批 `flushTimer` 复用或独立 timer，二选一）。
- `onAgentEvent` 新增分支：`reasoning_delta` → `appendReasoning(id, delta)`（generation 隔离：`handles.generation === generation` 才收；`stop/clear/新 send` 时与 `pendingBuffer` 同清）。
- `commitAssistant` 提交后：`pendingReasoning` 清零；同时把**截断后的全文 + 字数**挂到该 `assistantMessageId` 名下（如 `reasoningByTurn: Record<turnId, {text, chars, truncated}>`，随 `toolTraces` 同持久化上限，如 `48` 条只保留文本、`MAX_TOOL_TRACES` 同策略），供结束后展开回看。
- `getController` 暴露 `pendingReasoning`；`JanusChat` 新增可选 props（`pendingReasoning?: string`，`reasoningCollapsed` 内部 state 即可）。

### 5.2 视图（`JanusChat.tsx`）

- 流式块（`:1182`）内、正文上方插入 `<ThinkingRegion>`：收纳行（进度/字数/展开切换）+ 条件展开区。`contentSignature` 纳入 `pendingReasoning.length` 以驱动自动滚动与 badge 逻辑（仿 `:323`）。
- 提交后的 assistant 消息下方：若该 `msg.id` 有 reasoning 记录，渲染同一组件的“已收起”形态（`已思考 N 字`）。
- `discussionOnly`（圆桌中央）同样复用该组件但默认收起（该视图 `isStreaming=false` 写死，只展示回看行）。

### 5.3 传输（原则：不动主进程事件，只加前端分支）

`services/llm.ts` 的 `onAgentEvent` 已透传 `reasoning_delta`，无需改动；`useJanusChat` 的 `onAgentEvent` 回调是唯一新增分支点。

### 5.4 主进程可选加固（非必需，建议顺手做）

- `chat-orchestrator.ts onEvent`：`reasoning_delta` 累计字数，超上限（如 `8000` 字符/请求）后不再 `sendAgentEvent`，省 IPC；同时该计数可用于结束行 `N` 的准确性（以渲染端实际收到为准，二选一）。

### 5.5 不做的事（边界）

- 不向模型回传 thinking（压缩/`convertToLlm` 不引入），不新增 `thinkingLevel` 参数透传。
- 不改变 `streamedText`/空兜底判定；不改变审批、审计、工具执行任何语义。
- 打码/无 reasoning 的 provider：无行、无错，静默兼容。

## 6. 验收标准

1. 推理模型流式时：气泡加载区出现 `思考中… N字` 收纳行（默认收起），点开展示滚动区，字数实时增长；正文与工具卡行为不变。
2. 结束后：收纳行变为 `已思考 N 字`，点击可展开回看；新一轮发送后旧思考不串台（generation 隔离）。
3. 非推理模型：无任何新增行，现有快照/样式测试无变化。
4. 超限：`4000` 字符外被截断并标识 `…已截断`；长会话持久化不膨胀（条数上限）。
5. 回归：P0 空兜底用例（工具调用后空正文仍有可见回复）与 P1 三单测（`terminate` 共识、`shouldStop`、`handoff`）保持通过。

## 7. 测试计划

- 单测（`vitest`）：`reasoning_delta` 累积/截断/`generation` 隔离/`stop-clear` 语义；`commitAssistant` 挂接 `turnId`；超限截断方向。
- 联调：配推理模型（如带 `reasoning_content` 的 OpenAI-compatible / DeepSeek 类）走工作区问答，观察收纳行字数增长与结束收起。
- 回归：`janus-agent-loop`、`chat-session-runtime`、`workspace-chat-tools`、`chat-agent-events`、`island-chat-workspace-store`、`janus-chat-recall` 全绿；`eslint` 改动文件 0 错误。

## 8. 风险与控制

| 风险 | 控制 |
|---|---|
| 推理超长刷屏/胀内存 | 前端 `4000` 字符硬截断 + 主进程 `8000` 字符断流；只保留尾部/last-N |
| 用户误把思考当结论 | 视觉降级（弱字色、折叠、标注“思考过程”），默认收起 |
| 推理挤占 IPC/渲染性能 | 复用 `16ms` 合批；`contentSignature` 只用长度，避免逐字重排 |
| 打码 reasoning 无原文 | 无行、无错；字数为 0 时不渲染 |
| 与 P0 兜底冲突 | 思考永不计入 `streamedText`，判定链路零改动 |

## 9. 实施步骤（`xdo`，预计小批量）

1. `useJanusChat.ts`：`pendingReasoning` 状态 + `reasoningBuffer` 合批 + `turnId` 挂接（仿 `pendingContent/toolTraces`）。
2. `JanusChat.tsx` + `08-janus-workspace-chat.css`：`ThinkingRegion` 收纳组件 + 流式块/历史消息两处挂载。
3. 可选：`chat-orchestrator.ts` 推理断流上限。
4. 单测 + 回归套件 + 手工联调（推理模型工作区问答）。

---

## 10. P3–P6：janus-agent 硬限制治理（长编译专项，已确认，部分落地）

> 确认结论（2026-09-06）：全量写入 L1–L7；后台形态=**复用 `ProjectRunner`**；shell 策略=**保持单程序**（不引入 `shell.run`，组合命令由多 turn 串行完成）。
>
> 落地复核（2026-09-06，按代码实测修正原文；2026-09-05 UTC 二次复核确认以下均仍存在，仅行号漂移）：
> - 已落地：`command.run` 运行时 `DEFAULT 120s / MAX 600s`（`command-tools.ts:11-12`）、`background:true → runAdhoc`（`:168,203-209`）、`description` 已声明后台用法（`:158`）；`project.process-output(offsetLines)` 分页（`project-tools.ts:364-401`，`maxLines 1~1000`、`offsetLines 0~1000`）；`Runner.runAdhoc`（`runner.ts:179-236`，输出保留 `1000` 行、单行 `16KB`）；`chat` 侧 `preview` 自动生成（`workspace-chat-tools.ts:41`，模型免手写）；上下文已有压缩（`chat-session-runtime.ts`：`compactToolMessage 6k/4k` + `LoadedContextIndex 3×6k` + `droppedTurnsHandoffMessage`）；P2 思维链已落地（见 §2–§9 档案）；**P3-0 暴露层补齐已落地**（`workspace-chat-tools.ts:command_run[background+600s] + project_process_output[offsetLines+1000]`）。
> - P4（含尾巴，2026-09-06 落地）：同步 `8KB` 尾预览 + `.janusX/logs/cmd-*.log` + `preview-only` 模型值；后台 `runAdhoc` 退出落盘 `.janusX/logs/bg-*.log` + 快照保留 20 个 + `process-output` 可读已退出（含 `exitCode/logPath`），`stop` 已退出幂等成功；`toolResultToModelValue` 补后台 `projectId` 透传（此前会丢）。
> - P5（2026-09-06 落地）：安全编译 allowlist（包管理器 `run build/typecheck/lint/test` + `test`、`npx tsc --noEmit`、`node scripts/check-*.mjs`，裸命令名 + 参数元字符检查），`per-action` 下免审记 `AUTO_RUN_ALLOWED`；名单为代码级可配置常量（`policy-gate.ts:59-62 SAFE_COMPILE_*`），settings 接线见 R2（R2 已落地：`safeCompileAutoAllow` 总开关，名单内容保持 fail-closed 常量）。
> - P6（2026-09-06 落地）：`CHAT_MAX_STEPS` 经 `agentMaxSteps` 配置可调（默认 `40`，钳制 `1~100`，`config/service.ts:23-30` + settings IPC get/update；渲染设置面板见 R1，R1 已落地）；建流与消费期共用重试预算（R5 已落地：单轮 ≤3 次尝试，退避 `250ms→500ms`，`1000ms` 仅 cap，零可见进度边界，`INVALID_TOOL_CALL` 不变）；`toolTraces` 对长命令记 `exit/logPath/job` 摘要。
> - 未落地（见 §11 完整清单）：会话 `JSONL` 树、`/compact` 全量压缩、turn 中抢占 steering（按确认结论排后）＋ Runner `600s` 可配超时 kill、两处 settings/面板接线、消费期重试覆盖、follow-up 队列持久化。
>
> 参考：`earendil-works/pi`（`packages/agent` Agent Runtime、`packages/coding-agent` bash/read/write/edit 四工具、`background-bash` 社区扩展、`pi-bash-timeout` 超时包装扩展、`/tree//fork//compact` 会话机制）。

### 10.1 限制清单 L1–L7（现状 = 代码实测）

#### L1 执行超时：长编译仍死在暴露层（`command.run`）

| 项 | 实际实现（2026-09-06 复核） | 位置 |
|---|---|---|
| 单命令超时（运行时） | 已放宽：默认 `120s`，上限 `600s`（`1000~600000` 外抛错） | `command-tools.ts:11-12,138-141`（原文记 `:9-10`，已漂移） |
| 单命令超时（模型暴露层） | ~~仍卡旧值~~ **已补齐（P3-0，2026-09-06）**：`timeoutMs 1s~600s/default 120s`，模型可传 `>90s` | `workspace-chat-tools.ts:255-264` |
| 后台（运行时） | 已有：`background=true` 走 `getProjectRunner().runAdhoc()`，立即回 `{projectId,pid,name,logPath}` 不阻塞；退出后落盘 + 快照可读（P4 尾巴） | `command-tools.ts:168,203-209`，`runner.ts:179-236`（原文记 `command-tools.ts` / `runner.ts:158-237`，已漂移） |
| 后台（模型暴露层） | ~~缺失~~ **已补齐（P3-0，2026-09-06）**：`command_run.background: boolean, default false`，长编译可走 Runner 通道 | `workspace-chat-tools.ts:255-264` |
| 会话超时 | 每工具 `session.timeoutMs` 默认 `120s`，同步路径双重封顶；后台 Runner 进程独立生命周期不受其 kill | `runtime.ts:54,144,207` |
| 无重试 | 超时/失败无退避重试 | `runtime.ts:207` |

影响（2026-09-05 UTC 更新）：运行时与暴露层已对齐（P3-0），`npm run build` / `electron-vite build` 可走 `background:true` + `process-output(offset翻页)` + `stop` 全链路。`§10.7 P3-0` 由“最优先待办”转为“已落地档案”，新的最优先见 §11。

#### L2 输出截断：长日志半打通

| 项 | 实际实现（2026-09-06 复核） | 位置 |
|---|---|---|
| `command.run` 同步输出 | P4 已落地：`stdout/stderr` 为 `8KB` 尾预览，全量落 `.janusX/logs/cmd-*.log`（`10MB` 封顶，`logTruncated` 标记），返回 `logPath + totalBytes + wallTimeMs + exitCode` | `command-tools.ts:15,18,240`（原文记 `:12-14,34-130,232-278`，已漂移） |
| `command.run` 后台输出 | P4 尾巴已落地（2026-09-06）：退出落盘 `<cwd>/.janusX/logs/bg-*.log` + 快照保留 20 个（淘汰删文件）+ `process-output` 可读已退出（含 `exitCode/signal/logPath`，`exited:true`）；`stop` 已退出幂等成功；启动返回即带 workspace-relative `logPath` | `runner.ts:179-236,246-260,296-304,480-522`（原文记 `:44-68,158-237,246-260,296-304,480-522`，部分漂移），`project-tools.ts:379-425` |
| `project.process-output`（运行时） | `maxLines 1~1000`（原文误写 500）、`offsetLines 0~1000`、`128KB` 截断；尾部分页语义 `slice(start,end)` | `project-tools.ts:364-401`（原文记 `:379-410`，已漂移） |
| `project.process-output`（模型暴露层） | ~~仍旧值~~ **已补齐（P3-0，2026-09-06）**：`maxLines 1~1000/default 100` + `offsetLines 0~1000/default 0`，模型可翻页 | `workspace-chat-tools.ts:166-174` |
| 上下文风险 | P4 已落地：`toolResultToModelValue` 对 `command.run`/`project.process-output` 只放预览 + `logPath/totalLines/offsetLines` + 分页 `guidance` 进模型上下文（`tool-result.ts`），分页引用排在 blob 前以扛住 `compactToolMessage 4k` 裁剪；`workspace.search` 跳过 `.janusX` 防日志污染 | `tool-result.ts:11-62`，`chat-session-runtime.ts:121-141`，`workspace-tools.ts:288-292` |

#### L3 表达能力：单程序、无 shell、无自定义 env

| 项 | 实际实现（2026-09-06 复核，语义不变） | 位置 |
|---|---|---|
| 单程序 | `program + args[]`，禁 `&&`/`管道`/`重定向`；Win shim（`npm/yarn/pnpm/bun/.bat/.cmd`）下 args 含 `&\|<>\^\r\n` 直接拒 | `command-tools.ts:13,48-53`，`runner.ts:32-42` |
| 路径 | 禁绝对路径，只能命令名或工作区相对可执行文件（`/` 需解析为工作区内 file） | `command-tools.ts:131,146-150` |
| 参数 | `args<=100`，单参 `<=4096` 字符 | `command-tools.ts:11,135-137` |
| env | ~~`env: process.env` 写死，不可按调用传 `NODE_ENV` 等（`runAdhoc` 同样写死；仅 `Runner.run` 读 `LaunchConfig.env`）~~ **已补齐（R4，xdo）**：`command.run env?: Record<string,string>` allowlist 透传（`NODE_ENV/CI/TERM/FORCE_COLOR/NO_COLOR/CLICOLOR/LANG/LC_*/LANGUAGE/TZ`，32 条/4096 字符封顶，`PATH/LD_PRELOAD/NODE_OPTIONS` 永不放行），同步 `spawn` 与后台 `runAdhoc` 双路径生效 | `command-tools.ts:filterCommandEnv/SAFE_COMMAND_ENV_KEYS`，`runner.ts:runAdhoc env`，`workspace-chat-tools.ts:command_run env` |
| cwd | 支持 `cwd` 参数，但必须已存在的工作区内目录 | `command-tools.ts:126-129,151` |

`npm run build && tsc --noEmit` 必须拆 2 个 turn，多占 `maxTurns`。按确认结论不引入 `shell.run`，保持单程序。

#### L4 审批：安全编译已放行（P5 已落地 2026-09-06）

`command.run(actionRisk=external-command)` 在 `per-action` 下默认仍弹审批（`runtime.ts:98-132,190-199`，`policy-gate.ts:112-159`；默认 `per-action`，`auto-run` 才全免）。安全编译模式（包管理器 `run build/typecheck/lint/test` + `test`、`npx tsc --noEmit`、`node scripts/check-*.mjs`）在可信工作区内自动放行，记审计 `AUTO_RUN_ALLOWED`（`policy-gate.ts:isSafeCompileCommand` + `runtime.ts` 审批前分支）。含 `&|<>^` 等 shell 元字符、`..`/绝对路径/路径 program、超长参数一律维持 deny/审批；执行层校验照常 fail-closed。`preview` 由 `createToolPreview` 自动生成，模型免手写。

#### L5 工作区读写天花板

| 工具 | 上限（2026-09-06 复核，语义不变，补两处遗漏） | 位置 |
|---|---|---|
| `workspace.read` | 默认 `256KB`，上限 `1MB`；`>16MB` 文件 `sha256` 阶段即 `FILE_TOO_LARGE`；支持 `offset/maxBytes` 范围读 | `workspace-tools.ts:17-18,44-53`、`path-guard.ts:32,288` |
| `workspace.list` | `depth<=4`（默认2）、`maxEntries<=1000`（默认200）；模型暴露层是 `maxEntries<=600/default300`，略紧于运行时 | `workspace-tools.ts:20-22,224-228`，`workspace-chat-tools.ts:63-64` |
| `workspace.search` | 字面量子串（无正则），`query<=256` 字符，`maxResults<=50`，`maxFiles 2000`，单文件 `>512KB` 跳过，跳过 `node_modules/dist/out/build/coverage/target/vendor/__pycache__/.venv/venv/.janusX`（P4 加 `.janusX` 防日志污染，仅 `search` 的 walk；`list` 仍可列出 `.janusX`，见 `workspace-tools.ts:238-269` vs `:288-293,353`），行截 `300` 字符，`depth<=8` | `workspace-tools.ts:282-339` |
| `workspace.edit/create` | `<=1MB`，`replacements 1~40`，`oldText` 必须唯一命中，`unifiedDiff` 严格头/计数/路径一致，`expectedHash(SHA256)` 失配即 `TARGET_CHANGED`，仅 UTF-8 文本，`create` 用 `wx` 禁覆盖 | `file-transaction.ts:15-16,55-74,178-226,228-259,304-328` |
| 路径/链接 | 禁绝对路径、禁 `..`、目标必须已存在；`symlink` 跳过或 `O_NOFOLLOW` + `ino` 身份校验（`pnpm` 结构易 `TARGET_CHANGED`）；敏感路径（`.env/.npmrc/.git/.ssh/*.pem/key` 等）直接 `deny` | `path-guard.ts:61-68,135-189,228-316`、`policy-gate.ts:18-49` |
| `project.detect` | `depth<=3`、`maxDirectories<=100`，深 monorepo 扫不全 | `project-tools.ts:11-13,37-47` |

#### L6 循环/会话上限（P6 已落地 2026-09-06：步数 40 可配 + 建流重试）

`maxTurns` 经 `agentMaxSteps` 配置（默认 `40`，钳制 `1~100`，`config/service.ts:23-30 normalizeAgentMaxSteps` + settings IPC get/update；渲染设置面板已接线（R1 落地：`AgentSettingsPanel.tsx` 数字输入 1~100 + i18n + fallback 回显））；压缩已有（`transformContext=chatSession.buildContext` 做 `compactToolMessage` + `LoadedContextIndex` + 确定性 `handoff`，`chat-session-runtime.ts:121-289`）；`shouldStopAfterTurn` 预算守卫已有；建流与消费期共用重试预算（R5 已落地：`MAX_STREAM_ATTEMPTS=3`，退避实际为 `250ms → 500ms` 两次睡眠，`1000ms` 仅为 cap；消费期仅零可见进度轮次可重试，有进度/`INVALID_TOOL_CALL` 走原终态通道，见 §11 R5）。仍缺：turn 中 steering 抢占（steering 只在 turn 后注入 `janus-agent-loop.ts:187-188`）、无 follow-up 队列持久化。`project.start-process` 仅支持已保存 `LaunchConfig`，临时的 `npm run build` 走后台 `command.run` 通道（`project-tools.ts:334-362`）。

#### L7 Git/杂项上限

`git paths 1~100`、`status changes slice 500`、`diff 1~256KB（默认128KB）`、`log<=100`、`commit msg 1~500` 字符（`git-tools.ts:17-18,52-54,127-135`）；`chatSessions<=32`、`toolTraces<=24×300` 字符、推理转发 `8000` 字符、单工作区附件 `<=12`（`chat-orchestrator.ts:51,80-99,112`）；模型必须 `supportsFunctionCalling` 否则直接抛错（`chat-orchestrator.ts:476-478`）。

### 10.2 pi 是怎么处理的（抄什么、弃什么）

| pi 机制 | JanusX 取舍（已确认） |
|---|---|
| 核心极简：`read/write/edit/bash(+grep/find/ls)`，完整 shell（`command,timeout?,cwd?,env?,pty?,async?`），`timeout=0` 可禁用截止 | 抄方向：`command.run` 加 `env?/cwd?` 表达力 + 超时可配；**弃**：不引入无限制 shell，继续单程序 + 多 turn（安全优先） |
| 原生 `bash` **无默认超时**（挂起即卡死，`#1335` 结论：用 `AGENTS.md` 指导模型跑后台），靠 `pi-bash-timeout` 扩展包 `120s` 默认 + `tool_call` 拦截注入 + system-prompt 声明 | 抄：超时策略做成**可配置**而非写死常量；`description` 里声明默认超时让模型会用 `timeoutMs` |
| **无内置后台 bash，用 tmux**；社区标准解是 `background-bash` 扩展：`detached spawn(sh -c)` + 磁盘日志 + `jobId(bg-xxxx)` + `start/status/logs(offset/limit)/stop/list` + 进程组 kill + `thenable handle(.timeout/.each/.then)` + `execute_code({async:true})` 整块后台 + follow-up turn 投递 | 抄形态、换底座：**复用 `ProjectRunner`**（已确认），不另起 job 系统；`command.run` 长任务升级为 Runner 托管进程，`project.process-output` 统一读日志 |
| 输出：按行+字节双截断，全量进临时文件/artifact，预览 + `logPath` + 分页读，附 `Wall/Timeout` 统计 | 全抄：见 P4 |
| 无权限弹窗：容器隔离 + `bash.patterns` 模式审批（关键模式 deny）+ `--tools/--exclude-tools` + `/trust`（`ask/always/never`）+ 扩展 `tool_call` 拦截 | 抄一半：P5 只做**安全编译命令模式放行**，危险模式仍 deny/审批；不做全容器化 |
| 会话 `JSONL` 树 + `/tree//fork//clone` + 手动/自动 `compact`（溢出恢复 + 接近上限主动压），扩展可自定义压缩 | 抄：P6 先做 `maxTurns` 可配 + 失败重试 + 长日志不进全文（只进摘要+引用），压缩走知识库已有摘要能力复用 |
| `PI_SESSION_ID/FILE/PROVIDER/MODEL` 注入子进程 env；`!cmd` 送 LLM / `!!cmd` 不送；同名重注册覆盖内置工具（含渲染器） | 抄：`env` 透传 + `command.run` 重注册包装（只改 `execute`，保留渲染/审计） |

### 10.3 调整提案 P3–P6

#### P3 长任务后台化（底座=复用 `ProjectRunner`；运行时 + 暴露层均已落地，2026-09-05 UTC 复核）

* [已落地] `command.run` 新增 `background?: boolean`（默认 `false`，保持兼容）。`background=true` 时不 `spawn` 等待，改走 `getProjectRunner().runAdhoc()` 托管，立即返回 `{ projectId, pid, name, logPath }`，本次 turn 不阻塞；退出后日志落盘 + 快照保留，`process-output` 可读已退出（P4 尾巴）。
* [已落地] `description` 追加 `(default timeout 120s; pass background:true for long builds; poll with project.process-output)`（运行时 `command-tools.ts:158` + 暴露层 `workspace-chat-tools.ts:255` 均已同步）。
* [已落地] 状态/日志统一：`project.process-output(projectId, maxLines, offsetLines?)` 轮询运行中与已退出任务（`project-tools.ts`）；`stop` 复用 `project.stop-process`（已退出幂等成功）；Runner 侧 `1000` 行保留 + 退出快照 20 个。
* [已落地一半] 超时侧：`command.run` 同步路径 `MAX_TIMEOUT_MS 90s→600s`、默认 `30s→120s`已做（含暴露层 `workspace-chat-tools.ts:255-264`）；Runner 侧见 R3（已落地：`runAdhoc({timeoutMs?})` 1000~600000 opt-in，到期 SIGTERM→SIGKILL，`timedOut` 随快照落盘）。
* [已落地/P3-0] 暴露层补齐（见 §10.7 档案）：`workspace-chat-tools.ts:command_run` 补 `background` + `timeoutMs max 600s`，`project_process_output` 补 `offsetLines` + `maxLines max 1000`。运行时能力模型已可达。

#### P4 输出统一：预览 + 落盘 + 分页（已落地 2026-09-06）

* [已落地] `command.run` 同步返回：`stdout/stderr` 为尾部 `8KB` 预览 + `outputTruncated + logPath + totalBytes + wallTimeMs + exitCode + logTruncated`；全量（`10MB` 封顶，头保留）落 `.janusX/logs/cmd-<ts>-<rand>.log`（工作区内；写失败不 fail 命令，仅缺 `logPath`）。（`command-tools.ts`）
* [已落地] `toolResultToModelValue`：`command.run`/`project.process-output` 只放预览 + 分页引用 + `guidance` 进模型上下文，引用排 blob 前（扛 `compact 4k` 裁剪）；全文永不进 `messages`。（`tool-result.ts:11-62`）
* [已落地] `workspace.search` 跳过 `.janusX`，防构建日志污染代码搜索；同步日志分页走 `workspace.read(offset/maxBytes)`，后台日志分页走 `process-output(offsetLines)`。
* 验收：`npm run build` 日志 `>64KB` 时模型用 `logPath + workspace.read` 或 `offsetLines` 翻页定位到 `error TSxxxx` 行；后台构建结束后仍可用 `process-output(exited:true)` + `logPath` 回看（P4 尾巴）。
* 落地记录（2026-09-06）：`Runner.exitedAdhoc` + `getExited` + 退出落盘（`runner.ts`），`process-output` 已退出兜底（`project-tools.ts`），后台 `projectId` 进模型值（`tool-result.ts` 补透传）。

#### P5 审批：保持单程序，仅模式放行（已落地 2026-09-06）

* 不做 `shell.run`（已否决）。`command.run` 保持 `program + args[]` 单程序语义。
* [已落地] `preview` 由 `createToolPreview` 自动生成（`program+args+cwd`），模型免手写，`janus-chat` 通道缺 `preview` 不再 `PREVIEW_REQUIRED` 失败。
* [已落地] 安全编译模式 allowlist（代码级可配置常量 `policy-gate.ts:SAFE_COMPILE_MANAGERS/SCRIPTS/CHECK_SCRIPT`，默认）：`npm|yarn|pnpm|bun run build/typecheck/lint/test`、`npm test`、`npx tsc --noEmit`、`node scripts/check-*.mjs` 在可信工作区内自动放行（仍记审计 `AUTO_RUN_ALLOWED`，审批前分支，`runtime.ts`）；含 `&|<>^` 等 shell 元字符、`..`/绝对路径/路径 program、超长参数一律维持 deny/审批；执行层校验照常 fail-closed。
* 后续项（R2 已落地）：`safeCompileAutoAllow` 总开关 settings/面板接线完成（`GlobalConfig.safeCompileAutoAllow` + `ConfigService.get/updateSafeCompileAutoAllow` + settings IPC + `AgentSettingsPanel` 开关，默认 true；名单内容仍为代码级常量 `policy-gate.ts:59-62`，fail-closed）。

#### P6 循环/上下文小步快跑（已落地 2026-09-06）

* [已落地] `CHAT_MAX_STEPS` 经 `agentMaxSteps` 配置可调（默认 `40`，P6 前硬编码 `20`；钳制 `1~100`，`config/service.ts:23-30 normalizeAgentMaxSteps` + settings IPC get/update；仅 `janus-chat` 通道；渲染设置面板未接线——`AgentSettingsPanel.tsx` 仅 `approvalMode`，见 §11 R1），`session.timeoutMs` 保持 `120s` 默认，`command.run` 后台任务不受其 kill（Runner 侧独立生命周期）。
* [已落地] Provider 建流与消费期共用有限重试（R5 落地后：单轮 `MAX_STREAM_ATTEMPTS=3`，退避 `250ms→500ms`（`1000ms` 仅 cap），`vercel-stream-adapter.ts:runStreamAttempt` 尝试循环；消费期仅零可见进度轮次可重试，`INVALID_TOOL_CALL` 与有进度失败走现有 `model_error` 终态通道不变，见 §11 R5）。
* [已落地] 长日志摘要化：`toolTraceEntryFromResult` 对 `command.run/project.process-output` 记 `exit/logPath/job/totalLines` 摘要（`300` 字符预算内，全文走日志文件引用）。
* 不做：会话 `JSONL` 树、`/compact` 全量压缩、turn 中抢占 steering——排后。

### 10.4 验收标准

1. `npm run build`（>90s）在 `background:true` 下立即回 `jobId + logPath`，`process-output` 可翻页看到 `error` 行（含已退出 `exited:true`），`stop` 可杀/幂等。（P3-0 + P4 尾巴已落地）
2. 同步 `command.run` 默认 `120s`、`MAX 600s`；`>64KB` 日志有 `logPath` 且模型上下文只进预览。（P4 已落地）
3. 安全编译命令免逐次点击，审计仍有 `AUTO_RUN_ALLOWED` 记录；`&&`/敏感路径仍被拦。（P5 已落地）
4. `detect→build→fix→rebuild` 两轮回归在 `40` 步内跑完（默认步数已 `40`）；`janus-agent-loop` 五单测 + `runtime/command/project` 单测全绿。（P6 已落地；本轮回归 34 文件 373 通过）

### 10.5 实施步骤（`xdo`，已执行 2026-09-06）

1. [已落地/P3-0] `workspace-chat-tools.ts`：`command_run` 补 `background` + `timeoutMs 600s`，`project_process_output` 补 `offsetLines` + `maxLines 1000` + 描述同步。
2. [已落地/P4] `command-tools.ts`：`8KB` 尾预览 + `.janusX/logs` 落盘 + `logPath/totalBytes/wallTimeMs`；`tool-result.ts` preview-only 模型值；`workspace.search` 跳过 `.janusX`。
3. [已落地/P4尾巴] `runner/service`：`runAdhoc` 日志路径 + 退出落盘 + `exitedAdhoc` 快照（20 个）+ `getExited`；`project-tools.ts:process-output` 已退出兜底；`tool-result.ts` 后台 `projectId` 透传；`stop` 已退出幂等。
4. [已落地/P5] `policy-gate.ts:isSafeCompileCommand` + `runtime.ts` 审批前放行（`AUTO_RUN_ALLOWED`）；名单为代码级可配置常量。
5. [已落地/P6] `config/service` + `workspace/types` + settings IPC：`agentMaxSteps`（默认 40）；`chat-orchestrator.ts` 用配置步数 + `toolTraces` 长命令摘要；`vercel-stream-adapter.ts` 建流重试。
6. 单测：后台启停/翻页/截断/allowlist/deny/重试/步数配置/toolTrace 摘要；联调建议：本工程 `npm run build` 实测（`background:true`）。

### 10.6 不做的事（边界）

* 不引入 `shell.run` / `sh -c` / 管道解析；不做容器隔离；不做会话树/`compact` 全量；不放宽敏感路径与 symlink 策略。
> 修订（2026-09-05 UTC，R7）：其中“`compact` 全量”已收敛为手动 `/compact` 确定性折叠落地（见 §11 R7 行；无 LLM 调用、hash 原文保留）；会话树分支（`/tree//fork//clone`）与自动压缩仍不做。

### 10.7 最优先：P3-0 暴露层补齐（已落地 2026-09-06，解开长编译死锁；本节保留为档案，新待办见 §11）

> 结论先行：**最优先不是 P4 落盘也不是 P5 放行，而是把已写好的运行时能力暴露给模型**。否则 P3 后端是死代码，长编译必死依旧。
>
> 实施记录：仅改 `src/main/llm/workspace-chat-tools.ts`（`command_run` + `project_process_output` + `createCommandPreview`），`vitest 27 passed`（`workspace-chat-tools/command/project`），`eslint 0 errors`，zod 解析校验通过（默认 `120s/background:false/offset:0`，`600000+background:true` 通过，`600001` 拒）。

断裂（实施前实测，已修复）：

1. `command_run`（`workspace-chat-tools.ts:254-263`）：zod `timeoutMs max 90_000/default 30_000`，运行时已 `600_000/120_000`；且缺 `background` 字段。模型想跑 `npm run build` 只能同步 30s，被 kill 后连 `projectId` 都拿不到，`process-output` 无从 poll。
2. `project_process_output`（`:166-174`）：zod `maxLines max 500`、无 `offsetLines`，运行时已 `max 1000 + offsetLines 0~1000`。即使后台跑起来，模型也翻不了页，只能读尾部 `100` 行，`error TSxxxx` 在头部即失明。

改动（仅 `workspace-chat-tools.ts`，零运行时风险）：

```ts
command_run: {
  program, cwd, args,
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  background: z.boolean().default(false), // true → 长编译/安装走 Runner，不阻塞 turn
}
project_process_output: {
  projectId,
  maxLines: z.number().int().min(1).max(1000).default(100),
  offsetLines: z.number().int().min(0).max(1000).default(0),
}
```

+ `command_run.description` 追加 `pass background:true for long builds; poll with project_process_output(offsetLines)`（运行时 `description` 已有，暴露层同步一句即可）。

为什么排第一：

* 成本最小（1 文件、纯 zod + 描述），回归面最小（默认值保持兼容，`background` 默认 `false`）。
* 收益最大：补完即打通 `background:true → process-output(offset翻页) → stop` 全链路，`npm run build>90s` 从“必死”变“可跑”；否则 P4/P5/P6 全被卡住。
* pi 对照：`pi` 原生 `bash` 无默认超时 + `background-bash` 扩展 `jobId/logs(offset/limit)/stop`，JanusX 运行时已抄到同形态，只差这层透出。

次优先排序（P3-0 之后；2026-09-05 UTC 注：下述 1–3 均已落地，转为档案）：

1. **P4-sync 落盘 + preview-only**：同步 `command.run` `>64KB` 全量落 `.janusX/logs/` 并只把预览 + `logPath + error行` 给模型，根治 token 打爆（目前靠 `compactToolMessage` 事后压缩，仍先占 `messages`）。
2. **P5 allowlist**：安全编译命令（`npm run build/typecheck/lint/test` 等）在可信工作区免逐次点击，解决“每次编译都要点”；危险模式维持 deny/审批。
3. **P6 步数/重试**：`CHAT_MAX_STEPS 20→40` 可配 + provider 流错误 `3` 次退避重试；`afterToolCall` 对长日志只记摘要 + `logPath`。

---

## 11. 剩余待实施项（2026-09-05 UTC 按工作区实测整理，P0–P6 主体已落地；R1–R6 全落地，xdo）

> 结论先行：长编译死锁链（P3-0/P4/P5/P6）已打通，R1（步数面板）、R2（安全编译总开关）、R3（Runner 后台可配超时）、R4（env allowlist 透传）、R5（消费期重试）、R6-full（轮中抢占 + steer 队列；R6-lite 已被取代移除）、R7（手动 /compact 确定性折叠，会话树分支按需再议）已落地。P0–R7 无剩余硬伤项。

| 编号 | 事项 | 现状证据 | 建议做法 |
|---|---|---|---|
| R1 | `agentMaxSteps` 渲染设置面板接线（P6 后续） | **已落地（xdo）**：`AgentSettingsPanel.tsx` 数字输入 1~100（默认 40，`normalizeAgentMaxStepsInput` 钳制）+ zh/en 文案 + `types.ts`（生成器确认 1486 keys）+ fallback 回显；IPC get/update 早已存在 | 回归：`agent-max-steps-config` 1 通过；`i18n:check` OK；`tsc`/`eslint` 0 错误 |
| R2 | `SAFE_COMPILE_*` 名单 settings/面板接线（P5 后续） | **已落地（xdo，总开关形态）**：`GlobalConfig.safeCompileAutoAllow`（默认 true）+ `ConfigService.get/updateSafeCompileAutoAllow` + settings IPC get/update + `CreateAgentSessionInput.safeCompileAutoAllow`（`agent-runtime-handlers` 建会话时读配置默认）+ `AgentSession.safeCompileAutoAllow` 会话透传 + `runtime.ts` P5 门控（`!== false` 才放行）+ 面板开关 + zh/en 文案；名单内容仍为代码常量（fail-closed，有意不做用户自定义名单） | 回归：新增 `runtime.test.ts` 2 用例（默认 true/关闭后走审批且非 AUTO_RUN_ALLOWED）+ config 1 用例；agent 套件 34 文件 391 通过；`tsc`/`eslint`/`i18n:check` 全绿 |
| R3 | Runner 侧可配超时 kill（P3 未落地一半） | **已落地（xdo，显式 opt-in）**：`runAdhoc({timeoutMs?})` 整数 1000~600000（与同步路径同界，缺席即无截止，保持历史行为），到期按 stop 语义 SIGTERM→SIGKILL（5s 升级），计时器与 stop/退出三路互斥清理 + `unref`；`timedOut` 进 `ExitedAdhocProject` 快照 + 磁盘日志头 + `project:exit` 事件 + `process-output(exited)` + 模型值 + toolTrace；`command_run.background` 透传显式 `timeoutMs`（同步默认 120s 不透传，避免误杀常驻任务），启动响应回显 `timeoutMs`；两层 description 已同步 | 回归：新增 2 用例（真实 1s 超时 kill→`timedOut:true` 全链路；越界 `999/600001` 拒）+ 手动 stop 锁定 `timedOut:false`；agent 套件 34 文件 393 通过；`tsc`/`eslint`（0 错误，1 处 `runner.ts:106` 历史 warning 未动）全绿 |
| R4 | `command.run` env/cwd 表达力（L3 确认结论遗留） | **已落地（xdo）**：`env?: Record<string,string>` allowlist 透传（12 运维键，大小写不敏感；`PATH/LD_PRELOAD/NODE_OPTIONS` 拒；32 条/4096 字符/NUL 界；数组等畸形在 registry schema 层先拦一道）；同步 `spawn env` 与后台 `runAdhoc env` 双路径；审批 preview 含 env（`redactPolicyValue` 显示脱敏）；审计天然只存长度（`projectPolicyInput` 字符串→`[string:N]`）；模型值 refs 前置 `env`；P5 verdict 不受 env 影响（名单键无提权能力）；`cwd` 已有保持不变，不引入 `shell.run` | 回归：新增 4 用例（同步透传+回显；拒 PATH/LD_PRELOAD/NODE_OPTIONS/畸形/超量；后台透传；模型值 env refs）；agent 套件 34 文件 397 通过；`tsc`/`eslint`（0 错误）全绿 |
| R5 | 消费期错误重试覆盖 | **已落地（xdo）**：建流与消费期共用 `MAX_STREAM_ATTEMPTS=3` 预算（`runStreamAttempt` 尝试循环，退避 `250ms→500ms`，`1000ms` 仅 cap；`startStreamWithRetry` 已移除、无残留引用）；安全边界=零可见进度（正文/推理/工具事件任一吐出即不可重试，下游无丢弃重放机制，重试有进度轮次会正文翻倍）；中间可重试失败静默、终态 `model_error` 只发一次；`INVALID_TOOL_CALL`/有进度失败/中abort 原通道不变 | 回归：新增 4 用例（首错 429 重试成功且无 model_error；有进度后 429 不重试且事件序列精确；INVALID 不重试；耗尽 3 次后单 model_error）；既有建流重试 2 用例行为不变；agent 套件 34 文件 401 通过；`tsc`/`eslint`（0 错误）全绿 |
| R6 | turn 中 steering 抢占 + follow-up 队列持久化 | **已落地（xdo，R6-full；R6-lite 已移除取代）**：①loop（`janus-agent-loop.ts`）：`AgentSteeringPort`（keyed push/take/remove，exactly once）+ 流式尝试独占 abort 域（steer 只杀本轮生成，父 signal 照常透传工具）+ 三处检查点（流后/串行间隙/并行批后/轮尾合并槽）+ `steering_consumed` 事件；半截 toolCalls 一律剥离（provider 配对约束），被打断轮强制续轮（steering 无人回答即 bug，单测抓获），计入 maxTurns。②主侧：请求级 steering 目标注册（key=conversationId，`MAX 10` 条）+ `chat-steer`/`chat-steer-cancel` IPC + 消费回执事件链（loop→mapper→chat-agent→渲染）；请求结束丢弃未消费（渲染历史已乐观追加，随会话落盘即 durable，无另行落盘文件——有意设计）。③渲染：send-during-stream 改乐观追加 + steer 投递（拒收竞态回退普通发送），消息内 badge + 逐条撤销，队满走 modelNotice 提示。单测修出真 bug 一枚（打断轮直接 break 致 steering 石沉大海→强制续轮）。pi 对照结论：pi 参考材料仅有后台 follow-up turn 投递（轮次边界），轮中抢占无对应物，属 JanusX 原创 | 回归：loop 8/8（含抢占/剥离/间隙/取消四新）+ steering helper 4/4 + agent 34 文件全绿 + janus UI 相关绿 + `tsc`/`eslint`（0 错误）/`i18n:check` 全绿；全量套件失败文件逐个举证排除（改动文件零交集/`data-turn` 过期/负载 flaky） |
| R7 | 会话 `JSONL` 树 + `/compact` 全量压缩（明确排后） | **已落地（xdo，2026-09-05 UTC，手动 /compact 确定性折叠）**：存储层本已是 `JSONL` journal 快照链（`janus/chat-store.ts` parentId 链接 + 恶行/断链容错）；本轮补齐用户可见的持久化压缩——`janusChatConversations.ts:parseCompactCommand/compactJanusConversation`（`/compact` 默认保最近 10 条、可 `/compact N` 钳制 2~50，旧部折为一条 assistant 摘要，路径/hash/查询原文保留永不改写，沿用 P1 handoff 原则；摘要 4000 字符有界超限从最早行丢弃；toolTraces 摘要进正文后裁至最近 24 条）+ `useJanusChat.ts:send` 拦截（本地执行不发模型，流式中拒绝并提示，短会话/no-op 提示已足够紧凑，落盘随现有会话 save 走 JSONL journal 即 durable）；会话树分支（`/tree//fork//clone`）仍按需再议，有意不做 | 回归：`janus-chat-conversations` 10 通过（新增 4：解析钳制/短会话 no-op/折叠保序与原文保留/摘要有界+trace 裁剪）；`janus-chat-store`/`island-chat-workspace-store`/`janus-chat-recall`/`chat-session-runtime` 30 通过；`tsc`/`eslint`（改动文件 0 错误）全绿；`janus-resource-ui` 1 失败经 stash 对照证实为历史失败（`data-turn` 过期断言，与本轮无关） |

另：文档行号漂移已在本轮修正关键处（P0 `:528→:564-571`、Adapter `:195→:215-216`、`command-tools :9-10→:11-12/:107→:158/:142-169→:168,203-209`、`runner :158-205→:179-236` 等）；后续改动建议只记符号名不记硬行号，或以“复核日期 + commit”锚定。
