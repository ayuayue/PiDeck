# Pi CLI 兼容性记录

> 这是一份**兼容账本**，不是 PiDeck 的功能设计文档。每次升级 Pi CLI 时，先把上游行为、PiDeck 处理方式和兼容代码的移除条件记在这里。
>
> 模型能力、思考档位和多模态配置的详细链路与重构方案见 [`docs/pi-model-capability-plan.md`](./pi-model-capability-plan.md)。

## 当前基线

- 最近核对版本：`pi 0.85.0`（2026-09-04 发布）
- PiDeck 通信方式：`pi --mode rpc`，stdio JSON-RPC
- 本记录范围：Pi 后端（`src/main/pi/`）以及 PiDeck 对 Pi 配置/事件的适配
- 不包含：DSH 的 `pwsh_persistent`、Electron 自带终端、PiDeck 自己的应用更新器
- 当前原则：PiDeck 不替 Pi 管理内置工具选择，不自动安装 PowerShell 7，不向 Pi 传硬编码 `--tools` 白名单。

## 0.85.0 适配矩阵

| 上游变化 | PiDeck 处理 | 状态 | 代码/验证 | 兼容代码移除条件 |
|---|---|---|---|---|
| Anthropic transports 持久化每轮 thinking effort，安全恢复 signed-thinking mismatch | PiDeck 的思考选择器走 `get_available_thinking_levels` + `set_thinking`，effort 持久化是 Pi 内部行为 | 已确认 | `thinkingLevels.ts`、`AgentManager.setThinking` | 不适用；RPC 边界无变化 |
| SDK 新增 `SessionManager.inMemory()` 恢复外部管理会话 | PiDeck 只走 stdio JSON-RPC，不使用 pi SDK | 无需改动 | Pi RPC 边界 | 不适用 |
| 新增继承模型设置 `vllmPriority` / `supportsMaxOutputTokens` | PiDeck 配置模板/模型编辑不写这两个字段，pi 读取自己的 models.json；catalog 提取字段集合不含它们，无需新逻辑 | 已确认 | `generate-pi-ai-catalog.mjs`、`ConfigManager` | 不适用 |
| provider stream 事件序列与自定义 tool-call delta 修复 | PiDeck 流式投影已兼容 delta-only `message_update`，本次修复不改变事件形状 | 已确认 | `AgentManager.handleAssistantMessageEvent()` | 保留 delta-only 处理；不要恢复依赖 partial 的逻辑 |
| 恢复 `@earendil-works/pi-coding-agent/client` 入口 | PiDeck 不使用该入口 | 无需改动 | Pi SDK 边界 | 不适用 |
| Qwen Token Plan Individual catalog 补入 Qwen3.8 Flash | catalog artifact 重新生成（pi-ai 0.85.0）后自动获得 | 已完成 | `resources/pi-ai-catalog.json`、`tests/adaptiveModelTemplate.test.mjs` | 与主进程 catalog 升级同步完成 |
| Baseten GLM-5.2 不再误报图像输入 | catalog artifact 重新生成后 `input` 字段已修正 | 已完成 | `resources/pi-ai-catalog.json`（GLM-5.2 `input: ["text"]`） | 与主进程 catalog 升级同步完成 |
| 继承 NO_PROXY 根域/子域匹配修复 | PiDeck 只透传 `NO_PROXY` env（`PiLocator`/`sessionProxyPolicy`），匹配逻辑在 pi 内部 | 无需改动 | `PiLocator.createProcessEnv()` | 不适用 |
| 内置工具（bash/edit/find/grep/ls/read/write）尊重 `ctx.cwd` | PiDeck 不注入 cwd 策略，工具行为由 pi 自己管理 | 无需改动 | Pi 工具边界 | 不适用 |
| 导入会话同名不再覆盖已有文件 | pi 自身 `session import` 的修复；PiDeck 的 Codex/Claude/OpenCode 导入器是自己实现的独立路径 | 已确认 | `sessions/CodexSessionImporter.ts` 等 | 不适用；PiDeck 导入器是独立实现 |
| RPC `abort` 在手动压缩期间真正取消（此前误报成功） | PiDeck 发送 `compact` 命令后由 pi 执行；abort 语义修复让取消更可靠 | 已确认 | `compactRpc.ts`、AgentManager abort 路径 | 不适用 |
| `/model` 移除 Grok Build 0.1 | 运行中的 pi CLI 自己维护模型列表，PiDeck 不自建 `/model` | 无需改动 | Pi 边界 | 不适用 |
| `reload_config` RPC 提案被关闭（not_planned） | PiDeck `refreshModels()` 策略 1 永远不可用；注释与实现需改为现实的提示/重启方案 | 待做（P1） | `AgentManager.refreshModels()`、issue #6890 | 见下方专节 |

