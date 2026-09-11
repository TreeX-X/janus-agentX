# Agent Note: janus-agent 知识库只读接入

Status: proposed

## Problem

知识库的只读工具在 JanusX shell 侧经 stdio 供外部终端调用，但应用内 janus-agent 的工具注册只覆盖 workspace、project、git、command 四组，Agent 够不着已沉淀的 wiki 与 fact。回答沉淀过的问题时，Agent 只能靠对话上下文猜。若维持现状，沉淀的知识与执行侧的 Agent 脱节，沉淀越多，够不着的部分越多。

## Proposal

在 janus-agentX 内新增同进程直调的知识工具映射，不走 MCP 协议。新增 knowledge-tools.ts，按 RegisteredTool 写法映射只读子集：knowledge.search 复用混合召回与预算打包，knowledge.wiki_list、knowledge.wiki_get、knowledge.fact_get 复用 truth 侧轻查询，payload 构造抽纯函数与 MCP 侧共用，避免两份逻辑。actionRisk 定为 read。作用域强制 fail-closed：input.workspaceId 缺席时取 context.workspaceId，不一致时抛错，Agent 只读自己会话工作区的知识。预算沿用 MCP 侧默认值（maxItems 8，maxChars 4000，wiki_get 截断带 truncated 标记）。写入工具（批准、归档）不进 Agent 工具面，仍走工作台人工审核。

互补方向是 todo_write 计划跟踪，见 [2026-09-05-todo-write-sticky](../../implemented/feature/2026-09-05-todo-write-sticky.md)（多步计划跟踪，与本知识召回能力正交，互不依赖）。

## Alternatives considered

- 走 MCP stdio 协议接入 — 与外部终端形态统一；但同进程调用省去协议开销与进程边界，工具面更小更可控。
- 连 knowledge.context 一并暴露 — 召回信息更多；但该工具与 search 同源，全量增加上下文负担，只给 search 加 wiki 三件套可保持工具面最小。
- 开放写入工具 — Agent 可闭环归档；但批准与归档需要人工审核信任，进工具面风险超出收益，仍走工作台。
- Do nothing / reuse — Agent 维持四组工具，零成本；代价是沉淀知识够不着，问答质量不随沉淀增长。

## Acceptance criteria

- [ ] knowledge.search、knowledge.wiki_list、knowledge.wiki_get、knowledge.fact_get 四个工具注册成功，跨 workspaceId 调用被拒绝。
- [ ] janus-chat 里 Agent 经 wiki_list 再 wiki_get 回答一个已沉淀问题，全程只读、无审批打断、无跨工作区泄漏。
- [ ] wiki_get 缺页与 fact_get 幽灵 id 进入可纠错的 isError，模型可自愈。
- [ ] typecheck 与 agent 相关单测全绿，工具契约数量同步更新。

## Risks

- 上下文爆炸 — maxItems 与 maxChars 预算承担，超限截断并标记。
- 跨工作区泄漏 — workspace 隔离 fail-closed 承担。
- 与 MCP 侧逻辑分叉 — 抽纯函数共用承担，两份 payload 构造永不同时改。
- 只读语义被突破 — 写入工具不进工具面承担，审计侧可复核。
