# Agent Note: 输入框键盘选中与复制粘贴

Status: implemented

## Problem

TUI 输入框里的文本拿不出来。Ink 全屏接管键盘，SGR 鼠标上报让终端原生框选失效，Composer 没有选区模型，Ctrl+C 被清屏与中断占用，复制没有落点。粘贴只有单向的终端原生写入可用。长输入无法复用与改写，输入成本随长度线性上升。

## Decision

选区模型收敛在 `packages/cli/src/tui/composer-state.ts`。`selectionRange`、`selectedText`、`deleteSelection`、`replaceSelection` 是纯函数，单位与光标一致，空选区时删除与替换退化为普通删除与插入。`sliceAroundCursorEx` 在原窗口逻辑上追加起点与省略号标记，原 `sliceAroundCursor` 委托于它，行为不变。`expandTabsWithMap` 记录每个绘制字符的原料偏移，`rowSelectionSpan` 把 buffer 选区映射到可见行，`splitSelectedText` 拆出高亮三段，窗口标记与补齐空格永不参与高亮。

剪贴板集中在 `packages/cli/src/tui/clipboard.ts`。`copy` 总是写应用内回退缓冲。在本机 Windows 的真实标准输出上，应用使用系统 PowerShell 的 `Set-Clipboard` 写系统剪贴板，因为 JanusX 内置 xterm 没有 OSC52 处理器，而宿主 Ctrl+V 读取系统剪贴板。命令固定、禁用用户配置、窗口隐藏，文本以 UTF-8 的 Base64 从标准输入传入，不拼入命令。执行超时为 2 秒，失败后回退 OSC52 请求。SSH 会话、其他平台及自定义输出流使用 OSC52，由宿主决定是否接受；非 TTY 和超过 100KB 的内容只存应用缓冲。`paste` 只读应用内缓冲，终端原生粘贴通过 stdin 传入。

按键归属收敛在 `packages/cli/src/tui/Composer.tsx`，copy-vs-interrupt 在同一个 handler 内裁决。Shift 加方向键、Home、End 从光标处起扩展选区，边缘行扩展到缓冲端点，不触发输入历史回溯。无修饰的方向键收拢选区后移动，左键落到起点，右键落到终点。Esc 清除选区，补全弹窗优先消费 Esc。退格、删除、换行、Tab、输入与粘贴文本替换选区。Ctrl+A 全选。有选区时 Ctrl+C 复制并清除选区，无选区时走 `onInterrupt`，语义与过去的清屏、中断、1 秒内双击退出完全一致。Ctrl+X 剪切，Ctrl+V 粘贴应用内缓冲。`App` 只在 Composer 失活时处理 Ctrl+C，判定条件与 `disabled` 同源，不依赖 handler 注册顺序。任何复制、剪切、粘贴、全选手势清除双击退出窗口，复制后紧跟的 Ctrl+C 回到中断语义。选中行沿用补全弹窗的选中底色。

快捷键记录在 `/help` 的 Keys 行，与终端原生粘贴并存说明。

## Alternatives considered

- 纯原生鼠标框选加 `JANUS_NO_MOUSE=1` 逃生口 — 零新增代码，逃生口已经存在；但全屏 alt-screen 没有 scrollback，各终端对上报模式的框选行为不一，键盘用户依然没有复制手段，SSH 与 ConPTY 下残缺依旧。
- 保持仅 OSC52 系统复制：没有子进程成本，支持该协议的终端可以正常使用；JanusX 的 xterm 没有注册 OSC52 处理器，请求不更新系统剪贴板，宿主 Ctrl+V 会粘贴旧内容。
- 使用 `clip.exe`：系统自带且启动快；UTF-16 带 BOM 会把 BOM 保留为内容，无 BOM 的纯中文可能误判编码，因此无法保证原文复制。固定 PowerShell 命令通过 Base64 解码避开这个问题。
- 使用子进程读取系统剪贴板：可以让应用 Ctrl+V 读取其他程序内容；宿主已经提供原生粘贴，增加读取路径没有必要。本机命令仅负责复制。
- Ctrl+C 保持中断、另设复制键 — 零冲突；但可发现性差，用户直觉就是 Ctrl+C，选中态下中断输入本就没有意义，冲突让位给复制更符合预期。
- 运行时鼠标上报开关 — 滚轮与原生框选可切换，看似两全；但引入模式状态，关闭期间滚轮丢失，键盘方案已覆盖输入框场景，徒增心智负担。
- Do nothing / reuse — 维持终端原生粘贴单向可用，零成本；代价是框内文本永远拿不出来，问题原文的诉求无解。

## Consequences

- **Gains**: 输入框文本可选中、可复制、可剪切、可粘贴，有选区 Ctrl+C 复制，无选区行为与过去一致，中断与双击退出不受影响。守卫为 `npx tsc --noEmit` 加 `npx vitest run`（均在 `packages/cli`，31 文件 278 用例全过，新增 24：纯逻辑 18、Composer 交互 6）。
- **Costs and limits**: 本机 Windows 复制有一次同步 PowerShell 启动成本，故障时最多阻塞 2 秒，再回退 OSC52；系统粘贴仍由宿主负责。OSC52 发送成功不代表宿主接受，非 TTY、超限或两条系统路径均不可用时只留应用缓冲。SSH 环境标记存在时不写远端 Windows 剪贴板。键盘序列仍受宿主拦截规则影响。

`packages/cli/tests/tui-composer-selection.test.ts` 验证 Unicode 和多行文本传输、固定命令、超时、Windows 本机路径、SSH 路径与失败回退；命令为在 `packages/cli` 运行 `npx vitest run tests/tui-composer-selection.test.ts`。Windows ConPTY 加 JanusX 同版 xterm 的浏览器鼠标验证确认：拖选 `test` 后系统剪贴板精确等于 `test`，边框和提示符不参与。系统剪贴板直接验证还覆盖中文、Tab、LF 和已有 BOM 的保留。
