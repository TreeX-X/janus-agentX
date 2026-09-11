# Agent Note: harness 模式与任务绑定的持久子智能体

Status: proposed

## Problem

janus-cli 的对话是单线程 turn 循环，大任务只能靠主会话一路做到底。中间产物（文件读取、工具输出、日志）全部堆进主上下文，修一次 bug 就要重讲一次背景。若维持现状，任务越长，主上下文越脏，返修成本线性增长，多线并行更无从谈起。

## Proposal

引入 harness 模式：janus-cli 在工程化 harness 下按流程运行，子智能体按任务派发、按验收消亡。harness 常驻 engine 内，拥有任务树与线程注册表，是唯一推进任务状态的模块。

线程模型向 Codex 看齐、载体取进程内实现。AgentThread 绑定一个任务，持有独立消息数组、受限工具集、模型端点记录与 checkpoint 修订。子智能体与主会话分属不同上下文，中间调用与结果留在子线程内，只把截断摘要返给父侧。恢复即续跑：同一线程内修复只需追加 repair packet 并继续循环，零重读；该语义等价 Claude Code 的 resume（保留完整历史），区别是 harness 自动触发，不依赖人工 resume。

生命周期按验收门推进：running、awaiting-acceptance、accepted-hidden、destroyed，以及 rejected 后的 repairing。coder 完成后线程进入 awaiting-acceptance，不占并发槽，只留消息数组、状态与修订元数据；验收通过转 accepted-hidden，全任务完成时销毁；验收不通过则原线程进入 repairing，凭 checkpoint 修订继续改。隐藏线程的审批请求必须带源标签路由到前台，未消费的隐藏请求随任务落盘。

评审以模型为主：每轮验收起独立的 evaluator 线程，只读，绑定固定修订，返回结构化结论（approved、needs_fix、blocked，finding 含 severity 与 requiredAction）。harness 按结论自动流转，人工保留覆盖权。确定性检查（构建与测试命令）先行，模型评审只判固定修订，不直接改工作区。

派发语义复用上下文提炼透传方向，见 [2026-09-08-context-brief-task-spawn](../feature/2026-09-08-context-brief-task-spawn.md)（Brief 提炼与隔离派发，本 harness 的派发原语）。状态机思想复用持久审核闭环方向，见 [2026-08-31-persistent-subagent-review-loop](2026-08-31-persistent-subagent-review-loop.md)（shell 侧落点为主，engine 侧无需 provider 续接，实现路径不同）。计划跟踪与流式治理复用已落地能力，不另起机制。

持久化分两层：P1 内存加会话快照，沿用 ConversationStorePort 的 sanitize 与 save 模式，线程消息数组与任务状态随会话落盘，checkpoint 修订经 CheckpointManager 锚定文件版本；崩溃可恢复的 journal 留后。恢复线程时必须同时恢复模型端点记录（Codex 已踩过只恢复历史不恢复模型配置的坑），否则静默跑错模型。

并发与深度沿用现有 `.codex/config.toml` 的 `[agents]` 约束（max_threads、max_depth、job_max_runtime_seconds），harness 强制执行：超并发拒绝派发，超深度拒绝嵌套，超 job 时限按 stop 语义回收。等待路径一律有界超时，暂停与恢复时父子状态重同步，任一 stall 收敛到可恢复态。

## Alternatives considered

- 每次派发开全新无上下文调用 — 实现最省，无状态可管；但返修重复讲背景，与本方向要解决的问题正面冲突，成本随返修次数线性增长。
- 独立进程拉起子智能体、靠 provider session 续接 — 与外部终端形态统一；但续接要处理 session 失效、配置恢复与跨进程审批路由，复杂度全面上升，而进程内子 loop 让恢复免费。
- 人工验收为准、模型只给建议 — 人工判断最准；但每轮打断人，违背用户已定的模型评审为主，且确定性检查加人工覆盖已兜住误判。
- 全量历史回灌父会话 — 父侧信息最全；但父上下文被子 log 撑爆，主任务可靠性下降，截断摘要已够验收与继续。
- Do nothing / reuse — 维持单线程 turn 循环加手动重开会话，零成本；代价是大任务只能堆主上下文，多线并行与验收门无从谈起。

## Acceptance criteria

- [ ] 同一线程完成派发、等待验收、repair packet 修复、再验收的往返，全程无重读上下文。
- [ ] awaiting-acceptance 线程不占并发槽，应用重启后任务树、线程历史与等待状态可恢复。
- [ ] evaluator 只读可验证，固定修订之外的审核被拒绝；结论为 needs_fix 时原线程修复而非新开线程。
- [ ] 达到返修上限后进入 blocked，blocked 状态下禁止自动创建 attempt。
- [ ] 超并发、超深度、超 job 时限分别被拒绝或回收，等待路径有界超时，暂停恢复后父子状态一致。
- [ ] 隐藏线程的审批请求带源标签到达前台，未消费请求随任务落盘。

## Risks

- 跨修复上下文膨胀 — repair packet 只带增量、attempt 上限、摘要压缩三层承担，长线程不承诺免费。
- 模型误判验收 — 确定性检查先行、evaluator 绑定固定修订、人工覆盖权三层承担。
- 工作区在等待期被外部修改 — checkpoint 修订校验承担，漂移时转 blocked 或走冲突流程。
- 隐藏线程资源泄漏 — idle 不计并发槽、只留消息数组与元数据承担，全任务完成即销毁。
- 状态机被绕过 — 推进权收敛 harness 承担，渲染与通知只展示不推进。
