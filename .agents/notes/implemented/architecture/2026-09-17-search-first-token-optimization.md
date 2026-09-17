# Agent Note: 搜索首跳 token 优化

Status: implemented

## Problem

同一“提到即找”任务在 agentX 首轮消耗显著高于 opencode。触发条件是工作开始时路径未知、证据分散：模型必须先建立位置才能读写，首跳输出直接决定后续轮数。放任不管，每个任务都用多轮发现换单轮小输出，总输入随发现轮数超线性增长，首跳慢成为固定税。

根因在三处。发现链过长：系统提示要求形状未知先 `workspace.overview`（默认深度 2、300 条目、逐条 `stat` 加一次 `git` 调用），再 `workspace.search mode=files`，再 `mode=content`，最后 `workspace.read`；三轮历史重发吃掉小页省下的输出。枚举税过重：`workspace.search` 有 `rg` 时仍先 `rg --files` 全量枚举（上限 20000 文件）再按显式文件列表分批调 `rg --json`（每批约 6000 字符路径），超大仓多出一次全仓 walk 加 N 个子进程；`mode=files` 对全部命名命中做 `stat` 排序，内容模式对每个命中文件再做一次有界读求上下文与哈希。输出形状过富：内容命中默认带 `±2` 行 `hunk` 合并与全文 `SHA-256`，记录预算 40000 字符（约 10K token），首跳即打满上下文；分页与哈希契约见[读分页放大量级](../bug-fix/2026-09-16-read-paging-token-amplification.md)，分组形状见[搜索 hunk 分组](../bug-fix/2026-09-16-search-hunk-groups.md)，输出完整性见[搜索证据完整性](../bug-fix/2026-09-16-agent-context-search-efficiency.md)。

## Decision

内容搜索走单次 `rg` 直透。`searchWorkspace` 不再 `枚举加显式文件列表`，而是将 `path` 或定界文件直接作为单次 `rg --json` 的扫描目标，随 `--hidden --no-require-git --max-filesize --max-count` 与 `SKIP` 加敏感路径的 best-effort `--glob` 排除一次执行；用户 `glob` 只在结果侧经 `matchesGlob` 生效，正向 `glob` 永不覆盖 `.gitignore`。命中上限与输出预算在流式消费侧强制执行，超限即杀掉子进程，与 `take(limit+1)` 同形。`scannedFiles` 改为 `rg --json` 的 `end` 事件计数，与扫描文件数同义。无 `rg` 时沿用有界 Node 降级（字面搜索、文件筛选、明确提示不应用 ignore 文件），正则请求仍明确要求安装 `rg`。

首查默认只回命中行。`mode=content` 默认返回扁平 `{path, line, text}`，不做逐文件有界读，不算哈希；`withContext:true` 才按文件分组为 `hunk` 并携带全文 `SHA-256`，该哈希与 `workspace.read` 同函数计算，未变更时与 `workspace.edit` 的 `expectedHash` 等效。`workspace.search` 的工具 schema 与模型侧 `workspace_search` 参数同步新增 `withContext`，默认 `false`；文件模式形状不变，仍先收集全部命名命中再按修改时间倒序。系统提示改写为命中优先：未知路径先 `mode=files` 加 `glob`，内容首查用扁平命中加 `path/glob` 过滤，仅当需要上下文或文件哈希才传 `withContext:true`；总览改为浅深度先行、按需加深。剪枝摘要兼容新旧两种形状（扁平命中读 `line`，分组读首个 `hit` 行），`countSearchHits` 对扁平与分组双形状可读。

敏感过滤以结果侧为准。`rg` 侧排除只避免主动打开被排除文件，`eligible()`（敏感路径、`SKIP` 段、用户 `glob`）决定模型可见的每一条命中；`.env` 与 `node_modules` 命中在结果侧丢弃但仍计入 `scannedFiles`。会话级暖文件表不设：带 TTL 的枚举缓存把新建文件挡在结果外最长一个 TTL 窗口，一次失败用例证明该窗口不可接受，枚举保持每次现算。

## Alternatives considered

- 枚举加分批保持现状：最强理由是零代码，且显式文件列表让 `rg` 永不打开政策排除文件。否决驱动是超大仓固定多出一次全仓枚举加 N 个子进程，首跳慢与本 Note 目标直接冲突；现方案以 `rg` 侧 best-effort 排除加结果侧权威过滤替代，`isSensitivePath` 拒绝保持不变。
- 会话级暖文件表（15 秒 TTL、同域复用一次 `rg --files` 结果）：最强理由是重复定位调用零枚举开销。否决驱动是实测失败：同一目录内先搜后建文件，缓存命中导致新建文件在 TTL 窗口内不可见；正确性优先于该笔节省，不设该状态，重访信号是重复 `mode=files` 调用在实测中成为主导成本。
- 直接对齐 opencode 默认页与输出：将 `workspace.read` 默认改成 2000 行与 50KB，`workspace.search` 去上下文与哈希。最强理由是改两处常量即达首跳最小。否决驱动是超大日志与压缩单行文件把单轮撑爆，且编辑哈希直用能力丢失，定位到修复仍需二读；本决策保留 `withContext` 一次达。
- Codex 式 `shell` 直通面：最强理由是工具面最小，提示词与模型原生 `rg` 知识对齐。否决驱动是失去结构化输出、审批分类与哈希一致性，`workspace.edit` 的精确替换与 checkpoint 恢复需要重做；本决策只借用其预算形状（原文条数、原文 token 数、收窄指引），见[codex 工具面调研](../../proposed/architecture/2026-09-16-codex-cli-tool-surface-survey.md)。
- Do nothing / reuse：零代码，保留首跳富输出与发现链。代价是首跳大 token 与多轮发现固定存在，跨文件任务复现用户抱怨。

## Consequences

- **Gains**: 内容搜索的 `rg` 调用数恒为 1（此前为 1 次枚举加按 6000 字符分批的 N 次）；默认命中不再 paying 逐文件有界读与哈希计算，首跳输出从 `hunk` 分组回到命中行；`withContext:true` 的定位到修复仍无需二读（1MB 内文件哈希直用）；系统提示把总览首跳收敛到浅深度。
- **Costs and limits**: `scannedFiles` 在 `rg` 路径下为 `end` 事件计数，早停时只计已扫描部分；`rg` 侧排除是 best-effort，权威语义在结果侧，极端敏感命名若未列入排除表仍会被 `rg` 打开一次但永不返回；`withContext` 的逐文件有界读与 `mode=files` 的全量命名命中 `stat` 保留原开销，按需触发；默认命中行缺上下文，聚簇证据的追读由一次 `withContext` 调用补齐。
- **Verification**: `packages/agent-core` 全量 332 通过、1 跳过（既有跳过），含新增命中优先、ignore 生效、敏感排除、重复搜索稳定用例与 `workspace-search-passthrough.test.ts` 的 5 个模拟 `rg` 用例（单进程、结果侧过滤、`glob` 不透传、超限早停、`withContext` 分组加哈希），命令为 `npx vitest run`；`chat-core` 59、`janus-agent` 26、`cli` 353 通过；八个 workspace `npm run typecheck` 通过。`rg` 未随本仓安装，单透传路径由模拟 `rg` 用例覆盖，真机 `rg` 路径待有 `rg` 环境复核。
