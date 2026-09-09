# JanusX 持久子智能体与审核闭环方案

> 状态：方案分析，尚未实现
>
> 创建日期：2026-08-31
>
> 目标：在 JanusX 中扩展可恢复的子智能体委派能力，使 coder 完成实现后进入等待审核状态；审核不通过时由原 coder 继续修复，直到审核通过或任务被明确阻塞。

## 1. 结论摘要

这项能力可以在 JanusX 现有架构上实现，而且具备较好的基础。当前仓库已经有子任务注册表、父子任务归属、Agent loop、三种 CLI 引擎、checkpoint、diff、IPC 事件和 evaluator/coder 角色。

当前缺少的是“持久智能体线程”抽象：现有 `SubAgentRun` 是运行记录，`AgentStreamManager` 是一次性 CLI 进程管理器。CLI 进程退出后，session 和监听器会被删除，原模型上下文也不可由 JanusX 继续寻址。

推荐的实现方向是：

```text
持久 Agent Thread（身份、上下文、provider session、任务状态）
  ├─ Attempt 1：执行实现
  ├─ Review：独立审核固定版本
  ├─ Attempt 2：恢复原 coder，按增量反馈修复
  └─ Review：通过后完成，否则继续下一轮或阻塞
```

不要把重点放在“永不退出的 CLI 进程”上。更稳妥的模型是“逻辑线程长生命、执行进程短生命”：审核等待期间不占用进程和并发槽，收到审核反馈后再通过 provider session 恢复。

## 2. 当前实现事实

### 2.1 已有基础

| 能力 | 当前实现 | 可复用价值 |
|---|---|---|
| 子任务登记 | `src/main/agent/subagent-run-registry.ts` | 已支持父子关系、`missionId`、角色、状态和 renderer 广播 |
| 子任务类型 | `src/shared/subAgentRun.ts` | 已有 `coder`、`evaluator`、`waiting-approval` 等扩展点 |
| CLI 调度 | `src/main/agent/stream-manager.ts` | 已统一 Claude、Codex、OpenCode 的启动、输出解析、取消和并发队列 |
| Agent loop | `src/main/agent/loop/janus-agent-loop.ts` | 已支持多轮 tool call、steering、follow-up 和事件流 |
| 工作区安全 | `src/main/agent/runtime/runtime.ts` | 已有 schema、policy、approval、audit 和 workspace 隔离 |
| 变更版本 | `src/main/agent/checkpoint/checkpoint-manager.ts` | 可为每次实现和审核建立文件快照、diff 和恢复点 |
| Janus 对话 | `src/main/janus/chat-store.ts` | 已有 JSONL journal，可参考其持久化和崩溃恢复方式 |
| UI 监控 | `src/renderer/src/stores/subagent-run.ts` 等 | 已能展示任务层级和运行状态 |

### 2.2 当前限制

1. `AgentStreamManager` 在进程关闭时删除 session 和 listeners；`SubAgentRunRegistry` 只在内存中保存 run。
2. Claude 启动参数包含 `--no-session-persistence`，因此不能恢复会话。
3. Codex、Claude、OpenCode 的 provider session/thread ID 没有写入 Janus 状态模型。
4. `done` 表示 CLI 执行结束，而不是“等待审核”；审核和返修没有统一状态机。
5. WorkflowX 当前把返修定义为新的 coderX invocation，而不是恢复原 coder thread。
6. IPC 目前主要提供 `start`、`cancel`、`listSessions`，缺少恢复、投递审核反馈、审核决策和任务查询接口。
7. 当前终态清理策略只保留运行摘要，不保留可继续执行所需的 provider session、上下文摘要和 attempt 链。

## 3. 目标与非目标

### 3.1 目标

- 支持主智能体创建并委派 coder、evaluator 等子智能体。
- coder 完成后自动提交审核，而不是直接把任务标记为最终完成。
- evaluator 审核固定的变更版本，并返回结构化结论和可执行问题列表。
- `needs_fix` 时恢复原 coder thread，发送增量反馈并创建新的 attempt。
- 应用重启后可以恢复任务、查看审核历史，并在必要时继续执行。
- 等待审核时不占用 CLI 进程、Agent 并发槽或模型推理资源。
- 限制自动返修次数，避免错误验收标准导致无限循环。

