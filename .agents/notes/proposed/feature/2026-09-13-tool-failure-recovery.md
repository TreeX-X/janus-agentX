# Agent Note: 工具调用失败自愈与长任务防中断

Status: proposed

## Problem

V0.8.5 打包任务在一轮内连踩四个工具失败（`command_run` 报 -4058、`workspace.search` 传文件路径被拒、`workspace.edit` 失配、`workspace.create` 撞 `TARGET_EXISTS`），随后长命令回合被截断，typecheck 与打包无人接力。单次工具失败本不会杀死回合（`runJanusAgentLoop` 把异常收敛为 `isError` 工具消息喂回模型），真正的成本是错误信息不可操作：每条裸错都要烧掉一整轮模型往返去猜测正确调用，叠加前台长命令无心跳，体感即"一报错就全断"。放任不管，打包、发版类多步任务的期望轮次持续超预算。

## Proposal

按失败逐条收敛，全部落在工具层与提示层，不动循环主干。

- 执行环境：把 `packages/node-hosts/src/windows-shell.ts` 的 `windows-shell-shim` 同步到 JanusX 壳的 `command-tools.ts`，使 `npm` 等 shim 在两侧都走 `cmd.exe`；同步路径与后台路径的 `ENOENT` 统一映射为出路式报错（缺失程序名、宿主 PATH 未继承的修复动作），复用 `jobs.ts` 现有 `spawnHint` 措辞；会话启动探针一次 `npm --version` 并把结果写入 system prompt。
- 纠正执行：`workspace.search` 的 `path` 指向文件时自动收敛到父目录并限定该文件，结果附一句收敛声明；description 同步声明目录约束。
- 编辑宽容：`applyExactReplacements` 匹配前对双方做 `\r\n→\n` 归一化、写回保留原文件行尾；哈希过期报错直接返回当前 `sha256`，失配报错返回首个失配块附近的实际行号区间。
- 创建合流：`workspace.create` 新增默认 `false` 的 `overwrite` 入参，置位且目标存在时复用现有 checkpoint 与审批链覆盖；`TARGET_EXISTS` 文案指向该出路。
- 防中断：system prompt 与 tool description 明示超 60 秒预期的命令必须 `background:true` 并用 `project.process-output` 轮询；打包链每步落盘即检查点，截断后从日志或检查点续跑。

## Alternatives considered

- 照搬 codex 的全 shell 执行：一劳永逸继承用户 PATH，shim 问题消失；代价是放弃 direct-spawn 的审计边界（`destructive-commands.ts` 的无 shell 前提被推翻），安全模型重写，成本远超同步 shim。
- 失败重试下沉到循环层自动重放：工具报错由循环自动重试 N 次；简单的参数错误会被自动放大为多次副作用调用，且与审批语义冲突。错误自纠归模型、循环只保配对约束的现状更稳。
- Do nothing：保留精确匹配与拒绝式报错；Windows 落盘 CRLF 与 shim 解析问题 deterministic 复现，打包类任务每轮多烧 3 到 5 个无意义往返。

## Acceptance criteria

- [ ] 壳侧复现 `command_run npm run build` 后台启动不再报 -4058，缺失程序时模型收到含修复动作的中文提示。
- [ ] 同一批回归用例覆盖 search 传文件、edit 传 LF 配 CRLF 落盘、create 覆盖已存在文件，三者均在当轮按提示自纠成功。
- [ ] `npm run package:win` 级别的长命令走后台加轮询，前台不再出现回合截断导致任务链无人接力。

## Risks

- CRLF 归一化改变匹配语义，极端情况下含混合行尾的补丁可能误配；以写回保留原行尾加唯一性校验（现有的 ambiguity 拒绝保留）对冲。
- `overwrite` 通道拓宽覆盖面；默认关闭加同级审批链复用，风险等级与现有 `edit` 持平，属显式接受。
