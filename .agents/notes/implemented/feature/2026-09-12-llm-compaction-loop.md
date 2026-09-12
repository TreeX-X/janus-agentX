# Agent Note: LLM 压缩循环（单摘要吸收被裁剪 turn）

Status: implemented

## Problem

`buildContext` 的确定性裁剪保住了 `sha`，但丢掉需求句、决策句与失败尝试：长会话越长，可靠性越低。窗口表让阈值随模型走对了，可阈值撞墙后依然无摘要可接，`workspace.edit` 能用，模型却忘了要做什么。方向见 [context-compaction](../../proposed/feature/2026-09-12-context-compaction.md)，本 Note 只记录已落地的循环与指令。

## Decision

`ChatSessionRuntime` 持有单份摘要与头指纹。`maybeCompact` 在自动模式只压预算丢弃的旧 unit，在 `force` 模式压除最新 N 个（默认 1，可配 1 到 50并钳制）之外的全部历史；head 永不切开 tool 调用与其结果，系统消息永不进 head，tool 结果逐条截断到 `2000` 字符，head 全文封顶 `24000` 字符。摘要提示词模板固定七节，缺 `Goal/Progress/Next Steps` 即纠正一次再判失败；成功存入 `8000` 字符封顶的单版摘要，旧版丢弃。指纹对全文 head 寻址而 prompt 截断只为调用封顶，同尾异头必触发新摘要；同一 head 永不重复烧调用，新裁剪内容触发迭代更新并带上前版摘要。任何失败（抛错、空回、非法格式、预算内无 head）都返回 false 走确定性 digest 老路，压缩永不打断 turn。`buildContext` 把摘要以 user 口吻拼在 evidence 之后、digest 与原文之前，digest 拼装对 window 校验而非 budget，summary 预留只扣一次，否则紧预算下 digest 被无故丢弃，持久历史不删除。

自动触发住在 `runChatTurn` 的 `transformContext`：每轮发送前试压一次，指纹去重保证重复调用零成本，调用方缺 summarizer 时行为与从前一致。手动 `/compact` 经 `compactActiveConversation` 立即执行同一 `maybeCompact(force)` 并落盘，不依赖 turn；持久历史只存 prose 而 tool 结果留在 `toolTraces`，手动 head 为 prose-only，in-loop 的 tool 粘连只属于自动路径。摘要与指纹随会话持久化（`compactionSummary/compactionKey`），重启与切换会话时回填，短历史、已是最新、传输缺失、摘要非法各有明确回执。

## Alternatives considered

- 每轮只压一次（turn 级节流）— 调用更少；但指纹去重已把重复调用压到零，turn 级标记反而在超长单 turn 内放弃后续压，效果更差。
- 摘要进 system 消息 — 与指令同级；但系统区是每 turn 重读的安全规则位，摘要只配 user 身份的 handoff。
- 失败抛错中断 turn — 调用方立刻知道；但压缩是优化不是门禁，中断把偶发 provider 抖动变成任务失败，手动路径已单独透出错误。
- Do nothing / reuse — 维持纯确定性裁剪，零 LLM 成本；代价是长会话 prose 永久丢失，见 Problem。

## Consequences

- **Gains**: 超预算自动压一次且只压一次同一内容，`chat-compaction.test.ts` 锁定 8 条（触发、单版、迭代、force、tool 粘连、重试、回退、持久往返），`chat-turn.test.ts` 锁定自动路径单次调用与注入位置，`tui-compact.test.ts` 锁定手动三回执与重载复用。
- **Costs and limits**: 摘要调用走本会话同一模型与 transport，无独立小模型；mid-turn 超长单链仍可能先撞 `CURRENT_TURN_EXCEEDS` 停轮；provider overflow 重试与摘要用量计入账单留后；`keepRecentUnits` 是唯一可配项且只影响 force 模式。
