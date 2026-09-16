# Agent Note: 读分页放大量级与检索信号不足

Status: implemented

## Problem

同一定位任务在 agentX 消耗约十倍于 opencode 的输入 token。触发条件是跨 3 个以上文件、单文件数百行的诊断：模型需要建立调用关系才能下结论，证据分散在多个文件里。放任不管，每个诊断任务都用轮数换单轮小输出，总输入随分页数呈超线性增长，重读和收窄搜索成为固定税。

根因在三处。分页默认值差一个量级：opencode `read` 默认 2000 行与 50KB，600 行文件一次返回；agentX `workspace.read` 默认 200 行与 16KB，同一文件需要三页。行号分页与游标契约见[行号分页](../feature/2026-09-15-workspace-read-line-pages.md)。每新增一页都要重发系统提示与全部历史，N 页成本接近 N 次历史重发之和，小页省下的单轮输出被会话级重发吃掉。

检索信号密度不足放大轮数。`workspace.search` 默认 30 条、上限 50 条、总预算 12000 字符，`workspace.list` 默认深度 2 且按字母序排列，无修改时间信号。模型只能先列目录再按文件收窄，同一问题多走两到三轮。搜索与上下文的输出预算见[证据完整性](../bug-fix/2026-09-16-agent-context-search-efficiency.md)，裁剪与尾部保留见[上下文效率](../feature/2026-09-15-context-efficiency.md)。

一致性仪式增加必经轮数。`workspace.edit` 要求整文件 `expectedHash`，行级编辑要求先 `withLineAnchors:true` 再写，旧正文被 prune 成摘要后必须重读才能编辑。诊断跨越三文件时，`LoadedContext` 的三文件元数据提示刚好覆盖不全，重读成为常态。

## Decision

保持无索引、无向量化、无常驻守护进程的轻量底线，只调整输出形状与信号密度，不新增检索子系统。

默认页自适应：100KB 以下文件从 offset 起一次返回全文（仍受 2000 行与 1MB 上限约束）；以上文件默认 800 行与 48KB，上限保持 2000 行与 1MB 不变。16MB 整读上限与 `nextOffset` 续读语义不动，`outputOmitted` 仍从同一起点缩小重读。省略 caps 的调用走自适应分支，显式 `limit`/`maxBytes` 保持原语义，使单测与旧调用的页边界不受影响。

读路径按窗口早停：整文件仍做一次有界读取（16MB 上限内，编辑安全要求全文哈希），但行边界只扫描到窗口末尾，换行计数走字节扫描，全文 `split` 不再发生。哈希覆盖全文，页内容与 `expectedHash` 的等价关系不变。

每个输出带 token 计数与可选预算：`workspace.read`、`workspace.search`、`workspace.list`、`workspace.overview` 统一报告 `estimatedTokens`（ASCII 约 4 字符/token，非 ASCII 保守按 1 字符/token，与 chat-core 的 `estimateContextTokens` 同式，agent-core 内聚一份实现以避免反向依赖）。`maxTokens`（1 至 100000）在页上限之外进一步收紧，超限输出截断并返回原文 token 数、原文条数与缩小指引。预算默认不强制：页上限本身已有界，10K 默认强制会把自适应整文件读重新切碎，与本 Note 的首要目标冲突。长命令复用既有 `background:true` 加 `project_process_output(offsetLines)` 轮询，不新增后台机制。

搜索信号密度：`workspace.search` 内容命中按文件分组为 hunk（聚簇窗口合并，远距 hunk 记跳过行数，单行 300 字符截断，形状见[搜索 hunk 分组](./2026-09-16-search-hunk-groups.md)）并携带该文件的全文 SHA-256；哈希与 `workspace.read` 同函数计算，未变更时与 `workspace.edit` 的 `expectedHash` 等效，定位到修复无需二读（超过 1MB 的文件只给上下文不给哈希，此类文件显式重读）。`mode=files` 先收集全部命名命中再按修改时间倒序取 `maxResults`，字母序只做并列决胜，避免字母截断藏起最近改动的文件。`maxResults` 默认 30 不变、上限放宽到 100；记录预算 12000 字符放宽到 40000 字符（约 10K token），富化后复检保证单次输出不超预算。构建产物目录（`release` 等）退出搜索枚举。