### 3.2 非目标

- 不要求三个 CLI 永久保持交互式进程。
- 不把 evaluator 的自然语言结论直接当作可信的状态转换依据。
- 不让 evaluator 修改 coder 工作区。
- 不承诺仅凭长生命机制就能免除历史上下文 token 成本。
- 不在第一阶段替换现有 WorkflowX 的全部文档和派发规则。

## 4. 核心概念模型

当前 `run` 概念需要拆成三层：

| 概念 | 生命周期 | 作用 |
|---|---|---|
| Mission | 整个用户任务 | 关联主智能体、所有子任务、验收标准和最终结果 |
| AgentThread | 多个审核/修复轮次 | 表示可继续的 coder 或 evaluator 身份，保存 provider session 和上下文摘要 |
| Attempt | 一次实际 CLI/API 执行 | 记录 prompt、开始/结束时间、输出、checkpoint、错误和资源消耗 |

建议保留现有 `SubAgentRun` 作为 UI 运行投影，增加持久化的 `AgentThread` 和 `AgentAttempt` 存储，而不是让 UI 直接承担编排职责。

## 5. 生命周期状态机

```text
queued
  -> implementing
  -> awaiting_review
  -> reviewing
       ├─ approved -> completed
       ├─ needs_fix -> repairing -> awaiting_review
       ├─ blocked -> blocked
       └─ cancelled -> cancelled
```

建议把 `waiting-approval` 拆成更明确的状态：

- `awaiting-review`：coder 已完成，等待 evaluator。
- `reviewing`：evaluator 正在检查固定 revision。
- `repairing`：coder 正在处理审核反馈。
- `blocked`：达到返修上限、上下文失效、测试环境不可用或需要人工决策。

每次状态转换都应带：`missionId`、`threadId`、`attemptId`、`revisionId`、操作者、时间和原因。

## 6. 关键模块设计

### 6.1 AgentThreadStore

持久化内容至少包括：

```ts
interface AgentThread {
  id: string
  missionId: string
  role: 'coder' | 'evaluator' | 'custom'
  engine: 'claude' | 'codex' | 'opencode'
  providerSessionId?: string
  status: 'idle' | 'running' | 'awaiting-review' | 'blocked' | 'completed'
  currentAttemptId?: string
  workspaceId: string
  workspacePath: string
  contextSummary?: string
  revisionId?: string
  repairCount: number
  updatedAt: string
}
```

存储应采用版本化 JSONL 或 SQLite；第一阶段可沿用 Janus Chat Store 的 journal 思路，但必须提供原子写入、启动恢复、损坏记录跳过和大小上限。

### 6.2 ProviderContinuationAdapter

把不同 CLI 的 session 续接参数隔离到 provider adapter：

```ts
interface ProviderContinuationAdapter {
  start(input: StartThreadInput): Promise<ProviderSessionRef>
  resume(input: ResumeThreadInput): Promise<ProviderSessionRef>
  cancel(input: CancelAttemptInput): Promise<void>
}
```

当前本机 CLI 能力：

| 引擎 | 首次执行 | 继续执行 | Janus 注意事项 |
|---|---|---|---|
| Codex | `codex exec --json ...` | `codex exec resume <SESSION_ID> <PROMPT>` | 保存 Codex thread/session ID；不要使用 ephemeral 模式 |
| Claude | `claude -p ... --output-format stream-json` | `claude --resume <SESSION_ID> -p ...` | 去掉 `--no-session-persistence`；首次可指定 `--session-id` |
| OpenCode | `opencode run --format json ...` | `opencode run --session <SESSION_ID> ...` | 保存 OpenCode session ID |

provider session ID 必须与 Janus 的 `threadId` 分开，不能假设三种引擎的 ID 语义相同。

### 6.3 MissionOrchestrator

编排器负责：

1. 创建 mission、coder thread 和 evaluator thread。
2. 为 coder attempt 创建 checkpoint/revision。
3. coder 完成后投递审核请求。
4. 启动 evaluator，绑定待审核 revision。
5. 解析结构化审核结果。
6. `needs_fix` 时将反馈写入 coder mailbox，恢复原 coder thread。
7. 通过后关闭 thread、保留完整审计和最终 revision。

