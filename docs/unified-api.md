# PiDeck 统一接口（unified API）

PiDeck 桌面能力面统一门面 `piDeckApi` 的契约文档。三层结构：`src/shared/api/`（纯契约目录与组合函数）、`src/main/api/`（主进程域注册表装配）、`src/renderer/src/unifiedApi.ts`（渲染层门面入口）。叠加不替换：606→679 条既有 IPC 通道与 preload 暴露面一行不改，`piDeckApi` 是消费侧统一视图。

## API 总览

- 组合入口：`piDeckApi = composeUnifiedApi(desktopApi)`；**piDeckApi 以 preload 齐备为消费前提**（desktopApi 由 preload 经 contextBridge 注入，测试/SSR 等无 preload 环境下门面不可用）。
- 聚合三式：`aggregate`（引用透传恒等，`piDeckApi.git === desktopApi.git`）、`consolidate`（按组 Pick 视图收口，如 sessions 四子域 / config 十子库）、`redline`（四例外通道只透传，禁止扩成通用桥）。
- 主进程注册表装配：`registerAllDomains()` 在 `registerIpc()` 之后旁路调用，经 `registerDomain` / `registerImporter` 登记元数据后 `freeze()` 冻结；重复登记抛 `PIDECK_API_DUPLICATE_DOMAIN`，冻结后写路径抛 `PIDECK_API_REGISTRY_FROZEN`，非法条目抛 `PIDECK_API_INVALID_DOMAIN_ENTRY`。懒实例化，不改启动时序。
- 快照守卫：tests/unifiedApi*.test.mjs 把 679 通道 / 84 前缀 / 70 命名空间 / sessions 112 / config 48 锚定为 sha256 快照，暴露面任何漂移显式红。
- 2026-10-17 快照刷新：files:search-content（工作区文件内容检索，file-index sidecar）入场，通道 677→678；2026-10-18 再刷新：sessions:search-in-session（会话内查找）入场，通道 678→679，sessions 111→112；preload 方法清单摘要同步重算（命名空间/方法数锚点不变）。
- 2026-10-16 合并刷新：随 dev 演进（ACP 全渠道、微信渠道、宿主插件、pideck-mcp、生视频、公告历史等）补 6 域行，目录现为 61 域 + 11 导入器。

## 按域调用面

域表（65 行，按 core / workspace / content / config / integration / shell 分组）：