列表与总览：`workspace.list` 条目携带文件大小与秒级修改时间戳，目录优先分组保留，组内按修改时间倒序。新增只读 `workspace.overview`：一次返回浅树（默认深度 2、300 条目）、文件大小、修改时间与 git 摘要（分支、HEAD、staged/unstaged/untracked 计数，10 秒超时失败即省略，非仓库目录无此段），替代诊断开头的盲 `list` 循环。`workspace_overview` 是第 23 个模型工具，契约测试已同步；JanusX 壳侧 `BLUEPRINT_READ_ONLY_MODEL_TOOLS` 白名单同步待定，白名单本身未动。

## Alternatives considered

- Do nothing / reuse：零代码，保留当前单轮最小输出。代价是诊断任务的轮数与历史重发固定存在，十倍输入在跨文件任务复现。
- 直接对齐 opencode 的 2000 行与 50KB 默认页：最强理由是实现最小，一次改两个常量。否决驱动是超大日志与压缩单行文件会把单轮撑爆，自适应页在同样代码量下保留小文件一次达、大文件分页可达的性质。
- 引入常驻索引、向量检索或 LSP 符号服务：最强理由是概念查询一次命中，Codex 生态的 ast-grep 与 CodeRAG MCP 证明该路径在超大仓有效。否决驱动是新增守护进程、配置与缓存失效语义，违背本仓无预载的轻量约束；Codex 本体同样把该层放在可选 MCP 而非核心，核心只保留 shell 与 `apply_patch`。
- Codex 式极简工具面（`exec_command` 加 freeform `apply_patch`，读文件走 `cat` 与 `rg`，输出默认 10000 token 并回原文计数、总行数与会话号，长命令后台轮询；工具渐进披露走本地 BM25 `tool_search`，`AGENTS.md` 分层 32KiB 封顶；源码核验见[codex-cli 工具面调研](../architecture/2026-09-16-codex-cli-tool-surface-survey.md)）：最强理由是工具面最小且输出天然有预算，免去专用读搜工具的 schema 负担。否决驱动是失去结构化输出、审批分类与哈希一致性，`workspace.edit` 的精确替换与 checkpoint 恢复需要重做；本提案只借用其预算形状、后台会话与渐进披露，保留现有工具契约。
- opencode 式全量返回加 instruction 注入（读即 warming LSP、命中即注入规则）：最强理由是定位轮数最少。否决驱动是规则注入随文件数线性膨胀，且模糊锚链的静默纠偏与本仓精确编辑决策冲突，错行写入代价高于一次指引重试。
- 默认强制 10K token 预算：最强理由是与借用的 Codex 形状完全一致。否决驱动是 48KB 默认页与 100KB 自适应整文件天然超过 10K token，默认强制与自适应互斥；页上限已有界，预算只做显式收紧口。

## Consequences

- **Gains**: 600 行单文件定位在同一模型下 1 次 `workspace.read` 覆盖所需行；4 文件诊断的 `workspace.read` 调用数不高于文件数加 2；`mode=files` 与 `workspace.list` 最近修改在前；search 命中哈希在文件未变更时直接用于精确替换编辑；超预算输出携带原文 token 数、原文条数与缩小指引；`workspace.overview` 在 2000 文件仓的返回由一次有界 walk 加一次 git 调用组成，stat 量级与既有 `workspace.list` 同阶。
- **Costs and limits**: 内容搜索对每个命中文件多一次有界读取（1MB 内同读服务上下文与哈希，更大文件只取上下文不给哈希）；`mode=files` 对全部命名命中做 stat（上限 20000 文件）；`workspace.list` 与 `workspace.overview` 对每个列出条目做 stat；早停省的是解码与切分开销，IO 仍以哈希所需的 16MB 有界读取为准；`workspace_overview` 的壳侧白名单同步未完成，只有本仓契约测试覆盖；回看信号是用户抱怨单轮输出变大，届时收紧默认页或给 search 上下文加开关。
- **Verification**: `packages/agent-core` 全量 323 用例通过（1 跳过），命令为在 `packages/agent-core` 执行 `npx vitest run`；`chat-core` 59、`janus-agent` 26、`cli` 353 通过；`agent-core`、`janus-agent`、`chat-core`、`cli` 四包 `npm run typecheck` 通过。600 行单读、`search` 哈希直编、`mode=files` 修改时间倒序、截断形状由 `workspace-tools.test.ts` 新增用例与 `output-budget.test.ts` 锁定。