编排器必须是唯一允许推进 mission 状态的模块。Renderer、普通通知和自然语言输出只能展示状态，不能直接改变状态。

### 6.4 Review Protocol

审核结果应使用结构化协议：

```ts
interface ReviewResult {
  decision: 'approved' | 'needs_fix' | 'blocked'
  missionId: string
  threadId: string
  attemptId: string
  revisionId: string
  findings: Array<{
    severity: 'blocker' | 'major' | 'minor'
    title: string
    detail: string
    filePath?: string
    line?: number
    requiredAction?: string
  }>
  tests: Array<{
    command: string
    status: 'passed' | 'failed' | 'not-run'
    outputRef?: string
  }>
}
```

审核器只能审核提交给它的 `revisionId`。结果中的 `attemptId` 不匹配当前任务时必须拒绝，避免过期审核覆盖新代码。

### 6.5 Mailbox

每个持久 thread 需要一个可重放消息队列：

- `review-request`
- `review-result`
- `repair-instruction`
- `user-steering`
- `system-cancel`

消息需要唯一 ID、幂等键、目标 thread、来源、创建时间和消费状态。收到重复审核事件时不能重复创建修复 attempt。

## 7. Token 与资源策略

持久 thread 能减少重复启动、重复扫描仓库和重复解释背景，但不会自动使历史上下文免费。长线程仍可能增加输入 token，因此必须配合上下文管理：

- 审核反馈只发送结构化增量，不重新发送完整 diff 和完整日志。
- 测试输出、stdout 和大文件内容保存为 artifact，只在 prompt 中传引用、摘要和 hash。
- 每轮 attempt 完成后生成短的 task-state summary。
- 达到上下文阈值时压缩历史，并保留验收标准、当前 revision、未解决 findings 和安全约束。
- 对稳定 system prompt、任务摘要和固定工具描述使用 provider prompt caching（若 provider 支持）。
- evaluator 默认使用只读、短上下文；coder 恢复时只加载相关反馈和变更文件。

资源方面，等待审核的 thread 应处于 `idle/awaiting-review`，不保留子进程，不计入 `maxConcurrency`，只保留文件、状态和 provider session 元数据。

## 8. 安全与一致性边界

1. evaluator 默认只读，不能写入 coder 工作区。
2. evaluator 审核固定 checkpoint 或 git revision，不能审核“当前工作区”这种不稳定目标。
3. coder 修复前确认 revision 仍是预期版本；工作区发生外部修改时转为 `blocked` 或创建冲突处理流程。
4. 所有写操作仍通过现有 Workspace Agent Runtime 的 policy、approval 和 audit 层。
5. thread 恢复必须校验 workspace、engine、provider session 和 owner，避免跨工作区续接。
6. 返修次数默认限制为 3 次；超过上限转 `blocked`，由主智能体或用户决定。
7. 审核和修复操作使用 correlation ID，保证日志、通知、checkpoint 和 UI 能串联。
8. 应用退出、CLI 崩溃、网络错误和 provider session 失效必须可区分，不能都标为“审核不通过”。

## 9. IPC 与 UI 扩展方向

在现有 `agent:*` 和 `subagent-run:*` 通道上增加任务级 API：

```text
mission:create
mission:get
mission:list
mission:cancel
mission:resume
mission:review
mission:send-feedback
mission:event
```

UI 至少展示：

- mission 总状态和当前阶段
- coder/evaluator thread 关系
- 当前 attempt、revision 和 checkpoint
- 审核结论、findings 和测试结果
- 自动返修次数与剩余次数
- “继续执行”“人工接管”“取消任务”等明确动作

Renderer 不应直接调用 provider resume；所有恢复动作必须经过 Main 进程的编排器和权限边界。

## 10. 与现有 WorkflowX 的关系

现有 WorkflowX 的 `coderX -> evaluatorX -> repair` 流程可以保留，但需要改变执行语义：

