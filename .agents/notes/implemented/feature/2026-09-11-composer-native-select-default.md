# Agent Note: 默认原生鼠标框选，上报改手动开启

Status: implemented

## Problem

输入框文本平时鼠标拖不动。应用常驻 SGR 鼠标上报，把拖拽交给滚轮滚动，终端原生框选就此失效。上一轮给的是 Ctrl+B 框选模式，进模式才释放上报，不按键就框不动，默认行为依然是错的。

## Decision

上报改手动开启，默认终端全权拥有鼠标。`scroll.ts` 新增 `shouldCaptureMouse`，只有 `JANUS_MOUSE=1` 才接管，`JANUS_NO_MOUSE=1` 继续强制关闭并在冲突时获胜。`App` 的上报 effect 只看这一个谓词。默认挂载不写任何模式字节，普通拖拽即框选，复制粘贴全走终端原生，滚轮回退到 PgUp、PgDn 与 Ctrl 加方向键。`JANUS_MOUSE=1` 下恢复过去的行为，tmux 照旧需要 `mouse on`。

Ctrl+B 框选模式整体退役。暂停标记与开关随模式一起删除，`App` 的模式状态、徽标、左栏提示与三处按键接管全部还原，`Composer` 的 `selectModeActive` 让位一并删除。点击事件本来就被吞掉不上报后行为不变，滚轮字节解析保留，给手动开启留路。

键盘选中与降暗高亮不受影响，沿用上一轮的选区模型与 `selectionBg`。`/help` 重写鼠标行，默认框选与滚轮开启各一句话。

本决策部分取代框选模式，见 [2026-09-11-composer-mouse-select-mode](./2026-09-11-composer-mouse-select-mode.md)（暂停语义与开关退役，降暗选中色继续有效，两边互链）。

## Alternatives considered

- 保留模式改自动进出 — 按下左键自动释放、按键自动收回；但释放后收不到松开事件，只能靠计时器猜，误收回会打断正在进行的框选，不可验证的时序不值得赌。
- 应用内拖拽加 CPR 定位 — 橡皮筋体验最好；但 Ink 不暴露终端绝对原点，每次几何变化都要往返问询，跨终端脆弱，结论与上一轮一致。
- 常驻上报加 Shift 拖拽旁路 — 零代码；但旁路各终端不一且无人发现，默认行为仍错，方向反了。
- Do nothing / reuse — 留着 Ctrl+B 模式，零成本；代价是默认框不动，本轮诉求无解。

## Consequences

- **Gains**: 平时直接拖拽框选，零按键零模式；滚轮用户设一个环境变量即回。守卫为 `npx tsc --noEmit` 加 `npx vitest run`（均在 `packages/cli`，全过；上报默认关闭与 `JANUS_MOUSE=1` 接管各有 App 级用例）。
- **Costs and limits**: 默认无滚轮，只有键盘滚动；`JANUS_MOUSE=1` 与原生框选互斥，开滚轮即回上报； discussion 区原生选中色归终端主题。当终端普遍支持免上报滚轮或渲染方案暴露点击坐标时重访本决策。
