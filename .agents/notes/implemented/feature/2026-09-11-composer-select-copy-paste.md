# Agent Note: 输入框键盘选中与复制粘贴

Status: implemented

## Problem

TUI 输入框里的文本拿不出来。Ink 全屏接管键盘，SGR 鼠标上报让终端原生框选失效，Composer 没有选区模型，Ctrl+C 被清屏与中断占用，复制没有落点。粘贴只有单向的终端原生写入可用。长输入无法复用与改写，输入成本随长度线性上升。

## Decision

选区模型收敛在 `packages/cli/src/tui/composer-state.ts`。`selectionRange`、`selectedText`、`deleteSelection`、`replaceSelection` 是纯函数，单位与光标一致，空选区时删除与替换退化为普通删除与插入。`sliceAroundCursorEx` 在原窗口逻辑上追加起点与省略号标记，原 `sliceAroundCursor` 委托于它，行为不变。`expandTabsWithMap` 记录每个绘制字符的原料偏移，`rowSelectionSpan` 把 buffer 选区映射到可见行，`splitSelectedText` 拆出高亮三段，窗口标记与补齐空格永不参与高亮。

剪贴板收敛在 `packages/cli/src/tui/clipboard.ts`。`copy` 常写应用内回退缓冲，保证剪切粘贴在任何终端可用；在 live TTY 上追加 OSC52 系统复制，零依赖零子进程，超 100KB 或写入失败时静默降级。`paste` 只读应用内缓冲，系统级粘贴继续走终端原生 stdin 文本，不经过该模块。

按键归属收敛在 `packages/cli/src/tui/Composer.tsx`，copy-vs-interrupt 在同一个 handler 内裁决。Shift 加方向键、Home、End 从光标处起扩展选区，边缘行扩展到缓冲端点，不触发输入历史回溯。无修饰的方向键收拢选区后移动，左键落到起点，右键落到终点。Esc 清除选区，补全弹窗优先消费 Esc。退格、删除、换行、Tab、输入与粘贴文本替换选区。Ctrl+A 全选。有选区时 Ctrl+C 复制并清除选区，无选区时走 `onInterrupt`，语义与过去的清屏、中断、1 秒内双击退出完全一致。Ctrl+X 剪切，Ctrl+V 粘贴应用内缓冲。`App` 只在 Composer 失活时处理 Ctrl+C，判定条件与 `disabled` 同源，不依赖 handler 注册顺序。任何复制、剪切、粘贴、全选手势清除双击退出窗口，复制后紧跟的 Ctrl+C 回到中断语义。选中行沿用补全弹窗的选中底色。

快捷键记录在 `/help` 的 Keys 行，与终端原生粘贴并存说明。

## Alternatives considered

- 纯原生鼠标框选加 `JANUS_NO_MOUSE=1` 逃生口 — 零新增代码，逃生口已经存在；但全屏 alt-screen 没有 scrollback，各终端对上报模式的框选行为不一，键盘用户依然没有复制手段，SSH 与 ConPTY 下残缺依旧。
- 用子进程读写真系统剪贴板 — 双向都是真系统剪贴板；但引入平台命令探测与同步子进程阻塞 UI 的风险，OSC52 已覆盖 Windows Terminal、VS Code 与主流 xterm 系，成本超出收益。
- Ctrl+C 保持中断、另设复制键 — 零冲突；但可发现性差，用户直觉就是 Ctrl+C，选中态下中断输入本就没有意义，冲突让位给复制更符合预期。
- 运行时鼠标上报开关 — 滚轮与原生框选可切换，看似两全；但引入模式状态，关闭期间滚轮丢失，键盘方案已覆盖输入框场景，徒增心智负担。
- Do nothing / reuse — 维持终端原生粘贴单向可用，零成本；代价是框内文本永远拿不出来，问题原文的诉求无解。

## Consequences

- **Gains**: 输入框文本可选中、可复制、可剪切、可粘贴，有选区 Ctrl+C 复制，无选区行为与过去一致，中断与双击退出不受影响。守卫为 `npx tsc --noEmit` 加 `npx vitest run`（均在 `packages/cli`，31 文件 278 用例全过，新增 24：纯逻辑 18、Composer 交互 6）。
- **Costs and limits**: 粘贴读不到系统剪贴板，只能粘贴应用内复制的内容，系统粘贴走终端原生；OSC52 超 100KB、非 TTY 或终端不支持时只留应用内缓冲；Shift 加方向键依赖终端发送修饰序列；复制后清除选区，连续 Ctrl+C 的第二次是中断不是再复制；讨论区文本仍不可框选，受 alt-screen 限制。当讨论区复制、真系统粘贴读取或鼠标框选出现真实需求时重访本决策。