### reload_config 现状（2026-09 确认）

`https://github.com/earendil-works/pi/issues/6890` 已于 2026-07-21 以 `not_planned`（`no-action`）关闭，v0.85.0 与 main 的 `rpc-types.ts` 均无该命令。PiDeck 的 `refreshModels()` 中等待该 RPC 自动生效的策略 1 不会到来，应更新注释，并将后续工作改为：提示用户重启 Agent，或评估重启子进程策略（需处理 exit 事件竞态）。

## 0.84.3 适配矩阵

| 上游变化 | PiDeck 处理 | 状态 | 代码/验证 | 兼容代码移除条件 |
|---|---|---|---|---|
| `compact` 自定义指令字段由 `prompt` 改为 `customInstructions` | 同时发送两个字段；旧 Pi 读取 `prompt`，新 Pi 读取 `customInstructions` | 已完成 | `src/main/pi/compactRpc.ts`、`tests/compactRpc.test.mjs` | PiDeck 的最低支持 Pi 版本提升到 `>=0.84`，并完成一个迁移周期后，删除旧 `prompt` 字段与对应测试 |
| Windows 默认 shell 仍为 Bash | 不修改 Pi 的 shell 选择；Pi 自己按 `shellPath`、Git Bash、PATH 顺序解析 | 已确认 | Pi 0.84.3 `getShellConfig()`；PiDeck 不注入 shell 参数 | 不适用；这是 Pi 的职责 |
| 新增可选 `powershell` 工具 | 不默认写入 `defaultTools`，由用户在 Pi 的 `~/.pi/agent/settings.json` 中选择；Pi 自己负责 `pwsh.exe` → `powershell.exe` 回退 | 暂不接管 | 不修改 `PiProcess` 的 `--mode rpc` 启动参数 | 不适用；若未来 PiDeck提供开关，应单独定义配置契约和迁移策略 |
| `message_update` 改为 delta-only，不再带完整 partial message | 现有流式处理已可在无 partial 时使用 `delta` 累积正文/思考 | 已基本兼容 | `AgentManager.handleAssistantMessageEvent()` | 保留 delta-only 处理；不要恢复依赖 partial 的逻辑 |
| `toolcall_start` 携带稳定 id/name | 当前 UI 主要消费顶层 `tool_execution_start/update/end`，并按 `toolCallId`/`toolName` 合并工具卡 | 已基本兼容 | `AgentManager.upsertToolMessage()`、工具状态回归测试 | 只有当 Pi 删除顶层工具事件、或需要在执行前展示工具调用参数时才补专门处理 |
| streaming usage 数据修复 | PiDeck 当前主要在终态消息/`get_state`/session stats 读取 usage；不依赖中间 partial usage | 暂无必须改动 | `AgentManager` runtime stats 路径 | 若要显示实时 token 计数，再单独消费 `message_update.usage` |
| `compaction_end` 失败信息更完整 | 当前记录 `result/errorMessage` 到日志，但失败未形成明确用户提示 | 待做（P1） | `AgentManager` 的 `compaction_end` 分支 | 完成用户可见错误卡/提示并加入回归测试后关闭 |
| 压缩摘要模型不再暴露工具 | Pi 自己处理，PiDeck不复制摘要逻辑 | 无需改动 | Pi RPC 边界 | 不适用 |
| 新增模型/provider/thinking 能力 | 运行中的 Pi CLI 自动获得；配置自适应模板只读 PiDeck 自带、由 `pi-ai@0.84.4` 构建期提取的 catalog artifact，endpoint `/models` 实报字段优先合并，不读 capability cache / 外部 Pi 目录 | 已完成 | `src/main/pi/modelCapabilityResolver.ts`、`src/renderer/src/utils/modelSpecAutoFill.ts`、`ConfigModal.handleResetModelToAdaptive`、`tests/adaptiveModelTemplate.test.mjs` | 升级 catalog 输入后重新生成 artifact，并跑 typecheck、catalog 与自适应模板测试，并确认 DSH 仍使用 adapter 声明兼容的独立版本 |
| 按模型提供 thinking levels | Pi `0.81.0` 新增 `get_available_thinking_levels`；DSH 按 host 的 `reasoning.efforts` 过滤；Pi 活跃 runtime 调用该 RPC，旧 Pi/查询失败回退固定列表 | 已完成（带兼容回退） | `AgentManager.ts`、`thinkingLevels.ts`、`SessionRuntimeCoordinator.ts`、`ComposerPickerHost.tsx`、`tests/piThinkingLevels.test.mjs` | 最低支持 Pi 提升到 `>=0.81` 并完成迁移周期后，删除旧 RPC 的静态列表回退与 `TODO(remove-compat)` 分支；`THINKING_LEVELS` 的本地化标签映射仍保留 |
| `/thinking`、模型/思考级别默认变为 session-scoped、`Ctrl+S` 保存全局默认 | PiDeck 使用自己的模型/思考级别 UI；RPC 模式没有 Pi TUI 快捷键冲突 | 无需照搬 | `AgentManager.setModel/setThinking`、renderer composer | 不适用 |
| `pi update --self` 成为官方自更新入口 | PiDeck 当前仍执行兼容的 `pi update pi` | 待做（P1） | `src/main/extensions/ExtensionManager.ts` | 确认最低支持版本后改为 `--self`，或保留版本门控 |
| 更新机制增加版本缓存/原子更新语义 | PiDeck 自有 `PiProcess.versionCache`、`ExtensionManager.piVersion` 尚未在 Pi 更新后统一失效 | 待做（P1） | `src/main/pi/PiProcess.ts`、`src/main/extensions/ExtensionManager.ts` | 新 Agent 已能稳定使用更新后的版本，并有缓存失效回归测试后再关闭 |
| Pi 配置读取兼容 BOM | PiDeck 部分 JSON 读取仍直接 `JSON.parse(raw)` | 待做（P1） | `src/main/index.ts`、`src/main/settings/SettingsStore.ts`、配置读取模块 | 统一 JSON 读取入口并加入 BOM 测试后关闭 |

