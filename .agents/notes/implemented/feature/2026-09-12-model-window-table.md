# Agent Note: CLI 模型窗口内置表（丢弃 16384 一刀切）

Status: implemented

## Problem

CLI 的 `ModelResolverPort.resolve` 从不返回窗口，`ChatSessionRuntime.buildContext` 对一切模型回落到 `16384` 预算。1M 窗口的模型被提前几十倍裁剪，256k 与 1M 共用同一阈值，自动压缩的触发点与所选模型无关。`ProviderEntry` 没有地方声明窗口，`config.json` 也没有覆盖字段。

## Decision

窗口解析收敛在 `packages/cli/src/model-limits.ts` 的 `resolveModelLimits`，纯函数、无 IO。行数据住在 `packages/cli/src/model-limits.table.ts`（40 行前后缀，最长优先，特异 SKU 压住家族，`kimi-k3` 压住 `kimi-k2`，`o1-mini` 压住 `o1`）。优先级为配置覆盖大于内置行大于保守回落：provider 条目自带的 `contextWindow/maxOutputTokens` 直接获胜；否则按小写 id 做前缀匹配；未知 id 回落到与 `ChatSessionRuntime` 一致的 `16384/2048` 并标记 `estimated`。`CliSession.rebuildTransport` 把解析结果写入每次 `resolve` 的返回值，切模型下一 turn 即按新窗口预算。`/status` 展示 `context` 行，未知模型明示 `estimated` 并指引到配置覆盖。表的新鲜度由 `scripts/update-model-limits.mjs` 承担，零依赖、无运行时流量：默认对照 models.dev 全量目录输出三类漂移（UNSAFE 表高过文档有溢出风险、LOW 表低过文档压早了待人工看、UNCOVERED 无前缀命中是新行候选）。`--apply-safe` 只自动下调不安全的行到文档最小值，从不上调、不新建——上调与新建改变 blast 半径，永远人工进。CI 每周跑 `--check`，UNSAFE 即红；比较核在 `scripts/model-limits-diff.mjs`，由单测直接锁定。非法覆盖值（非正整数）在 `parseCatalog` 消毒时丢弃，查询侧把非正数当缺失处理。

## Alternatives considered

- 运行时拉取 models.dev 保持新鲜 — 表永远最新；但用户机器多一个网络依赖与缓存失效语义，故只允许开发机与 CI 时拉取，运行时永远只读随仓表。
- 按模型自适应学习天花板 — 越用越准，零维护；但引入持久状态与收敛逻辑，与最优简易的设计方向冲突。
- 纯反应式（只在 overflow 时压） — 零表零维护；但每次压缩先浪费一次失败调用，长 tool 链体验差。
- 预算制（固定 token 上限，与窗口解耦） — 简单且省钱；但已知模型的真实上限被浪费，用户也不知道该设多少。
- Do nothing / reuse — 维持 16384 一刀切，零代码；代价是窗口解析缺失时压缩阈值对大模型系统性偏早，长会话无从谈起，见 [context-compaction](../../proposed/feature/2026-09-12-context-compaction.md)。

## Consequences

- **Gains**: 已知家族与特异 SKU（`gpt-5.6 1.05M`、`deepseek-v4 1M`、`kimi-k3 1M`、`qwen3-coder 256k`、`doubao 128k起`、`glm-5 200k`）按文档窗口预算，`packages/cli/tests/model-limits.test.ts` 锁定 precedence、特异性与表不变量，`packages/cli/tests/model-limits-update.test.ts` 锁定比较核；`/status` 对猜测值诚实标注，覆盖路径可测。
- **Costs and limits**: 表值只在存疑时保守偏小，provider 单方面改窗口时 `--apply-safe` 只自动下调、上调与新行永远人工进，周 CI 即红即修；全自动重写被拒绝，映射判断（API 值还是权重值、provider 加码还是文档值）需要人类，codex 与 opencode 的 stale 表事故已经证明静默同步会烧到用户。
