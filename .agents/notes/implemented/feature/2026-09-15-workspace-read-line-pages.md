# Agent Note: workspace.read 行号分页

Status: implemented

## Problem

`workspace.read` 按字节偏移分页，描述只有一句话，参数没有用途说明，返回没有下一页游标。大文件默认调用每次都落回同一段开头，模型没有可抄的继续调用，只能重复读开头或猜字节偏移，而字节偏移在 UTF-8 裁剪下还会漂移。放任不管，每个大文件任务都烧掉多轮往返在重复的头部内容上，超长文件则根本不可达。

## Decision

输入按 1 起始的行号分页：`offset` 为起始行（默认 1，`0` 宽容为 1），`limit` 为最多行数（默认 200，上限 2000），`maxBytes` 为页面字节上限（默认 16KB，运行时上限 1MB，聊天 schema 上限 256KB），字节上限优先于行数上限。schema 每个参数都带用途描述，工具描述直接写明默认页大小与 `nextOffset` 续读规则。

输出携带 `lineStart/lineEnd/totalLines/nextOffset/guidance`，只要还有剩余行 `truncated` 即为真，`guidance` 写出可直接执行的下一调用。模型载荷保留完整页及其游标，不能在上下文层截断正文后沿用原游标。`offset` 越界报错直接给出总行数，`limit` 为 0 直接拒绝，单行超字节上限指引更大的 `maxBytes` 重读，超 16MB 整读上限指引收敛到该文件的 `workspace.search` 定位。

上下文层按行键存元数据，摘要保留 `Lx-y/z`。正文去重、超预算时的明确省略和重读规则见[证据完整性](../bug-fix/2026-09-16-agent-context-search-efficiency.md)。系统提示写明正常页的 `truncated:true` 按 `nextOffset` 续读；`outputOmitted` 则从同一起点缩小范围重读。

## Alternatives considered

- Do nothing / reuse：零代码；代价是每个大文件确定性地循环读头，字节与行号的混淆在每次调用重现。
- 保留字节分页只补文档：最强理由是零 schema 扰动。否决驱动是模型默认按行思考，UTF-8 边界裁剪仍让字节累加漂移，文档救不了算术。
- 流式早停（opencode 式换行快进，工作量正比于 offset+limit）：最强理由是巨型文件按页成本有界。否决驱动是 16MB 上限已约束整读成本，且编辑哈希本来就需要全文件；超 16MB 日志需要分页时重访。
- 单行 2000 字符截断：最强理由是单行压缩文件的上下文安全。否决驱动是截断行误导精确匹配编辑；字节上限加更大的 `maxBytes` 重试已覆盖该情形。

## Consequences

- **Gains**: 整页步进可达文件尾（三页走到 EOF 有单测覆盖）；越界与零 limit 当轮按报错文本自纠；证据头与摘要在压缩后仍保留页位置。
- **Costs and limits**: 每页整读至多 16MB 文件，无早停；CRLF 文件返回 LF 连接的内容（编辑侧归一化行尾，匹配不受影响）；超 16MB 文件仍不可整读，定位走收敛搜索；默认页 200 行或 16KB，长行文件需要更多分页。
- **Verification**: 全仓 5 包 `npm run typecheck` 通过；`@janus-agent/agent-core` 269 通过 1 跳过；`@janus-agent/chat-core` 50 通过；`@janus-agent/janus-agent` 16 通过；`@janus-agent/node-hosts` 33 通过；`@janus-agent/cli` 334 通过、1 失败为 HEAD 已有失败（`tui-app` 文件预览标题，在干净 HEAD worktree 同样复现，与本次改动无关）。
