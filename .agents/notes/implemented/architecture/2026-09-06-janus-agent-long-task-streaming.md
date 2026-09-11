# Agent Note: janus-agent 长任务与流式治理

Status: implemented

## Problem

推理模型的思维链没有独立载体，长编译任务在超时、后台托管、输出分页、审批与步数上处处受卡，流式中用户追问只能等整轮结束。若无治理，长命令死在同步等待里，大日志撑爆模型上下文，追问需求只能绕道重开会话。

## Decision

推理增量经 loop 的 reasoning_update 事件透出，经 event-mapper 与 IPC 转为 reasoning_delta 到达各端，进入独立于正文的缓冲。展示收纳在 assistant 气泡的加载区内：流式中默认收起，只显示进度字数，点击展开限定高度滚动区；结束收起为一行并可展开回看。缓冲有界，超限截断并标识。思考永不计入正文，永不进入模型上下文；无 reasoning 的模型无新增行，静默兼容。

command.run 声明超时界与 background 开关：同步默认 120s、上限 600s，background 无截止，除非显式传入 timeoutMs（上限 600s）。background 调用走 Runner 托管，立即返回 job 标识与 logPath，本轮不阻塞；project.process-output 翻页轮询运行中与已退出任务，stop 对已退出幂等成功。同步输出只给 8KB 尾预览，全量落 .janusX/logs；模型上下文承载预览、分页引用与翻页指引，引用排在 blob 之前以扛住压缩裁剪；全量日志凭 logPath 翻页定位。env 按 allowlist 透传运维键并设条数与长度封顶，提权键永不放行。组合命令拆多个 turn 串行完成，单程序语义保持。

安全编译命令在可信工作区自动放行并记 AUTO_RUN_ALLOWED 审计，名单为包管理器、固定脚本与 check 脚本模式的代码级常量，fail-closed；含 shell 元字符、越界路径与超长参数维持拒绝或审批。步数经 agentMaxSteps 配置，默认 40。建流与消费期共用 3 次尝试预算，退避 250ms 起、1000ms 封顶；仅零可见进度轮次可重试，有进度失败与非法工具调用走原终态通道。长命令的 toolTrace 只记退出码、logPath 与 job 摘要。

上下文经 transformContext 压缩：compactToolMessage 按 6k 与 4k 两档裁剪，LoadedContextIndex 只保留最近的已读结果，shouldStopAfterTurn 做预算守卫。steering 经 AgentSteeringPort 投递，每条 exactly-once 消耗并回执 steering_consumed 事件；流式生成中 push 立即打断本轮，工具执行中只排队，到串行间隙与并行批次结束应用；被打断轮次的半截 toolCalls 一律剥离，被打断轮次同样计入 maxTurns。

## Alternatives considered

- shell.run 全功能 shell — 组合命令一轮跑完；但单程序加多 turn 已覆盖需求，全 shell 打开注入与审批面，安全成本超出收益。
- 容器隔离加模式审批 — 权限体验顺滑；但容器化超出当前交付边界，安全编译 allowlist 已解决最高频的点击疲劳。
- bash 无默认超时、靠文档指导跑后台 — 实现最省；但模型不会自觉切后台，超时可配加描述声明更可靠。
- 会话树 fork 与 clone — 探索分支更自由；但树管理复杂度超出手动折叠的收益，按需再议。
- 自动压缩 — 用户无需动手；但压缩时机误判会丢关键上下文，确定性压缩优先。
- 用户自定义编译名单 — 灵活性最高；但名单语义 fail-closed，用户自改易放宽边界，名单保持代码常量。
- Do nothing / reuse — 维持同步短超时与全文日志进上下文，零成本；代价是长编译必死、大日志必爆，追问只能重开。

## Consequences

- **Gains**: 长编译经 background 加翻页跑通；同步日志有界，模型上下文只见预览与引用；安全编译免逐次点击且审计可查；步数可配覆盖深回归；追问打断可续轮。守卫为 `npx vitest run packages/agent-core/tests/tools-contract.test.ts packages/agent-core/tests/tool-result.test.ts packages/agent-core/tests/janus-agent-loop.test.ts`，20 用例（5、7、8）实测通过。
- **Costs and limits**: 单程序语义保持，组合命令占多 turn；名单为常量不可用户扩展；有进度失败不重试；压缩阈值固定为常量；当组合命令成为主流、名单扩展压力出现或自动压缩收益明确时重访本决策。
