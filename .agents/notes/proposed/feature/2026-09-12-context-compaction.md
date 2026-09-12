# Agent Note: 上下文压缩 compaction（LLM 摘要 + 精确 digest 双轨）

Status: proposed

## Problem

`ChatSessionRuntime.buildContext` 目前只有确定性预算：tool 输出截断到 `6000/4000` 字符，旧 turn 按新到旧塞入直到 `budget = contextWindow - reserved - margin` 塞满为止，丢掉的旧 turn 只留 `droppedTurnsHandoffMessage` 的精确 digest（path、sha 前缀、query、条数，最近 24 行）。做法保住了 `workspace.edit` 的 `expectedHash` 不被改写，但丢掉的需求句、决策句、失败尝试与口头约束找不回来。默认 `contextWindow` 仅 `16384`，稍长的重构或修 bug 会话必然撞墙，撞墙后越旧的探索越先消失，模型只能盲列目录重定位。若维持现状，会话越长，可靠性越低，长任务无从谈起。

## Proposal

janus 采用本地 checkpoint 式压缩，不依赖 server 端点。janus 面向多家 OpenAI 兼容 endpoint，没有可依赖的 `POST /v1/responses/compact` 类 server 端点，压缩必须在客户端用一次独立 LLM 调用完成，工具调用在该调用内禁用。压缩在 agent loop 内双点触发：新 turn 发送前做 preflight 估算，超阈值先压再发；长 tool 链在 loop 边界超阈值当场压，压完重建请求并重放 pending 输入，不多耗一个 agent step。压后模型视图只含三样东西：一条 `summary`、一段精确 `digest`、一段最近 tail 原文，最多保留一版 summary，旧版按 hidden 下标去重丢弃，持久历史不删除。

切分按 turn 边界从新到旧累加 token 估算（`len/4`，与现有 `estimateTokens` 同口径）直到 `keep.tokens` 预算为止，永不从 `tool` 结果中间切断；单个 turn 超预算时允许切到 `assistant` 处形成 split turn，前缀与历史各生成一份摘要再合并。tail 序列化只保留文本与调用记录：tool 输出截断到 `2000` 字符，附件只留 `mime:filename` 描述符。阈值公式取 `estimated >= min(input_limit - buffer, context - max(output_reserve, buffer))`，窗口来源为随仓内置表：`models.json` 在发版时由脚本从 models.dev 拉取生成并落库，运行时只做 map 查，无状态无网络；匹配按 `provider/model` 精确优先、裸 `modelId` 后缀次之，未知回落保守默认值并在状态处明示为估算值。用户配置覆盖赢过一切。判断正确性不靠单次估准，靠三层兜底：保守估算提前压、有 provider 用量时取 `max(本地估算, 上轮用量+尾部增量)`、overflow 无输出时压后重试一次。

digest 轨与摘要轨并存，职责切开。现有 `toolDigest` 与 `droppedTurnsHandoffMessage` 保留并继续承担精确事实：`path`、`sha256`、`range`、`query`、条数永不经 LLM 改写，原样拼接入压后上下文；`LoadedContextIndex` 的最近已读证据继续按预算注入，并累积 `readFiles/modifiedFiles` 写入摘要尾部。LLM 摘要只承担正文，模板固定为目标、约束、已完成与进行中与阻塞、关键决策、下一步、关键上下文、相关文件，每节为空时填 `(none)`，缺节则纠正一次再判失败；迭代时以前版摘要加新 head 合并，冲突以新 head 为准，`tokensBefore` 按重建后上下文重算。摘要口吻用 notes-to-self 而非 exposition，模型按 resume 语气继续，不重做已完成工作。指令文件（`AGENTS.md`、`CLAUDE.md` 类规则）永不进摘要，每 turn 重读，安全规则不赌压缩存活。

触发与操控分两层。自动阈值取上述 `usable` 公式并设硬顶（用户只能调早不能调晚，避免后端溢出），阈值与 `keep.tokens`、`tool_output_token_limit` 均可配置；provider overflow 且无输出时允许压后重试同 step 一次，第二次溢出直接返回错误。手动 `/compact` 为必做指令，不带参数，在任务边界主动压，`auto=false` 时仍可用，短历史也可压；接线范围含 `commands.ts` 解析与补全、`exec.ts` 执行、`commandHelpText` 帮助文本。首版不做 codex 式的压后自动重读 5 文件，避免重读引发的压缩雪崩循环；重读需求由 `LoadedContextIndex` 的 evidence 机制按预算承担。`session memory` 优化（记忆充足时免一次 LLM 调用）、provider 原生压缩、`prune-first` 留后，不进首版。

