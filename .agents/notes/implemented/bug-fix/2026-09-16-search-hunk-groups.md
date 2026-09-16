# Agent Note: 搜索命中按文件成 hunk

Status: implemented

## Problem

内容搜索对每个命中独立挂载上下各两行上下文。聚簇命中把同样的行发送多次，并把路径与文件哈希重复同样多次：60 个连续命中把约 64 个唯一行展开成约 240 行份拷贝，`sha256` 重复 60 次。100 条封顶输出是一张扁平列表，近重复证据淹没真正的文件级答案（哪些文件、哪些区域）。放任不管，读分页 Note 的富化投入（每文件一次有界读取）把预算花在重复行上，截断态输出维持噪声形态。

## Decision

内容命中按文件分组，文件顺序沿扫描顺序不变：`{path, matchCount, hunks[], sha256?}`。重叠或相接的 ±2 行窗口合并，2 行以内的间隔吸收为普通上下文，更大的跳跃记为显式 `gapBefore` 行数。hunk 行形为 `{line, text, hit}`，展示文本沿用 300 字符截断，文件末尾换行产生的空尾段不渲染。`matchCount` 跟随展示的 hunk；工具层 `totalResults` 保持截断前命中总数，契约不变。trace 与 prune 交接的摘要按 `matchCount` 计命中，扁平形状（`mode=files` 与历史数据）回落为单条计数，两种形状可读。

生成物过滤补齐：`SKIP` 新增 `release`。原生 rg 路径在仓库内本就经 `.gitignore` 排除构建产物，硬编码补齐覆盖 Node 降级路径与非仓库检出。`package-lock.json` 这类文件保持可搜（依赖版本查询需要它），双后端既有的 512KB 单文件扫描上限继续约束其成本。

## Alternatives considered

- Do nothing / reuse：零代码，保持每命中独立上下文。代价是预算花在重复行上，100 条封顶输出维持扁平噪声形态，富化读取的投入只解决"有没有上下文"，不解决"上下文发了几遍"。
- 每文件命中封顶（如每文件 25 条）：最强理由是文件间公平，防单个文件吃掉全部名额。否决驱动是与 `maxResults` 契约冲突（点名要某文件 60 条只给 25 条）；单文件淹没需要 100 个以上 512KB 内命中，全局上限已有界。回看信号是截断输出长期被单一路径主导，届时再加。
- 所有间隔一律 gap 标记（含 1 至 2 行）：最强理由是形状统一。否决驱动是标记本身比被跳过的行更贵，2 行以内直接吸收，总字符更少。
- 只去重哈希、保留扁平命中：省每命中 64 字符，但上下文重复是更大的浪费；分组一次解决两处。

## Consequences

- **Gains**: 聚簇证据只发送一次；封顶输出读作"文件 × 区域"；`gapBefore` 让不连续显式化而不为跳过的行付费；换行空尾段不再渲染；`release/` 产物退出 Node 降级搜索。
- **Costs and limits**: 内容模式输出契约变化，`matches` 元素从扁平命中变为文件分组（`mode=files` 的扁平 `{path}` 不变）；chat-core 两处摘要同时兼容新旧形状；hunk 合并是已读缓冲上的 O(命中数) 后处理，无新增 IO；扫描与富化之间文件若变化，保留扫描侧命中文本并锚定其行号（与既有过期同类，写侧仍由编辑哈希守卫）。
- **Verification**: `packages/agent-core` 全量通过（含新增 hunk 合并、gap 标记、无重复行用例），命令为在 `packages/agent-core` 执行 `npx vitest run`；`chat-core`、`janus-agent` 全量通过，`cli` 相关（tool-display、trace-preview、session-tools）通过；`agent-core`、`chat-core`、`janus-agent`、`cli` 四包 `npm run typecheck` 通过。
