# 上下文提炼透传双工具实施计划（context.brief + task.spawn）

> 状态：草案（先方案、后实施）
> 创建：2026-09-08
> 范围：**janus-agentX only**（`packages/agent-core` + `packages/chat-core` + `packages/janus-agent` + `packages/cli`），不含 JanusX shell 侧实现
> 前置调研：主循环 `agent-core/src/main/agent/loop/janus-agent-loop.ts`、上下文预算 `chat-core/src/main/llm/chat-session-runtime.ts`、工具注册 `agent-core/src/main/agent/runtime/registry.ts`、模型工具契约 `agent-core/tests/tools-contract.test.ts`

## 1. 背景与问题

当前上下文链路是隐式保底裁剪，不是显式可传递产物：

- `ChatSessionRuntime.buildContext()` 按 `contextWindow-reserved-margin` 从新到旧塞 turn unit，塞不下丢弃；`LoadedContextIndex` 只保留最近 3 个 `workspace.read` 结果，`edit/create` 后标 `stale`。
- `droppedTurnsHandoffMessage()` 把丢弃 turn 变成精确 `digest`（path/sha/query），刻意不用 LLM 改写，保证 `workspace.edit expectedHash` 可用。
- 模型工具面只有 `workspace.* / project.* / git.* / command.run`，无 `Task/子智能体`、无 `todo/plan`、无 `context.*`。

痛点：主 Agent 在上下文中已明确需求并读过文件，后续派发子智能体只能靠纯 `prompt` 转述，`sha256`、文件范围、`tool digest` 丢失，子智能体只能盲 `list/search` 重来。

目标：做成两个正交工具能力，对标压缩上下文工具 + todo 工具的定位，但职责是提炼与透传。

## 2. 目标与非目标

目标（MVP 可验）：

- 主 Agent 可调用 `context.brief` 把散在上下文中的需求/决策/文件证据提炼为可命名、可复用的 `Brief`。
- 主 Agent 可调用 `task.spawn` 引用 `briefId + 具体任务指令` 派发子智能体，子智能体直接继承 `Brief` 上下文，不靠纯 prompt 转述。
- 全程不破坏 `sha` 有效性、不破坏现有 21 工具契约、不引入无限递归。

非目标（明确不做）：

- 不做 DB 持久化（Brief 先内存 + 随会话，跨会话持久化放 V2 进 knowledge observation）。
- 不做 LLM 自由改写 `sha/path`（MVP 纯确定性抽取，LLM 改写层放 V1 且必须带 citations）。
- 不做通用 `todo_write` 状态机（另见 `docs/janus-agent-capability-plan.md`，可后联动，不耦合）。
- 不改 Runtime 审批/审计主链语义，只新增两个工具的策略分支。

## 3. 双工具职责定义

| | `context.brief`（提炼） | `task.spawn`（派发） |
|---|---|---|
| 类比 | 压缩上下文工具的显式版 | Task/subagent 工具 |
| `actionRisk` | `read`，可并行，免审批 | `run`，强制串行，需审批+预算 |
| 输入 | `topic/query?, scope?, maxChars?`，不需要传内容，工具自己读上下文 | `briefId?, task*, workspaceId*, readOnly?, maxTurns?, maxChars?` |
| 输出 | `Brief{briefId, requirements[], decisions[], fileRefs[{path,sha256,range}], digests[], tokenEstimate}`，只返 `briefId` + 摘要 | 子 loop 截断摘要 `{summary, changedFiles[], newSha[], briefId}`，不回灌全量 log |
| 复用 | 一份 Brief 可被多个 `task.spawn` 复用，人可审查 | 每次派发独立子 loop，深度 guard 防套娃 |
| 失败语义 | 无命中进正常空结果，不进 `isError` | 参数非法/递归超限/预算超限进 `isError` 可纠错文案 |

调用序：

```text
用户提需求 -> 主Agent workspace.read/search -> context.brief{topic} 得 br_01
  -> task.spawn{briefId:br_01, task:"实现A"} -> 子AgentA 带sha直接干
  -> task.spawn{briefId:br_01, task:"实现B"} -> 子AgentB 复用同一份提炼
```

## 4. 数据结构设计

