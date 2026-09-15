# Agent Note: todo 连续执行与中途可改

Status: implemented

## Problem

`todo_write` 建单后，模型做完一项即以纯文本收尾，剩余 `pending` 项被静置，回合直接结束。根因在两处：循环退出只看有无工具调用（`packages/agent-core/src/main/agent/loop/janus-agent-loop.ts` 无工具分支直接 `break`），续跑只靠回合内一次性 `todoResumeIssued` 注入（`packages/janus-agent/src/orchestrator/chat-turn.ts`），第二次纯文本即放行。若维持现状，多步计划退化为单步执行，`pending` 堆积只能靠用户手动追问续跑。另有计数分叉：`summarizeTodos` 的 `open` 取 `total - done`，把 `cancelled` 也算作未完成，与 `hasOpenTodos`（`completed`/`cancelled` 均闭合）不一致，sticky 条在全取消后仍显示有剩余。

## Decision

连续执行由 `getFollowUpMessages` 承担。`packages/janus-agent/src/orchestrator/chat-turn.ts` 删除 `todoResumeIssued` 一次性守卫：每轮无工具调用且仍有 `open`（`pending` 或 `in_progress`）时注入 `todoResumePrompt`，上界由 `CHAT_MAX_STEPS` 经 `maxTurns` 承担。`formatTodoStateMessage` 的回合首注入保留，明示 `open` 计数并要求以工具调用续跑。模型以纯文本声明具体阻塞或请求决策时方视为合法停顿，复述计划不算完成——nudge 文案保留 blocker 出口，不是硬阻塞。

中途修改由既有全量替换语义承担，不新增机制。模型每次传入完整新列表，可增补后续步骤、拆分粗项、对无关项标 `cancelled`；校验保持不变：1-20 条、单 `in_progress`，违例走 `isError` 自愈，不写回会话。

`summarizeTodos` 的 `open` 改为 `pending`/`in_progress` 计数，`cancelled` 不计入，与 `hasOpenTodos` 同口径；`completed`/`cancelled` 全闭合时无 nudge，单轮纯文本即正常结束。

## Alternatives considered

- 维持一次性 nudge：实现成本为零，单轮追加覆盖多数场景；否决驱动是第二次纯文本即停，多步任务仍会中断。
- 硬阻塞直到 `open` 清零：续跑最彻底；否决驱动是模型声明真实阻塞时也会被强行续跑，烧往返且可能逼出幻觉工具调用。
- 事件总线加会话唤醒：回合结束后仍可自动 re-drive；否决驱动是需新系统，每轮注入以模型往返成本覆盖连续性更便宜。
- Do nothing / reuse：零代码，复用 opencode 纯 prompt 约束；代价是单项完成即停的问题继续复发，计划跟踪只剩展示价值。

## Consequences

- **Gains**: 建单后纯文本轮不再终结回合，模型逐轮被压回工具调用或明确阻塞；`cancelled` 正确闭合，sticky 条不再虚报剩余；中途增补/拆分/取消走同一全量替换通道，无新状态机。
- **Costs and limits**: 顽固纯文本（模型既不调工具也不声明阻塞）最多烧到 `CHAT_MAX_STEPS` 上界；模型为停而虚构阻塞是接受的逃逸，状态机不做语义真伪校验，靠工具结果与复核发现；`completed` 不回退是与模型的约定，代码层不强制。
- **Verification**: `npm run typecheck --workspace=@janus-agent/chat-core` 与 `--workspace=@janus-agent/janus-agent` 通过；`npm run test --workspace=@janus-agent/chat-core` 5 文件 55 通过（含 `cancelled` 不计 `open` 2 例断言）；`npm run test --workspace=@janus-agent/janus-agent` 3 文件 22 通过（含连续 nudge 跑满 `maxTurns`、`cancelled`-only 无 nudge、首轮闭单后停 nudge 3 例）。
