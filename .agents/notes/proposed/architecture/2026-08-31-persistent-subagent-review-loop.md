# Agent Note: 持久子智能体与审核闭环

Status: proposed

## Problem

子任务记录是一次性运行投影，执行进程退出后身份、模型上下文与监听器一并释放，coder 完成后即终态，审核意见只能开一次全新的无上下文调用返修。恢复原 coder 需要重讲背景、重扫仓库、重释约束。若维持现状，返修次数越多，重复支付的上下文成本越高；审核历史无处可查，应用重启后任务无法继续。

本方向落点以 JanusX shell 侧为主（子任务注册、CLI 调度、checkpoint、IPC 与 UI 均在 shell 侧），janus-agentX 侧以派发语义对接：修复走原 thread 投递，全新无上下文调用不在本方向内。

## Proposal

引入三层模型：Mission 关联整单任务，AgentThread 承载可继续的 coder 或 evaluator 身份（provider session、上下文摘要、revision），Attempt 记录单次执行。逻辑线程长生命，执行进程短生命：等待审核期间 thread 处 idle，不占进程与并发槽，只留文件、状态与 provider session 元数据。

Provider 续接经 ProviderContinuationAdapter 隔离：Codex 用会话 resume，Claude 去掉无持久化启动参数后用 session 续接，OpenCode 用 session 续接；provider session ID 与 Janus threadId 分开保存，语义永不混用。首次调用创建 Thread 加 Attempt，审核绑定固定 revision，evaluator 只读，不写 coder 工作区。

编排器是唯一推进 mission 状态的模块：coder 完成即投审核，evaluator 返回结构化 ReviewResult（approved、needs_fix、blocked，finding 含 severity 与 requiredAction，tests 含命令与状态），needs_fix 时向原 coder thread 投递 repair packet 并 resume，attemptId 失配与过期审核拒绝，重复审核事件幂等。自动返修上限 3 次，超限转 blocked，由主智能体或用户接管。WorkflowX 的派发语义同步调整：修复走原 thread 投递；evaluator 每轮保持独立 thread，不继承 coder 偏见与写权限。

## Alternatives considered

- 永久驻留的交互式 CLI 进程 — 恢复最快；但进程管理、断线恢复、并发占用与跨平台复杂度全面上升，token 成本并不因此减少。
- evaluator 自然语言结论直转状态 — 实现最省；但自然语言不可信为状态依据，必须经结构化协议与 revision 校验。
- evaluator 可写 coder 工作区 — 顺手修复最快；但破坏审核独立性，写权限只属于 coder thread。
- 审核当前工作区而非固定 revision — 省去快照；但目标漂移时审核结论无锚点，过期覆盖新代码的风险无从防范。
- Do nothing / reuse — 维持一次性运行记录加新调用返修，零成本；代价是返修重复讲背景，等待期占资源，重启后无恢复。

## Acceptance criteria

- [ ] 应用重启后恢复任务树、attempt 历史与等待审核状态。
- [ ] 同一 thread 完成至少一次首次执行、进程退出、resume 的往返。
- [ ] approved、needs_fix、重复审核、过期审核、取消、恢复失败按状态机收敛，无非法转换。
- [ ] evaluator 全程只读可验证，固定 revision 之外的审核被拒绝。
- [ ] 达到返修上限后进入 blocked，blocked 状态下禁止自动创建 attempt。

## Risks

- 历史上下文 token 成本 — 增量反馈、artifact 引用、task-state summary 与压缩策略承担，长线程不承诺免费。
- provider session 失效与外部修改 — 与审核不通过区分归因承担，workspace 漂移时转 blocked 或走冲突流程。
- 并发 mission 串扰 — mailbox、workspace session、provider session 按 mission 隔离承担。
- 审核等待期资源泄漏 — idle 不计并发槽承担，只留元数据。
- 状态机被绕过 — 渲染与通知只展示不推进承担，推进权收敛编排器。
