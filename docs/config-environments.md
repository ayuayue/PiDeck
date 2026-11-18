# Pi 配置管理：环境（本机 / SSH / WSL）

> **Status: Current（2026-11-18；SSH 与本机共用配置及全局资源编辑器）**
>
> 读者：改「配置管理」弹窗、`config:*` IPC、远端 helper 配置域的人。
> 相关：`docs/architecture.md`（分层）、`docs/maintenance-domains.md`（改到哪读哪）、`docs/unified-api.md`（IPC 快照）。

## 1. 心智模型

**Pi 环境 = 一份真实的 pi 配置目录**，只有三种：

| 环境 | 配置目录 | 读 | 写 |
|---|---|---|---|
| 本机 | Windows `~/.pi/agent` | 本机文件（ConfigManager） | 本机文件（文件锁 + 原子替换） |
| SSH 主机 | 该主机 `$HOME/.pi/agent` | 远端 helper `config.read`（**脱敏**） | helper `config.replace`（完整文档 + `expectedVersion`）；兼容 `config.patch` |
| WSL 发行版 | `\\wsl.localhost\<distro>\home\<user>\.pi\agent` | 本机 UNC | 发行版内 `sh` 原子替换（不经 UNC 写） |

WSL 只有一个环境：发行版与 Linux 用户来自**开发设置**（`wslEnabled/wslDistro/wslUser`），
不在「设置 → 连接」里登记、也没有可枚举的档案列表（设置 → 连接只列 SSH 主机）。

整个 Pi 面板（配置组 + 资源组）**只服务一个环境**。环境不是页内字段，而是页面的作用域：
切环境 = 整页按新环境重载。页内不再有第二、第三个目标选择器。

## 2. 唯一的切换点

- 位置：顶层「Pi 配置管理」分页上的环境下拉（`ConfigBackendSwitch`，`data-testid="config-env-trigger"`）。
  分页上直接显示当前环境名，所以任何截图/任何一页都能看出「正在编辑哪台机器」。
- 面板内状态条（`ConfigEnvironmentStatus`）显示：当前环境、SSH 连接状态（连接中/在线/稳定码 + 重试）、
  以及该环境的能力边界一句话。**自动连接与密码补录只在这里发起**（下拉只选择，不连接）。
- 选择会被记住（`localStorage: pideck-config-last-target`）；主机被删/禁用后自动回落本机。
- 远端项目里打开配置管理时仍按项目主机预选（`preferredConfigTargetForProject`），但只在用户没有主动选过环境时生效。

切换守卫（草稿不能静默丢）：任一环境存在配置草稿时，弹「保存并切换 / 放弃并切换 / 取消」。
保存全部完成后才切换；失败保留当前环境和草稿。供应商子页也参与同一保存与关闭流程。

## 3. 能力矩阵（导航按此过滤）

| 页 | 本机 | SSH | WSL |
|---|---|---|---|
| 模型 models.json | 富编辑器 | 同一富编辑器 + 主机模型目录 | 富编辑器（`target` 路由） |
| 认证 auth.json | 富编辑器 | 同一表单；可新增/替换 API Key、复制、删除，已有凭据值留在主机 | 富编辑器（UNC 读 + 发行版内写） |
| OAuth | ✓（跑本机 pi 登录） | ✗ | ✗（同上，只在本机） |
| 设置 settings.json | 富编辑器 | 同一富编辑器 | 富编辑器（资源键以磁盘为准） |
| 信任 trust.json | 富编辑器 | 同一富编辑器 | 富编辑器 |
| MCP mcp.json | McpTab（探测/登录/模板） | 文件级 JSON 编辑 | 文件级 JSON 编辑（探测/登录仍只在本机） |
| 源文件 | 5 个文件，原文读写 | 5 个文件；models/settings/trust/mcp 为脱敏 JSON 文档，auth 为专用保留/替换文档 | 5 个文件，原文读写 |
| 安全策略 | ✓（PiDeck 宿主策略） | ✗ | ✗ |
| 技能 / 提示词 / 扩展 | ✓ | ✓（固定用户资源根与主机 Pi 包） | ✓ |

「✗」= 该环境的导航里没有这一页，不是「点进去告诉你不可用」。原因由状态条一句话说明
（`config.env.scopeLocal / scopeWsl / scopeSsh`）。

provider 连接测试和用量查询仍只在本机开放。SSH「获取模型」读取该主机的 Pi 模型目录；
「刷新模型目录」强制执行主机级 `pi --list-models`，不要求远端项目或活动会话，不借用本机凭据或网络探针。

## 4. 契约与代码落点

### SSH 共享编辑器（2026-11-18，已实现）

