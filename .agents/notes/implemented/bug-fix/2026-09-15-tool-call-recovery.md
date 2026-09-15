# Agent Note: 流式工具调用失败回灌而非杀死整轮

Status: implemented

## Problem

模型输出未知工具名、schema 非法参数、畸形或截断 JSON 时，`vercel-stream-adapter` 的 `completeToolCall` 直接抛错杀死整轮 `stream`，错误冒泡至 `runChatTurn` 终结整个 turn。单次手滑的成本是一整轮模型往返，而同类错误中 `ask_user` 参数错走 `isError` 回灌自愈。两种命运下解析失败的重试成本是参数错的数倍，打包发版类多步任务的期望轮次持续超预算。

## Decision

`ToolCallAccumulator.complete` 返回结构化失败分类（`missing-name`、`json`、`missing-arguments`、`validation`、`too_large`），附畸形原文前 300 字预览；schema 非法但 JSON 合法的调用保留已解析参数透传。`vercel-stream-adapter` 把失败装配成带 `validationError` 的合成调用，随正常 `tool_call_ready` 进入 loop；`janus-agent-loop` 的 `execute` 对该标记短路为 `isError` 工具消息，不执行任何工具。截断形残 JSON（尾部非闭合括号）单独给出缩小参数重试指引，不与普通语法错混同。空 `argsTextDelta` 不再产生 `tool_call_update` 事件；单调用拼接超过 2M 字符 fail-closed 为 `too_large`。

## Alternatives considered

- 保持抛错即死，由上层重试整轮：最强理由是零新增类型与通道；否决驱动是整轮重试烧掉已流式正文且 R5 门控本就禁止有进度重试，失败仍终结 turn。
- 模糊 JSON 修复（补括号、单引号转义）：最强理由是省下重试轮次；否决驱动是静默改写模型原意，且与 `2026-09-13-tool-failure-recovery` 精确匹配决策冲突，已有事故在案。
- 新增专用 `invalid_tool_call` 执行工具：最强理由是通道显式；否决驱动是新增工具面常驻 prompt，且 `tool` 消息配对已满足回灌需求，零工具面增长更划算。
- Do nothing / reuse：零代码；代价是每次括号失衡与截断继续烧整轮，Windows 长参数任务复现 deterministic。

## Consequences

- **Gains**: 四类裸错当轮转为可操作工具消息，配对约束完整，下一轮模型直接重试；截断不再被误分类为参数错；空 delta 自旋与无界拼接退出。
- **Costs and limits**: `JanusToolCall` 新增可选 `validationError` 字段，`toVercelMessages` 忽略该字段；JSON 非法的调用以 `{}` 占位进入配对，字段级细节由文案承担。超大合法单调用（>2M 字符流式参数）被拒，重访信号为该上限的命中率。
- **Verification**: `npm run typecheck --workspace=@janus-agent/agent-core` 通过；`npm run test --workspace=@janus-agent/agent-core` 19 文件 275 通过、1 跳过（既有跳过）；`R5: does not retry INVALID_TOOL_CALL` 旧断言按新契约更新为回灌断言。
