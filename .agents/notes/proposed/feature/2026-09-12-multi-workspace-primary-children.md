# Agent Note: 主工作区 + 子工作区多挂载

Status: proposed

## Problem

`janus` 现只认单个工作区。`CliSession` 以 `CLI_WORKSPACE_ID` 绑定唯一 root（`packages/cli/src/session.ts`），`resolveWorkspaceRoot` 只放行该 id，`sendTurn` 只下发单个 `workspaceResources`；`/workspace <dir>` 语义为替换并清空历史（`packages/cli/src/tui/exec.ts`、`commands.ts`）。跨仓库工作（前后端分仓、主仓加参照仓、monorepo 拆仓比对）只能重启进程或另开窗口，上下文与待办随切换丢失，模型也无法在同一 turn 内同时取证两个仓库。维持现状的代价是多仓任务被迫串行化到人肉复制粘贴，`janus` 在多仓日常面前退回单仓工具。

## Proposal

引入主从两级挂载。打开目录即主工作区，全程存在且不可移除；子工作区可中途按需挂载多个，也可中途移除。底层无需重造：`WorkspaceAgentRuntime` 本是多 session 映射，`createWorkspaceChatTools` 以 `resources: Map` 寻址，`buildChatSystemPrompt` 本就渲染附着工作区列表，改造集中在 CLI 会话层与两套 TUI 宿主。

挂载入口沿用 `/connect` 的双宿主形态。TUI 内 `/workspace add [path]` 唤起面板，形态复用 `ConnectPanel` 的步骤机（列表选择加分步表单，`Esc` 取消）：先选目录，再确认别名，最后挂载。`--plain` 回环保留文字向导，形态复用 `runConnectWizard` 的问答驱动。快写形式 `/workspace add <path> [--as <alias>]` 跳过面板直达挂载。只读命令保留 `/workspace`（显示名册）与 `/workspace list`；移除为 `/workspace rm <ref>`，拒绝主工作区，别名与路径前缀皆可寻址。`/workspace <dir>` 单参旧语义保留为替换式切换并清空历史，避免存量习惯断裂，新文档主推 `add/rm`。

路径补全做成挂载面板的一等能力，而非裸参数的附带品。面板内输入即过滤，候选源为当前目录子目录、兄弟目录与本次进程历史，按输入子串过滤，方向键加回车确认，超出上限截断并提示。Ink 侧需扩展 `composer-state.ts` 现有仅首 token 的补全（`filterCompletions` 只看 `/` 命令本身，`completeSlashCommand` 遇空格即返回空），为 `/workspace add/rm` 的第二参接上目录源；`--plain` 回环的 readline completer 同步接上目录补全。候选只收录目录，数量有界，非法路径在面板内即时报错，不送入会话创建。

顶部预览与状态必须随名册同步更新。`store.ts` 的 `workspaceLabel` 现为单名，`App.tsx` 的状态栏按固定预算截断且永不换行。挂载变化后 `refreshContext` 下发的标签须改为名册形态，主工作区别名常驻，子工作区折叠为 `+N` 并在 `/status` 展开全路径与会话状态。审批卡片已带 `workspaceId`，渲染时须同时显示别名与相对路径，使放行人看得出是哪一个仓库的哪一条路径。`trace-preview.ts` 现按单 root 解析 diff 与状态，须改为按触发 trace 所属工作区 root 解析，否则子工作区的改动预览将指向错误的仓库。

会话层持有 `Map<workspaceId, { sessionId, root, alias }>`。主工作区沿用 `cli` 以保兼容，子工作区以别名 slug 分配 id 并做 `realpath` 去重，嵌套 root 给出警告或拒绝。`resolveWorkspaceRoot` 改为查表，`sendTurn` 下发全名册。新增即 `createSession` 加表项，移除即 `cancelSession` 并按 `chat-session-runtime` 既有证据失效思路清理该工作区的已加载证据与待定审批。`chat` headless 侧首工作区为主，其余 `--workspace` 重复项为子，事件流已带 `workspaceId`，无需改协议。

## Alternatives considered

- 多开进程或窗口，一仓一进程 — 零改造成本，隔离最彻底；但上下文割裂正好是本提案要消除的痛点，跨仓取证仍靠人肉搬运，否决。
- 聚合根（把多仓 symlink 到一个临时父目录再单 root 打开）— 实现最薄，复用全部单工作区链路；但 git 根、审计路径、审批预览全部失真，删除与提交的blast radius 被掩盖，否决。
- 落盘式多根配置（如 `.janus/workspaces.json` 自动加载）— 重启可恢复，适合固定多仓组合；但引入外部文件即信任新 root 的持久化攻击面，评审与信任门还没立起来，先以进程内名册起步，该形态延后，否决纳入本次范围。
- 模型自助挂载（给模型一个无需确认的 attach 工具）— 交互最顺滑，一句话即加仓；但挂载等于信任新 root，静默放行违背 fail-closed，必须经主机确认，否决。
- Do nothing / reuse — 保留单工作区加替换式切换，零成本零风险；代价是多仓任务永远走重启加丢上下文的老路，本次确认的差异化点直接作废。

## Acceptance criteria

- [ ] `/workspace add [path]` 在 TUI 唤起面板、`--plain` 走文字向导，快写 `/workspace add <path> [--as <alias>]` 可直达；非法目录、重复 `realpath`、嵌套 root 均有明确报错或警告。
- [ ] `/workspace list` 与 `/status` 展示主从名册（含别名、路径、会话状态）；`/workspace rm <ref>` 可移除任意子工作区，移除主工作区被拒绝并提示。
- [ ] 面板与 `--plain` 均提供目录补全（子目录、兄弟目录、进程历史，目录限定、数量有界）；裸 `/workspace` 仍显示当前名册，旧单参替换语义可用。
- [ ] 顶部状态栏随增删即时更新且永不换行（沿用既有预算截断）；审批卡片与工具输出标出所属工作区别名；子工作区改动预览解析到正确仓库。
- [ ] 移除工作区后，该工作区的已加载证据失效、待定审批被取消，后续 turn 不再引用其路径；主工作区会话不受影响。
- [ ] `typecheck` 与全 workspace `vitest` 全绿，`commands.ts`、`composer-state.ts` 的补全覆盖测试随新命令同步更新。

## Risks

- 模型调错 `workspaceId`（用 A 的 hash 改 B）— `expectedHash` 与按会话隔离承担底线，系统提示须强调先定位再读再改且 `workspaceId` 显式，验收以跨仓改动用例承担。
- 检索扇出随工作区数线性放大 — 默认浅列举加 `search` 优先的既有约束承担，上限（如 5~8 个）在会话层硬截断并提示。
- 头部预算被长别名撑爆 — 既有 `truncateToWidth` 预算机制承担，主别名优先保全，子工作区折叠为计数。
- Ink 与 `--plain` 双宿主分叉 — `exec.ts` 共享执行语义承担，面板只做渲染，两侧验收用例同断言。