```ts
// Brief 存储对象（内存，key=briefId）
interface ContextBrief {
  id: string;                 // br_<8hex>，stable within session
  topic: string;              // 调用方传入或从 query 推导，<=120 chars
  createdAt: string;          // ISO
  sessionId: string;          // 创建会话，隔离
  workspaceId: string;
  requirements: string[];     // 来自 user 消息 + assistant 确认，<=20条，去重截断
  decisions: string[];        // 来自 assistant 消息中的决策句，<=20条
  fileRefs: Array<{           // 来自 LoadedContextIndex 非stale条 + tool digest
    path: string; sha256: string; offset: number; bytes: number; truncated: boolean;
  }>;
  digests: string[];          // 来自 droppedTurnsHandoffMessage 风格 digest，<=24行
  tokenEstimate: number;      // requirements+decisions+fileRefs头+digests 粗估
  sourceTurns: number;        // 参与提炼的 turn unit 数（可观测）
}

// context.brief inputSchema（RegisteredTool）
{
  workspaceId: string,
  topic?: string,             // 1..120，缺省用 latestUserQuery 前80
  query?: string,             // 1..256，用于过滤 digest/knowledge，可选
  maxChars?: number,          // 512..8000，default 4000
}

// task.spawn inputSchema
{
  workspaceId: string,
  briefId?: string,           // 缺省=该会话最新 Brief；非法id进 isError
  task: string,               // 1..4000，子任务指令
  readOnly?: boolean,         // default false；true 则只给 read-only 工具集
  maxTurns?: number,          // 1..10，default 5，计入父 maxTurns 之外但需上限
  maxChars?: number,          // 子结果回灌上限，512..8000，default 4000
}
```

约束：`Brief.fileRefs` 只收 `!stale` 条；`sha256` 原样透传，任何 LLM 层不得改写；`requirements/decisions` MVP 用确定性规则抽（user 首句 + `决定/采用/需求:` 前缀句），V1 才允许 LLM 改写正文且必须保留 `fileRefs` 原样。

## 5. 技术方案

### 5.1 存储：随 `ChatSessionRuntime`（不进 DB）

- `ChatSessionRuntime` 新增 `BriefStore: Map<briefId, ContextBrief>` + `latestBriefIdBySession`，复用 `LoadedContextIndex` 的 `record()` 时机（`chat-turn.ts afterToolCall` 已有 `recordToolResult`，同处 `recordBriefSource`）。
- `buildContext()` 不自动注入全部 Brief，只在 `task.spawn` 构造子上下文时注入，避免父上下文膨胀。父侧只在 system 里保留一行 `Available briefs: br_xx(topic, n files)` 索引（有界 5 条）。
- 会话结束/`MAX_CHAT_SESSIONS` 淘汰时同 `todosByConversation` 策略一起清。

### 5.2 `context.brief` 执行链（确定性 MVP）

1. 取 `messages[]` 非 system 部分，按 `agentTurnUnits()` 同逻辑切 turn unit（复用函数，不另写切分）。
2. `requirements`：扫 `role=user` 首句 + 含 `需求/需要/实现/支持` 的行，去重，截断 20。
3. `decisions`：扫 `role=assistant` 含 `决定/采用/确认/方案` 的行，截断 20。
4. `fileRefs`：直接读 `LoadedContextIndex` 非 `stale` 前 N（按 `remainingTokens` 换算 `maxChars`），原样拷贝 `path/sha/offset/bytes`。
5. `digests`：对未被 `fileRefs` 覆盖的旧 turn 调 `toolDigest()` 同逻辑生成，取后 24 行。
6. 组装 `Brief`，算 `tokenEstimate=ceil(chars/4)`，写入 `BriefStore`，返回 `{briefId, topic, fileCount, tokenEstimate, preview(<=800 chars)}`。

文件：新增 `packages/agent-core/src/main/agent/runtime/tools/context-tools.ts`，导出 `contextBriefTool: RegisteredTool` + 纯函数 `buildBriefDeterministic()`（可单测）。

### 5.3 `task.spawn` 执行链（子 loop 隔离）

