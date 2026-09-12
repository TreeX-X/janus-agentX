# Agent Note: agent-cli 基础能力缺口矩阵与补齐路线

Status: proposed

## Problem

janus-agentX 的对话循环、TUI 与 headless 单轮已经可用，但在独立 `agent-cli` 视角下，与 `codex`、`opencode`、`pi`（含 `pi-code` 扩展包）对比存在代际差距。`packages/cli/src/commands.ts` 的 16 个斜杠命令写死且未知即报错，`packages/cli/src/providers.ts` 只认 OpenAI 兼容 endpoint，`packages/agent-core/src/main/agent/chat-tools/workspace-chat-tools.ts` 的模型工具面无 Task 委派、无 web、无 MCP。`system-prompt-builder.ts` 为纯静态拼接，从不读取工作区指令文件。维持现状的代价是每个新场景都要改源码加硬编码，项目级复用、外部工具生态、多线并行无从谈起，`janus` 只能做内嵌引擎，不能做日常主力 CLI。

## Proposal

以本 Note 为总账维护全部缺口，后续按 P0 → P1 → P2 逐项拆独立 Note 与实现。本 Note 只做分级与验收口径，不直接规定每项的实现细节，细节归各子 Note 所有。

P0 决定 `janus` 能否称为 agent-cli，须先做。指令文件加载读取仓库与全局的 `AGENTS.md`、`CLAUDE.md` 及同目录规则并注入 system prompt，证据现状见 `packages/chat-core/src/main/llm/system-prompt-builder.ts`。MCP 客户端支持 stdio 与 HTTP/SSE 两种传输，工具以 `<server>_<tool>` 形态注册并受权限管控，现状为零实现。Skills 与自定义斜杠命令支持用户级与项目级 `SKILL.md`、`commands/*.md` 发现与按需加载，现状只有 `commands.ts` 的固定集合。Subagent 与 Task 委派提供隔离子循环、摘要回灌与并发深度上限，派发原语复用 [context-brief-task-spawn](2026-09-08-context-brief-task-spawn.md)，harness 形态复用 [harness-persistent-subagents](../architecture/2026-09-11-harness-persistent-subagents.md)。用户 Hooks 在工具调用前后与会话生命周期触发本地命令，现状仅有内部 `beforeToolCall`/`afterToolCall` 而无用户配置。Plan 模式提供只读规划与显式确认后执行，现状只有 `effort` 八档与 `todo_write`。Web 搜索与抓取提供 SSRF  guard 的只读工具，现状唯一网络调用是 `connect.ts` 的 `GET /models` 探活。项目级配置与细粒度权限提供 `global → project` 分层与 `allow/ask/deny` 规则文件，现状只有 `~/.janus/` 单层加代码常量。

P1 决定日常好不好用，次之做。Sandbox 与隔离在现有 `path-guard.ts`、`policy-gate.ts`、`destructive-commands.ts` 之上提供可选的容器或系统级沙箱档位。Provider 生态在 `model.ts` 的 `createOpenAI` 之外补 Anthropic 原生与 OAuth 登录。审批从 `auto-run|per-action` 两档细化到按工具与命令模式匹配。会话补 `fork/share`、LLM 摘要式 compaction（方向见 [context-compaction](2026-09-12-context-compaction.md)，替代 `chat-session-runtime.ts` 现有确定性 digest 裁剪）、以及 checkpoint 引擎之上的 `/rewind` UI（引擎见 `agent-core/src/main/agent/checkpoint/checkpoint-manager.ts`）。Headless 补通用的 `--json`、`-p` 语义与非交互审批策略。

P2 为生态与运维，按需做。`@file` 引用与 `/mention`、图片附件、`/init` 脚手架、`/diff` 与 review 视角、LSP 与 IDE 联动、GitHub `pr/issue` 集成、插件目录、主题与 i18n、自更新。知识召回方向已有独立提案，见 [knowledge-mcp-access](2026-09-05-knowledge-mcp-access.md)，与本矩阵正交，互不阻塞。

