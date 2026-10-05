---
schema: harness-note/1
id: ac75da81-9c0e-4ad2-964b-4919d924fe0e
kind: decision
lifecycle: implemented
created: 2026-10-05
class: architecture
tags: [agentX, workflowx, tools, harness, mcp]
codeRefs:
  - repoId: 62b44166-82f0-41ff-838d-e2b02388ed06
    path: packages/janus-agent/src/workflowx.ts
    role: entry
  - repoId: 62b44166-82f0-41ff-838d-e2b02388ed06
    path: packages/harness-node/src/note-service.ts
    role: implementation
  - repoId: 62b44166-82f0-41ff-838d-e2b02388ed06
    path: packages/node-hosts/src/mcp.ts
    role: implementation
relations:
  - type: related-to
    target: note://972afef3-2fc7-49de-a3ee-7e041225d28c/bd7fd0c6-48d1-4d1c-8c6b-b675d7e489bd
---

# agentX 统一工程能力与内置 WorkflowX

## Problem

CLI 与桌面分别维护 Note 服务、工具适配和压缩逻辑，会让同一工程操作得到不同校验与结果。仅加载 WorkflowX 文档不能使会话识别执行模式，也不能提供独立任务会话与可核实的验证回执。宿主又需要保留蓝图关注、高亮等产品扩展，因此共享边界必须同时支持能力复用和显式扩展。

## Decision

agentX 拥有通用工程能力。agent-core 提供读写工具、运行策略、可扩展工具清单与嵌套参数校验；chat-core 提供基础会话压缩及带检查点、原始引用的 ManagedChatSession；harness-core 提供 Note 创建和结构化编辑；harness-node 提供缓存索引、读取、事务、监听、共享导入、撤销与 NoteChatEditor；node-hosts 提供命令、Git、Note 工具和 MCP 连接。CLI 与桌面从这些包导入实现。宿主通过 registry、会话和事件端口叠加自己的能力。

WorkflowX 在附带工作区的普通工程会话中默认使用 xdo。用户输入 `/xdo`、`/xdel`、`/xflow` 切换模式，也可在命令后直接附带需求。只有用户消息改变模式；宿主在历史压缩前从完整消息解析模式，摘要和工具输出不能切换模式。裸命令在共享入口不调用模型。受限维护会话仍以调用者的工具集合为边界。

xdo 注入搜索已有 Note、原地同步、验证、自审及代码与 Note 同提交的规则。运行时根据成功工具回执提示缺少的 Note 归档、修改后检查与 Git 提交。此提示不阻塞旧项目；命令成功不等于验收覆盖，脚本内部行为、反向引用与同提交关系仍需自审，不能将提示消失视作形式化通过。

xdel 和 xflow 通过 `workflow_execute` 消费已接受且具备 scope、acceptanceRefs 和 verification 的任务 Note。执行器固定契约和输入，持有租约，每次实现、命令检查及评审使用独立运行会话，继承宿主审批和工具限制。xdel 只做实现者自审；xflow 额外做独立只读评审，最多自动返修一次。未提供子会话能力、取消、工具失败、检查失败或回执不匹配均不能冒充完成。主会话不能直接调用工程写文件、任意命令或 MCP 绕过任务范围。

验证完成与 Git 落地分开。执行结果返回 closeout 状态，主会话将范围内代码、任务 Note 和证据一起提交，再用 `workflow_execute` 的 `action: status` 核实落地。父会话仍可操作 Note、Git 提交及宿主展示工具；共享执行器不把验证成功表述为已提交。

MCP 从用户目录 `~/.janus/mcp.json` 的 `mcpServers` 读取配置，支持 stdio 和 Streamable HTTP。工作区文件不自动成为可执行配置。发现的工具以稳定名称注册并经现有 runtime 执行，服务端只读注解不改变网络操作的审批策略。工具参数支持明确的 JSON Schema 子集；不支持的约束使该服务连接失败，状态工具显示失败而不泄露环境变量或请求头。连接关闭注销工具，取消传播到远端调用。

`note.init` 暴露最小初始化预览和按预览标识应用。共享 API 支持同进程撤销，拒绝伪造或改动后的预览、覆盖现有身份、链接路径和已改动的初始化文件；出现额外 Notes 时拒绝撤销身份。完整 WorkflowX 配置安装、启动设置页与蓝图空态引导属于后续产品工作。

[Janus 的复用边界](note://972afef3-2fc7-49de-a3ee-7e041225d28c/bd7fd0c6-48d1-4d1c-8c6b-b675d7e489bd)记录蓝图扩展和宿主接线。

## Alternatives considered

- 两个宿主分别实现：能够独立调整体验，但底层缺陷修复与参数校验需要重复维护。宿主差异通过端口处理。
- 所有产品能力都放进 agentX：接入最少，却使引擎依赖蓝图和界面状态，限制独立 CLI 与其他宿主复用。
- Do nothing / reuse：只复用已有循环并依赖提示词文件，改动最少，但不能解决共享 Note 服务、模式切换、MCP 和实际任务派发的缺口。

## Consequences

共享包需要按依赖顺序构建；根 `npm run build` 提供明确顺序。工具扩展不要求在引擎里登记产品名称，嵌套参数与 provider 名称冲突在注册时校验。桌面安装后修改依赖产物的补丁机制不属于支持路径。

MCP 启动配置变更需重新建立宿主连接；本实现不提供设置 UI 或完整 JSON Schema 解释器。初始化预览不跨进程保存。任务执行器依赖结构化模型评审，无法解析的评审明确失败。xdo 的机械检查是回执提示；若需要强制验收与范围隔离，使用任务 Note 支持的委派模式。扩展 schema 子集、收紧 xdo 或增加初始化档位时，应以真实服务或产品需求为触发条件。

验证命令为根目录 npm test --workspaces --if-present -- --maxWorkers=3，八个包合计 1,109 项通过，1 项按环境跳过。补充测试覆盖 1 项子会话权限继承和 2 项 CLI 端到端委派，包含实际文件写入、审批、命令执行、自审和独立评审。MCP 使用与 Janus 相同的 SDK 版本，并通过 3 项真实 stdio 调用、拒绝与取消测试。初始化有 4 项预览、冲突和撤销测试；标准范围、漂移及 Git closeout 由现有 harness 测试覆盖。Janus 侧使用自己的服务、工具和压缩测试验证消费兼容。真实远端 MCP、生产模型调用和安装器发布未作为本次机器验证证据。
