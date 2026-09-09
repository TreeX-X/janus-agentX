# janus-agent 能力规划书（todo_write + 知识 MCP 接入）

> 状态：草案（先方案、后实施）
> 创建：2026-09-05（todo_write 部分）；同日融合知识 MCP 接入并改名（原 `janus-todo-write-plan.md`）
> 前提：工作区内部分 todo 改动已回退（见 §1），P3-P6 / knowledge 等非 todo 改动予以保留
> 参考：https://github.com/anomalyco/opencode/（`packages/opencode/src/tool/todo.ts`、`packages/opencode/src/session/todo.ts`、`packages/opencode/src/tool/todowrite.txt`、TUI `sidebar/todo`、`docs/tools` 权限说明）

## 1. 回退说明（已执行）

回退范围只限 todo 部分实现，保留其他未提交改动：

- 删除新增孤儿文件（已备份到 `C:\Users\Tree\AppData\Local\Temp\opencode\todo-rollback-20260905\`）：
  - `src/main/llm/chat-todo-store.ts`
  - `src/main/llm/chat-todo-tool.ts`
  - `src/renderer/src/components/janus/TodoListCard.tsx`
- 还原纯 todo 文件（`git restore`）：
  - `src/main/llm/system-prompt-builder.ts`
  - `src/shared/ipc/llm.ts`
  - `src/renderer/src/services/llm.ts`
  - `src/renderer/src/components/janus/useJanusChat.ts`（仅 1 行 todo import）
  - `src/renderer/src/i18n/locales/en/janus.json`、`zh-CN/janus.json`（仅 `chat.todo` 块）
- 手术式剥离混合文件（保留非 todo 能力）：
  - `src/main/llm/chat-orchestrator.ts`：去掉 todo store/tool/sync/`todoStateMessage`/`todoEnabled`/双工具合并，保留 P6（`agentMaxSteps` 默认 40、`maxSteps`、长命令 toolTrace 摘要）
  - `src/renderer/src/components/janus/styles/08-janus-workspace-chat.css`：去掉 `.janus-todo-card` 全块，保留 input-wrapper 光晕上移改动

验证：`git diff` 无 `todo_write|ChatTodo|todo_update|todoEnabled|chat-todo|TodoListCard` 残留；`src/**` grep 同样 0 命中；`chat-orchestrator` 剩余 diff 仅 P6；未动 `tests/unit/agent-max-steps-config.test.ts`、`tests/unit/agent/tool-result.test.ts`（P6/P4，非 todo）。

## 2. opencode 对标（抄什么）

| opencode | 位置/行为 | JanusX 取舍 |
|---|---|---|
| `TodoWriteTool` 名为 `todowrite`，描述来自 `todowrite.txt` | `tool/todo.ts` | 工具名建议用 `todo_write`（已回退实现即如此，与 JanusX `workspace_*` 蛇形命名一致）；描述复刻 `todowrite.txt` 触发条件 + 状态机 |
| 参数 `todos[{content,status,priority}]`，返回 `title/output/metadata.todos` | `tool/todo.ts` + `session/todo.ts:Info` | 第一版可不做 `priority`（回退版也没有），但要在方案里明确是“有意裁剪”，后续再补；返回必须带结构化 `todos` 供事件流转 |
| `Todo.Service.update(sessionID,todos)` 事务式 delete+insert（含 `position`），`get(sessionID)` 保序 | `session/todo.ts` + `TodoTable` | JanusX 回退版是主进程内存 `Map<conversationId, todos>`，无 DB、无 `position` 持久化。小方案建议：先内存 + 渲染端持久化双写，后续再评估是否需要 SQLite/JSONL |
| `todo.updated` bus 事件 + `EventV2Bridge` | `session/todo.ts` | 对应 `ChatAgentEvent todo_update` 经 `llm:chat:agent-event` 透传（已回退，需重做） |
| 权限 `todowrite: allow`，子 agent 默认禁用 | `docs/tools` | JanusX 回退版是“workspace 无关、免审批、常开”。小方案需明确：是否进 Runtime 审批/审计，还是保持本地工具白名单 |
| TUI 右侧 Todo 栏：`[ ]/[•]/[✓]`、>2 项可折叠、空/全完成自动隐藏 | `tui/sidebar/todo.tsx` + `component/todo-item.tsx` | 回退版 `TodoListCard` 已抄到同交互，建议保留该设计 |
| prompt 强约束：3+ 步主动调用、同时仅 1 个 `in_progress`、实时更新、禁 markdown 清单替代 | `todowrite.txt` + `session/prompt/*.txt` | 回退版 `system-prompt-builder` 只加了 3 行，缺 `priority`、缺压缩/回放策略，需补齐最小 prompt 闭环 |

## 3. 回退版缺口（为什么先回退）

1. UI 孤儿：`TodoListCard.tsx` 无任何 import/挂载，`useJanusChat` 只有类型 import，无 `todo_update` 状态、无持久化（注释里写的 `janus-chat.ts` 双写并未实现）。
2. 主进程半闭环：`sync/sync+format/emit` 有了，但 `formatTodoStateMessage` 在有/无 workspace 两分支各拼一次 system message（重复注入风险），且无单测。
3. 模型契约缺 `priority/position`，与 opencode `Info` 不对齐；`MAX_TODOS=20`、`CONTENT 200` 是硬编码，未进配置。
4. 无权限/审计决策记录：免审批是合理的（对标本地计划工具），但未写入方案，review 时会被质疑。
5. 零单测：todo store/tool/card 均无 `vitest`，而 P6/P4 都有单测覆盖。

## 4. 目标与非目标

目标（小批量，1 轮 `xdo` 可完）：

- janus-chat 通道可用 `todo_write` 做 3+ 步计划跟踪，流式中 UI 实时更新，结束后可回看。
- 语义与 opencode 一致：`pending/in_progress/completed/cancelled`、同时仅 1 个 `in_progress`、空清单拒绝写入。

非目标（明确不做）：

- 不做 DB 持久化（仍内存 + 渲染端快照），不做 `priority`，不做子 agent 独立 todo，不做 `/compact` 压缩回放。
- 不改 Runtime 审批/审计主链；`todo_write` 保持本地直调。
- 不引入 `shell.run` 等 P3-L3 内容。

## 5. 技术方案（最小闭环）

### 5.1 契约层 `src/shared/ipc/llm.ts`

- `ChatTodoStatus`、`ChatTodoItem{content,status}`、`ChatRequest.todos?`、`ChatAgentEvent todo_update`（即回退前形态，原样恢复即可）。

### 5.2 主进程 `src/main/llm/`

- `chat-todo-store.ts`：`Map<conversationId, ChatTodoItem[]>` + `validateTodos(MAX 20/200)` + `todoRuleViolation(单 in_progress)` + `formatTodoStateMessage`（调用方只注入一次，避免双分支重复）。
- `chat-todo-tool.ts`：`zod todos[1..20]` + `createTodoVercelTool`（模型可见）+ `createTodoLoopTool`（loop 实执行，`details.todos` 回传）。
- `chat-orchestrator.ts`：流起点 `sync(conversationKey, rendererTodos)` → `todoStateMessage` 只拼一次 → `modelTools = {...workspaceTools, ...todoTools}`、`loopTools = [...runtimeTools, todoLoopTool]` → `emitTodoUpdate` 发 `todo_update`。保持 P6 `maxSteps` 不动。
- `system-prompt-builder.ts`：`todoEnabled?` + 无 workspace 时兜底句 + 有 workspace 时 2 行（workspace 独立声明 + Task Management 3+ 步规则）。

### 5.3 渲染端（双层：常驻条 + 气泡回看）

> 结论（2026-09-05 确认）：不放左侧、不新开右侧列。左侧 `JanusChat.tsx:760 janus-chat-sidebar` 是会话级列表（粒度错）；chat 模式无常驻右栏，新开列在 `@container 720px` 下会挤死，且 `auxiliary-island` 属 Island 模式。`opencode` 右栏常驻思想改为 JanusX 居中流适配：sticky 常看层 + 气泡回看层。

- `services/llm.ts`：`chatStream options.todos` + `startChatStream` 透传（回退前形态）。
- `useJanusChat.ts`：`todosByConversation` 状态 + `onAgentEvent todo_update` 分支 + 随 `conversationId` 快照持久化（复用 `toolTraces` 上限策略，如 24 条/会话）。同一份 `todos` 同时喂常驻条与气泡卡，避免双真相源。
- 常看层 `TodoStickyBar`（新增，小组件，复用 `TodoListCard` 的 `hasOpenTodos`/计数逻辑）：
  - 位置：`JanusChat.tsx:1246 input-wrapper` 上方（composer 顶贴边），`messages` 滚动容器之外，滚到哪都在，解决“todo 要一直看”。
  - 形态：单行 `待办 n/m · 当前: <in_progress content>` + 超 2 项点击展开全单；空/全完成自动隐藏（与卡片同规则）；流式中实时涨（`contentSignature` 纳入 `todos.length` 驱动滚动/计数，仿 `pendingContent`）。
  - 工作区嵌入：`janus-chat--workspace` / docked 下同样全宽置顶于 composer，不进气泡流，故窄列不挤；`discussionOnly`（圆桌中央）默认隐藏 sticky，只留气泡内只读折叠态（仿 P2 `ThinkingRegion` 在 `discussionOnly` 的处理）。
- 回看层 `TodoListCard.tsx` + `08-janus-workspace-chat.css` + `janus.json(en/zh-CN)`：恢复回退版设计（空/全完成隐藏、>2 可折叠、`✓/•/✕`、i18n `title/expand/collapse/status.*`），挂点固定二选一不再摇摆：
  - 历史 `assistant` 气泡 `MarkdownContent` 上方（与 `ThinkingRegion snapshot=false` 并列，顺序：Todo → Thinking → 正文 → `ToolCallGroup`）；
  - 流式气泡同序置顶。工作区模式下气泡内卡片默认折叠，只露计数行，点开展示。

### 5.4 测试

- `chat-todo-store`：空清单拒写、超 20 截断、双 `in_progress` 拒写、`format` 快照有界。
- `chat-todo-tool`：zod 非法参数进 `isError`、正常写触发 `onUpdate`。
- `orchestrator` 轻量：`todoStateMessage` 只注入一次（防双分支回归）。
- 回归：`workspace-chat-tools`、`janus-agent-loop`、`chat-session-runtime` 全绿；`eslint` 0 错误。

## 6. 验收

1. 3+ 步任务模型首调 `todo_write` 建全量计划，且同时仅 1 个 `in_progress`。
2. 常驻条计数 `n/m` + 当前项实时涨，滚动时仍可见；点击展开/收起全单；空/全完成自动隐藏（常驻条与气泡卡同规则）。
3. 气泡卡只做回看：历史消息上方折叠态可展开，工作区窄列默认折叠；`discussionOnly` 无 sticky、仅只读折叠。
4. 新一轮/切换会话不串台（`conversationKey` 隔离）。
5. 非法写入（空清单/双 `in_progress`）模型收到可纠错 `isError` 文案并自愈。
6. 无 workspace 附件时 `todo_write` 仍可用；有 workspace 时不干扰审批/审计。

## 7. 风险与控制

| 风险 | 控制 |
|---|---|
| system message 双注入撑上下文 | 只拼一次；`format` 有界（行数=清单长度，上限 20） |
| 前端状态膨胀 | 随会话快照上限裁剪；流内 `Map` 按 `MAX_CHAT_SESSIONS=32` 复用已有淘汰 |
| 模型用 markdown 清单替代调用 | prompt 明确禁止替代句（回退版已有，保留） |
| 与 P6 步数/重试冲突 | todo 不占 turn；`maxTurns` 仍走 `agentMaxSteps` |
| 居中气泡信息过载（正文+工具卡+todo） | 常驻条与气泡卡职责分离：live 看 sticky 单行，回看才展开气泡卡；工作区窄列气泡卡默认折叠 |
| 工作区嵌入列宽不足 | sticky 在 `input-wrapper` 上方全宽置顶，不进 `messages` 流；`720px` 容器查询下只压缩单行省略，不另开右列 |

## 8. 实施步骤（预计 9 文件 + 2 单测）

1. `shared/ipc/llm.ts`：恢复 todo 契约。
2. `main/llm/chat-todo-store.ts` + `chat-todo-tool.ts`：恢复（修双注入注释）。
3. `main/llm/chat-orchestrator.ts` + `system-prompt-builder.ts`：恢复接线（单次注入）。
4. `renderer/services/llm.ts` + `useJanusChat.ts`：恢复透传与 `todosByConversation` 状态（含 `contentSignature` 纳入计数）。
5. `TodoListCard.tsx`（回看） + `TodoStickyBar.tsx`（常驻，复用前者逻辑） + css + i18n：挂载到 `input-wrapper` 上方与气泡置顶（顺序 Todo → Thinking → 正文 → ToolCallGroup）。
6. 单测 + 回归 + 手工联调（3+ 步工作区任务，重点看窄列工作区嵌入与 `discussionOnly` 隐藏逻辑）。

> 备份：本次回退的 todo 实现原文在 `C:\Users\Tree\AppData\Local\Temp\opencode\todo-rollback-20260905\`（3 个 `.bak` + `todo-tracked.diff`），实施时可直接对照恢复，避免重写走样。

## 9. janus-agent 知识 MCP 接入（待实施，和 todo_write 同属 agent 能力面）

> 背景：知识库 MCP 已有 5 个只读工具（`knowledge_search` / `knowledge_context` / `wiki_list` / `wiki_get` / `fact_get`，见 `src/main/knowledge/knowledge-mcp-tools.ts`），外部终端经 stdio 接入；但应用内 janus-agent 调不到——`src/main/ipc/agent-runtime-handlers.ts` 只注册了 workspace / project / git / command 四组工具。

### 9.1 方案（同进程直调，不走 MCP 协议）

- 新增 `src/main/agent/runtime/tools/knowledge-tools.ts`，照 `workspace-tools.ts` 的 `RegisteredTool` 写法映射 5 个只读工具（`actionRisk: 'read'`）：
  - `knowledge.search` → `knowledgeContextService.search`（BM25 混合召回 + 预算打包）
  - `knowledge.wiki_list` / `knowledge.wiki_get` / `knowledge.fact_get` → `knowledgeTruthService.list()` 之上的轻查询（复用 `knowledge-mcp-tools.ts` 的 payload 构造，抽纯函数共用，避免两份逻辑）
  - `knowledge.context` 可选（与 search 同源，按需决定是否暴露，给 agent 的建议是只给 search + wiki 三件套，保持工具面最小）
- `agent-runtime-handlers.ts` 加一行 `registerKnowledgeTools(workspaceAgentRuntime.registry)`。
- 作用域强制（照 `workspace.read` 模式，fail-closed）：`input.workspaceId ?? context.workspaceId` 必须等于 `context.workspaceId`，否则抛错；Agent 只能读自己会话工作区的知识。
- 预算沿用 MCP 侧默认值（`maxItems 8 / maxChars 4000`，`wiki_get` 支持 `maxChars` 截断 + `truncated` 标记），防止上下文爆炸。

### 9.2 非目标

- 不做写入工具（批准/归档仍走工作台人工审核，不进 agent 工具面）。
- 不在 agent 内复刻 MCP stdio 服务端；外部终端继续用 `out/main/knowledge-mcp.js`，设置页知识库区段已支持一键写入三客户端配置。

### 9.3 测试与验收

- 单测（`tests/unit/agent/knowledge-tools.test.ts`，仿 `command-tools.test.ts` 模式）：5 工具注册成功；跨 workspaceId 拒绝；`wiki_get` 缺页进 `isError`；`fact_get` 幽灵 id 进 `isError`。
- 验收：janus-chat 里让 Agent 先 `wiki_list` 再 `wiki_get` 回答一个已沉淀问题，全程只读、无审批打断、无跨工作区泄漏。
- 回归：`typecheck`、`test:unit --run tests/unit/agent/` 全绿。
