# Agent Note: 模型窗口周检只比权威源

Status: implemented

## Problem

周检 `model-limits` 对照 models.dev 全量目录判定漂移，网关转售目录的截断窗口、图像与音频变体的小窗口、嵌入模型的极小窗口全部计入 `UNSAFE`，`kimi-k3` 的 `1000000/1048576/1050000` 单位换算也计入溢出。远端定时运行以 `230 unsafe` 变红，本地复现为 `229` 且日间漂移，`--apply-safe` 按最小值下调会把 `gemini 1M` 砍到 `32k`、`qwen 32k` 砍到 `8k`，不可执行。

## Decision

比较核只采信权重与文档拥有方的 provider 名单（`openai`、`anthropic`、`google`、`deepseek`、`moonshotai`、`mistral`、`alibaba`、`zai`、`volcengine`、`minimax`、`xai`、`meta` 等，见 `AUTHORITATIVE_PROVIDERS`），输出限定纯文本单模态，模型名含 `embed` 的行跳过，表值与文档差 `<=5%` 视为舍入一致。网关与非聊天行计入 `skipped` 计数，不进入 `UNSAFE/LOW/UNCOVERED`。子家族真差异落为特异前缀行（`gpt-5.2-chat`、`gpt-5.3-chat`、`deepseek-r1-distill`、`qwen-mt`、`qwen-math`、`glm-4.5v` 等），最长前缀在运行时与检查侧一致生效。拉取失败重试三次并设 `30s` 超时，工作流失败上传漂移报告。

## Alternatives considered

- 全量目录照旧比较 — 零代码；但网关截断与变体窗口让周检永久变红，信号不可用，故拒绝。
- `--apply-safe` 一键下调消红 — 最省事；但路由器最小值会摧毁大窗口预算（`gemini/minimax/qwen` 全被砍到变体下限），故拒绝。
- `continue-on-error` 置灰周检 — CI 变绿最快；但溢出真信号与误报一起被丢掉，只适合止血，故拒绝。
- Do nothing / reuse — 维持现状；代价是每周红且无人敢动表，见远端 `34864338820` 记录，故拒绝。

## Consequences

- **Gains**: 同一真实源复测 `UNSAFE` 归零，`LOW 223` 与 `UNCOVERED 58` 全部来自权威纯文本模型，可逐条人工复核；`7303` 行网关与非聊天行以 `SKIPPED` 明示去向。`packages/cli/tests/model-limits-update.test.ts` 锁定白名单、纯文本与容差规则，`model-limits.test.ts` 锁定新增特异行的最长前缀。
- **Costs and limits**: 新增拥有方或家族需要同步维护 `AUTHORITATIVE_PROVIDERS` 与表行，否则新模型只进 `UNCOVERED` 或被跳过；`5%` 内容差可能掩盖权威源的小幅真实下调，复核信号是连续两周同前缀 `LOW` 反转或文档公告，届时收紧容差或补特异行。