## 思考级别过滤现状

### Pi 后端：已接入按模型过滤

Pi 0.84.3 的 RPC 会基于当前模型的 `thinkingLevelMap`/`getSupportedThinkingLevels()` 返回档位。PiDeck 活跃 Pi session 打开思考选择器时调用：

```text
sessions:runtime-thinking-levels
→ get_available_thinking_levels
→ ThinkingPicker.levels
```

旧 Pi 返回 unknown-command、runtime 查询失败或返回结构不合法时，渲染层继续使用固定的 `off/minimal/low/medium/high/xhigh/max` 列表，保证未升级 Pi 的用户可用。RPC 返回的未知未来档位仍会显示原始 id。

### DSH 后端：已经有按模型过滤

流程是：

1. DSH host 的 `llm.models` / `session.models` 返回模型的 `reasoning.efforts`；
2. `src/main/dsh/dshModels.ts` 转换为 `AvailableModel.reasoningEfforts`；
3. `ComposerPickerHost.tsx` 找当前 provider/model，把这些 effort 映射成 `ThinkingPicker.levels`。

其中 `llm-deepseek` 通常返回自己的档位声明；`llm-pi-ai` 则由 `@deepseek-ai/dsh-llm-pi-ai` 调用 pi-ai 的 `getSupportedThinkingLevels(model)`，依据 `reasoning` 与 `thinkingLevelMap` 生成档位，并在请求不支持时拒绝 `UNSUPPORTED_REASONING_EFFORT`。

### RPC 接入后，模型映射仍然需要

