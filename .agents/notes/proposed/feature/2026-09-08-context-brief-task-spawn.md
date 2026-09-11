# Agent Note: 上下文提炼透传 context.brief 与 task.spawn

Status: proposed

## Problem

主 Agent 向子智能体派发任务时只能用自然语言 prompt 转述需求。散在多个 turn 的需求语句、已读文件的 sha256 与字节范围、旧 turn 的 tool digest 在转述中丢失，子智能体只能从目录列举与盲搜重新定位。若维持现状，每次派发都重复支付定位成本；sha 失真还会让 workspace.edit 的 expectedHash 校验冲突，派发规模越大，浪费越大。

## Proposal

新增两个正交的模型工具：context.brief 负责提炼，task.spawn 负责派发。

context.brief 的 actionRisk 定为 read，可并行，免审批。工具自行读取会话上下文，按 topic 或 query 抽取需求句、决策句、非 stale 文件引用与 digest，组装为一份可命名的 Brief，存入 ChatSessionRuntime 的内存 BriefStore。Brief 按 sessionId 与 workspaceId 隔离，父上下文只保留有界索引（5 行以内），全量不注入父上下文。

task.spawn 的 actionRisk 定为 run，强制串行，需审批并计预算。调用方传入 briefId 与最小任务指令，工具按 Brief 渲染固定的子系统提示（Topic、需求、决策、文件证据与 sha、digest、约束），构造隔离的子 loop 执行。子 loop 深度上限为 2，单次 maxTurns 上限为 5，结果回灌按 maxChars 截断并标记 truncated，子全量 log 永不回灌父历史。

MVP 的需求与决策句采用确定性规则抽取，sha256 与 path 由代码侧原样拼接，任何 LLM 改写层不得触碰 fileRefs。非法 briefId、空 task、超深递归进入带纠错文案的 isError，模型可自愈。

## Alternatives considered

- Brief 落盘或进 DB 持久化 — 跨会话复用的吸引力真实存在；但 MVP 只需随会话可用，持久化引入存储、淘汰与跨会话泄漏面，成本超出收益，跨会话召回留给 knowledge observation（V2）。
- 允许 LLM 自由改写 sha 与 path — 摘要可读性更高；但一次改写失真即导致 edit 冲突，MVP 禁止改写，V1 的润色层也只动正文。
- 与 todo_write 状态机耦合 — 统一计划载体的想法成立；但提炼与跟踪职责正交，耦合拖慢两边，联动（Brief 挂 todoId）放到 V2。
- 改动 Runtime 审批与审计主链 — 统一策略面更干净；但主链语义已稳定，两个新工具只需新增策略分支，无需重排主链。
- Do nothing / reuse — 维持纯 prompt 转述，零实现成本；代价是每次派发重复定位，sha 链持续失真，派发规模越大成本越高。

## Acceptance criteria

- [ ] 主 Agent 在 3 个以上 turn 与 2 个以上文件读取后调用 context.brief，返回的 fileRefs sha 与 workspace.read 返回一致。
- [ ] task.spawn 的子智能体首个工具调用为直读 Brief 中的 path（以子首动作为 workspace.read 验收）。
- [ ] workspace.edit 后旧 Brief 的 fileRefs 转 stale，子智能体收到重读提示，旧 expectedHash 失效。
- [ ] 非法 briefId、空 task、递归 spawn 返回可纠错的 isError，模型可自愈。
- [ ] 无 workspace 附件时 context.brief 仍可做纯对话提炼；无资源时 task.spawn fail-closed。
- [ ] 上下文预算打满时父会话不崩，子结果截断带 truncated 标记。

## Risks

- LLM 改写 sha 导致 edit 冲突 — MVP 禁改写承担，V1 改写层只动正文并用单测锁定 fileRefs 原样。
- 子 loop 无限递归 — depth 上限 2 硬拒、maxTurns 上限 5、串行可取消三层承担。
- 父上下文被 Brief 与子 log 撑爆 — 父侧有界索引与截断摘要承担，全量永不回灌。
- 工具名契约漂移 — tools-contract.test.ts 锁定数量（HEAD 为 22，新增后同步更新），改名必须与 JanusX shell 同版本同步。
- 跨会话与跨 workspace 泄漏 — Brief 按 sessionId 与 workspaceId 隔离、spawn 只透传单资源承担，workspaceId 不一致时抛错。
