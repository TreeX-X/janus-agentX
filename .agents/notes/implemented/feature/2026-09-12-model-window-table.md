# Agent Note: CLI 模型窗口内置表（丢弃 16384 一刀切）

Status: implemented

## Problem

CLI 的 `ModelResolverPort.resolve` 从不返回窗口，`ChatSessionRuntime.buildContext` 对一切模型回落到 `16384` 预算。1M 窗口的模型被提前几十倍裁剪，256k 与 1M 共用同一阈值，自动压缩的触发点与所选模型无关。`ProviderEntry` 没有地方声明窗口，`config.json` 也没有覆盖字段。

## Decision

窗口解析收敛在 `packages/cli/src/model-limits.ts` 的 `resolveModelLimits`，纯函数、无 IO。优先级为配置覆盖大于内置家族表大于保守回落：provider 条目自带的 `contextWindow/maxOutputTokens` 直接获胜；否则按小写 id 做家族前缀匹配（最长优先，`gpt-4o` 同时覆盖 `gpt-4o-mini`）；未知 id 回落到与 `ChatSessionRuntime` 一致的 `16384/2048` 并标记 `estimated`。`CliSession.rebuildTransport` 把解析结果写入每次 `resolve` 的返回值，切模型下一 turn 即按新窗口预算。`/status` 展示 `context` 行，未知模型明示 `estimated` 并指引到配置覆盖。非法覆盖值（非正整数）在 `parseCatalog` 消毒时丢弃，查询侧把非正数当缺失处理。

## Alternatives considered

- 运行时拉取 models.dev 保持新鲜 — 表永远最新；但用户机器多一个网络依赖与缓存失效语义，首版为轻量拒绝，刷新留在发版脚本侧。
- 按模型自适应学习天花板 — 越用越准，零维护；但引入持久状态与收敛逻辑，与最优简易的设计方向冲突。
- 纯反应式（只在 overflow 时压） — 零表零维护；但每次压缩先浪费一次失败调用，长 tool 链体验差。
- 预算制（固定 token 上限，与窗口解耦） — 简单且省钱；但已知模型的真实上限被浪费，用户也不知道该设多少。
- Do nothing / reuse — 维持 16384 一刀切，零代码；代价是窗口解析缺失时压缩阈值对大模型系统性偏早，长会话无从谈起，见 [context-compaction](../../proposed/feature/2026-09-12-context-compaction.md)。

## Consequences

- **Gains**: 已知家族（`gpt-4o/4.1/5`、`o1/o3`、`claude`、`gemini`、`deepseek`、`qwen`、`llama`、`mistral`、`glm`）按文档窗口预算，`packages/cli/tests/model-limits.test.ts` 锁定 9 条 precedence 与匹配规则；`/status` 对猜测值诚实标注，覆盖路径可测。
- **Costs and limits**: 表值只在存疑时保守偏小，provider 单方面改窗口或新模型缺条目时靠提前 `buffer` 与 overflow 重试兜底；表更新靠手工对照 models.dev 发版时同步，无自动刷新脚本，条目过期时由用户覆盖先行承担。
