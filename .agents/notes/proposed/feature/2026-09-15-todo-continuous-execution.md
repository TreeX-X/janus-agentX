# Agent Note: todo 连续执行与中途可改

Status: proposed

## Problem

`todo_write` 建单后，模型做完一项即以纯文本收尾，剩余 `pending` 项被静置，回合直接结束。根因在两处：循环退出只看有无工具调用（`packages/agent-core/src/main/agent/loop/janus-agent-loop.ts` 无工具分支直接 `break`），续跑只靠回合内一次性 `todoResumeIssued` 注入（`packages/janus-agent/src/orchestrator/chat-turn.ts`），第二次纯文本即放行。2026-09-14 Note 已承认该 nudge 为一次性。若维持现状，多步计划退化为单步执行，`pending` 堆积只能靠用户手动追问续跑。

## Proposal

`todo` 建单后必须连续执行，且计划允许中途修改。

连续执行由 loop 承担。`getFollowUpMessages` 在每轮无工具调用且仍有 `open`（`pending` 或 `in_progress`）时注入 `todoResumePrompt`，取消 `todoResumeIssued` 的一次性守卫，上界仍由 `CHAT_MAX_STEPS` 承担。`formatTodoStateMessage` 的回合首注入保留，明示 `open` 计数并要求以工具调用续跑。模型以纯文本声明阻塞或请求决策时方视为合法停顿，复述计划不算完成。

中途修改由全量替换语义承担。模型每次传入完整新列表，可增补后续步骤、拆分粗项、对无关项标 `cancelled`。修改时保持当前 `in_progress` 不动，只改 `pending` 队列；`completed` 仅在工作加验证完成后标记，不回退已完成项，不批量完成。校验保持不变：1-20 条、单 `in_progress`，违例走 `isError` 自愈。

## Alternatives considered

- 维持一次性 nudge — 实现成本为零，单轮追加覆盖多数场景；但第二次纯文本即停，多步任务仍会中断，否决。
- 硬阻塞直到 `open` 清零 — 续跑最彻底；但模型声明真实阻塞时也会被强行续跑，烧往返且可能逼出幻觉工具调用，否决。
- 事件总线加会话唤醒 — 回合结束后仍可自动 re-drive；但需新系统，2026-09-14 Note 已否决同类方案，每轮注入以模型往返成本覆盖连续性，否决。
- Do nothing / reuse — 零代码，复用 opencode 纯 prompt 约束；代价是单项完成即停的问题继续复发，计划跟踪只剩展示价值。

## Acceptance criteria

- [ ] 两项 `pending` 计划下，模型连续两轮返回纯文本时回合仍不结束，第三轮发出工具调用或声明具体阻塞。
- [ ] 全部 `completed`/`cancelled` 时无 nudge，单轮纯文本即正常结束。
- [ ] 中途增补一项 `pending` 后校验通过，`in_progress` 仍唯一，sticky 条计数更新。
- [ ] 双 `in_progress` 提交返回可纠错 `isError`，不写回会话。
- [ ] `summarizeTodos` 的 `open` 口径与 `hasOpenTodos` 一致，`cancelled` 不计入 `open`。

## Risks

- 无限续跑烧往返 — `CHAT_MAX_STEPS` 上界与阻塞声明出口承担，nudge 文案保留 blocker 出口。
- 模型为停而虚构阻塞 — 首版接受该逃逸，`todo` 状态机不做语义真伪校验，靠工具结果与复核发现。
- 中途改单冲掉进度 — 全量替换语义固有风险，由单 `in_progress` 校验与 `completed` 不回退约定承担。
