# Agent Note: 输入框原生鼠标框选模式与降暗选中色

Status: implemented

## Problem

输入框文本鼠标拖不动。SGR 鼠标上报把点击与拖拽交给应用做滚轮滚动，终端原生框选就此失效，框内文本只能走键盘选中复制。鼠标用户没有对等的拿出文本的手段。

## Decision

框选模式收敛在 `App` 的 Ctrl+B 开关，进模式即释放鼠标上报。`scroll.ts` 新增暂停语义，`setMouseCaptureSuspended` 写上报开关并立标记，2 秒恢复计时器在暂停期间跳过重申，teardown 清标记，计时器与开关永不打架。释放期间终端全权接管鼠标，普通拖拽即框选，终端自有复制进真系统剪贴板，粘贴走原生 stdin。草稿与全部键盘流程保持可用，滚轮暂退为 PgUp、PgDn 与 Ctrl 加方向键。`JANUS_NO_MOUSE=1` 下上报本就关闭，开关短路为一句提示。

键归属以护草稿为先。模式内 Ctrl+C 只退出模式，从不清空草稿与中断 turn，因为用户此时按下它几乎都是复制意图。Esc 退出模式，Ctrl+B 复按退出。`Composer` 经 `selectModeActive` 交出 Ctrl+C，子 handler 先触发，无选中也会走到中断回调，不显式让位就会在 `App` 之前误删草稿。其他剪贴键在模式内照常作用于键盘选区。

模式可见性收敛在页脚与 `/help`。右栏徽标 `框选·Esc退出`，忘记退出时常驻提醒。左栏 full 档追加 `[Ctrl+B] 框选`，窄终端按既有分档回落。`/help` 的 Keys 行同步开关、退出键与复制方式。

选中色单独降暗。`TUI_CHROME` 新增 `selectionBg`，比行拾取的 `selectBg` 低一档，行拾取与文本标记是两种 affordance，不共用。Composer 文本高亮改用它，正文色保留，对比足够认出选中范围，又不形成亮带。补全弹窗选中行沿用 `selectBg`。

## Alternatives considered

- 应用内拖拽加 CPR 定位 — 橡皮筋高亮体验最好，选中直接进 OSC52；但 Ink 只暴露相对坐标，终端绝对原点要靠 CPR 往返推算，每次几何变化都要重问，ConPTY、tmux 与 VS Code 时序各异，脆弱性超出输入框场景。
- 只文档化 Shift 加拖拽旁路 — 零代码；但各终端行为不一，没被发现等于不存在，显式开关才是可验证的能力。
- 常驻关闭上报 — 原生框选恒可用；但滚轮滚动永久丢失，讨论区回看退回纯键盘，得不偿失。
- Alt 组合或 F 键做开关 — F 键可发现性差，Alt 组合跨终端脆弱，Ctrl 加字母里 Ctrl+B 无冲突又好记。
- Do nothing / reuse — 键盘选中已经可用，零成本；代价是鼠标用户依然框不动，本轮诉求无解。

## Consequences

- **Gains**: 输入框与讨论区可原生拖拽框选，复制进真系统剪贴板，键盘选中高亮降暗。守卫为 `npx tsc --noEmit` 加 `npx vitest run`（均在 `packages/cli`，32 文件 283 用例全过，新增 5：暂停语义 2、App 开关 2、Composer 让位 1）。
- **Costs and limits**: 模式内滚轮失效，只剩键盘滚动；原生选中色归终端主题所有，应用侧只降暗自有键盘高亮；模式需手动进出，徽标是唯一的防忘提醒；粘贴仍走终端原生。当渲染方案暴露点击坐标、框选成为高频动作或用户要求自动进出时重访本决策。

本决策被部分取代，见 [2026-09-11-composer-native-select-default](./2026-09-11-composer-native-select-default.md)（上报改默认关闭，暂停语义与 Ctrl+B 开关退役，降暗选中色继续有效，两边互链）。