1. 参数校验：`briefId` 不存在进 `isError{error:"Unknown briefId", hint:"先调 context.brief"}`；`task` 为空拒绝；`depth = (parentDepth ?? 0)+1`，`>2` 拒绝（防套娃）。
2. 取 `Brief`，构造子 `initialMessages: JanusAgentMessage[] = [{role:system, content: renderBriefSystem(brief, maxChars)}, {role:user, content: task}]`。`renderBriefSystem` 格式固定：`Topic/Requirements/Decisions/Evidence(file+sha+range)/Digests/约束(先读后改、用expectedHash)`。
3. 工具集：`readOnly=true` 用 `createJanusRuntimeReadOnlyToolsForResources`，否则用 `createJanusRuntimeToolsForResources`，`resources` 只透传当前 `workspaceId` 单资源（最小权限）。
4. 调 `runJanusAgentLoop(subMessages, {tools, stream: 父stream复用或注入轻量直调, maxTurns, transformContext: 父chatSession.buildContext 复用})`，`signal` 用子 `AbortController` 链接父 `signal`。
5. 子结果截断 `maxChars`，提取 `changedFiles/newSha`（扫子 `tool` 消息 `changedPaths/sha256`），返回父 `tool` 消息，不把子全量 log 塞回父历史。

文件：新增 `packages/agent-core/src/main/agent/runtime/tools/task-tools.ts`，导出 `createTaskSpawnTool(deps): RegisteredTool`，`deps={getBrief, buildSubTools, runLoop, parentDepth}` 以解循环依赖、可单测注入 fake loop。

### 5.4 接线面（4 包）

- `agent-core/src/main/agent/runtime/registry.ts`：无改，仅 `register()` 两个新工具。
- `agent-core/src/main/agent/runtime/tool-manifest.ts`：无改，`providerName` 自动 `context_brief/task_spawn`，需检查与现有 `providerName` 无碰撞。
- `agent-core/src/main/agent/chat-tools/workspace-chat-tools.ts`：加 `context_brief/task_spawn` 两个 zod wrapper + `createToolPreview()` 加 `task.spawn` 预览分支（`Run subtask with brief br_xx` + task 前 200 chars），`context.brief` 无预览（read）。
- `agent-core/src/main/agent/loop/runtime-tool-adapter.ts`：`task.spawn` 标 `executionMode` 串行（`actionRisk=run` 已默认串行，需确认 `READ_ONLY_RISKS` 不含 `run`）；`context.brief` 标并行（`read` 已并行）。
- `chat-core/src/main/llm/system-prompt-builder.ts`：`Enabled tools` 后追加 3 行纪律：`先读后brief、有brief才spawn、spawn必须带briefId+最小任务指令；sha不得改写`。
- `janus-agent/src/orchestrator/chat-turn.ts`：`afterToolCall` 同处记录 Brief 源；`getFollowUpMessages` 不动；`shouldStopAfterTurn` 不动。
- `cli`：`registerWorkspaceTools` 后加 `registerContextTools(registry, deps)`，`task.spawn` 在 CLI 默认 `readOnly=true`（无审批 UI，先只读验证透传率）。

### 5.5 审批/审计/预算

- `context.brief`：`read`，走现有 auto-allow，无 preview，不记突变审计。
- `task.spawn`：`run`，必须 `preview{summary, paths:[workspaceId], detail: task前4000, truncated}`，走 `per-action` 审批；审计记 `AUTO_RUN_ALLOWED` 仅当 `readOnly=true` 且 `safeCompileAutoAllow` 语义复用，否则逐次审批。
- 预算：父 `maxTurns` 不变，子 `maxTurns<=5`；父 `buildContext` 预算不变，子结果回灌截断 `maxChars`；`Brief` 索引行有界 5。

## 6. 契约与回归

- `agent-core/tests/tools-contract.test.ts`：`ALL_MODEL_TOOLS` 21→23（+`context_brief/task_spawn`），`BLUEPRINT_READ_ONLY_MODEL_TOOLS` +`context_brief`（只读），`task.spawn` 不进只读白名单。任一改名必须双仓（JanusX shell）同步，见文件头注释。
- 新增单测：
  - `context-tools.test.ts`：空上下文返回空 Brief 不报错；`stale` 文件不进 `fileRefs`；`sha` 原样；`maxChars` 截断有界。
  - `task-tools.test.ts`：非法 `briefId` 进 `isError`；`depth>2` 拒绝；fake loop 验证子 `initialMessages[0]` 含 `sha` 且 `resources` 仅单 workspace；回灌截断。
  - `chat-session-runtime` 回归：`SYSTEM_CONTEXT_EXCEEDS_BUDGET / CURRENT_TURN_EXCEEDS_CONTEXT_BUDGET` 语义不变。
