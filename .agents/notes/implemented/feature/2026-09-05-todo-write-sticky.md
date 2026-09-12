# Agent Note: todo_write 单层 sticky 计划跟踪

Status: implemented

## Problem

3 步以上的任务在流式对话里缺少可执行的计划载体。写在正文里的 markdown 清单不可校验，UI 无法据此驱动计数与当前项展示，跨 turn 与跨会话时计划归属也没有隔离。若无写入约束，多个 in_progress 并存会让计数与当前项失去意义，计划跟踪退化为装饰。

## Decision

todo_write 是 janus-chat 通道的常开模型工具，与 workspace 附件无关。参数为 1 到 20 项的 todos，单项 content 上限 200 字符，状态机限定 pending、in_progress、completed、cancelled 四态。空清单拒绝写入，同时只允许一个 in_progress，非法写入返回带纠错文案的 isError，模型可自愈。校验与格式化收敛在 packages/chat-core/src/main/llm/chat-todo.ts，工具的模型形态与 loop 执行形态收敛在 packages/janus-agent/src/orchestrator/todo-tool.ts，流起点同步、system 单次注入与 todo_update 事件发射收敛在 packages/janus-agent/src/orchestrator/chat-turn.ts。system 提示只注入一次，长度随清单长度，上限 20 行；若无该约束，双分支重复注入会撑大上下文。

渲染侧只有一层常看载体。TodoStickyBar 置于 composer 上方、messages 滚动容器之外，滚动时保持可见，内容为待办计数与当前 in_progress 项，超过 2 项点击展开。空清单与全完成时自动隐藏，流式中随 todo_update 实时涨落。历史回看不另设气泡卡，只靠 todo_write 紧凑工具卡留痕；该约束避免双真相源与窄列过载。纯文本通道降级为 turn 内更新块加 turn 末单行提醒，工具卡压成单行计数。UI 永不写回计划，模型是唯一的写入者，折叠与隐藏只影响展示。存储为 ChatSessionRuntime 内存 Map 加会话快照双写，按会话隔离并随上限裁剪，abort 保留已落地的部分快照。

计划级概括由 todo_write 的可选 plan 字头承载：单行短串，超长截断，随清单全量替换写入，随 todo_update 事件透传；缺省与老快照按既有样式渲染。渲染时 plan 置于 TodoStickyBar 边框卡顶部与纯文本通道计数行之上，之下保留计数、当前项与明细，折叠态仍可见。模型在首次建表时写 plan，范围不变时保持稳定，变域才改写；UI 只读，永不写回 plan。

互补方向是知识 MCP 接入，见 [2026-09-05-knowledge-mcp-access](../../proposed/feature/2026-09-05-knowledge-mcp-access.md)（Agent 只读知识召回，与本计划跟踪能力正交，互不依赖）。

## Alternatives considered

- DB 持久化 todos — 崩溃恢复更完整；但内存加会话快照已覆盖切换与重进场景，DB 引入迁移与并发语义，当前规模下成本超出收益。
- 对齐 opencode 的 priority 与 position 模型 — 排序表达力更强；但首版只需状态推进，裁剪 priority 让校验与 UI 保持最小，待真实排序需求出现再补。
- 气泡回看卡加常驻条双层 — 历史可视性更好；但双层引入双真相源，窄列下折叠卡仍占信息带宽，单 sticky 加工具卡留痕已覆盖常看与回看。
- 子智能体独立 todo 域 — 派发场景的归属更干净；但子计划的归属需求尚未出现，留待派发能力落地时再定。
- 用户手动打勾写回 — 交互更直接；但双写者破坏单 in_progress 约束的可校验性，UI 只保留折叠与隐藏逻辑。
- Do nothing / reuse — 用 markdown 清单替代调用，零成本；代价是计划不可校验、不可驱动 UI，跨会话必串台，prompt 必须明令禁止该替代。
- 独立 plan 模式（只读分析加批准执行） — 先审后做更稳妥；但与列表上方总概括的需求正交，需动 agent loop 与权限门禁，成本超出收益。
- plan 独立 tool 或事件通道 — 概括与清单解耦演进；但引入第二个写入者与第二真相源，违背模型唯一写入者的可校验约束。
- 复用 session title 或首条 todo 充当标题 — 零 schema 成本；但跨 concerns 拼凑，首条漂移即错，不可校验。

## Consequences

- **Gains**: 3 步以上任务首调即建全量计划，且单 in_progress 可校验；常驻条计数与当前项随流实时更新，滚动时仍可见；非法写入自愈；会话隔离不串台。守卫为 `npx vitest run packages/chat-core/tests/chat-todo.test.ts packages/janus-agent/tests/todo-turn.test.ts packages/cli/tests/tui-todo.test.ts`，15 用例（8、3、4）实测通过。
- **Costs and limits**: 无 priority 与 position、无 DB（内存加会话快照，进程退出后只剩快照）、无子智能体独立域、无手动写回；清单上限 20 项、单项 200 字符，超限截断或拒写；当任务需要排序、跨进程恢复或子域隔离时重访本决策。
- **Gains (plan 字头)**: 计划级一句话概括常驻输入框上方，折叠态仍可见；可选字段保证缺省调用与老快照渲染不变。
- **Costs and limits (plan 字头)**: 每 turn 状态注入与事件透传多一行（截断上限内）；plan 写错或陈旧时随下次全量替换纠正，无独立修复通道。
