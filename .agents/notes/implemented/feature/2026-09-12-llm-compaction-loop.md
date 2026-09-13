# Agent Note: LLM 压缩循环（单摘要吸收被裁剪 turn，轻量硬化）

Status: implemented

## Problem

`buildContext` 的确定性裁剪保住了 `sha`，但丢掉需求句、决策句与失败尝试：长会话越长，可靠性越低。窗口表让阈值随模型走对了，可阈值撞墙后依然无摘要可接，`workspace.edit` 能用，模型却忘了要做什么。阈值无硬顶时偏晚的配置把失败调用留给后端，单个超大 turn 直接终结会话，provider 溢出后同 turn 无恢复，摘要正文里的路径经 LLM 转述后失真。方向见 [context-compaction](../../proposed/feature/2026-09-12-context-compaction.md)，本 Note 只记录已落地的循环、指令与轻量硬化。

## Decision

`ChatSessionRuntime` 持有单份摘要与头指纹。`maybeCompact` 在自动模式只压预算丢弃的旧 unit，在 `force` 模式压除最新 N 个（默认 1，可配 1 到 50 并钳制）之外的全部历史；head 永不切开 tool 调用与其结果，系统消息永不进 head，tool 结果逐条截断到 `2000` 字符，head 全文封顶 `24000` 字符。摘要提示词模板固定七节，缺 `Goal/Progress/Next Steps` 即纠正一次再判失败；落盘前代码侧把 head 中的读写路径拼到摘要尾部（各最多 20 条，摘要正文为清单让出预算），成功存入 `8000` 字符封顶的单版摘要，旧版丢弃。指纹对全文 head 寻址而 prompt 截断只为调用封顶，同尾异头必触发新摘要；同一 head 永不重复烧调用，新裁剪内容触发迭代更新并带上前版摘要。任何失败（抛错、空回、非法格式、预算内无 head）都返回 false 走确定性 digest 老路，压缩永不打断 turn。`buildContext` 把摘要以 user 口吻拼在 evidence 之后、digest 与原文之前，digest 拼装对 window 校验而非 budget，summary 预留只扣一次，否则紧预算下 digest 被无故丢弃，持久历史不删除。

触发预算取 `min(window - reserved - buffer, floor(window * 0.9))`，`buffer` 缺省 512 并钳制在 0 到窗口 10% 之间。调用方只能把触发点提前，不能推迟到超过窗口 90%；没有 90% 硬顶，偏晚的阈值把溢出留给后端承担。单个超预算 turn 进入被丢弃 head 而不是抛错，digest 或强制摘要继续承载它；没有这条，一个巨大 tool 输出终结整个会话。系统超预算仍抛 `SYSTEM_CONTEXT_EXCEEDS_BUDGET`。

自动触发住在 `runChatTurn` 的 `transformContext`：每轮发送前试压一次，指纹去重保证重复调用零成本，调用方缺 summarizer 时行为与从前一致。provider 溢出错误（`isContextOverflowError` 覆盖 context/overflow/413 等形态）在同一 turn 内触发一次强制压缩并重试一次；第二次溢出直接返回错误，不循环。手动 `/compact [focus]` 经 `compactActiveConversation` 立即执行同一 `maybeCompact(force)` 并落盘，不依赖 turn，500 字符内的强调语写进摘要提示词而不删减其它章节；持久历史只存 prose 而 tool 结果留在 `toolTraces`，手动 head 为 prose-only，in-loop 的 tool 粘连只属于自动路径。摘要与指纹随会话持久化（`compactionSummary/compactionKey`），重启与切换会话时回填，短历史、已是最新、传输缺失、摘要非法各有明确回执。最近一次压缩的 `tokensBefore` 与摘要长度经 `getLastCompactionInfo` 可查。

## Alternatives considered

- 每轮只压一次（turn 级节流）— 调用更少；但指纹去重已把重复调用压到零，turn 级标记反而在超长单 turn 内放弃后续压，效果更差。
- 摘要进 system 消息 — 与指令同级；但系统区是每 turn 重读的安全规则位，摘要只配 user 身份的 handoff。
- 失败抛错中断 turn — 调用方立刻知道；但压缩是优化不是门禁，中断把偶发 provider 抖动变成任务失败，手动路径已单独透出错误。
- provider 用量回路（`max(本地估算, 上轮用量 + 增量)`）— 阈值更准；但要在 stream 适配器与压缩之间新增用量 plumbing，保守估算加单次 overflow 重试已覆盖绝大多数溢出，精度收益抵不过状态成本，延后。
- loop 边界中途压加 pending 重放 — 长 tool 链存活率更高；但要重建请求并重放 pending 输入，改动 agent loop 主干，preflight 加 overflow 单次重试已覆盖常见链，延后。
- split-turn 双摘要合并 — 超大单 turn 的前后缀各得一份摘要，质量最高；但单摘要吸收超大 head 加 digest 兜底已保证存活，双调用合并留待真实超大 turn 出现再补。
- Do nothing / reuse — 维持纯确定性裁剪，零 LLM 成本；代价是长会话 prose 永久丢失，见 Problem。

## Consequences

- **Gains**: 超预算自动压一次且只压一次同一内容，阈值带 90% 硬顶且只许调早，超大单 turn 经 digest 或强制摘要存活，provider 溢出同 turn 恢复一次，文件路径由代码侧原样拼接到摘要尾部，手动 `/compact` 支持聚焦语。`chat-compaction.test.ts` 锁定 14 条（触发、单版、迭代、force、tool 粘连、重试、回退、持久往返、硬顶钳制、超大单轮存活、文件清单、聚焦语、溢出识别），`chat-turn.test.ts` 锁定 7 条（含自动路径单次调用与注入位置、溢出重试一次、连续溢出直接透出），`tui-compact.test.ts` 锁定手动三回执、重载复用与聚焦透传。
- **Costs and limits**: 摘要调用走本会话同一模型与 transport，无独立小模型；mid-turn 超长单链的中途压与 pending 重放留后；provider 用量回路与 split-turn 双摘要留后；`bufferTokens` 只影响触发早晚且钳制在 0 到 10%；`keepRecentUnits` 只影响 force 模式；摘要用量尚未计入账单。
