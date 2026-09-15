# Agent Note: agentX 可靠性、Token 效率与中断稳定性综合优化

Status: proposed

## Problem

实际开发中 `janus` 的体感显著弱于 codex、opencode：工具调用频繁出错且一次手滑烧掉整轮、完成同等任务消耗更多 token、取消与审批交互容易卡死或误触发。三个症状各有独立根因，但共同指向 harness 层的收敛缺失。

工具可靠性方面，`packages/agent-core/src/main/agent/stream/tool-call-accumulator.ts` 只做字符串拼接，`JSON.parse` 延迟到 `complete` 才执行，增量失衡、截断、单引号问题要到整轮流结束才以 `Tool call arguments are not valid JSON` 暴露。`packages/agent-core/src/main/agent/loop/vercel-stream-adapter.ts` 把 `INVALID_TOOL_CALL` 直接转为 `model_error` 并抛 loop，而 `ask_user` 参数错却走 `isError` 回灌模型自愈。同一类错误两种命运，解析失败的重试成本是一次参数错的数倍。`workspaceId` 每个 `workspace.*` 调用必填，模型在多资源下高频幻造或串号，`chat-tools` 描述的默认值与 `runtime` 实际默认值漂移（`list depth`、`read maxBytes`），`command.run` 的 `program/args` 分离与 700 字单句 description 超出模型直觉，`edit` 的 `expectedHash` 新鲜度与逐字节 `oldText` 在 Windows CRLF 下失配，三者叠加让裸错率居高不下。

Token 效率方面，`packages/chat-core/src/main/llm/system-prompt-builder.ts` 的静态部分约 1400 到 1800 tokens，本身精简。膨胀来自动态堆叠：每轮 `traceHistory`、`todoState`、`knowledge`、`LoadedEvidence`（3 文件乘 6k）、`summary`（8k）、`handoff` 全量进窗口，`chat-session-runtime.ts` 只有 `compactToolMessage` 的 6k 与 4k 截断，没有保留调用擦除输出的 prune。`registry.listManifests` 动态生成的工具数组排序不固定，`usage` 只取 `prompt/completion` 而丢推理 token，预算长期低估。`chat-turn.ts` 的 `getFollowUpMessages` 只在空回复时补 recovery，工具失败靠模型把 6k 错误全文再读一遍盲重试。

中断稳定性方面，`packages/cli/src/repl.ts` 的 `process.once('SIGINT')` 全生命周期只注册一次，第一次 abort 消耗后下一 turn 的 `Ctrl+C` 直接杀进程；turn 运行期 `queued.push` 不 drain，取消后粘贴内容立刻开新 turn。`packages/cli/src/session.ts` 把 `approvalSignal` 与 turn signal 共用，`janus-agent-loop.ts` 把 `denied/cancelled` 当普通 `tool_result` 继续下一轮 LLM 调用，审批等待期既不能切回 `auto-run` 也不能排队输入。`Esc` 在 `App.tsx` 的 busy、中断、审批、提问四条路径语义分裂。`runtime.ts` 的 `withTimeout` 只管 `tool.execute` 不管模型流，超时后 `timeoutSession` 永久砖掉会话，下轮 `resolveWorkspaceChatResources` 直接抛 `Attached workspace session is unavailable`。`max-turns` 到数静默 `break` 无事件，`runChatTurn` 抛异常时 `persist` 全跳过，内存与落盘分叉。在途工具一旦 `await host.executeFunctionCall` 即与 turn signal 脱钩，`Ctrl+C` 后 `command.run` 照跑到 120s，前端 `cancelled` 只是假象。

维持现状的代价是每类任务多烧 3 到 5 个无意义往返，打包发版类多步任务期望轮次持续超预算，Windows 后台子进程与审批 hang 的风险随使用时长累积。本 Note 以总账维护全部修复，后续按 P0 到 P2 拆独立实现，细节归各子实现所有。

## Proposal

以本 Note 为总账，后续按 P0 止血、P1 省 token、P2 收敛架构三批落地。本 Note 只定方向、分级与验收口径，不直接规定每项的代码 diff，diff 归各子实现所有。

