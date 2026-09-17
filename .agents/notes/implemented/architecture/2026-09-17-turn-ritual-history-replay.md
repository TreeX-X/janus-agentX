# Agent Note: 首跳之后——轮次仪式与历史重发

Status: implemented

## Problem

首跳优化落地后同一问题从 500k 降到 200k（搜索与输出提速），opencode 同一问题只用 40k，仍差 5 倍。触发条件是诊断加修复全程：总量约等于轮数乘每轮 5.3k 固定前缀，再加此前全部历史原文的逐轮重发。放任不管，每轮前缀与 8 至 12k 的大输出随轮数线性放大，优化首跳形状不再降低总量。

实测口径与 dist 构建加仓内估算器同式。固定前缀 5298 tokens 由系统提示 953 与 23 个工具 schema 4345 组成。历史 blob 里 `workspace.overview` 300 条目约 8022 tokens，`workspace.read` 默认页 48KB 约 12318 tokens，`command.run` 8KB tail 约 2000 tokens 起；30 条扁平搜索命中仅 660 tokens，搜索形状已到位。`layoutContext` 让最新 40000 tokens 工具输出原文逐轮重发，assistant 消息永不修剪；还原 agentX 轨迹约 10 至 12 轮（总览先行、files 再 content、read-before-edit、命令验证加日志追读），历史里长期躺着 8k 加 12k 的输出，即得 200k 量级。前序决策见[搜索首跳优化](./2026-09-17-search-first-token-optimization.md)，分页与修剪契约见[读分页放大量级](../bug-fix/2026-09-16-read-paging-token-amplification.md)。

## Decision

保持哈希一致性、审批审计与 checkpoint 恢复不动，只砍轮数与 blob 体积。

系统提示按查询性质路由。错误文本、符号、内容归属类查询直查扁平内容搜索；文件名类查询才走 `mode=files`，总览只保留给“检出形状本身就是问题”的情形；`withContext:true` 只在需要上下文行时传递，首命中自带哈希。`Prefer search over walking the tree` 原句保留。

扁平命中带回文件哈希。同文件多命中只在首命中携带，1MB 以上或不可读文件省略；哈希由服务端有界读计算，每文件约 16 tokens。`workspace.edit` 的 `expectedHash` 在文件未变更时直接可用，常见定位到修复无需二读，`TARGET_CHANGED` 语义不变。

内容结果按修改时间倒序。只对命中文件做 `stat`（不超 `maxResults` 个的去重集合），纯 mtime 稳定排序：并列（含未知文件）保持扫描原序，不回落字母序，避免打乱 `rg` 的产出顺序。顺序变化不改动输出契约，`withContext` 分组沿用该顺序，截断时优先保留最新文件。

总览默认条目从 300 收到 100。条目继续携带文件大小与秒级修改时间戳，目录优先分组保留；首跳输出从约 8k 降到约 3k。

工具 schema 保守瘦身。四份顶层描述与重复字段说明压缩后，同口径从 4345 降到 4121 tokens（实测，省 224 tokens 每轮）。参数结构本身占大头，顶层描述压缩的上界即在于此；行为关键的哈希、锚点、审批语义一字未动。

## Alternatives considered

- 剪枝尾从 40000 下调到 16000：最强理由是最新大输出的重发税直接减半。否决驱动是该值经过刻意决策且 digest 保真依赖它，只测后动：同问题复放总量下降且无补读轮数上升才保留；本次未改，回看信号是仪式砍完后总量仍超 100k。
- 读默认页收缩：最强理由是单轮最大 blob 直接变小。否决驱动是与已验证的“大页省轮数”结论冲突，分页轮数回升会被历史重发吃掉。
- 工具渐进披露（codex 式 `tool_search`）：最强理由是每轮前缀从 4.1k 降到约 1.5k。否决驱动是改动跨模型工具契约与壳侧白名单同步；回看信号是本次瘦身后前缀仍占总量三成以上。
- Do nothing / reuse：零代码，保留仪式链与 blob 体积。代价是同问题 200k 常态化。

## Consequences

- **Gains**: 内容类问题省掉总览轮与文件名模式绕行（各约一轮加其 blob 的后续重发）；定位到修复在文件未变更时无需二读（省整轮 12k 重读）；内容首命中偏向最近修改，追查轮数随首命中率下降；总览首跳约 8k 到约 3k；每轮前缀省 224 tokens。
- **Costs and limits**: 内容搜索新增最多去重后 `maxResults` 个 `stat` 与同等规模的有界哈希读，均为服务端 IO，不进模型上下文之外的计费项只有约 16 tokens 每文件；并列 mtime 保持扫描原序，同仓复放确定，跨机器 `rg` 产出顺序差异可致顺序差异；总览 100 条目在大仓形状问题上需加深或加条目；schema 仍约 4.1k 每轮，参数结构是下限。
- **Verification**: `packages/agent-core` 全量 335 通过、1 既有跳过，含扁平首命中哈希、同文件次命中无哈希、不可读文件无哈希、内容按修改时间倒序（字母序反例锁定）、模拟 `rg` 的顺序保持用例，命令为 `npx vitest run`；`chat-core` 59、`janus-agent` 26、`cli` 353 通过；`agent-core` 与 `chat-core` `tsc --noEmit` 通过。本机无 `rg`，透传路径由 `workspace-search-passthrough.test.ts` 覆盖。
