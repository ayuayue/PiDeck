# Pi 配置管理：环境（本机 / SSH / WSL）

> **Status: Current（2026-11-11；WSL 环境改为跟随开发设置里的那一份身份）**
>
> 读者：改「配置管理」弹窗、`config:*` IPC、远端 helper 配置域的人。
> 相关：`docs/architecture.md`（分层）、`docs/maintenance-domains.md`（改到哪读哪）、`docs/unified-api.md`（IPC 快照）。

## 1. 心智模型

**Pi 环境 = 一份真实的 pi 配置目录**，只有三种：

| 环境 | 配置目录 | 读 | 写 |
|---|---|---|---|
| 本机 | Windows `~/.pi/agent` | 本机文件（ConfigManager） | 本机文件（文件锁 + 原子替换） |
| SSH 主机 | 该主机 `$HOME/.pi/agent` | 远端 helper `config.read`（**脱敏**） | helper `config.patch`（RFC 7396 merge patch + `expectedVersion`） |
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

切换守卫（草稿不能静默丢）：本机草稿或远端未应用 patch 存在时，弹「保存并切换 / 放弃并切换 / 取消」。
纯远端 patch 只给「放弃并切换」（本机保存链路落不到远端）。

## 3. 能力矩阵（导航按此过滤）

| 页 | 本机 | SSH | WSL |
|---|---|---|---|
| 模型 models.json | 富编辑器 | 脱敏快照 + patch | 富编辑器（`target` 路由） |
| 认证 auth.json | 富编辑器 | ✗（凭据结构性不可达） | 富编辑器（UNC 读 + 发行版内写） |
| OAuth | ✓（跑本机 pi 登录） | ✗ | ✗（同上，只在本机） |
| 设置 settings.json | 富编辑器 | 脱敏快照 + patch | 富编辑器（资源键以磁盘为准） |
| 信任 trust.json | 富编辑器 | 脱敏快照 + patch | 富编辑器 |
| MCP mcp.json | McpTab（探测/登录/模板） | 脱敏快照 + patch | 文件级 JSON 编辑（探测/登录仍只在本机） |
| 源文件（5 个） | ✓ | ✗（远端没有字节级概念） | ✓（原文读写） |
| 安全策略 | ✓（PiDeck 宿主策略） | ✗ | ✗ |
| 技能 / 提示词 / 扩展 | ✓ | ✗（资源未路由远端） | ✓ |

「✗」= 该环境的导航里没有这一页，不是「点进去告诉你不可用」。原因由状态条一句话说明
（`config.env.scopeLocal / scopeWsl / scopeSsh`）。

provider 探针（连接测试 / 拉取模型 / 用量查询）**只从本机网络出口发起**：非本机环境即使读到 key 也不发请求。

## 4. 契约与代码落点

- 目标类型与文件表：`src/shared/piConfig.ts`
  - `PiConfigTarget = local | ssh{hostId} | wsl`（wsl 不带 hostId：distro/user 由主进程从设置解析，
    渲染层自报身份一律 `WSL_CONFIG_TARGET_INVALID`；`PiResourceTarget = local | wsl` 同理）
  - `PI_CONFIG_FILES = models/settings/trust/mcp`（ssh helper 白名单，**永不含 auth**）
  - `WSL_PI_CONFIG_FILES = 上述 + auth`；`PI_CONFIG_FILE_NAMES` 是文件名唯一真源。
- 主进程路由：`src/main/config/PiConfigRouter.ts`（`readModels/readSettings/saveModels/saveSettings/readRaw/writeRaw`）。
  本机 → `ConfigManager`；ssh → `RemotePiConfigBackend`；wsl → `WslPiConfigStore`。绝不互相回退。
- 远端 helper 配置域：`src/main/remote/RemoteConfigSource.ts`（冻结源码 + sha256 钉死）+
  `RemoteHelperEntry.ts`（**当前 build 1.27.0**）。新增文件必须同时改这两处的版本/摘要与
  `tests/remoteConfigContract.test.mjs`。
- IPC：`config:get-raw`（新增，源文件页统一读取）、`config:save-raw`（加 `options`，wsl 整文件原文 /
  ssh 只接受 `expectedVersion`+`patch`）、`config:get|save-models|settings`（既有，已带 `options`）。
  三处同步：`src/shared/ipc.ts` → `src/main/ipc/systemIpc.ts` → `src/preload/index.ts`。
- 渲染层：`src/renderer/src/ConfigModal.tsx`（环境 state、切换守卫、按环境取数）、
  `config/ConfigEnvironmentSwitch.tsx`（分页 + 下拉 + 状态条）、`config/configEnvironmentModel.ts`（能力表）、
  `config/useRemotePiConfigPanel.ts`（ssh 面板一个文件级通道对覆盖四个文件）。

## 5. 部署与兼容

- helper 是内容寻址 bundle：改了 `RemoteConfigSource.ts`/`RemoteHelperEntry.ts` 就要同步 bump 版本与摘要，
  PiDeck 升级后**下一次连接该主机时**自动部署新 bundle。旧 helper 对 `trust`/`mcp` 返回
  `REMOTE_CONFIG_UNSUPPORTED`，界面在面板里显示稳定码，不回落本机。
- 本机与 WSL 不受 helper 版本影响。
- 本机读取语义保持不变：`config:get-raw` 本机分支复用 `ConfigManager` 的既有读取器（mcp 取可写层原文）。

## 6. 验证

| 层 | 命令 |
|---|---|
| 能力表纯规则 | `node --test tests/configEnvironmentModel.test.mjs` |
| 远端面板/切换/文案装配 | `node --test tests/remoteConfigRendererWiring.test.mjs tests/remoteTargetAutoConnect.test.mjs` |
| helper 冻结契约 | `node --test tests/remoteConfigContract.test.mjs` |
| 主进程路由（ssh/wsl/本机） | `node --test tests/remotePiConfigBackend.test.mjs tests/piConfigRouterWsl.test.mjs tests/wslPiConfigStore.test.mjs` |
| IPC/preload 快照 | `node --test tests/unifiedApi*.test.mjs`；`npm run check:ipc-wiring` |
| 类型/格式 | `npm run typecheck`；`npm run check:format` |

真机 E2E（需要已配好的 SSH 验收主机）：`npx playwright test e2e/remoteSessionAcceptance.spec.ts -g "远端配置"`。
WSL 的 `tests/wslConfig*Smoke.mjs` 需要本机 WSL 发行版处于可用状态，否则失败属环境问题。

## 7. 已知边界（有意为之）

1. **ssh 不提供 auth.json 与源文件页**：helper 的秘密脱敏是「只回 configured/missing」，字节级回传会破坏这条边界。
   远端凭据请在远端终端用 `pi /login` 或直接编辑该主机文件。
2. **MCP 页在 WSL 是文件编辑**：`McpTab` 的探测、OAuth 登录、模板要跑本机 `pi mcp`，不能假装在那台发行版里执行；
   文件本身（`mcpServers`）已可读写。
3. **OAuth 与安全策略永远只在本机**：前者绑定本机 pi 进程，后者是 PiDeck 宿主策略（`SecurityStore`），都不属于某个 pi 目录。
4. **ssh 的远端资源管理未路由**：技能/提示词/扩展在 ssh 环境不出现，等资源写面按主机路由后再开。
