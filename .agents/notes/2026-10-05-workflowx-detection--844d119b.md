---
schema: harness-note/1
id: 844d119b-8dd7-423c-9981-fba6b7726ec6
kind: decision
lifecycle: implemented
created: 2026-10-05
class: architecture
tags: [agentX, workflowx, configuration]
codeRefs:
  - repoId: 62b44166-82f0-41ff-838d-e2b02388ed06
    path: packages/node-hosts/src/workflowx-detection.ts
    role: entry
relations:
  - type: related-to
    target: note://62b44166-82f0-41ff-838d-e2b02388ed06/ac75da81-9c0e-4ad2-964b-4919d924fe0e
---

# WorkflowX 导入检测由 agentX 统一提供

## Problem

外部开发工具可以复用 Claude 或 Codex 的 WorkflowX 配置，终端名称不能说明约束是否存在。仅检查目录会把普通工具配置误报为 WorkflowX，校验完整文件清单和版本又要求宿主随每次 WorkflowX 更新适配。全局部署还可能只包含技能，没有工作区根目录指令。

## Decision

node-hosts 导出 `detectWorkflowX` 与检测结果类型。宿主传入当前工作区路径，检测器合并用户全局目录和工作区根目录的证据，任一 Claude 或 Codex 来源命中即返回 detected。没有工作区时仍检测全局；环境变量 CODEX_HOME、CLAUDE_CONFIG_DIR 与显式目录参数支持自定义位置。宿主自行安排刷新及展示。

有效证据包括实际指令入口中的完整 wfx-managed 标记、部署在 skills/orchestrateX/SKILL.md 且 frontmatter 声明 orchestrateX 的技能，以及带 WorkflowX 名称、官方 repository 身份和安装或启用记录的插件。Claude 插件使用 installed_plugins.json 和 settings 的启用状态；Codex 插件使用 config.toml 的 plugins 表与已知缓存布局。工作区专属安装只适用于记录的 projectPath。配置明确停用、孤立缓存、旧文字引用、损坏或无法读取的候选配置返回 uncertain。找不到证据返回 missing。已识别的独立来源优先于另一来源的不确定性。

检测器忽略 README、示例代码块、普通配置目录和 Note 身份文件，不校验版本、摘要、技能数量或完整安装文件清单。Codex 的 AGENTS.override.md 按非空优先规则遮蔽同层 AGENTS.md。扫描仅涉及已知入口与插件缓存的固定层级，每个文件最多读取 256 KiB，每个目录最多枚举 100 项，每次最多 256 次文件或目录读取；超过边界保留 uncertain。

[统一运行时边界](./2026-10-05-workflowx-runtime--ac75da81.md)规定工程能力所有权；[Janus 展示要求](note://972afef3-2fc7-49de-a3ee-7e041225d28c/b69b7ec5-cbf6-4242-bd29-3b48703979c5)规定 Island 提醒和自动检测触发。

## Alternatives considered

- 复用目录存在检查：成本最低，但无法区分普通 Claude/Codex 配置与 WorkflowX 导入；保持不检测则用户无法发现配置缺口。
- 检查完整配置、版本和每个技能：能够发现安装损坏，但会将工作流演进变成宿主适配任务，超出导入识别的职责。
- 分别按每种终端实现：可针对特定工具判断实际加载，但不能覆盖工具复用其他格式配置的行为，也重复维护通用检测。

## Consequences

检测结果只说明配置身份，不保证进程加载、项目可信、技能完整、实际遵循工作流或自动维护 Note。插件格式改变、非标准位置和未扫描的祖先目录可能需要手动确认；实际配置体系改变时再扩展入口识别。检测器不执行脚本、不启动终端、不联网、不安装配置，也不返回配置内容或认证信息。宿主需要处理请求竞态、异常文案与非打扰展示。

验证入口为 `npm test --workspace=@janus-agent/node-hosts -- --maxWorkers=2`，59 项通过；其中 packages/node-hosts/tests/workflowx-detection.test.ts 的 23 项覆盖全局、工作区、覆盖入口、插件身份、停用、示例误报、异常和目录自定义。`npm run build --workspace=@janus-agent/node-hosts` 通过，验证公开类型及构建。Janus 的 checkNotes 对这两篇共享 Note 检查无错误；共享仓库其他历史 Note 保留 6 项旧链接或版本文字诊断。真实外部工具的运行时加载不属于此接口的验证结论。