| # | 缺口 | 现状证据 | 对标 | 级别 |
|---|---|---|---|---|
| 1 | 指令文件 | `system-prompt-builder.ts` 无 fs 读，`grep AGENTS packages/*/src` 仅 `.gitignore` | codex 分层 AGENTS.md，opencode instructions，pi 原生读 CLAUDE.md/AGENTS.md | P0 |
| 2 | MCP | `packages/*/src/**/mcp*` 零文件 | codex `/mcp`+`mcp-server`，opencode `mcpServers`，pi `pi-mcp-adapter` | P0 |
| 3 | Skills/自定义命令 | `commands.ts:38-56` 固定 16 个 | codex skills，opencode `skill+commands/*.md`，pi-code `skills.ts` | P0 |
| 4 | Subagent/Task | 22 模型工具无 Task，`PORTS.md:52-65` 声明驻壳 | codex agents，opencode `@mention` 委派，pi-code `subagent/` | P0 |
| 5 | Hooks | 无用户 `hooks.json` loader，`TUI-IMPLEMENTATION.md:199` 明示不发 hooks | 三家均有 lifecycle hooks | P0 |
| 6 | Plan 模式 | 无 `--plan` flag 与 slash | codex `/plan`，opencode `plan` agent，pi-code `/plan` | P0 |
| 7 | Web 工具 | 工具面无 `web_*`/`fetch` | codex search，opencode `webfetch/websearch`，pi-code key-free search | P0 |
| 8 | 配置分层+权限文件 | 仅 `~/.janus/config.json+auth.json+history/`，无 project 层 | codex `config.toml+profiles`，opencode `global→project+permissions[]`，pi `~/.pi/+ .pi/` | P0 |
| 9 | Sandbox | 仅 jail+审批，无容器字段 | codex sandbox 三档，opencode `external_directory` | P1 |
| 10 | Provider/Auth | 仅 `createOpenAI`，仅 API Key | 三家多 provider+OAuth/login | P1 |
| 11 | 审批粒度 | 仅两档 | codex 三档+sandbox 正交，opencode per-tool pattern | P1 |
| 12 | 会话能力 | 无 fork/share/LLM compaction/rewind UI，compaction 方向见 [context-compaction](2026-09-12-context-compaction.md) | codex `unarchive`，opencode `fork/share/compact`，pi-code `rewind/memory/goal` | P1 |
| 13 | Headless | 仅 `chat` JSONL，无通用 `--json` | codex `exec`，opencode `run --format json`，pi `-p/--mode json/rpc` | P1 |
| 14 | 引用/多模态/脚手架 | 无 `@file`/image/`/init`/`/diff` | 三家均有 | P2 |
| 15 | IDE/LSP/GitHub/插件/运维 | 均无实现 | codex IDE+GH Action+update，opencode plugins+LSP，pi extensions 市场 | P2 |

## Alternatives considered

- 按缺口逐个建独立 proposed Note，不设总账 — 粒度最干净，每个方向独立评审；但 15 个缺口之间有顺序依赖，分散后优先级与重复论证散落各处，总账的协调价值超过一文件多决策的气味，子 Note 建档后本 Note 只保留索引即可收敛。
- 直接对标某一家全量抄（如照搬 opencode config schema） — 上手最快，兼容生态；但 janus 的 OpenAI 兼容单传输与直调工具注册与三家都不完全同构，全抄引入不必要的协议与权限复杂度，分项吸收更可控。
- 只补 P0，不动 P1/P2 — 投入最小，先达到可用线；但 sandbox、provider、compaction 的缺席会让 P0 上线后仍难进日常主力，总账必须提前暴露全貌，实施分批即可。
- Do nothing / reuse — 维持 `janus` 为 JanusX 壳的内嵌引擎，CLI 只保 headless 与基础 TUI，零额外成本；代价是独立 `janus` CLI 永远够不上 codex/opencode/pi 的基础线，本次调研的结论即被浪费。

## Acceptance criteria

- [ ] P0 八项每项有独立子 Note 或明确复用既有 Note（如 Task 复用 context-brief 与 harness 两案），本 Note 届时只保留链接索引。
- [ ] 指令文件、MCP、Skills、Subagent、Hooks、Plan、Web、配置分层各自可演示：不改源码，仅靠工作区与用户目录文件触发行为变化。
- [ ] 新增能力默认 fail-closed：未知配置不放行，外部仓库带来的 MCP/hooks/skills 须经显式信任才加载。
- [ ] `typecheck` 与全 workspace `vitest` 全绿，工具契约数量测试随工具面同步更新。

## Risks

- 总账 Note 与子 Note 分叉 — 本 Note 只定分级与验收，细节归子 Note，建档后回链索引承担，定期对账。
- 范围蔓延到壳侧能力 — `README.md:16-20` 的范围声明承担边界，知识服务与外部桥接仍驻壳，本矩阵只收 CLI 本体能力。
- 权限与 sandbox 被绕过 — 现有 `policy-gate` 与 `path-guard` 为底线承担，新增扩展点默认拒绝，外部输入先过信任门。
- 上下文与工具面膨胀 — MCP 与 skills 按需加载承担，全量工具定义永不常驻 prompt。