| 域 | 分组 | 主进程归属 | IPC 注册文件 | preload 命名空间 | 通道前缀 | 聚合方式 |
| --- | --- | --- | --- | --- | --- | --- |
| `pi` | core | AgentManager（pi RPC 运行时宿主；pi 安装/路径检查面注册在 systemIpc.ts） | systemIpc.ts | `pi` | `pi` | `redline`（红线：standby 池与模型快照端点宿主；只透传，禁止扩成通用桥） |
| `sessions` | core | SessionCatalog + SessionScanner + SessionRuntimeCoordinator + SessionFileEditor/SessionHistoryReader/RewindCheckpointCoordinator | ipc/sessionIpc.ts, index.ts | `sessions` | `sessions`, `agents` | `consolidate` |
| `dsh` | core | DshHost + DshAgentManager + DshApiClient + DshPluginInstallService + DshRuntimeInstaller/DshRuntimeManager | ipc/sessionIpc.ts | `sessions` | `dsh`, `dsh-runtime` | `redline`（红线：DSH 是既有能力非 PiDeck 扩展点；门面不聚合、只透传） |
| `security` | core | SecurityStore | ipc/securityIpc.ts | `security` | `security` | `aggregate` |
| `system` | core | 系统信息与运行时检查（systemIpc 汇聚面） | ipc/systemIpc.ts | `system` | `system` | `aggregate` |
| `app` | core | 应用生命周期（systemIpc 汇聚面） | ipc/systemIpc.ts | `app` | `app`, `update`, `renderer`, `preload` | `aggregate` |
| `logs` | core | AppLogger | ipc/systemIpc.ts | `logs` | `logs` | `aggregate` |
| `rpc-logs` | core | RpcLogger + ModelTraceStore + RpcLogLiveBroadcaster | ipc/systemIpc.ts | `rpcLogs` | `rpc-logs` | `aggregate` |
| `projects` | workspace | ProjectStore | ipc/projectsIpc.ts, ipc/systemIpc.ts | `projects` | `projects`, `user-data-migration` | `aggregate` |
| `project-resources` | workspace | ProjectResourceManager | ipc/projectResourceIpc.ts | `projectResources` | `project-resources` | `aggregate` |
| `git` | workspace | GitService + WorktreeService + GitRefsWatcher | ipc/gitIpc.ts | `git` | `git` | `aggregate` |
| `terminal` | workspace | TerminalSessionManager | ipc/terminalIpc.ts | `terminal` | `terminal` | `aggregate` |
| `editors` | workspace | 外部编辑器检测 | ipc/editorsIpc.ts | `editors` | `editors` | `aggregate` |
| `browser` | workspace | main/browser/（webview 宿主与导航白名单） | ipc/filesIpc.ts | `browser` | `browser` | `aggregate` |
| `files` | workspace | 文件抽屉读写 | ipc/filesIpc.ts | `files` | `files` | `aggregate` |
| `local-image` | workspace | 本地图片字节读取（Markdown 图片保存/复制） | ipc/localImageIpc.ts | `localImage` | `local-image` | `aggregate` |
| `clipboard` | workspace | 剪贴板（sendSync 同步读） | ipc/clipboardIpc.ts | `clipboard` | `clipboard` | `aggregate` |
| `paste-files` | workspace | 粘贴文件收集 | ipc/pasteFilesIpc.ts | `pasteFiles` | `paste-files` | `aggregate` |
| `wsl` | workspace | WslPaths | ipc/systemIpc.ts | `wsl` | `wsl` | `aggregate` |
| `data-env` | workspace | 数据环境（userData 目录切换） | ipc/dataEnvIpc.ts | `dataEnv` | `data-env` | `aggregate` |
| `resource-import` | workspace | 资源导入 | ipc/resourceImportIpc.ts | `resourceImport` | `resource-import` | `aggregate` |
| `quick-task` | workspace | QuickTaskController | ipc/quickTaskIpc.ts | `quickTask` | `quick-task` | `aggregate` |
| `scratch-pad` | workspace | 便签（ScratchPadStore） | ipc/scratchPadIpc.ts | `scratchPad` | `scratch-pad` | `aggregate` |
| `shell-menu` | workspace | Shell 上下文菜单 | ipc/shellMenuIpc.ts | `shellMenu` | `shell-menu` | `aggregate` |
| `dialog` | workspace | 系统文件选择器（无独立 Manager，dialog 命名空间消费） | ipc/filesIpc.ts, ipc/backgroundsIpc.ts | `dialog` | `dialog`, `backgrounds` | `aggregate` |
| `reply-actions` | workspace | 快捷回复动作 | ipc/replyActionsIpc.ts | `replyActions` | `reply-actions` | `aggregate` |
| `prompts` | content | PromptManager + XuePromptManager | ipc/storeIpc.ts | `prompts` | `prompts` | `aggregate` |
| `prompt-store` | content | promptStoreUpdater（提示词模板检索与导入） | ipc/storeIpc.ts | `promptStore` | `prompt-store` | `aggregate` |
| `yao-prompts` | content | YaoPromptsService | ipc/storeIpc.ts | `yaoPrompts` | `yao-prompts` | `aggregate` |
| `skills` | content | SkillManager + skillStoreUpdater | ipc/systemIpc.ts | `skills` | `skills` | `aggregate` |
| `skill-store` | content | skillStoreUpdater（技能商店条目检索与导入） | ipc/storeIpc.ts | `skillStore` | `skill-store` | `aggregate` |
| `skill-hub` | content | SkillHub 检索与安装 | ipc/storeIpc.ts | `skillHub` | `skill-hub` | `aggregate` |
| `content-store` | content | BuiltinContentUpdater（prompts-store/skills-store 两通道域共用同一更新器） | ipc/contentStoreIpc.ts | `contentStore` | `prompts-store`, `skills-store` | `aggregate` |
| `extensions` | content | ExtensionManager + BuiltInExtensionsUpdater | ipc/storeIpc.ts, ipc/builtInExtensionIpc.ts | `extensions` | `extensions` | `aggregate` |
| `favorites` | content | FavoritesStore（`<userData>/favorites.json` 本机快照；正文只在收藏动作发生时由渲染层提交，不动会话文件） | ipc/favoritesIpc.ts | `favorites` | `favorites` | `aggregate` |
| `imagegen` | content | ImagegenService + 三个图存储 Store | ipc/imagegenIpc.ts | `imagegen` | `imagegen` | `aggregate` |
| `videogen` | content | VideoJobRunner + IlinkClient + VideoJobStore/VideoBlobStore/VideoSessionStore/VideoGenConfigStore | ipc/videogenIpc.ts | `videogen` | `videogen` | `aggregate` |
| `settings` | config | SettingsStore + VisionBridgeConfigManager | ipc/systemIpc.ts | `settings` | `settings` | `aggregate` |
| `config` | config | ConfigManager + ConfigBackupManager + PiResourceConfigService + TokenDance 三 Store | ipc/systemIpc.ts, ipc/backupIpc.ts, ipc/visionIpc.ts | `config` | `config`, `mcp`, `pi-resources`, `vision` | `consolidate` |
| `config-backup` | config | ConfigBackupManager | ipc/backupIpc.ts | `configBackups` | `config-backup` | `aggregate` |
| `custom-themes` | config | 自定义主题包读写 | ipc/themesIpc.ts | `customThemes` | `themes` | `aggregate` |
| `catalog` | config | PiAiCatalogUpdater（模型目录更新，分支白名单 main/dev） | ipc/catalogIpc.ts | `catalog` | `catalog` | `aggregate` |
| `pi-auth` | config | PiAuthService（NDJSON 子进程 pi-auth-host.mjs） | ipc/piAuthIpc.ts | `piAuth` | `pi-auth` | `redline`（红线：例外一，pi-auth-host.mjs 只做认证；凭据 pi 自管） |
| `feishu` | integration | FeishuBridge/FeishuConnection/CardStream | ipc/feishuIpc.ts | `feishu` | `feishu` | `aggregate` |
| `web` | integration | WebServiceManager + WebEventStream/WebWorkspaceRoutes/WebI18n/WebNetwork | ipc/systemIpc.ts | `settings` | `web` | `aggregate` |
| `enhance` | integration | EnhancePromptService（常驻 sidecar pi-enhance-host.mjs） | ipc/enhanceIpc.ts | `enhance` | `enhance` | `redline`（红线：例外四，pi-enhance-host.mjs 单用途补全；禁止通用模型桥） |
| `prompt-suggestion` | integration | EnhancePromptService（prompt-suggestion 独立实例，systemPrompt 由主进程常量注入） | ipc/promptSuggestionIpc.ts | `suggestion` | `suggest` | `redline`（红线：例外四，与 enhance 共用协议但独立实例；渲染层禁传 systemPrompt/userText） |
| `agent-profiles` | integration | AgentProfileStore + AgentInvokeService（划词工具一次性调用，复用 pi-enhance-host sidecar 独立实例） | ipc/agentProfilesIpc.ts + ipc/agentInvokeIpc.ts | `agentProfiles` | `agent-profiles` | `aggregate`（例外四：systemPrompt 只能由主进程按 agentId 解析） |
| `selection-tool` | integration | SelectionToolService + SelectionToolWindow（全局快捷键 + 系统级划词浮窗） | ipc/selectionToolIpc.ts | `selectionTool` | `selection-tool` | `aggregate` |
| `channel-switch` | integration | ChannelSwitchService + UpdateService（更新通道切换） | ipc/channelSwitchIpc.ts | `channelSwitch` | `channel-switch` | `aggregate` |
| `cua` | integration | CuaEngine + CuaGate + McpHttpHost + CuaService | ipc/cuaIpc.ts | `cua` | `cua` | `aggregate` |
| `usage-stats` | integration | 用量统计 | ipc/usageStatsIpc.ts | `usageStats` | `usage-stats` | `aggregate` |
| `voice-transcription` | integration | 语音转写（5 类协作组件） | ipc/voiceTranscriptionIpc.ts | `voiceTranscription` | `voice-transcription` | `aggregate` |
| `automation` | integration | AutomationStore + AutomationScheduler + RunCoordinator | ipc/automationIpc.ts | `automation` | `automation` | `aggregate` |
| `acp` | integration | AcpAgentManager + AcpConnection/AcpProcessHost + AcpMessageSnapshotStore（外部 ACP CLI agent 接入） | ipc/acpIpc.ts | `acp` | `acp` | `aggregate` |
| `wechat` | integration | WeChatBridge + WeChatService/WeChatLogin | ipc/wechatIpc.ts | `wechat` | `wechat` | `aggregate` |
| `host-plugins` | integration | HostPluginManager + HostPluginService + HostPluginWebviewBridge | ipc/hostPluginsIpc.ts | `hostPlugins` | `host-plugin`, `host-plugins` | `aggregate` |
| `pideck-mcp` | integration | PiDeckMcpService（PiDeck 对外 MCP 服务） | ipc/piDeckMcpIpc.ts | `piDeckMcp` | `pideck-mcp` | `aggregate` |
| `pet` | shell | PetSystem + PetWindow/PetPackageManager/PetPatrol/PetStateBridge | pet/index.ts, index.ts | `pet` | `pet` | `aggregate` |
| `floating-ball` | shell | FloatingController | ipc/floatingIpc.ts | `floatingBall` | `floating-ball` | `aggregate` |
| `mini-overlay` | shell | MiniOverlayWindow | floating/MiniOverlayWindow.ts | `miniOverlay` | `mini-overlay` | `aggregate` |
| `sounds` | shell | 音效（自定义音效导入/删除） | ipc/soundIpc.ts | `sounds` | `sounds` | `aggregate` |
| `announcements` | shell | AnnouncementService | ipc/announcementIpc.ts | `announcements` | `announcement` | `aggregate` |
| `quick-messages` | shell | 快捷消息 | ipc/quickMessagesIpc.ts | `quickMessages` | `quick-messages` | `aggregate` |
| `notice-history` | shell | NoticeHistoryStore（公告已读历史） | ipc/noticeHistoryIpc.ts | `noticeHistory` | `notice-history` | `aggregate` |

