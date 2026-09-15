# Agent Note: 上下文效率：工具冻结、prune 档与推理用量

Status: implemented

## Problem

同等任务 janus 的 token 消耗显著高于对标：工具数组每轮按 registry 顺序装配，顺序抖动即打掉 provider prompt-cache 前缀；`usage` 只透传 prompt/completion，思考模型的推理 token 被丢弃，预算长期低估；`chat-session-runtime` 只有 6k/4k 截断而无 prune，长会话里 40k 之前的旧 `tool_output` 全文保留，每轮重读；工具执行失败后模型把 2k 错误 blob 再读一遍盲重试同一调用，白烧一轮；`command.run` 的阈值语义挤在 700 字单句 description 里，又长又难命中。

## Decision

工具顺序冻结：`chat-turn` 对 registry manifests 按 `providerName` 排序后装配，`activeToolManifests` 经 `Object.freeze` 定形，`modelTools` 按排序键重建（本地 `todo_write`/`ask_user` 恒居末尾）；`system-prompt-builder` 同样排序后渲染，双通道前缀跨轮稳定，`SystemPromptBuilderInput.toolManifests` 放宽为 `readonly`。

用量含推理 token：`AgentUsage` 新增可选 `reasoningTokens`，`vercel-stream-adapter` 同时接受 prompt/completion 与 input/output 两种形状并透传推理数，`model-stream` 与 `model-compat` 同步保留，`ports` 契约、`tool-display` 事件、`tui/store` 的 turn/session 累计跟进（展示仍为 in/out，推理数只进预算账本）。

prune 档：`buildContext` 在确定性裁剪之上增加按尾预算的 prune——最新约 40k tokens（`pruneKeepTokens` 可调，下限 4k，默认远大于 system+tools）内旧输出保持原文，超出部分保留 assistant `tool_call`、以 digest 占位符替换 `tool_output` 正文；`dropped` 单元仍走原有精确 digest handoff。tail 截断统一为 2000 字（`MAX_TOOL_CONTENT/MESSAGE_CHARS` 均收至 2k），`LoadedEvidence` 单文件 6k 收至 4k，stored summary 8k 收至 6k。短会话（窗口 < prune 尾）行为零变化。

失败修复 follow-up：`getFollowUpMessages` 在一次性 todo nudge 之后追加一次性修复提示——有 `failed`/`timed-out` 类 trace 且本轮无工具调用时，指引模型读错误文本、修参数后重试一次，不重复同一失败调用；`denied`/`cancelled` 明确排除（拒后停手，沿用既有约定）。`command.run` 的运行时 description 拆成短句，120s/600s/60s 后台阈值语义逐字保留；面向模型的长描述保留 env 白名单自愈细节不动。

## Alternatives considered

- 会话树改历史格式（pi 式 JSONL 分支）：最强理由是 prune 粒度最细且可回溯；否决驱动是改持久化格式与 hydrate 路径，风险远高于 opencode 式输出占位，延后到 P2 之后重访。
- 推理 token 并入 completion 上报：最强理由是零类型改动、下游求和不变；否决驱动是并入后无法区分思考占比，预算仍是糊涂账，显式字段更诚实，展示层忽略即可。
- prune 阈值固定 40k 不可调：最强理由是少一个选项；否决驱动是长短会话窗口差异大，小窗调试需要可复现的小阈值（测试即用 4k 覆盖），`keep.tokens` 可调是总账明示要求。
- 失败 nudge 每次失败都发（非一次性）：最强理由是覆盖连续失败；否决驱动是模型若执意盲重试，每轮一 nudge 即烧一轮，烧钱上限应由 `CHAT_MAX_STEPS` 承担而非 nudge 次数。
- Do nothing / reuse：零代码；代价是缓存前缀每轮抖动、推理占比越高的模型低估越狠、长会话稳定陷入 compact 循环。

## Consequences

- **Gains**: 工具前缀跨轮字节稳定，cache 亲和可测；思考模型用量不再系统性低估；长会话旧输出占位、调用保留，可继续多轮而不进 compact 循环；可修复失败最多花一轮修复提示而非盲重试；`command.run` 描述短句化。
- **Costs and limits**: `AgentUsage`、`SystemPromptBuilderInput`、`ChatContextBuildOptions`、`CliDisplayEvent`、`TuiState` 各增可选/累计字段，均为加法兼容；prune 占位符要求模型按 digest 重读，极端依赖旧原文逐字的任务多一次重读；`command.run` 面向模型描述未动，token 大头仍在。
- **Verification**: `typecheck` 五包全绿（agent-core、chat-core、janus-agent、cli、node-hosts）；`chat-core` 54 通过（含 prune/2k-tail/排序 4 例新增）；`agent-core` 277 通过 1 跳过（含推理透传 2 例新增）；`janus-agent` 20 通过（含修复 nudge/deny 排除 2 例新增）；`node-hosts` 33 通过；`cli` 343 通过、1 失败为 HEAD 已有失败（`tui-app` 文件预览标题旧断言，`checkpoint` 新格式 vs `sha256=` 旧期望，与本次改动无关）。