共享本机 models/settings/trust/auth 编辑器、MCP JSON 编辑器与源文件页；SSH 适配器按主机、编辑视图保留读入版本，不经本机配置 API。模型目录复用主机级 `pi --list-models`，不依赖活动会话。

整文档编辑新增同一 helper 配置域的 `config.replace`，沿用四文件白名单、版本检查、脱敏、原子写入与读回确认。`data` 表达完整 JSON（包括 null）；`secretSources` 仅允许同一文件内的路径映射，用于供应商改名/复制，秘密值仍由远端保留。模型数组按唯一 id 匹配原项；无法定位的隐藏凭据拒绝保存，绝不把占位文字写为真实凭据。旧 `config.patch` 保留兼容。

认证与资源不进入通用文件白名单。`config.readAuth` 只返回 provider/type/configured，`config.replaceAuth` 按版本提交完整条目集合：新 API Key 写入主机，已有 API Key/OAuth 只能 retain 或同主机复制，删除即从条目集合移除，渲染层和主进程都不接触原凭据。技能、提示词、扩展走独立 `resources.*` 域，只接受四个固定用户资源根；正文读写、创建、改名、删除、启停、源码编辑与 Pi 包安装/卸载/更新均由当前 SSH 主机绑定 API 执行。

保存失败保留草稿；版本冲突/回执未确认禁止盲重试，显式重读前由界面确认丢弃当前草稿。切环境、切文件、关闭与保存全部沿用共享脏状态流程。验证覆盖文档替换、null/删除、密钥和数组保留、版本冲突、主机隔离、目录脱敏以及共享页面交互。

- 目标类型与文件表：`src/shared/piConfig.ts`
  - `PiConfigTarget = local | ssh{hostId} | wsl`（wsl 不带 hostId：distro/user 由主进程从设置解析，
    渲染层自报身份一律 `WSL_CONFIG_TARGET_INVALID`）；`PiResourceTarget = local | ssh{hostId} | wsl`
  - `PI_CONFIG_FILES = models/settings/trust/mcp`（ssh helper 的写白名单，**永不含 auth**）
  - `SSH_PI_CONFIG_READ_FILES = 上述 + auth`（ssh 的 **read** 白名单：auth 只有派生视图 `RemotePiAuthSnapshot`）
  - `WSL_PI_CONFIG_FILES = 上述 + auth`；`PI_CONFIG_FILE_NAMES` 是文件名唯一真源。
- 主进程路由：`src/main/config/PiConfigRouter.ts`（`readModels/readSettings/saveModels/saveSettings/readRaw/writeRaw`）。
  本机 → `ConfigManager`；ssh → `RemotePiConfigBackend`；wsl → `WslPiConfigStore`。绝不互相回退。
  ssh 的 `readRaw("auth")` 走 `RemotePiConfigBackend.readAuth`（`config.readAuth`）；表单保存走专属
  `config:replace-remote-auth`，通用 `writeRaw("auth")` 仍被拒。
- 远端 helper 配置域：`src/main/remote/RemoteConfigSource.ts`（冻结源码 + sha256 钉死）+
  `RemoteHelperEntry.ts`（**当前 build 1.31.0**）。新增文件必须同时改这两处的版本/摘要与
  `tests/remoteConfigContract.test.mjs`。
- IPC：`config:get-raw`（新增，源文件页统一读取；ssh + auth.json 回 `remoteAuth` 派生视图且 `raw` 为空）、
  `config:save-raw`（`options`：wsl 整文件原文 / ssh `expectedVersion` + `document` 或兼容 `patch`，不含 auth）、
  `config:replace-remote-auth`（auth 表单专属版本化替换）、`remote:pi-resources`（固定主机用户资源域）、
  `config:get|save-models|settings`（既有，已带 `options`）。
  三处同步：`src/shared/ipc.ts` → `src/main/ipc/systemConfigIpc.ts` → `src/preload/api/config.ts`。
- 渲染层：`src/renderer/src/ConfigModal.tsx`（环境 state、切换守卫、按环境取数）、
  `config/ConfigEnvironmentSwitch.tsx`（分页 + 下拉 + 状态条）、`config/configEnvironmentModel.ts`（能力表）、
  `config/useConfigEditorApi.ts` / `config/remoteConfigEditorApi.ts`（每个 SSH 主机一份适配器，结构化/源文件视图分别保存版本）、
  `config/remoteAuthEditorApi.ts`（ssh 认证表单适配器）、`config/remoteResourceEditorApi.ts`（当前主机的技能/提示词/扩展/商店适配器）、
  `config/RemoteExtensionSourceButton.tsx`（扩展源文件编辑）；主进程资源路由分别在
  `RemotePiResourceBackend.ts`、`RemoteResourceSource.ts` 与 `remotePiResourcesIpc.ts`。