- Dispatch Payload 继续描述任务范围、验收标准和验证要求。
- coderX 第一次调用创建 `AgentThread + Attempt`。
- evaluatorX 审核该 attempt 的固定 revision。
- 修复不再默认创建全新的无上下文 coder invocation，而是向原 coder thread 投递 repair packet 并调用 provider resume。
- evaluatorX 每轮仍可使用独立 evaluator thread，确保审核者不会继承 coder 的偏见或写权限。
- Main Agent 继续拥有状态转换、返修上限和跨 Child 集成决策。

这不会改变 `xdo` 的直接执行模式，也不要求把所有普通终端任务都纳入审核闭环；建议先针对明确的 WorkflowX mission 开放。

## 11. 分阶段实施路线

### 阶段 A：状态模型和持久化

- 新增 `Mission`、`AgentThread`、`AgentAttempt`、`ReviewResult` 类型。
- 将 `SubAgentRunRegistry` 的运行投影与持久状态分离。
- 增加 thread/attempt journal、恢复、幂等和清理策略。
- 先不改变 provider 启动参数。

验收：应用重启后可以恢复任务树、attempt 历史和等待审核状态。

### 阶段 B：Provider 续接

- 为 Codex、Claude、OpenCode 实现 `start/resume/cancel` adapter。
- 去除 Claude 的 `--no-session-persistence`，保存真实 provider session ID。
- 扩展 parser 和 stream manager，使 attempt 完成后保留可恢复元数据，但释放进程和 listener。

验收：同一 thread 至少可以完成一次“首次执行 -> 进程退出 -> resume”。

### 阶段 C：审核闭环

- 实现 MissionOrchestrator 状态机。
- 创建 evaluator thread 和固定 revision 审核请求。
- 实现结构化 Review Protocol、mailbox 和幂等处理。
- 增加最多 3 次自动返修和 blocked 分支。

验收：模拟 `approved`、`needs_fix`、重复审核、过期审核、取消和恢复失败等场景。

### 阶段 D：IPC、UI 和可观测性

- 增加 mission API 和事件。
- 在 Janus 圆桌/岛屿界面展示阶段、审核意见、attempt 和操作入口。
- 将 checkpoint、diff、测试、通知和 policy audit 串成一条时间线。

验收：用户可以查看、暂停、恢复、人工接管或取消完整任务。

### 阶段 E：成本优化

- task-state summary 和 artifact 引用。
- 上下文压缩和 token 预算。
- provider prompt caching 适配。
- 基于历史数据调整 evaluator 模型、返修上限和并发策略。

## 12. 测试重点

- 状态机合法转换和非法转换拒绝。
- journal 原子写入、损坏记录跳过和重启恢复。
- provider session ID 保存、resume 参数和失败分类。
- evaluator 只读权限与固定 revision 校验。
- 重复 review 事件不重复修复。
- 过期 attempt 的审核结果被拒绝。
- coder 修复后生成新 attempt，但保持同一 thread。
- 取消、超时、CLI 崩溃、网络断开和 workspace 外部修改。
- 并发 mission 不共享 mailbox、workspace session 或 provider session。
- `approved` 后不再自动创建新 attempt；达到上限后必须进入 `blocked`。

## 13. 最终建议

优先实现“持久逻辑线程 + 短执行 attempt + 结构化审核闭环”。这能满足：

- 子智能体完成后不立即丢失身份和上下文
- 审核后由原 coder 继续修复
- 审核等待期间不占用进程和并发资源
- 应用重启后可恢复
- 通过状态机、revision 和返修上限控制风险

不建议第一阶段实现永久驻留的 CLI 子进程。它会增加进程管理、断线恢复、并发占用和跨平台复杂度，而不一定减少模型 token。真正的收益来自可恢复 session、增量反馈、上下文摘要和稳定的任务状态持久化。

## 14. 参考

- JanusX 当前实现：`src/main/agent/stream-manager.ts`
- JanusX 当前实现：`src/main/agent/subagent-run-registry.ts`
- JanusX 当前实现：`src/main/agent/loop/janus-agent-loop.ts`
- JanusX 当前实现：`src/shared/subAgentRun.ts`
- JanusX 当前实现：`src/main/agent/checkpoint/checkpoint-manager.ts`
- OpenAI 官方文档：[Subagents](https://developers.openai.com/codex/multi-agent/)