需要保留，且它们不是同一层的重复数据：

- Pi 模型的 `reasoning`：仍表示模型是否支持推理，是 Pi 自己计算可用档位的输入；
- Pi 模型的 `thinkingLevelMap`：仍负责把规范档位映射成 provider 的 wire 值。RPC 只返回“可选哪些档位”，不替用户配置或保存这个映射；
- DSH 模型的 `reasoningEfforts`：仍是 DSH host 的模型目录契约；
- `providerMigration.ts` 中 `thinkingLevelMap ↔ reasoningEfforts` 的双向映射：仍需保留，因为它负责持久化的 Pi↔DSH 配置迁移，不是思考选择器的运行时查询。

因此本次改动只替换 Pi 选择器的能力来源，不删除新增模型配置里的两个 reasoning 映射。

## Windows shell / tool 决策

### Bash（当前默认，推荐保持）

Pi 0.84.3 在 Windows 上按以下顺序找 Bash：

1. `~/.pi/agent/settings.json` 的 `shellPath`
2. Git Bash 默认路径
3. PATH 中的 `bash.exe`（Cygwin/MSYS2/WSL 等）

保持 Bash 默认的理由：

- 与 Pi 原生默认行为和既有扩展/skills/提示词兼容；
- 不把工具策略写进 PiDeck，避免覆盖用户 Pi 配置；
- Git for Windows 已经是 Windows 开发环境的常见依赖。

### PowerShell（可选，不要求 PS7）

只有用户把 `powershell` 放入 `defaultTools` 后，模型才会把它作为内置工具使用：

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

Pi 负责执行器选择：优先 `pwsh.exe`，否则 `powershell.exe`。因此 PiDeck 不应下载或捆绑 PowerShell 7。

`defaultTools` 的职责是 Pi 的配置，不是 PiDeck 的运行时开关。若同时启用 Bash 和 PowerShell，模型会拥有两个命令工具，适合用户对比测试，不建议作为 PiDeck 默认策略。

注意：`shellPath` 控制的是 Pi 的 Bash 工具路径，不是 PowerShell 的路径；PowerShell 有自己的自动探测逻辑。

### DSH 例外

PiDeck 的 `pwsh_persistent` 是 DSH 独立工具。其当前实现默认指向 Windows PowerShell 7 路径；这不代表 Pi 原生 `powershell` 工具要求安装 PS7。本记录不把两者合并。

## PiDeck 后续工作清单

### P0 / 应优先

- [x] `compact` 同时发送 `prompt` + `customInstructions`，兼容未升级 Pi 的用户。
- [ ] 如果 PiDeck 宣称支持“用户手动启用 powershell”，把 `powershell` 加入安全门的受管工具集合，并补充工具短语/回归测试；但不替用户启用 `defaultTools`。

### P1 / 建议

- [ ] `compaction_end` 失败形成用户可见提示。
- [ ] 更新完成后失效 `PiProcess.versionCache` 和 `ExtensionManager.piVersion`，并提示已有 Agent 需重启。
- [ ] 评估 `pi update --self`，必要时按 Pi 版本门控。
- [x] Pi 后端调用 `get_available_thinking_levels`，按 sessionId + agentId + runtimeGeneration 读取，旧 Pi 回退静态列表。
- [ ] 统一 PiDeck JSON 读取入口，兼容 UTF-8 BOM。
- [x] PiDeck 主进程 catalog 已从精确锁定的构建期 `@earendil-works/pi-ai@0.85.0` 提取为静态资源；DSH adapter 继续使用其声明兼容的 `0.82.1`，不通过 overrides 强行升级。

## pi-ai 依赖边界

PiDeck 当前有三条不同的 pi-ai 使用路径，不能混为一谈：

