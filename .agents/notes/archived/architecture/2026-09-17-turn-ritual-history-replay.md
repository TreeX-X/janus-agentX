# Agent Note: 首跳之后——轮次仪式与历史重发

Status: proposed

## Problem

首跳优化落地后同一问题从 500k 降到 200k（搜索与输出提速），opencode 同一问题只用 40k，仍差 5 倍。触发条件是诊断加修复全程：总量约等于轮数乘每轮 5.3k 固定前缀，再加此前全部历史原文的逐轮重发。放任不管，每轮前缀与 8 至 12k 的大输出随轮数线性放大，优化首跳形状不再降低总量。

实测口径与 dist 构建加仓内估算器同式。固定前缀 5298 tokens 由系统提示 953 与 23 个工具 schema 4345 组成，其中 `workspace.edit` 431、`command.run` 408、`workspace.search` 387、`workspace.read` 363。历史 blob 里 `workspace.overview` 300 条目约 8022 tokens，`workspace.read` 默认页 48KB 约 12318 tokens，`command.run` 8KB tail 约 2000 tokens 起；30 条扁平搜索命中仅 660 tokens，搜索形状已到位。`layoutContext` 让最新 40000 tokens 工具输出原文逐轮重发（`DEFAULT_PRUNE_KEEP_TOKENS`），assistant 消息永不修剪；还原 agentX 轨迹约 10 至 12 轮（总览先行、files 再 content、read-before-edit、命令验证加日志追读），历史里长期躺着 8k 加 12k 的输出，即得 200k 量级。Opencode 轨迹约 4 至 6 轮且 blob 小，即得 40k 量级。前序决策见[搜索首跳优化](../../implemented/architecture/2026-09-17-search-first-token-optimization.md)，分页与修剪契约见[读分页放大量级](../../implemented/bug-fix/2026-09-16-read-paging-token-amplification.md)。

## Proposal

保持哈希一致性、审批审计与 checkpoint 恢复不动，只砍轮数与 blob 体积，按预期收益排序实现。

内容类查询跳过总览与文件名模式，直查内容。系统提示改为按查询性质路由：错误文本、符号、内容归属类查询首查 `mode=content`；文件名、目录形状类查询才走 `mode=files` 与 `workspace.overview`（浅深度先行）。总览不再是内容问题的必经轮，一轮加 8k 输出及其后续每一轮的重发同时消失。

扁平命中带回文件哈希。哈希由服务端有界读计算，不占模型上下文之外的成本，每命中约 16 tokens；同文件多命中只在首命中携带，后续命中省略。`workspace.edit` 的 `expectedHash` 在文件未变更时直接可用，常见定位到修复无需二读；文件逾 1MB 或变更后仍走显式重读，`TARGET_CHANGED` 语义不变。

内容结果按修改时间倒序。只对命中文件做 `stat`（不超 `maxResults` 个），最近修改在前，字母序只做并列决胜，与 `mode=files` 现有顺序同式。首命中率上升则追查轮数下降；顺序变化不改动输出契约，剪枝摘要按 `matchCount` 计数的形状不变。

总览默认条目从 300 收到 100。条目继续携带文件大小与秒级修改时间戳，目录优先分组保留；首跳输出从约 8k 降到约 3k，信号密度不变。

工具 schema 瘦身。`workspace.edit`、`command.run`、`workspace.search`、`workspace.read` 四个描述各压缩到 250 tokens 内，总 schema 从 4345 降到约 3300，每轮固定前缀同步下降；工具名、参数、审批分类不动，壳侧白名单无需同步。

剪枝尾只测后动。`DEFAULT_PRUNE_KEEP_TOKENS` 从 40000 下调到 16000 先在同问题复放下实测：总量下降且无补读轮数上升才保留，否则回退。摘要的哈希与路径保真语义不变，`LoadedContext` 元数据提示继续覆盖三文件。

## Alternatives considered

- 读默认页收缩（48KB 回 16KB 或 800 行回 200 行）：最强理由是单轮最大 blob 直接变小。否决驱动是与已验证的“大页省轮数”结论冲突，分页轮数回升会被历史重发吃掉；本提案先砍整轮仪式，页大小待复放数据再定。
- 工具渐进披露（codex 式 `tool_search`，常用 5 工具先行）：最强理由是每轮前缀从 4.3k 降到约 1.5k。否决驱动是改动跨模型工具契约与壳侧白名单同步，一次提案装不下；列为远期方向，回看信号是 schema 瘦身后前缀仍占总量三成以上。
- 默认强制小 token 预算：最强理由是形状上与 codex 完全一致。否决驱动与前序结论相同，自适应整文件读天然超过小预算，默认强制与自适应互斥。
- Do nothing / reuse：零代码，保留当前仪式链与 blob 体积。代价是同问题 200k 常态化，首跳优化的收益被轮数吃掉；回看信号是用户复放同问题仍报 5 倍差。

## Acceptance criteria

- [ ] 同问题复放下端到端输入 tokens 进入 60 至 80k 区间，且轮数不高于 6 轮；内容首查命中目标文件的首跳占比可复现。
- [ ] 扁平命中哈希可用：定位到修复在文件未变更时无需二读，`TARGET_CHANGED` 与超 1MB 文件的显式重读语义由用例锁定。
- [ ] 顺序与条目变更可测：内容结果最近修改在前，`workspace.overview` 默认 100 条目且信号字段齐全，契约测试同步。
- [ ] 验证命令为 `npx vitest run`（`agent-core`、`chat-core`、`janus-agent`、`cli` 四包）与八个 workspace `npm run typecheck`；剪枝尾调整只有复放数据达标才保留。

## Risks

- 扁平哈希过期：搜索与编辑之间文件变化会触发一次 `TARGET_CHANGED` 重读；缓解是该语义现成且仅发生在真实变更时，误报率由复放统计。
- 内容排序新增最多 30 个 `stat`：超大命中集下是额外 IO；缓解是只在 content 命中路径触发，`maxResults` 即上界。
- 路由改写误伤文件名查询：内容首查对纯文件名问题多一轮；缓解是提示词保留名字类查询走 `mode=files` 的显式分支。
- 记录日为 2026-09-17，计数基于当日 dist 与估算器；供应商 tokenizer 与消息包装不同，复放以同口径对比为准，不承诺计费比例。
