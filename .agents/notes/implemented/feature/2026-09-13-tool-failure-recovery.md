# Agent Note: 工具调用失败自愈与长任务防中断

Status: implemented

## Problem

V0.8.5 打包任务在一轮内连踩四个工具失败（后台 `command.run` 报 -4058、`workspace.search` 传文件路径被拒、`workspace.edit` 失配、`workspace.create` 撞 `TARGET_EXISTS`），随后前台长命令被回合截断，typecheck 与打包无人接力。单次失败本不会杀死回合，真正的成本是错误信息不可操作：每条裸错烧掉一整轮模型往返去猜测正确调用。放任不管，打包发版类多步任务的期望轮次持续超预算，Windows 后台子进程还有残留风险。

## Decision

`workspace.search` 的 `path` 指向文件时收敛到父目录并限定该文件，结果附一句收敛声明；description 同步声明该约束。模型当轮按声明继续；没有该声明，每次误传都要多烧一轮。

`workspace.edit` 的精确替换对行尾不敏感，文件保持主导行尾风格，CRLF 落盘与 LF `oldText` 照常匹配；没有归一化，每次 Windows 落盘都是一次失配往返。`expectedHash` 失配报错直接给出当前 `sha256` 与重读指引，纯哈希过期无需重读即可重试。`replacement` 失配报错给出文件行数、字节数与 `oldText` 首行锚点行号，模型按行号定位缺口。

`workspace.create` 的 `TARGET_EXISTS` 文案直接给出覆盖出路（`workspace.edit` 覆盖，或 `workspace.delete` 后重建），description 声明已存在即失败。不设 `overwrite` 入参，覆盖语义只属于 `edit`。

`command.run` 的 description 规定预期超 60s 的命令必须 `background:true` 并用 `project.process-output` 轮询；打包链每步落盘即检查点，截断后凭 `jobId` 与 `logPath` 续跑。

win32 的后台 kill 走 `taskkill` 整树强制终结，退出码 128 视为已退出竞态并回退句柄杀。控制台进程无视优雅终结，强制是唯一可靠语义；整树终结杜绝打包子进程残留。shim 判定沿用 `windows-shell` 纯函数（见[后台任务 Windows shell 兼容](../bug-fix/2026-09-13-background-jobs-windows-shell-shim.md)），两侧永不漂移。

## Alternatives considered

- 模糊匹配链（opencode 式多级 replacer、codex 式 seek 四档）：最强理由是容忍 LLM 空白缩进漂移，省下重试轮次。否决驱动是两家均有静默破坏事故在案（漂移缩进被吸收落盘、未改 context 行被重写），精确匹配加可操作报错的重试成本低于养护模糊引擎。
- `workspace.create` 新增默认关闭的 `overwrite` 入参：最强理由是单工具覆盖创建与覆盖。否决驱动是与“报错后调 `edit`”同为一轮往返，却新增 schema、审批分支与覆盖面，零轮次收益换 API 增长不划算。
- 会话启动 eager `npm --version` 探针：最强理由是提前暴露宿主 PATH 缺 Node。否决驱动是每会话一次 spawn 常态开销，而 ENOENT 落盘指引已覆盖定位需求。
- completion 推送、唤醒、footer dock 与 `readyPattern`：最强理由是模型免轮询。否决驱动是需要事件总线加会话唤醒加 TUI 的新系统，有界轮询加检查点已满足续跑。
- 全 shell 执行：最强理由是一劳永逸继承用户 PATH。否决驱动是推翻 direct-spawn 审计边界，`destructive-commands` 守卫与 env 白名单的安全模型重写，成本远超同步 shim。
- Do nothing / reuse：零代码；代价是 Windows 落盘 CRLF 与 shim 解析问题 deterministic 复现，打包类任务每轮多烧 3 到 5 个无意义往返，子树残留随打包次数累积。

## Consequences

- **Gains**: 四类裸错当轮按文案自纠，无需猜测正确调用；行尾差异退出失配原因之列；win32 超时与停止即时生效且无子树残留，`stop` 回归实测从 11s 降至 0.5s；长命令有明确的 60s 后台阈值与续跑句柄。
- **Costs and limits**: shim 名单为静态集合，归 `windows-shell` Note 所有；行尾恢复取主导风格，混合行尾文件的插入行随主导风格；整树强制杀只在后台 `JobManager`，同步 `command.run` 超时路径仍为单句柄杀；JanusX 壳 `command-tools.ts` 的 shim 对齐尚未落地，为明确的跨仓后续。混合行尾或模糊缩进的高频重试一旦出现，重访模糊策略。
- **Verification**: `npm run typecheck` 全仓 5 包通过；`npm run test --workspace=@janus-agent/agent-core` 260 通过、1 跳过；`npm run test --workspace=@janus-agent/node-hosts` 32 通过。
