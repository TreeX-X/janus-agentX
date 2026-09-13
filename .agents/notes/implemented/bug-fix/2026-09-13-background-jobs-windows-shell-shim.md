# Agent Note: 后台任务与同步命令共享 Windows shell 解析并透出启动失败

Status: implemented

## Problem

`command.run background:true` 的 `JobManager.start` 以裸 `spawn` 启动进程，无 `shell:true` 兼容、无参数元字符拦截、无启动错误落盘。Windows 上 `npm` 等包管理器实为经 `cmd.exe` 解析的 shim，裸启动即 `ENOENT`（读数为 `-4058` 之类负退出码），日志仅有任务头与空输出。同步 `command.run` 具备 `windows-shell-shim` 映射，同一 `npm run build` 在前台可启动、在后台必失败，模型只能对着空日志盲重试。V0.8.5 打包日志（`bg-mtzyftym-e11e2e`，55ms、无输出、`timedOut=false`）即此形状。

## Decision

shim 判定收敛在 `packages/node-hosts/src/windows-shell.ts` 的 `commandExecutionMode`，纯函数、无 IO：win32 下包管理器名与 `.cmd/.bat` 后缀走 `windows-shell-shim`，其余直启。同步 `command.run` 与后台 `JobManager.start` 同查该函数：命中时以后台 `shell:true` 启动并沿用同一元字符拒绝口径。`spawn` 的同步抛错与异步 `error` 事件均写入任务日志：同步抛错落盘后继续抛出，异步错误随退出脚注一并落盘并附带修复指引（宿主 PATH 缺 Node、shim 经 `cmd.exe` 解析）。任务头新增 `executionMode` 行，轮询侧无需改接口即可在日志中读到原因。

## Alternatives considered

- 全 shell 化（codex-cli/opencode/pi-agent 式 `bash -c`/`cmd /c`，任意字符串、完整用户 PATH、stderr 直达）—— Diagnose 最快，模型零适配；但引入 shell 注入面与现有程序/参数分离、破坏性命令守卫、env 白名单的 fail-closed 冲突，故仅对已知 shim 名开 `shell:true`，其余保持裸启动。
- 放开 `PATH`/`PATHEXT` 的 env 白名单或允许绝对 `program` —— 调用方自救最直接；但白名单的收紧是有意为之（路径劫持与注入），放开的 blast 半径大于本次故障，故维持拒绝，只把指引写进日志。
- 同步重试兜底（后台 ENOENT 时自动改 shell 重起）—— 调用次数最少；但副作用命令的重试语义不透明，失败原因仍不可见，故只对齐映射、如实落盘，把决策留给调用方。
- Do nothing / reuse —— 零代码；代价是 Windows 后台包管理命令系统性不可用且无声，V0.8.5 式空日志故障重复出现。

## Consequences

- **Gains**: 后台与同步的 win32 启动语义一致，不可解析程序的轮询输出携带 `spawn error` 与修复指引而非空日志；`packages/node-hosts/tests/windows-shell.test.ts` 锁定映射与 `command.js` 重导出兼容，`packages/node-hosts/tests/jobs.test.ts` 锁定不可解析程序的日志透出与新任务头行号。
- **Costs and limits**: shim 名单为静态集合（`npm/yarn/pnpm/bun` 加 `.cmd/.bat`），新 shim 需人工增补，以 `commandExecutionMode` 单测为哨兵；宿主进程本身 PATH 缺 Node 时仍需从有 Node 的 shell 启动宿主，日志指引只缩短定位时间。验证：`npm run test --workspace=@janus-agent/node-hosts`（32 通过）、`npm run typecheck`（全仓通过）。