外部会话导入器（11 个，独立清单 IMPORTER_CATALOG）：

| 导入器 | 主进程归属 | IPC 注册文件 | preload 命名空间 | 通道前缀 | 能力 |
| --- | --- | --- | --- | --- | --- |
| `codex` | CodexSessionImporter | ipc/sessionIpc.ts | `codexSessions` | `codex-sessions` | scan / import |
| `claude` | ClaudeSessionImporter | ipc/sessionIpc.ts | `claudeSessions` | `claude-sessions` | scan / import |
| `qoder` | QoderSessionImporter | ipc/sessionIpc.ts | `qoderSessions` | `qoder-sessions` | scan / import |
| `opencode` | OpenCodeSessionImporter | ipc/sessionIpc.ts | `openCodeSessions` | `opencode-sessions` | scan / import |
| `zcode` | ZCodeSessionImporter | ipc/sessionIpc.ts | `zcodeSessions` | `zcode-sessions` | scan / import |
| `workbuddy` | WorkBuddySessionImporter | ipc/sessionIpc.ts | `workbuddySessions` | `workbuddy-sessions` | scan / import |
| `cursor` | CursorSessionImporter | ipc/sessionIpc.ts | `cursorSessions` | `cursor-sessions` | scan / import |
| `kimi` | KimiSessionImporter | ipc/sessionIpc.ts | `kimiSessions` | `kimi-sessions` | scan / import |
| `kimi-work` | KimiWorkSessionImporter | ipc/sessionIpc.ts | `kimiWorkSessions` | `kimi-work-sessions` | scan / import / describe |
| `minimax` | MiniMaxSessionImporter | ipc/sessionIpc.ts | `minimaxSessions` | `minimax-sessions` | scan / import |
| `directory-sessions` | DirectorySessionImporter | ipc/sessionIpc.ts | `directorySessions` | `directory-sessions` | scan / import / listSources |

