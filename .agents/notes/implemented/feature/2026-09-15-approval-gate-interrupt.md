# Agent Note: 审批门与提问面板的中断统一与常许快捷键

Status: implemented

## Problem

TUI 内 Esc 有四种命运：忙时中断整轮、审批门内只否决单次、提问面板只取消单次调用、浮层内归浮层。用户在门与面板前没有停整轮的键，只能按出 deny 后再等一轮。审批等待期 Composer 被卸载，键入 `/approval auto-run` 无路可走，切回直跑的唯一办法是先 deny 再打字，卡死的体感集中于此。放任不管，每次高风险审批都是一次要么误继续、要么退不出的赌博。

## Decision

Esc 在全 TUI 统一为取消整轮：忙时走既有通用中断；审批门内 Esc 经由同一中断落 deny（fail-closed 不变）并随 abort 收尾整轮；提问期 Esc 在面板单次取消之外叠加整轮 abort，两者一致。审批门新增 `a` 常许键：切 auto-run 并直接放行当前等待，后续同类操作不再弹窗，对齐 opencode 内联卡片的 allow-always。`CliSession` 跟踪最新未决审批并以同 id 比对清理，`approvePendingAndAutoRun` 对已解决的等待返回 false 而无副作用。

## Alternatives considered

- 审批等待期重新挂载 Composer 以便键入命令：最强理由是命令入口统一；否决驱动是门与输入框双焦点、键路由分裂，且只需 auto-run 一个动作，重挂整个输入栈不划算。
- Esc 在门内保持仅否决、另设新键停整轮：最强理由是保留细粒度；否决驱动是用户要记两套键，而 busy-Esc 早已承担中断，统一 happens-before 更少心智负担；单次否决仍在（←→+Enter 选 Cancel）。
- `a` 只切模式不放行当前等待：最强理由是语义最小；否决驱动是用户按完仍被 gate 拦住，与直觉相悖，一次按键解决两次阻塞才成立。
- Do nothing / reuse：零代码；代价是门前无停整轮键、切模式必经 deny 加打字，审批密集任务每轮多一次无效往返。

## Consequences

- **Gains**: Esc 处处停整轮且 fail-closed 不变；高风险连击场景一键常许，后续零打扰；`tui-approval` 的 abort 即 deny 断言与新三用例同绿。
- **Costs and limits**: 并行双审批同时等待时 `a` 只放行最新跟踪的一单（只读工具并行从不进审批，串行链下至多一单等待）；`a` 在门已解决的竞态下仍会切换模式，返回 false 标示无放行。终端按 `a` 即切 auto-run 的提示只在门 hint 与面板文案中出现。
- **Verification**: `tsc --noEmit`（cli）通过；`tui-app` 新增审批 Esc、常许 `a`、提问 Esc 三用例通过；cli 全量 341 通过，剩余 3 例失败已证与改动无关（2 例 git 初始化并发超时隔离 6/6 过，1 例脏树 display 旧断言）。