- 回归：`typecheck`、`test --workspaces` 全绿；`eslint` 0 错误。

## 7. 验收

1. 主 Agent 在需求散在 3+ turn + 2+ 文件 `read` 后，首调 `context.brief` 得到 `br_xx`，`fileRefs` 的 `sha` 与 `workspace.read` 返回一致。
2. `task.spawn{briefId, task}` 子智能体首动作是 `workspace.read(brief中path)` 而非 `workspace.list` 盲扫（透传率验收）。
3. `workspace.edit` 后旧 Brief 的 `fileRefs` 变 `stale`，子智能体被提示重读，不用旧 `expectedHash`（hash 有效性验收）。
4. 非法 `briefId`、空 `task`、递归 `spawn` 模型收到可纠错 `isError` 并自愈。
5. 无 workspace 附件时 `context.brief` 仍可用（纯对话提炼）；`task.spawn` 无资源时 fail-closed。
6. 上下文预算打满时父不崩（`shouldStopAfterTurn` 原语义），子结果截断有 `[truncated]` 标记。

## 8. 风险与控制

| 风险 | 控制 |
|---|---|
| LLM 改写 `sha/path` 致 `edit` 冲突 | MVP 禁改写；V1 改写层只动正文，`fileRefs` 代码侧原样拼接 + 单测锁 |
| 子 loop 无限递归 | `depth<=2` 硬拒 + `maxTurns<=5` + 串行间隙可取消 |
| 父上下文被 Brief/子 log 撑爆 | 父只留 5 行 Brief 索引；子全量不回灌，只回截断摘要 |
| 工具名契约漂移 | `tools-contract.test.ts` 锁 23 个 + shell 双仓同步注释 |
| 审批疲劳 | `context.brief` 免审，`task.spawn(readOnly)` 可 auto-run，写操作逐次审 |
| 跨会话/跨 workspace 泄漏 | Brief 按 `sessionId+workspaceId` 隔离，`task.spawn` 只透单资源，`workspaceId` 必须等于 `context.workspaceId` 否则抛错 |

## 9. 实施步骤（预计 6 文件 + 2 单测 + 1 契约更新）

1. `agent-core/src/main/agent/runtime/tools/context-tools.ts`：`buildBriefDeterministic()` + `contextBriefTool`。
2. `agent-core/src/main/agent/runtime/tools/task-tools.ts`：`createTaskSpawnTool(deps)` + `renderBriefSystem()`。
3. `agent-core/src/main/agent/chat-tools/workspace-chat-tools.ts` + `runtime/loop/runtime-tool-adapter.ts`：zod wrapper + preview + 执行模式确认。
4. `chat-core/src/main/llm/chat-session-runtime.ts`：`BriefStore` + 索引行（有界）。
5. `chat-core/src/main/llm/system-prompt-builder.ts` + `janus-agent/src/orchestrator/chat-turn.ts`：纪律 3 行 + `afterToolCall` 接线。
6. `agent-core/tests/tools-contract.test.ts` + 新增 `context-tools.test.ts` / `task-tools.test.ts`：契约 21→23 + 单测。
7. `packages/cli` 注册 + 手工联调（重点看透传率与 `stale` 语义）。

## 10. 后续（V1/V2，不在本期）

- V1：`context.brief` 加可选 LLM 改写（`requirements/decisions` 润色，`fileRefs/digests` 不动），复用 `ports.model`，超时回退确定性结果。
- V2：Brief 持久化到 knowledge `observation(type=user-note, tags=[brief])`，支持跨会话 `knowledge.search` 召回；与 `todo_write` 联动（Brief 挂 `todoId`）。
- 可选：`Brief` 人工审查 UI（只读折叠卡，仿 Todo 卡），`task.spawn` 干跑 `preview` 展示引用文件清单。