使用示例（引用透传恒等，无包装无拷贝）：

```ts
import { piDeckApi } from "./unifiedApi";

const branches = await piDeckApi.git.listBranches(projectId);
const records = await piDeckApi.sessions.catalog.list();
const probes = await piDeckApi.config.mcp.probeMcp();
```

## 插件扩展点设计

> 设计稿（未实现）：本章为宿主插件体系消费 piDeckApi 的规划口径，落地前以 `apiVersion: "proposed" | "stable"` 类型位管理稳定承诺。

- **manifest 声明**：插件以 manifest 声明依赖的域与 apiVersion，主进程按声明裁剪可见面，未声明域不可见。
- **权限四级**：只读 UI（读会话/时间线/状态）→ 读写指定目录（声明目录白名单内的文件读写）→ 终端与进程（受控终端会话与命令执行）→ 网络与凭据（代理与凭据引用，凭据本体不经插件手）。逐级授予、默认最小。
- **激活**：插件经宿主插件管理器加载（内容 sha256 指纹授权），激活时注入按 manifest 裁剪的 piDeckApi 视图； deactivate 释放全部句柄与订阅。
- **失败隔离**：插件异常不拖垮宿主——面板渲染失败只塌陷该落点，IPC 调用超时与异常在插件边界结算，宿主进程与其余插件不受影响。

## 主题壳扩展点设计

> 设计稿（未实现）：本章为自定义主题壳消费统一接口的规划口径。

- **主题是数据不是代码**：主题包只含数据（token 覆盖集 + 元信息），不含可执行代码，加载路径不做任何动态求值。
- **token 受限覆盖集**：只能覆盖白名单内的语义 token（颜色/圆角/字号/动效常量），白名单外字段忽略；与 CSS 双轨的 `@theme` 桥接同一套 foundation token，不另起平行色板。
- **亮暗成对**：每个主题必须同时提供亮、暗两套 token 覆盖，缺一不予加载，避免半套主题在暗色模式下破相。
