# Agent Note: 对标 opencode 的 token 结构

Status: implemented

## Problem

同一诊断加修复任务消耗约 200k tokens，opencode 处理同一问题约 40k。总量服从轮数乘每轮前缀再加历史原文的逐轮重发：固定前缀约 5.1k（系统提示加 23 个工具 schema），`workspace.read` 默认页约 12k、`workspace.overview` 约 3k、`command.run` 尾预览约 2k 长期躺在历史里，`pruneKeep 40k` 让最新大输出逐轮原文重发，还原轨迹约 10 至 12 轮。放任不管，每轮前缀与大输出随轮数线性放大，首跳形状优化不再降低总量。前序决策见[搜索首跳优化](./2026-09-17-search-first-token-optimization.md)与[轮次仪式与历史重发](./2026-09-17-turn-ritual-history-replay.md)。

## Decision

保持哈希一致性、审批审计与 checkpoint 恢复不动，只砍前缀体积、历史重发与失败重试轮数。

模型可见值一律纯文本，结构化输出只走详情与回溯。`workspace.search` 渲染为按文件分组的 `Found N matches` 加 `Line N: text` 行，首命中行携带完整文件哈希；`workspace.read` 渲染为路径加行区间加完整哈希的头行与 `N: line` 编号正文；`workspace.list/overview` 渲染为每行一路径的条目；变更结果收敛为 `Edited/Created/Deleted <path> sha=<64hex> checkpoint=<id>` 单行；`command.run` 收敛为 `$ <cmd> exit=<n>` 头行加日志引用加尾预览。`workspaceId`、`estimatedTokens`、字节数、`env` 回显不出模型上下文。实现位于 `toolResultToModelValue`，运行时输出对象保持完整。

模型文本全局截断与 opencode `Truncate` 同形：2000 行与 50KB，头留尾舍，超限文本命名更窄的重查方式，不再邀请全量重读。截断器归属 `output-budget` 的 `truncateModelText`，各渲染器共用。

工具按阶段暴露。诊断加修复加验证的核心集（搜索、读写、改动、命令、只读 git 与工程只读面）每轮全给；发布管理类 9 个工具（`git stage/unstage/commit/pull/push`、`project generate/apply/start/stop`）只在用户提出发布意图或历史已出现成功变更时加入。缺失的发布工具退化为一句追问，不造成失败。实现位于 `runChatTurn` 的 staged offering。

历史剪枝分级。`pruneKeep` 从 40000 降到 16000；搜索、列表、总览输出只在最新 2 轮保留原文，更早的即使预算充足也压成摘要（重跑成本为一次搜索）；读、改动、命令证据保留完整尾巴。摘要器兼容纯文本头行，首行即摘要。

编辑接受空白漂移。精确匹配仍权威；仅当精确匹配落空且去缩进形状在全文件唯一命中时应用该位置，零命中或多命中沿用原精确错误（多命中报歧义）。`expectedHash` 并发门保持不变。

工具描述保守瘦身。读、改、搜、列表、总览、删除、命令的顶层描述压缩约三成，哈希、锚点、审批语义一字未动。

## Alternatives considered

- 全量 23 工具每轮暴露：最强理由是零误伤，任何意图都可一轮直达。否决驱动是每轮前缀约 5.1k，经 10 轮重发放大到约 50k；现方案保留修复路径全量，只门控极少在诊断中使用的发布类工具。
- `pruneKeep` 保持 40000：最强理由是最新证据零损失。否决驱动是 8k 加 12k 的输出在尾巴里躺多轮，重发税超线性；现方案按重跑成本分级，搜索类早压，读与命令晚压。
- `shell` 直通面：最强理由是工具面最小，单轮可聚合多步。否决驱动是失去结构化审批分类与哈希一致性，`workspace.edit` 的精确替换与 checkpoint 恢复需要重做。
- 会话级枚举缓存：最强理由是重复定位零枚举开销。否决驱动是实测新建文件在 TTL 窗口内不可见，正确性优先，不设该状态。
- Do nothing / reuse：零代码，保留前缀与重发结构。代价是同问题 200k 常态化。

## Consequences

- **Gains**: 每轮前缀下降约 1.5k（发布 schema 门控加描述瘦身）；单结果包装下降约 200 至 300 tokens 且不再随轮数携带回显字段；旧搜索输出最多存活 2 轮原文；空白漂移的编辑不再 spending 一整轮重试；超限文本统一指向更窄的重查。
- **Costs and limits**: 发布意图识别依赖关键词与历史变更记录，非常规措辞的发布请求首轮缺工具，需一句追问后次轮补齐；纯文本历史摘要依赖首行格式，旧 JSON 历史仍按 JSON 路径解析；模糊匹配只覆盖去缩进情形，实质内容差异仍需重读。
- **Verification**: `agent-core` 341 项（340 通过、1 既有跳过，命令 `npx vitest run`）、`chat-core` 60、`janus-agent` 28、`cli` 353、`node-hosts` 33 全过；`agent-core`、`chat-core`、`janus-agent` `tsc --noEmit` 通过。新增用例覆盖纯文本渲染 9 项、截断 3 项、阶段暴露 2 项、分级剪枝 1 项、模糊编辑 2 项。同问题 token 复放待有线上口径后核对 40 至 60k 档。
