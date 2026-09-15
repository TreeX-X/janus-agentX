# Agent Note: 写路径锚链与只读计划档及单一循环收敛

Status: implemented

## Problem

`workspace.edit` 的 `expectedHash` 整文件校验与逐字节 `oldText` 精确匹配在并发编辑与 Windows CRLF 下失配率高：一次行号漂移即整单 `TARGET_CHANGED`，模型必须重读整文件再拼三段往返。`plan` 只有口头约定，探索轮里一次误调写工具即产生副作用。`janus-agent-loop` 的 steering 在流后、工具间隙、轮尾三处各取各发，`steering_consumed` 语义分散，父级 abort 与半截 `toolCalls` 的归属无统一出口。

## Decision

`workspace.read` 加可选 `withLineAnchors`，返回当页每行的 `LINE#HASH` 锚（行哈希取 sha256 前 8 hex，CRLF 归一后计算，尾空行无锚）。`workspace.edit` 加第三互斥模式 `lineEdits`（1 到 40 条，每条 `line`、`anchor`、`newText`），执行前校验锚，失配整批 abort 且错误内带失败行前后各两行的 fresh anchors，一轮内可直接重试而不重读；校验通过后按行号自底向上应用，`newText` 可含换行做插入，多行插入不使先验行号失效；重复行号拒绝而非猜测，超界行号按 `TARGET_CHANGED` 指引重读。文件保持主导换行符风格，输出超 1M 即拒。

`plan` 是权限级只读档而非提示词约定。`AgentApprovalMode` 与 `ApprovalPolicy` 加 `plan`，`evaluateWorkspaceActionPolicy` 在敏感路径与只读放行之后、常规审批之前拦截：`plan` 下一切非只读 `actionRisk` 直接 `deny` 并记 `PLAN_MODE_BLOCKED`，永不进审批等待；只读四件（`inspect`、`list`、`stat`、`read`）照常放行，敏感路径仍按 `SENSITIVE_PATH` 拒绝。`runtime` 对该码返回只读指引而非裸拒，模型停手并转述方案；切出 `plan` 后同一会话继续可用。CLI 的 `--approval-mode`、`/approval`、审批面板与状态行同步第三档。

`janus-agent-loop` 的 steering 消费收敛到单一 `takeSteered` 出口：每次 take 发一次 `steering_consumed` 并置位强制续轮标记，调用点只决定条目落向哪个队列。父级 abort 与 steering 打断走同一剥离路径：保留半截正文，已落历史不动，未执行的半截 `toolCalls` 剥除而不执行，中断只弃当轮 stream。

## Alternatives considered

- codex 式原子多文件 DSL 替代三编辑模式：最强理由是一次调用收敛多文件写，往返最少；否决驱动是新 DSL 改变工具面与预览契约，`lineEdits` 已覆盖行漂移主因，多文件原子走现有 checkpoint 加 git 显式恢复即可。
- opencode 式模糊锚链（前缀匹配加自动纠偏）：最强理由是手滑锚仍可救回，少一次重试；否决驱动是静默改写行归属，与精确匹配决策冲突，错行写入的代价高于一次指引重试。
- `plan` 只做 prompt 约束而不进 policy 层：最强理由是零类型改动；否决驱动是模型误调写工具时副作用已发生，审批等待亦会被 `plan` 轮的写调用占住，只读必须在执行与审批之前 fail-closed。
- steering 保留三处独立 take：最强理由是调用点自解释；否决驱动是 exactly-once 与强制续轮标记散落三处，新增检查点必漏标记，收敛到单一出口后调用点只剩队列归属。
- Do nothing / reuse：零代码；代价是行漂移编辑每轮重读整文件，`plan` 探索轮保留误写风险，steering 检查点继续各管各的消费语义。

## Consequences

- **Gains**: 行级编辑失配时一轮内凭 fresh anchors 重试，无需重读；连续编辑形成读一次多写链；`plan` 会话可自由探索而写操作在政策层必拒；steering 在流后、间隙、轮尾三检查点语义统一，中断只弃 stream 不弃历史。
- **Costs and limits**: 新增 `line_edits` 第三模式与 `LINE#HASH` 锚契约，调用方必须先 `withLineAnchors:true` 再写；锚是行内容哈希，行内单字改即失配，重访信号为 fresh-anchor 重试命中率；`plan` 下 `a` 常许等放行路径对写操作无意义，仍须显式切档。
- **Verification**: `npm run typecheck --workspace=@janus-agent/agent-core` 通过；`npm run test --workspace=@janus-agent/agent-core` 19 文件 302 通过、1 跳过（含锚链 7 例、plan 4 例、循环收敛 2 例新增）。
