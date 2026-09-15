# Agent Note: TUI 长行换行显示全文

Status: implemented

## Problem

待办展开态与 ask_user 选项面板对超长文本做单行截断（`truncateToWidth` 收尾加省略号），选项 label 与 description 拼成一行后更容易超宽。待办内容模型侧允许 200 字符，面板宽度却固定 56/76 格，被截掉的部分没有任何入口可以查看，中文（双倍 cell）更容易触发，用户看不全选项内容就只能凭猜选择。

## Decision

只读长行改用新增的 `wrapToWidth`（`packages/cli/src/tui/composer-state.ts`）按终端 cell 宽度换行：单词优先不断词，超长词与 CJK 按字断，保留原有换行，不丢字。`packages/cli/src/tui/palette.tsx` 新增 `WrappedRow` 承载序号前缀加悬挂缩进加选中整块高亮。Todo 展开态（`TodoStickyBar`）与选项面板（`QuestionPanel`，含问题文本、选项、自定义行）全部经由它渲染全文；面板宽度由 App 传入实时 `discW`，替代写死的固定值。折叠态待办摘要保持单行截断，那是标题栏语义，展开即见全文。

## Alternatives considered

- Ink 原生自动换行：零代码；但选中行的背景高亮只覆盖文字宽度而非整行，且做不出悬挂缩进，长选项的可读性与选中态一致性都差，故拒绝。
- 保留截断另加按键查看全文：交互最重；待办与选项都是高频扫读界面，多一步操作即多一份打断，故拒绝。
- Do nothing / reuse：维持现状；代价是用户持续看不全选项内容，误选风险一直存在，故拒绝。

## Consequences

- **Gains**: 超长待办与选项在 TUI 显示全文，无省略号；选中长选项时多行整块高亮，首尾文字可读。`packages/cli/tests/tui-composer-state.test.ts` 锁定换行规则，`packages/cli/tests/tui-wrap.test.tsx` 用真实 Ink 帧锁定长选项无截断。
- **Costs and limits**: 超长列表占用更多行数，长待办清单加长选项同时出现时讨论区上滚更快；回看信号是用户抱怨面板过高，届时给展开态加最大行数加滚动。`/model`、`/provider` 等小面板仍是 60 格截断，同病根但本次未动，后续沿 `WrappedRow` 跟进。
