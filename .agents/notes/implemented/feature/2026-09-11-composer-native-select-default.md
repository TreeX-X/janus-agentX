# Agent Note: 输入框约束选择默认启用，原生框选显式退出

Status: implemented

## Problem

终端原生框选按屏幕单元格取字，不认识输入框边界。用户拖选输入内容时，边框、提示符和框外文字都可能进入剪贴板。应用已有约束拖拽，但要求手动开启鼠标上报会让默认使用路径继续复制框线。

## Decision

`scroll.ts` 的 `shouldCaptureMouse` 默认开启鼠标接管，让普通拖拽直接进入[输入框约束选择](./2026-09-11-composer-drag-select-constrained.md)，滚轮负责历史滚动。`App` 的挂载、拖拽路由和坐标回显处理共用这个谓词；只有真实 TTY 写入上报字节，卸载时恢复终端鼠标模式。

`JANUS_MOUSE=0` 或 `JANUS_NO_MOUSE=1` 显式交还鼠标给终端，后者在与 `JANUS_MOUSE=1` 冲突时优先。原生框选可选择讨论区，但也会复制框线；这个模式没有输入空间约束，滚动使用 PgUp、PgDn 与 Ctrl 加方向键。支持原生鼠标旁路的终端也可使用 Shift 加拖拽选择输出。tmux 接管需要 `mouse on`。

键盘选中使用既有选区模型与 `selectionBg`。运行中没有 Ctrl+B 模式切换和暂停计时器，`/help` 说明默认行为及原生选择入口。

文本选中色的取舍见[框选模式与降暗高亮](./2026-09-11-composer-mouse-select-mode.md)；鼠标默认值和退出条件以本文为准。

## Alternatives considered

- 保持现状、复用默认原生选择：无需应用坐标映射，讨论区复制也可直接使用；终端不能从选区剔除边框和提示符，因此无法满足输入范围约束。
- 按手势自动释放鼠标：可以保留终端复制体验；终端若没有收到按下事件，就无法接续当前选择，释放上报后应用又收不到松开，恢复时机只能猜测。
- 默认复用应用约束拖拽：已有选区、坐标映射和剪贴板实现，复制内容来自输入缓冲；代价是终端原生框选必须走显式旁路。本实现选择此项，使默认路径满足输入边界要求。

## Consequences

默认使用者无需设置环境变量即可拖选干净的输入文本。`packages/cli/tests/tui-scroll.test.ts` 覆盖默认值、两个退出变量及冲突优先级；`tui-scroll-wheel.test.tsx` 覆盖真实 TTY 接管与卸载恢复；`tui-mouse-drag.test.tsx` 覆盖默认复制和两个退出入口。完整验证命令为 `npm run typecheck --workspace @janus-agent/cli` 与 `npm run test --workspace @janus-agent/cli`。

应用接管期间，讨论区普通拖拽不会创建选区。Shift 旁路取决于终端，显式退出则放弃输入边界约束。坐标查询与系统剪贴板的终端支持限制见约束选择记录；若讨论区需要默认应用内复制，应单独评估渲染行到原文的映射。