| 路径 | 实际使用 | 当前版本/职责 |
|---|---|---|
| Pi 后端运行时 | 外部 `pi --mode rpc` 进程内部使用用户安装的 Pi 自己携带的 pi-ai | PiDeck 不打包 Pi CLI，也不把自己的 pi-ai 注入 Pi 子进程；Pi 0.85.0 的 provider/thinking 逻辑由外部 Pi 自己负责 |
| PiDeck 主进程 | 只读构建期生成的 `resources/pi-ai-catalog.json` 与 manifest | `@earendil-works/pi-ai@0.85.0` 是精确锁定的 `devDependency` 输入；构建脚本只提取 context/maxTokens/reasoning/input/name/thinkingLevelMap 等规格字段，运行时不加载 SDK |
| DSH host | `dsh-llm-pi-ai` 动态调用 `createModels`、catalog、`getSupportedThinkingLevels` 和 provider API | `dsh-llm-pi-ai` 声明 `^0.82.1`；lock 将其解析为嵌套的 `@earendil-works/pi-ai@0.82.1`。对 0.x semver 而言该范围为 `>=0.82.1 <0.83.0`，不包含 `0.85.0` |

因此：

- **仅升级 PiDeck 的构建期 `@earendil-works/pi-ai` 输入到 0.85.0，不会让 Pi 后端 runtime 变成 0.85.0**，也不会自动打开 Pi UI 的按模型过滤；
- DSH adapter 在自己的依赖树中解析 `0.82.1`；PiDeck catalog artifact 的来源是 `0.85.0`，两者有意共存；
- 不建议用 `overrides` 强行把 DSH 的 pi-ai 改成 0.85.0。应等待/推动 `dsh-llm-pi-ai` 发布声明兼容 0.85.x 后，再整体升级 DSH 相关包并做 host smoke、thinking effort、流式请求和 provider catalog 回归。

### 是否打包进 PiDeck

**PiDeck 主进程不再打包完整的 `@earendil-works/pi-ai@0.85.0` SDK；安装包只带静态 catalog artifact**：

- `@earendil-works/pi-ai` 位于精确锁定的 `devDependencies`，`npm run build` 先运行 `scripts/generate-pi-ai-catalog.mjs`；
- 生成器从官方 `dist/providers/data/*.json` 仅提取主进程消费的模型规格，写入 `resources/pi-ai-catalog.json` 及带来源/完整性信息的 manifest；
- electron-builder 通过 `extraResources` 将这两个文件放进 `resources/`；`piAiBuiltinCatalog.ts` 运行时校验 manifest 的 catalog SHA-256 与条目数，失败则回退 endpoint `/models` 或用户手填；
- `scripts/verify-asar-runtime.js` 守护 app 的两份 catalog 资源；`scripts/check-dsh-asar.mjs` 与 `scripts/check-dsh-boot.mjs` 继续守护 DSH runtime 所需的 `pi-ai@0.82.1`；
- DSH 的完整 `pi-ai@0.82.1` 仍是其独立运行时闭包的一部分，不能为瘦身主进程而删除。

这份 catalog artifact **不是 Pi 后端 runtime 使用的那一份**。PiDeck 通过 `PiLocator` 执行用户已经安装的 `pi` CLI；Pi CLI 自己携带/解析自己的 pi-ai。PiDeck 不打包 `pi-coding-agent`，也不把 catalog 来源版本注入外部 Pi 进程。

升级记录：PiDeck 主进程 catalog artifact 的来源从 `0.84.4` 升级为 `0.85.0`（2026-09，随 pi v0.85.0 跟进）；DSH 仍保留 adapter 兼容的嵌套 `0.82.1`。只有当 `@deepseek-ai/dsh-llm-pi-ai` 发布明确兼容 `@earendil-works/pi-ai 0.85.x` 的版本后，才升级 DSH adapter/runtime 依赖树，并完成 typecheck、catalog/迁移测试、DSH host smoke、thinking effort、流式请求和 provider catalog 回归。

## 兼容代码移除规则

兼容代码不能仅因“过了一段时间”删除。删除前必须同时满足：

1. PiDeck 明确提高最低支持 Pi 版本；
2. 安装/诊断数据或发布观察确认旧版本占比已低于项目设定阈值；
3. 对应的旧版本回归测试已改为最低版本测试；
4. 发布说明记录迁移影响；
5. 删除后跑 `npm run typecheck` 和对应针对性测试。

所有临时兼容分支应在代码中写明 `TODO(remove-compat)`，并在本文件同步写出移除条件，便于后续检索。