本方向隶属总账矩阵第 12 项，见 [agent-cli-gap-matrix](2026-09-12-agent-cli-gap-matrix.md)（会话能力，P1）。派发与多线语义仍归 [context-brief-task-spawn](2026-09-08-context-brief-task-spawn.md) 与 [harness-persistent-subagents](../architecture/2026-09-11-harness-persistent-subagents.md)，本 Note 只管单会话压爆后的存续。

## Alternatives considered

- 照搬 codex server 路径（加密 blob，不透明摘要） — 防篡改且 server 可迭代，OpenAI 自家链路最快；但 janus 必须兼容多家 OpenAI 兼容 endpoint，无统一 server 端点可用，且黑盒摘要不可审计，合规场景反而是负担，故只借鉴触发与重建形态，不引入加密 blob。
- 维持纯确定性 digest 并调大窗口 — 零 LLM 成本，sha 永不失真，实现最小；但需求与决策一旦被裁即永久丢失，长会话只能靠重读自救，窗口越大单 turn 越贵，治标不治本。
- 照搬 opencode V2 checkpoint（`estimated >= min(input-buffer, ctx-max(out,buffer))` preflight、`keep.tokens` tail、`2000` 字符截断、固定模板缺节纠正一次、持久历史不删、请求从最新 checkpoint 重建） — 调度与重建形态最完整，且手动 `compact` 为 durable 请求、安全边界执行、失败也放行 pending；但其 `buffer 20k / keep 15k` 面向大窗口，`provider` 原生分支与指令 epoch 机制超出 janus 首版范围，故只取本地摘要分支的触发公式、tail 切分与迭代合并，不取 provider 分支与大默认值。
- 照搬 pi-mono 全套（`contextTokens > window-reserve`、`keepRecent 20k` 倒走、`chars/4` 估算、永不切 `toolResult`、split turn 双摘要合并、`Goal/Constraints/Progress/Decisions/Next/Critical + read/modified files` 累积、`tokensBefore` 重算、`session_before_compact` 扩展） — 切点规则与文件累积最细，`cacheRetention:none` 与重试包 transient 的摘要调用形态可直接复用；但其分支摘要、`modelOverrides`、扩展钩子属于多线与可插拔范畴，故首版只取切点规则、摘要模板、文件累积与用量计入，不取分支与钩子。
- 照搬 Claude 式全程可读摘要加 microcompaction — 透明且手动压体验好；方向一致，本 Note 的可读明文即取此意，只是 microcompaction 的早期卸载机制留后。
- Do nothing / reuse — 维持截断加 digest，零成本；代价是长会话可靠性随长度单调下降，多线与验收门的上层设计全部建在沙上。

## Acceptance criteria

- [ ] 长会话超阈值时自动压一次，压后上下文只含一版 summary、一段 digest、一段 tail 原文，旧 summary 不堆积。
- [ ] 压后 `workspace.edit` 仍可用 digest 中的 sha 通过 `expectedHash` 校验，LLM 摘要正文不得改写任何 sha 与 path。
- [ ] 手动 `/compact` 可在任务边界触发，`auto=false` 时仍可用；CLI 侧解析、补全、帮助文本可用，忙时排队、失败放行 pending。
- [ ] 切分永不从 `tool` 结果中间切断，大单 turn 切到 `assistant` 处时前缀信息进入摘要而非丢失。
- [ ] 指令类规则不依赖摘要存活，压后行为与压前一致。
- [ ] 已知模型按内置表解析出窗口并触发，未知模型回落保守值且状态处明示为估算值，给出覆盖方式。
- [ ] `typecheck` 与 chat-core 相关单测全绿，阈值配置超硬顶时被钳制而非溢出。

## Risks

- LLM 改写 sha 导致 edit 冲突 — digest 轨代码侧原样拼接承担，单测锁定摘要层碰不到 `fileRefs`。
- 压后重读引发压缩雪崩 — 首版不做自动重读 5 文件承担，evidence 按预算重建，阈值只许调早。
- 摘要被提示注入污染 — 摘要只作 user-role handoff、不给写权限提升承担，敏感路径仍走 `policy-gate`。
- 压缩本身烧 token — 阈值、工具输出上限、任务边界手动压三层承担，长任务分段而非单会话到底。
- 内置表 stale（provider 单方面改窗口、新模型缺条目） — 只许保守偏小、提前 `buffer` 触发、overflow 重试兜底承担，发版脚本定期重拉，不做运行时探测。