## 5. 部署与兼容

- helper 是内容寻址 bundle：改了 `RemoteConfigSource.ts`/`RemoteHelperEntry.ts` 就要同步 bump 版本与摘要，
  PiDeck 升级后**下一次连接该主机时**自动部署新 bundle。旧 helper 缺少 `config.replace`、
  `config.replaceAuth` 或 `resources.*` 时返回 `REMOTE_CONFIG_UNSUPPORTED` / 资源不可用稳定码，
  界面在面板里显示错误，不回落本机。
- 本机与 WSL 不受 helper 版本影响。
- 本机读取语义保持不变：`config:get-raw` 本机分支复用 `ConfigManager` 的既有读取器（mcp 取可写层原文）。

## 6. 验证

| 层 | 命令 |
|---|---|
| 能力表纯规则 | `node --test tests/configEnvironmentModel.test.mjs` |
| 共享编辑/草稿/主机隔离 | `node --test tests/remoteConfigEditor.test.mjs tests/remoteConfigSharedEditing.test.mjs tests/remoteConfigDocument.test.mjs tests/remoteTargetAutoConnect.test.mjs` |
| 认证/资源行为 | `node --test tests/remotePiManagement.test.mjs` |
| helper 冻结契约 | `node --test tests/remoteConfigContract.test.mjs tests/remoteHelperEntry.test.mjs tests/remoteHelperSearchContent.test.mjs` |
| 主进程路由（ssh/wsl/本机） | `node --test tests/remotePiConfigBackend.test.mjs tests/remotePiManagement.test.mjs tests/piConfigRouterWsl.test.mjs tests/wslPiConfigStore.test.mjs` |
| IPC/preload 快照 | `node --test tests/unifiedApi*.test.mjs`；`npm run check:ipc-wiring` |
| 类型/格式 | `npm run typecheck`；`npm run check:format` |
| 隔离 Electron 交互（模拟 SSH IPC） | `npx playwright test e2e/remote-config-editing.spec.ts` |

2026-11-18 Windows 验证：远端配置/资源定向单测覆盖认证 CRUD、版本冲突、密钥不回传、固定根资源
CRUD、正文保存、包启停/安装/更新/卸载、商店导入、发现资源只读、主机隔离与不回落本机。
`remote-config-editing.spec.ts` 使用模拟 SSH IPC 覆盖模型、设置、信任、MCP、源文件、认证、技能、
提示词、扩展源码编辑与主机切换。本轮没有连接真实 SSH 主机。

真机 E2E（需要已配好的 SSH 验收主机）：`npx playwright test e2e/remoteSessionAcceptance.spec.ts -g "远端配置"`。
WSL 的 `tests/wslConfig*Smoke.mjs` 需要本机 WSL 发行版处于可用状态，否则失败属环境问题。

## 7. 已知边界（有意为之）

1. **SSH 认证只对 API Key 提供正文输入**：已有 API Key/OAuth 可保留、同主机复制或删除，原 access/refresh
   与 API Key 值不会进帧。OAuth 登录/刷新仍请在该主机终端运行 `pi /login`；未知凭据类型只能保留、复制或删除。
2. **MCP 页在 SSH/WSL 是文件编辑**：`McpTab` 的探测、OAuth 登录、模板要跑本机 `pi mcp`，不能假装在那台主机里执行；
   文件本身（`mcpServers`）已可读写。
3. **OAuth 与安全策略永远只在本机**：前者绑定本机 pi 进程，后者是 PiDeck 宿主策略（`SecurityStore`），都不属于某个 pi 目录。
4. **SSH 资源域是固定用户根**：技能只管理 `~/.pi/agent/skills` 与 `~/.agents/skills`，提示词只管理
   `~/.pi/agent/prompts`，扩展文件只管理 `~/.pi/agent/extensions`。项目资源、PiDeck 随包资源和宿主安全策略
   不借用这台主机的全局资源入口；Pi 包的安装/卸载/更新只走主机已探测 Pi 的固定 CLI 参数。
5. **SSH 源文件是脱敏文档**：不提供原始字节、缩进保留或损坏 JSON 的原文修复。models/settings/trust/mcp
   密钥占位符/空值保留远端原值；auth 表单只提交新 API Key 与 retain/source 标记。
   删除整个包含凭据的对象可移除它。表单与源文件同时修改同一文件时分别保留原版本，先保存的一份不会自动合并另一份；
   后保存遇到版本冲突会保留草稿，需复制所需内容并显式重新读取。