P0 止血工具与中断，须先做。解析失败不再即死，`ToolCallAccumulator` 增加增量上限与空 delta 过滤，`complete` 的 `invalid` 转为 `isError` 的 `tool` 消息回灌模型，文案区分参数错与截断两种情况，截断单独给缩小参数重调的指引。`vercel-stream-adapter` 的 `INVALID_TOOL_CALL` 分支与 `Unknown tool` 分支同样走回灌，不再抛 loop。`workspaceId` 引入默认值，等价单资源时模型可省略，多资源时 `system-prompt-builder` 只列出 attached 列表且 `not attached` 自愈保留。`command.run` 增加字符串兜底解析，`program` 含空格时按 `windows-shell` 纯函数拆分并在结果中声明拆分方式，`description` 拆成短句且阈值语义不变。`git.pull/push` 忽略模型臆造的多余字段而不是整 call 拒绝。`chat-tools` 与 `runtime` 的默认值对齐由契约测试锁死，漂移即失败。

P0 中断语义统一为可重入取消。`repl.ts` 与 `cli.ts` 的 `SIGINT` 改为每 turn 装配与拆除，abort 时清空排队输入，`TUI App.tsx` 的队列行为与 `repl` 对齐。`approval/question` 的 signal 与 turn signal 分离，`abort` 走 `break` 而不是 `deny`，`denied` 才走 `isError` 继续。`Esc` 收敛为取消整轮唯一键，审批与提问卡片的 `Esc` 同样触发整轮取消，单次否决改用显式 `n` 键。`timeout-ms` 只失败当次工具调用，不再 `timeoutSession`，会话保持可用；模型流增加独立超时兜底，底层迭代器不响应 abort 时按超时切断。`max-turns` 耗尽发出显式事件，`repl` 与 TUI 展示可操作的截断提示而不是空文本。`runChatTurn` 的 `persist` 移入 `finally`，异常路径同样落盘 `todos` 与 `messages`，内存与磁盘不再分叉。在途工具执行前检查 `aborted`，执行中通过 `session.controller` 联动取消，`command.run` 的超时与停止沿用整树强杀语义。`headless` 无 `onQuestion` 时 `ask_user` 一次性返回非交互指引，不再耗 `maxTurns` 反复试探。

P1 省 token，次之做。历史只追加不原地改，`tools` 数组排序固定后 freeze，`env` 动态部分最小化，`skill` 只发 metadata 而调用时拉全文。`compaction` 在现有确定性裁剪之上增加 prune 档：保留 `tool_call`，擦除 40k 之前的 `tool_output` 并以占位符保留，tail 截断统一为 2000 字，`keep.tokens` 可调且默认远大于 `system+tools` 以避免 compact 循环。`usage` 计入推理 token，预算按实测窗口计算。`LoadedEvidence` 与 `summary` 上限收紧，`traceHistory` 与 `handoff` 只保留路径与 hash 而不重复正文。工具失败的 follow-up 增加专用修复提示，`APPROVAL_DENIED` 与 `TARGET_CHANGED` 之外的裸错同样附带行动建议。`command.run` 的长描述按阈值拆成短规则，`workspaceId` 默认值生效后工具列表每行缩短。

P2 收敛架构，按需做。写操作收敛到原子多文件 DSL 并配流式 hunk 预览，替代 `read` 加 `edit` 加 `verify` 三步中的后两步往返。`plan` 做成权限级 agent 而不是 prompt 口号，只读档默认拒绝 `edit`。`steeringPort` 的抢占语义收敛到单一 orchestrator，`transformContext`、`getFollowUpMessages`、`getSteeringMessages` 的调用点合并，中断只弃 stream 不弃已落历史，已执行 tool 不回滚而靠 checkpoint 与 git 显式恢复。`ai@3.4.33` 的 `model-compat` 垫片在升级后删除，`IGNORED_CHUNK_TYPES` 与 `model-stream` 的透传语义统一。`Ink` 是否保留待独立评估，长列表与大 diff 下的抖动由渲染专项承担。

