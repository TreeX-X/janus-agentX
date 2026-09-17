# Agent Note: 搜索首跳 token 优化

Status: proposed

## Problem

同一“提到即找”任务在 agentX 首轮消耗显著高于 opencode。触发条件是工作开始时路径未知、证据分散：模型必须先建立位置才能读写，首跳输出直接决定后续轮数。放任不管，每个任务都用多轮发现换单轮小输出，总输入随发现轮数超线性增长，首跳慢成为固定税。

根因在三处。发现链过长：系统提示要求形状未知先 `workspace.overview`（默认深度 2、300 条目、逐条 `stat` 加一次 `git` 调用），再 `workspace.search mode=files`，再 `mode=content`，最后 `workspace.read`；三轮历史重发吃掉小页省下的输出。枚举税过重：`workspace.search` 有 `rg` 时仍先 `rg --files` 全量枚举（上限 20000 文件）再按显式文件列表分批调 `rg --json`（每批约 6000 字符路径），超大仓多出一次全仓 walk 加 N 个子进程；`mode=files` 对全部命名命中做 `stat` 排序，内容模式对每个命中文件再做一次有界读求上下文与哈希。输出形状过富：内容命中默认带 `±2` 行 `hunk` 合并与全文 `SHA-256`，记录预算 40000 字符（约 10K token），首跳即打满上下文；分页与哈希契约见[读分页放大量级](../../implemented/bug-fix/2026-09-16-read-paging-token-amplification.md)，分组形状见[搜索 hunk 分组](../../implemented/bug-fix/2026-09-16-search-hunk-groups.md)，输出完整性见[搜索证据完整性](../../implemented/bug-fix/2026-09-16-agent-context-search-efficiency.md)。

## Proposal

保持无向量化、无常驻守护进程默认开启的轻量底线，只调整首跳形状与调用次数，不新增检索子系统为必选项。

单次 `rg` 直透内容搜索。有 `rg` 时 `workspace.search` 不再 `枚举加显式文件列表`，而是将 `path/glob` 直接转成 `rg` 原生 `--glob` 与目标路径单进程执行，`.gitignore` 由 `rg` 自身应用；敏感路径过滤保留在结果侧而非枚举侧。`workspace.search` 的调用方语义不变，`path` 为空即仓根单次扫描。无 `rg` 降级保持现有 Node 字面搜索与明确提示。

首查默认只回命中行。`mode=content` 首跳不带 `±2` 行上下文与文件哈希，只回 `{path, line, text}`（单行保持 300 字符截断）；调用方显式 `withContext:true` 或进入编辑前才回 `hunk` 分组加 `sha256`。`mode=files` 默认 `maxResults` 保持 30 不变，`stat` 只对截断前候选做最近修改排序，避免全量命名命中 `stat`。

首探小预算与暖文件表。`workspace.overview` 保持只读入口地位，但诊断首跳指引改为深度 1 小条目先行，需要再加深；`workspace.list` 默认行为不动。后台可选暖文件表：复用一次 `rg --files` 结果缓存给同会话 `mode=files/glob` 用，显式关闭即回冷启动语义；该表只存路径与目录，不做内容索引。输出预算形状借 codex：超限输出必须带原文条数、原文 token 数与收窄指引，本仓已有 `estimatedTokens/guidance` 契约保持不变。

