# Agent Note: Checkpoint 驱动的改动 diff 卡

Status: implemented

## Problem

改动展示与落盘事实脱节。直播层（`packages/cli/src/tool-display.ts`）回显模型发出的 `args`，属于意图而非落盘事实。校验层（`packages/cli/src/trace-preview.ts`）取 `git diff` 累计值：非仓库与无 git 环境退化为 summary-only，同 turn 多改同一文件时多张卡片贴出同一份累计 diff，归因错误。审批框仅凭 summary/paths/detail 做判断，审批者批的是描述而非字节。与此同时每次 `workspace.edit/create/delete` 都已产出本次调用的精确字节与 `checkpointId`，展示层均未使用。

## Decision

改动卡展示本次调用验证过的字节，fallback 链按 per-call diff → `git diff` → args 意图 → summary 取内容。`packages/agent-core/src/main/agent/runtime/tools/workspace-tools.ts` 在提交后为输出附上有界 `diffPreview`（`replacements` 按 replacement 分 hunk，`unifiedDiff` 原样回显，create 按新文件行加 `+` 前缀，delete 在提交前读取被删文件字节），源上限 256KB、预览上限 4000 字符并携带 `diffTruncated`，超限时省略预览使卡片回落到 summary。`packages/agent-core/src/main/agent/runtime/tool-result.ts` 把 `diffPreview` 与 `diffTruncated` 挡在模型负载之外，展示资产只走 trace 与 UI。`packages/chat-core/src/main/llm/chat-pure.ts` 与 `packages/chat-core/src/shared/ipc/llm.ts` 把 `diffPreview`、`diffTruncated`、`checkpointId` 送进 `ChatToolTraceEntry`，回放 summary 保持原样。`packages/cli/src/tool-display.ts` 的直播卡与 `packages/cli/src/trace-preview.ts` 的 post-turn 卡优先渲染 per-call diff，沿用 `formatDiff` 版式（24 行截断、`@@` 行号、`(+a -d)` 尾行），卡片头统一为 `path · (+a -d) · checkpoint <短id>`（`summarizeCallDiff` 是唯一归一处），trace 卡末端追加 `checkpoint <短id> · 可撤销`。`packages/cli/src/tui/store.ts` 把 `checkpointId` 随预览贴到 `toolCheckpointId`。审批 `preview.detail`（`packages/agent-core/src/main/agent/chat-tools/workspace-chat-tools.ts`）携带同源的有界 unified diff（edit 按 replacement 分 hunk，create 按新文件行），上限 4000 字符并置 `truncated` 标记，TUI 与纯终端审批框分别截断 8 行展示。纯终端 turn 内直播输出保持 6 行截断，post-turn 预览复用同一 `buildTracePreviews` 数据。词级高亮与语法着色不做，行级着色已满足。

## Alternatives considered

- 维持 git-diff 主路径并补非仓库分支 — 改动最小，但累计值归因错误仍在，同文件多改场景无从修复，故 git 只保留为外部改动的 fallback。
- 全量 codex/opencode 式展示（含词级高亮、语法着色） — 观感最接近两家，但 Ink 全量重排成本高，且与 janus 审计定位无关，故只吸收头行统计、分层展开与审批即所见三项。
- 按 call 回读 checkpoint blob 快照再算 diff — 快照最权威，但每次展示增加一次有界存储读取；本次调用的输入字节在提交时已在手，渲染应用字节零读取且永不阻断 turn，故采用应用字节直渲染，checkpoint 只承担可逆链接。
- Do nothing / reuse — 零代码，但展示与落盘事实持续脱节，审批维持批描述，checkpoint 资产在终端不可见。

## Consequences

- **Gains**: 非仓库改动渲染真实 diff，不再退化为 summary-only；同 turn 多改同一文件时每张卡片归因各自字节；审批框在写入前呈现有界 unified diff；大文件按行数与字节封顶并回落 summary（`packages/cli/src/trace-preview.ts`，`packages/agent-core/src/main/agent/runtime/tools/workspace-tools.ts`；`npm run test --workspace=@janus-agent/agent-core -- --run tests/tool-result.test.ts tests/workspace-tools.test.ts tests/workspace-chat-tools.test.ts`，`npm run test --workspace=@janus-agent/chat-core -- --run tests/smoke.test.ts`，`npm run test --workspace=@janus-agent/cli -- --run tests/tool-display.test.ts tests/tui-trace-preview.test.ts` 全过）。
- **Costs and limits**: 展开仍只有全局 `toolsExpanded`，无单卡展开状态，多卡同屏时须整体展开；卡片尾只有可撤销文案而无 `/restore`  slash 命令，回滚走既有 checkpoint 通道；delete 审批仍是 summary 加作用域描述（字节在执行后才可知，执行后卡片补删除 diff）；超限审批展示有界 diff 加截断标记而非纯 summary 回落。任一超限或读取失败都静默降级，展示永不阻断 turn。