| # | 方向 | 现状证据 | 对标 | 级别 |
|---|---|---|---|---|
| 1 | 解析失败回灌 | `tool-call-accumulator.ts:46`、`vercel-stream-adapter.ts:215` 即死抛 loop | codex `RespondToModel`、opencode `InvalidTool`、pi `tool_result` 自修 | P0 |
| 2 | 可重入取消 | `repl.ts:552 once`、`queued.push` 不 drain、`App.tsx:604` 分裂 | grok-build `Esc/stop` 终止后台子 agent、pi `/tree` 分支后继续 | P0 |
| 3 | 审批与中断分离 | `session.ts:960` 共用 signal、`loop.ts:257` abort 等同 deny | opencode 内联审批卡片、codex 审批弹窗与 turn 取消正交 | P0 |
| 4 | 超时不砖会话 | `runtime.ts:164 timeoutSession` 永久不可恢复 | codex/opencode 超时只失败当次 exec 并保留尾部输出 | P0 |
| 5 | 默认值对齐 | `chat-tools` 与 `runtime` 的 `depth/maxBytes` 漂移 | opencode zod 单一出处、pi TypeBox 单一 schema | P0 |
| 6 | 历史只追加与工具 freeze | 动态工具数组、`usage` 丢推理 token | codex append-only input 与 cache 亲和、pi 会话树 JSONL 追加 | P1 |
| 7 | 擦 output 留 call | 只有 6k 与 4k 截断 | opencode prune、pi `branch_summary` 折叠、codex server-side compact | P1 |
| 8 | 原子写与流式预览 | `edit expectedHash` 三步往返 | codex `apply_patch` DSL、pi hash 锚定行编辑 | P2 |
| 9 | 权限级 plan | 只有 `effort` 八档与口头约定 | opencode `plan/build/explore` 三 agent、grok-build `plan` agent 与 `--permission-mode plan` | P2 |
| 10 | 单一 orchestrator | `transformContext/followUp/steering` 三处分散 | grok-build `SessionActor` 单一主循环、pi `Agent` 单一循环 | P2 |

## Alternatives considered

- 逐项建独立 proposed Note，不设总账 — 粒度最干净，每项独立评审；但工具、中断、token 三者共享同一 loop 与同一 session 层，分散后顺序依赖与重复论证散落各处，总账的协调价值超过一文件多决策的气味，子实现建档后本 Note 只保留索引即可收敛。
- 照搬某一家全量设计（如全盘抄 opencode 权限或 codex 沙箱） — 上手最快，生态兼容；但 janus 的 OpenAI 兼容单传输、直调工具注册、`path-guard` 加 `policy-gate` 的 jail 模型与三家都不完全同构，全抄引入不必要的协议与 OS 沙箱复杂度，分项吸收更可控。grok-build 的 Rust Actor 与内核级沙箱、pi 的会话树分支语义同样不可直搬，取其 invariants 而不取其实现。
- 只修 P0，不动 P1 与 P2 — 投入最小，先止住中断与裸错；但上下文堆叠与预算低估会让 P0 上线后仍费 token，总账必须提前暴露全貌，实施分批即可。
- Do nothing / reuse — 零代码，依赖模型自身变强与用户手动重读、手动 kill 残留进程；代价是打包发版类任务每轮多烧 3 到 5 个往返，审批 hang 与砖会话问题 deterministic 复现，本次调研的结论即被浪费。

## Acceptance criteria

- [ ] 解析失败与未知工具不再抛 loop，截断与参数错各自有可操作回灌文案，裸错重试轮次下降可用当轮自纠率衡量。
- [ ] `Ctrl+C` 与 `Esc` 可重入且语义唯一，取消后无排队输入误开新 turn，审批等待期可显式切回 `auto-run` 或取消整轮。
- [ ] 超时只失败当次调用，會话保持可用；在途工具可联动取消，无 120s 空跑假象；`max-turns` 耗尽有显式事件与可操作提示。
- [ ] `chat-tools` 与 `runtime` 默认值由契约测试锁死，`tools` 排序固定，历史只追加，`usage` 含推理 token。
- [ ] prune 档可用：保留调用擦除旧输出，`keep.tokens` 可调，长会话不再陷入 compact 循环。
- [ ] `typecheck` 与全 workspace `vitest` 全绿，工具契约数量测试随工具面同步更新。

## Risks

- 总账与子实现分叉 — 本 Note 只定分级与验收，细节归子实现，建档后回链索引承担，定期对账。
- 回灌文案被模型忽略 — 可操作报错的措辞由工具契约测试承担，截断与参数错各有独立断言。
- 取消语义收紧误杀合法后台任务 — `command.run` 的后台阈值与 `project.process-output` 续跑句柄承担，长构建仍走后台加轮询而不是前台超时。
- prune 误删跨轮证据 — `LoadedContextIndex` 的 hash 账本承担，擦除只针对旧 `tool_output` 正文，调用与 hash 保留。
- 架构收敛引入大改 — P2 不阻塞 P0 与 P1，`steeringPort` 与 `model-compat` 的改动各自独立 Note，先凍结行为再重构。
