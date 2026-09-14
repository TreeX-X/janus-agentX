# Agent Note: 报错当轮自愈补全与 todo 计划自动续跑

Status: implemented

## Problem

2026-09-13/14 两轮 JanusX 实测（V0.8.5 打包日志与推送中断日志）暴露两类残余问题。其一，报错仍烧往返：`command.run` env 白名单拦截只报 `env key is not allowlisted: HTTP_PROXY`，模型拿不到正确替代，实测连烧 5 步诊断才换 `git -c` 传参；同步路径 spawn 启动失败（ENOENT）仍是裸错，与后台路径的 `spawnHint` 不对称；chat 面向的 `command_run` 描述缺 60s 后台阈值规则，且三份描述副本的轮询工具名漂移（`project.process-output` vs `project_process_output`）。其二，todo 计划自动中断：`ConversationRegistry.load` 只回填压缩状态，持久化的 `todos` 从不写回 `ChatSessionRuntime`，应用重启后模型侧注入返回 null，计划只剩 sticky bar 可见而模型永远不续跑；回合以「要不要继续？」式提问收尾后任务停在 pending，无任何机制 re-drive（已两次实锤）。

## Decision

env 白名单拒绝文案直接枚举全部白名单键并给出参数式替代（`git -c http.proxy=... clone ...`）；`spawnHint` 从 `jobs.ts`/`runner.ts` 导出复用，同步 `executeCommand` 的 `error` 事件包装为「原始信息 + hint」再 reject，两侧同步路径与后台路径共享同一指引；chat 面向 `command_run` 描述补入 60s 阈值规则与参数式 env 替代，JanusX 副本统一轮询工具名为 `project_process_output`。

todo 注入即续跑通道：`formatTodoStateMessage` 在存在 open 项时明示 open 计数、要求立即以工具调用续跑且不得停下来等确认；回合内复用 `recoveryIssued` 守卫模式新增一次性 `todoResumeIssued`——loop 在无工具调用轮次咨询 `getFollowUpMessages` 时，若计划仍有 open 项则注入 `todoResumePrompt`，每回合最多多烧一轮模型往返；`ConversationRegistry.load` 将持久化 `todos` 回填 `chatSession.setTodos`（缺省按空处理），重启后模型可见计划。JanusX 侧打包链新增 `prepackage`（`npm install --install-links`）并前置到三个 `package:*` 脚本，杜绝 file: 依赖物化后静默过期。

## Alternatives considered

- 放开 `HTTP_PROXY`/`HTTPS_PROXY` 入 env 白名单：代理场景零报错；但白名单收紧是有意为之（劫持面），且代理属程序自身配置，参数传递即可覆盖，否决。
- pending 提醒改为事件总线加会话唤醒：真正自动 re-drive；但需要新系统，Note 已否决过同类方案，一次性 follow-up 注入以一轮往返成本覆盖 90% 场景，否决。
- todos 回填改为懒加载（turn 时从 record 读取）：省一次 setTodos；但两个读取点（注入与 nudge）都要感知持久层，运行时态仍双源，回填单点收敛更简，否决。
- Do nothing / reuse：零代码；代价是 env 拦截与 spawn 裸错继续各烧多轮往返，重启后计划永久失联，pending 任务第三次复发只是时间问题。

## Consequences

- **Gains**: env 拒绝与启动失败当轮按文案自纠，轮询工具名三副本一致；重启后模型侧 todo 注入恢复，回合末尾有一次性续跑 nudge，`npm run package:*` 不再消费冻结的旧 file: 依赖。
- **Costs and limits**: 白名单键的增补仍需两仓同步（枚举文案随名单走）；resume nudge 是回合级一次性而非逐轮逼问，模型解释阻塞后不再重复注入；JanusX 的会话 LRU 无持久化 todo 快照可回填（该侧未持久化 todos），壳侧续跑仍依赖 janus-agentX 通道，留待壳侧持久化落地再对齐。
- **Verification**: janus-agentX `npm run typecheck` 全仓通过；`npm test` agent-core 260 通过、chat-core 49、cli 323、node-hosts 33（含 spawnHint 与 env 指引新用例）、janus-agent 16（含 resume nudge 正反用例）；JanusX `npm run typecheck` 通过、`tests/unit/agent/command-tools.test.ts` 13 通过（含 hint 与 `git -c` 指引用例）。
