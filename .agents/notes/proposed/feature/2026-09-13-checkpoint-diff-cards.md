# Agent Note: Checkpoint 驱动的改动 diff 卡

Status: proposed

## Problem

改动展示存在三处脱节。直播层（`packages/cli/src/tool-display.ts`）回显模型发出的 `args`，属于意图而非落盘事实。校验层（`packages/cli/src/trace-preview.ts`）调 `git diff` 取累计值：非仓库与无 git 环境退化为 summary-only，同 turn 多改同一文件时多张卡片贴出同一份累计 diff，归因错误。审批框（`packages/cli/src/repl.ts`）仅有 summary/paths/detail，审批者批的是描述而非字节。与此同时每次 `workspace.edit` 已产出改前改后全文、`previousHash→sha256` 与 `checkpointId`（`packages/agent-core/src/main/agent/runtime/file-transaction.ts`、`packages/agent-core/src/main/agent/runtime/tools/workspace-tools.ts`），展示层均未使用。

## Proposal

改动卡收敛为“可验证 diff 加一键可逆 checkpoint”：fallback 链按 `checkpoint 快照 diff → git diff → args 意图 → summary` 取展示内容，checkpoint 分支沿用现有 `formatDiff` 版式（24 行截断、`@@` 行号、`(+a -d)` 尾行）。卡片头统一为 `path · (+a -d) · checkpoint <短id>`，末端接 `/restore` 可撤销语义。审批 `preview.detail` 携带同一来源的有界 unified diff，使写入前审批精确到字节。展开沿用现有全局 `toolsExpanded` 并增补单卡展开状态，REPL 纯终端模式保持 6 行截断对齐。词级高亮与语法着色不做，行级着色已满足。

## Alternatives considered

- 维持 git-diff 主路径并补非仓库分支 — 改动更小；但累计值归因错误仍在，多改同一文件场景无从修复，故只保留 git 作为外部改动的 fallback。
- 全量 codex/opencode 式展示（含词级高亮、语法着色） — 观感最接近两家；但 Ink 全量重排成本高，且与 janus 审计定位无关，故只吸收其头行统计、分层展开与审批即所见三项。
- Do nothing / reuse — 零代码；代价是展示与落盘事实持续脱节，审批维持“批描述”，checkpoint 资产在终端不可见。

## Acceptance criteria

- 非仓库改动渲染真实 diff，不再退化为 summary-only。
- 同 turn 多改同一文件时每张卡片归因各自 before/after。
- 审批框呈现有界 unified diff，超限回落 summary。
- 大文件 diff 行数封顶，超限回落 summary。

## Risks

- checkpoint 快照存于 blob store，按 call 取镜像增加一次有界读取；失败时静默降级到 git 分支，展示永不阻断 turn。
- diff 算法 operates on in-memory 全文，须设行数与字节上限后计算。
