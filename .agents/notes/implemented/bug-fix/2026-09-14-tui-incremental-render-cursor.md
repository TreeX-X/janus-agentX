# Agent Note: 流式重绘改为增量渲染并降频稳定光标

Status: implemented

## Problem

流式输出期间用户在输入框打字，真实终端光标在输入行与帧底部之间来回漂移。根因在 Ink 7 的整帧重绘协议：`log-update` 每次内容变化都执行"隐藏光标 → 回到帧底部 → `eraseLines` 擦掉整个上一帧（本布局约 39 行）→ 重写整帧 → 把光标从底部移回光标单元格"（`cursor-helpers.js` 的 `buildCursorSuffix`）。物理光标因此随每次重绘完整走一遍"底部↔输入处"，重绘频率越高摆动越快。

三个放大器叠加：`text_delta`/`reasoning_delta` 以 50 毫秒窗口合批（`App.tsx` 的 `STREAM_BATCH_MS`），仍达 20 帧/秒，且每个按键也是一次内容变化、一次全帧重绘，两者互相抢帧；Ink 以 2026 同步序列（`bsu`/`esu`）包裹整帧更新，支持它的终端原子呈现中间态，但 ConPTY 转发链路上整屏字节量大，任一层缓冲不足即直接可见；win32 上 Ink 判定帧高度 ≥ 终端行数后每帧走 `clearTerminal` 整屏擦除重画（`ink.js` 的 `isWindowsConsole` 分支），布局任何一行溢出（补全浮层、待办卡展开、CJK 标签撑爆宽度）都触发该分支，抖动剧烈一个数量级。

先期工作（[2026-09-13-tui-stream-batch-cursor.md](2026-09-13-tui-stream-batch-cursor.md)）通过合批与放缓 `Activity` 计时压掉了一半重绘，但没有改变重绘模式本身：每次重绘仍是整帧擦写加光标两段式搬家。

## Decision

`runFullscreen` 的 `render()` 调用启用 Ink 7 内置增量渲染与 24 帧节流：`{ exitOnCtrlC: false, incrementalRendering: true, maxFps: 24 }`。`incrementalRendering` 使 `log-update` 走逐行 diff 路径（`createIncremental`），只重写变化的行：流式输出时 composer 那几行不变则完全不动，光标 suffix 只在光标行变化时移动，整帧擦写协议的光标两段式搬家随之消失。`maxFps: 24` 把渲染节流从默认 30 帧/秒降到 24 帧/秒，与流式合批窗口匹配。

`STREAM_BATCH_MS` 从 50 提到 100 毫秒。打字时的渲染需求由按键驱动，输出重绘是在与按键重绘抢帧；100 毫秒窗口把流式重绘压到 10 帧/秒，首字延迟增量落在无感区间。合批机制本身（队列、定时器所有权、`turn-done` 前排空）不变。

两个参数都在 `packages/cli` 落地：`run.tsx` 的 `render` 选项、`App.tsx` 的合批窗口常量。验证为在 `packages/cli` 执行 `npx vitest run`（36 文件 322 用例全过），在仓库根执行 `npm run typecheck --workspace @janus-agent/cli`（通过）。行为验证为流式输出期间打字观察光标稳定性；复现排查走 Ctrl+G 的 `%TEMP%\janus-cursor-debug.log` 光标快照。

## Alternatives considered

- 维持现状（整帧重绘 + 50 毫秒合批）：零改动零风险；但光标摆动是整帧擦写协议的固有产物，合批只能降频不能消除，边打边流的核心场景持续受扰。
- 隐藏流式期间的原生光标、转完再显示：重绘模式不变，忙时可编辑是既定行为，隐藏光标使用户失去插入符与输入法锚点，属于降级。
- 把 `useSyncedCaret` 的 `measureElement` 挪进 `useLayoutEffect` 消除一帧错位（`native-cursor.ts` 的 origin state 往返）：能消除原点变化帧的二次跳动，但触碰光标协议核心且 `tui-cursor.test.tsx` 的多行/调整尺寸用例依赖现有时序，与本项低风险参数调整分开落。
- 合批窗口提到 200 毫秒以上：重绘更少，但首字延迟进入可感知区间，输出实时性损失大于光标稳定收益。

## Consequences

流式文本的最坏首屏延迟从 50 毫秒升到 100 毫秒，理论最坏渲染帧率由 24fps 与 10fps 取小。增量渲染路径的逐行 diff 在 Windows Terminal / ConPTY 下的实际表现依赖终端对相对寻址序列的完整支持：若个别行残留，回退方式是去掉 `incrementalRendering` 单个选项，不影响其他参数。`maxFps: 24` 与 100 毫秒窗口只影响流畅度，不影响正确性；帧高 ≥ 终端行数时 win32 整屏 `clearTerminal` 分支仍在，布局溢出（补全浮层、待办卡展开）依旧会放大抖动，护栏靠 `height={termHeight - 1}` 预留维持。