Codex 与 opencode 的对照结论只借形状。Codex 默认无专用搜索工具：`grep_files/read_file/list_dir` 为 `experimental_supported_tools` 门控，`grep_files` 已在 `openai/codex#15775` 删除，`list_dir` 删除在 `openai/codex#21170` 进行中；模型默认走 `shell/shell_command/exec_command` 跑 `rg`、`rg --files`、`cat`、`sed`，`codex-rs/core/src/tools/spec.rs` 与 `handlers/mod.rs` 为准。Codex 输出天然带预算：`exec_command` 默认 `max_output_tokens=10000`（`tool_output_token_limit` 可放宽），输出体为退出码、耗时、总行数加截断正文（`tools/mod.rs` 的 `format_exec_output_for_model`），长命令以前台预算加后台会话号两次返回，`write_stdin` 沿同一会话轮询；工具渐进披露走本地 BM25 `tool_search`，指令分层走 `AGENTS.md` 最近优先、合并 32KiB 封顶，细节见[codex 工具面调研](./2026-09-16-codex-cli-tool-surface-survey.md)。Opencode 为单次 `rg` 调用：`packages/core/src/ripgrep.ts` 的 `grep` 以 `--json --hidden --no-messages [--glob] -- pattern [file|.]` 单进程执行，流式 `take(limit+1)` 截断，行预览 2000 字符，无二次文件重读；`packages/core/src/filesystem/search.ts` 在会话 scope 后台预取文件表给 `find` 模糊搜索，新层 `fff` 提供 `fileSearch/directorySearch/grep(timeBudgetMs=1500)` 索引加速；`packages/core/src/tool/grep.ts` 只对命中文件做并发 16 的 `stat` 按 `mtime` 倒序，`limit=100`，输出为 `Found N (showing first 100)` 加 `path:` 与 `Line N: text`。借用清单为单次调用、命中行优先、后台文件表三项；`shell` 直透读文件与 freeform 编辑两项不借，本仓保留结构化审批、哈希一致性与 checkpoint 恢复。

## Alternatives considered

- 直接对齐 opencode 默认页与输出：将 `workspace.read` 默认改成 2000 行与 50KB，`workspace.search` 去上下文与哈希。最强理由是改两处常量即达首跳最小。否决驱动是超大日志与压缩单行文件把单轮撑爆，且编辑哈希直用能力丢失，定位到修复仍需二读。
- 引入常驻索引、向量检索或 LSP 符号服务：最强理由是概念查询一次命中，`ast-grep` 与 CodeRAG MCP 在超大仓有效。否决驱动是新增守护进程、配置与缓存失效语义，违背本仓无预载轻量约束；opencode 把该层放在可选 `fff` 而非核心，codex 本体同样把该层放在可选 MCP 而非核心。
- Codex 式 `shell` 直通面：最强理由是工具面最小，提示词与模型原生 `rg` 知识对齐，免去专用读搜工具的 schema 负担。否决驱动是失去结构化输出、审批分类与哈希一致性，`workspace.edit` 的精确替换与 checkpoint 恢复需要重做；本提案只借用其预算形状、后台会话与渐进披露。
- 默认强制 10K token 预算：最强理由是与 codex 形状完全一致。否决驱动是 48KB 默认页与 100KB 自适应整文件天然超过 10K token，默认强制与自适应互斥；页上限已有界，预算只做显式收紧口。
- Do nothing / reuse：零代码，保留当前首跳富输出与发现链。代价是首跳大 token 与多轮发现固定存在，跨文件任务复现用户抱怨；回看信号是首跳输出被截断抱怨或单轮变大抱怨二选一，届时再收紧默认页或给上下文加开关。

## Acceptance criteria

- [ ] `workspace.search` 有 `rg` 时单进程直透可复现：`rg --files` 枚举不再出现在内容搜索热路径，`path/glob` 转原生 `--glob`，敏感过滤在结果侧生效。
- [ ] 首跳默认命中行：无 `withContext` 的内容搜索不回 `hunks/sha256`，显式上下文调用才回分组加哈希且哈希可直接用于 `workspace.edit expectedHash`。
- [ ] 首跳调用数可测：600 行单文件定位 1 次 `workspace.read` 覆盖所需行；4 文件诊断的 `workspace.read` 调用数不高于文件数加 2；`mode=files` 最近修改在前由 `workspace-tools.test.ts` 新增用例锁定。
- [ ] 超限形状不变：截断输出携带原文条数、原文 token 数与收窄指引，`output-budget.test.ts` 覆盖。

## Risks

- 单次 `rg` 直透需要把敏感路径政策从枚举侧移到结果侧，遗漏即越界读取；缓解是结果侧保持现有 `isSensitivePath` 拒绝并补用例。
- 命中行优先可能让聚簇证据缺上下文而多一轮追读；缓解是编辑前上下文调用保持一次达，`gapBefore` 语义不动。
- 暖文件表引入会话级缓存失效语义；缓解是默认小仓才启用感知的后台预取，大仓保持冷启动，关闭开关可回退。
- 记录日为 2026-09-17，codex 与 opencode 的 HEAD 引用随版本漂移，重访需重核 `spec.rs`、`ripgrep.ts`、`search.ts` 路径与默认值。
