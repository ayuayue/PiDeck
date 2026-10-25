# AGENTS.md

> 本文件是 PiDeck 的开发宪法，每次 AI 会话全量注入——只放硬约束与速查，细节放 `docs/` 按需读。
> 维护纪律：新增规则必须可判定（触发条件 + 动作 + 判定标准）；被取代或证伪的条目当次删除，不留「已废弃」注记；领域运维细节写进 `docs/maintenance-domains.md`，不往本文件堆。

## 项目简介

PiDeck 是 Electron 桌面应用，在多个项目目录间管理和运行 pi RPC Agent：多项目工作区、会话时间线、历史恢复、文件抽屉、Git 面板、终端、内置浏览器、提示词/技能/扩展商店、打包发布。

技术栈：Electron + React 19 + TypeScript + Vite（版本以 `package.json` 为准）。

## 核心边界（不可逾越）

- pi 负责 Agent 行为、工具调用、会话读写、模型调用——**pi 的事不要替它做**；PiDeck 负责窗口、进程生命周期、会话浏览、Git/终端/设置——**UI 框架的事 pi 也不要做**。两者只通过 stdio JSON-RPC 通信，禁止引入第二条通道。

**例外一：认证通道（`pi-auth`，只允许认证用途）**

- pi 的供应商登录只存在于交互层，RPC 没有 auth 入口。主进程以子进程运行 `resources/pi-auth-host.mjs`（import pi 的 `ModelRuntime`）完成「列供应商/登录/答问/取消/登出」；**凭据由 pi 写进自己的 `auth.json`，PiDeck 不碰**。
- 代码归属：`src/main/pi/auth/piAuthHostLaunch.ts`（WSL 不支持，提示改用终端 `/login`）、`src/main/pi/auth/PiAuthService.ts`（NDJSON 协议）、`resources/pi-auth-host.mjs`（stdout 只放协议数据）。必须列进 `extraResources`。
- 禁止扩展成通用 pi API 桥；渲染层只能经 `pi-auth:*` IPC 访问，不得直接 import pi SDK。

**例外二：模型请求快照端点（`pi-deck-model-trace`，只允许模型请求快照）**

- `resources/extensions/pi-deck-model-trace.ts` 随包分发、`-e` 注入，在 `before_provider_request` / `after_provider_response` 里把请求帧 POST 给主进程端点；完整请求体落 `userData/logs/model-traces/`，时间线只留摘要 + traceId（存储侧 `src/main/logging/ModelTrace.ts`，只读入口 `modelTrace:*` IPC）。
- 主进程端点只绑 `127.0.0.1`（`src/main/pi/modelTrace/ModelTraceServer.ts`，每 agent 一份 token，spawn 时注入 `PIDECK_MODEL_TRACE_URL` / `PIDECK_MODEL_TRACE_TOKEN`，扩展直连该 URL 不再拼子路由），路径形如 `/trace/<token>`，强校验请求头 `x-pideck-model-trace-token`。唯一路由只承载模型快照，**禁止扩展成通用宿主控制/回调通道**。
- 线格式唯一来源 `src/shared/types/modelTrace.ts`；扩展是自包含 `.ts`（只能 `import type`），字段与端点契约由 `tests/modelTraceExtension.test.mjs` 兜底。
- fail-safe：端点起不来 → 不注入 env → 扩展不注册任何 handler；扩展抛错/写失败只丢追踪，不影响 pi 会话与其余功能。生命周期配对：`registerModelTraceSession` ↔ `unregisterModelTraceSession`（stop/restart/删会话/退出都要注销）。

**例外三：standby 运行时池（预热 + 只读命令预览；「消费池进程」仍然只有「提前起进程」一个用途）**

- 一次 pi RPC 激活约 8.5s（实测 ≈ node/pi boot 0.5s + 用户 npm 扩展 5s + 内置 16 个 TS 扩展 2.4s），全部发生在 spawn→握手段。池的用法：草稿创建/激活完成后 `AgentManager.ensureStandbyAgent(projectId)` 后台起一个完整握手的进程待命（`src/main/pi/StandbyAgentPool.ts`：单槽位、容量 1、3min TTL 自动回收——待命进程 RSS 数百 MB 是空闲期最大单点常驻，TTL 只需覆盖「打字→认领」窗口，2026-10 内存轮从 10min 收紧）；新会话激活经 `SessionRuntimeCoordinator.claimStandbyAgent` 认领，认领后照常走 applyLatestPreferences/mergePendingPermissionSettings，模型与权限热更新语义不变。
- 只服务新会话（noSession/恢复历史会话不认领）；spawn 输入指纹（`src/main/pi/standbyFingerprint.ts`：扩展根/禁用集/offline/noExt/noSkills/customPiPath/WSL/代理/launchArgs）任一变化即丢弃回退普通 spawn，改设置无需重启池；信任走 `resolveTrustWithoutPrompt`，含资源未决策不池化（绝不后台弹 trust 弹窗）。
- 已知限制：池化进程不带 PIDECK_SESSION_ID，安检门按默认档工作，per-session 安全覆盖对认领会话要重启才生效；池化 agent 对 agents:list/agent:state-changed 不可见。开关 `settings.standbyRuntimeEnabled`（默认开，开发者页可关）。启动耗时探针：`scripts/probePiStartup.mjs`（JITI_DEBUG=1 出逐模块 trace）。
- 只读借用（Issue #316）：草稿会话斜杠命令预览 `AgentManager.draftCommands` 经 `StandbyAgentPool.peek(projectId)` 查同项目池进程的 `get_commands`（不认领、不消费、进程须 idle、指纹须新鲜）；链路 `sessions:draft-commands` IPC → 渲染层优先预览、空/失败回退本地技能/提示词发现；dsh/browser/preview 模式返回 null。

**例外四：一次性补全侧车（`pi-enhance-host.mjs`，只允许「一次性单条补全请求」用途：提示词增强 + 智能体一次性调用 + 输入预测）**

- 输入框提示词增强需要直接调 pi SDK 的补全（不走 RPC 会话），主进程经常驻单进程 sidecar 实现：`resources/pi-enhance-host.mjs`（stdout 只放 NDJSON 协议，载入 `PIDECK_PI_SDK_ENTRY` 指向的 pi `dist/index.js` 建 `ModelRuntime`），宿主侧收口在 `src/main/pi/enhance/EnhancePromptService.ts`，启动参数定位复用 `piAuthHostLaunch` 的 `resolvePiAuthHostLaunch`，必须列进 `extraResources`。
- 常驻单进程多 run：新 run 打断旧 run、显式 cancel、boot/run 超时、进程意外退出都在服务层结算（每 run 回调恰好一次）；渲染层按 scopeKey 隔离，切会话作废进行中的 run，结果只回填发起方输入框。入口 `enhance:run`/`enhance:cancel`/`enhance:on-event` 在 `src/main/ipc/enhanceIpc.ts`（边界校验；provider/modelId 形态校验只挡空白/控制字符/超长，真实目录的 `builtin:` `https://` `a/b` 形态必须放行）与 preload 白名单；hook 为 `src/renderer/src/hooks/usePromptEnhance.ts`。目标模型优先级见 `src/shared/enhanceModelPreference.ts`：设置固定模型（`settings.enhanceModel`，设置页通用 tab）> 会话记录 > 引导页点选 > 部署/主进程默认，默认跟随会话模型。fail-safe 与 pi-auth 一致：sidecar 起不来只是按钮置灰 + toast，不影响 pi 会话与其余功能。禁止扩展成通用模型 API 桥。
- **智能体一次性调用（划词工具 / 智能体）复用同一侧车协议，但必须独立实例**：装配层为 `src/main/agents/AgentInvokeService.ts` 注入**另一个** `EnhancePromptService` 实例（logger 命名空间 `agent-invoke`，退出清理登记名 `agent-invoke`），因为该服务的单飞语义是「新 run 打断旧 run」——共用实例会让划词翻译打断输入框增强。入口 `agent-profiles:invoke` / `agent-profiles:invoke-cancel` / `agent-profiles:invoke-event`（`src/main/ipc/agentInvokeIpc.ts`）。边界：`systemPrompt` 只能由主进程按 `agentId` 从 `AgentProfileStore`（`<userData>/agent-profiles.json`）解析，**渲染层不得直接传 systemPrompt**（只传短 instruction、目标语言与 provider/modelId）；一次性、无工具、不碰会话文件；事件按 runId 配对，`started|delta|done|aborted|error` 终态恰好一次。禁止把该通道做成任意 systemPrompt 直通。智能体本身是 PiDeck 层预设：会话与智能体的绑定存 `AgentMarketSettings.sessionAgentBindings`（只能经 `agent-profiles:bind-session` 改），发送时由 `sessionIpc` 调 `composeAgentInstruction` 把角色设定拼进 `SendPromptInput.agentMessage`（DSH 拒绝该通道，退化为可见前缀），PiDeck 不替 pi 写系统提示。**系统级划词**（`src/main/selection/`）目前隐藏且默认关闭：`SYSTEM_SELECTION_TOOL_ENABLED=false`、默认设置 `systemSelectionEnabled=false`，设置页与快捷键页不展示，复制监听/原生捕获/快捷键全部不启动；恢复后才按“Windows UIAutomation 选区优先、模拟复制兜底”启用。
- **输入预测（回合结束后的下一句建议）复用同一 sidecar，但必须是第三个独立实例**（logger / 退出清理名 `prompt-suggestion`）：三个消费者共享「新 run 打断旧 run」的单飞语义，共用实例会让预测打断增强或划词。入口 `suggest:run` / `suggest:cancel` / `suggest:event`（`src/main/ipc/promptSuggestionIpc.ts`）；`systemPrompt` / `userText` 由主进程常量（`src/main/pi/enhance/promptSuggestion.ts`）注入，**渲染层禁传**，并带 `purpose: "suggest"` 让宿主不再追加「只改写最后一条草稿」约束。触发与展示全在渲染层（`usePromptSuggestion`）：只在回合 `isTurnActive` 落回 false、草稿为空、开关开且目标模型可解析时发起，上下文用 `collectPromptEnhanceContext` 有界快照；ghost 文案是绝对定位的视觉层，**不得写进 ProseMirror 文档**（不参与撤销/发送判定），Tab / → 采纳时整体回填草稿，Esc 忽略，失败静默（后台功能不弹 toast）。开关 `settings.promptSuggestionEnabled`（缺省开，只有字面 false 能关）。

**例外五：运行时控制扩展（`pi-deck-runtime.ts`，只允许 `/reload`）**

- RPC 模式不执行 pi 的 builtin `/reload`，也没有原生 reload RPC；pi 只把 `ctx.reload()` 暴露给扩展命令。内部扩展 `resources/extensions/pi-deck-runtime.ts` 只注册一个 `reload` 命令：`ctx.isIdle()` 时调用 `ctx.reload()`，不注册工具、不提供其他宿主控制。
- 注入走 `INTERNAL_BUILT_IN_EXTENSIONS`（始终随 RPC 注入，`piRpcNoExtensions` 除外；不上设置页、不参与用户移除）。写入 `extensions-manifest.json`，热更新覆盖层按整份快照分发。
- 宿主唯一入口：`sessions:runtime-reload-resources` → `SessionRuntimeCoordinator.reloadResources` → `AgentManager.reloadResources`。后者先 `get_state`/挂起 UI 请求校验 idle，再按 `sourceInfo.path` 确认命令来自 `pi-deck-runtime.ts`，最后直接发 RPC prompt；**禁止复用 `sendPrompt`**（它会在 RPC 前写乐观用户消息）。重载后重新 `get_commands` 返回新命令表，渲染层刷新 `/` 菜单与时间线命令 chip。
- 扩展热重载与「运行控制工具条」都只对 pi 提供：running/compacting/有排队消息/挂起 Ask 时拒绝热重载；DSH（共享 host）与 ACP（外部 CLI）没有会话级 reload，头部工具条与重载菜单项一律不渲染，操作只走 Tab ⋯ / 右键菜单。扩展缺失、重载失败、命令未被 `handled` 都返回结构化错误 + toast，不影响会话本身；禁止扩展成通用命令执行桥。

**例外六：本地 MCP 工具端点（`pideck-cua` host，只允许宿主能力的工具调用）**

- 主进程内 StreamableHTTP MCP Server（127.0.0.1、每次启动随机 bearer token、写 `~/.pi/agent/mcp.json` 的 `pideck-cua` 条目）把宿主能力以工具形式暴露给 pi：CUA 桌面输入注入（`cua_*`）与内置浏览器操作（`browser_*`，`src/main/browser/`）。工具调用走 pi 标准 tool_call → tool_result JSON-RPC，不构成第二条 pi↔PiDeck 通道；审批经进程内 IPC（`cua:approval-*`）。
- 能力各自有独立开关（`cuaEnabled` / `browserAgentEnabled`，默认都关）、独立 gate 实例与独立 autoApprove（浏览器默认自动放行，可关闭改为逐次确认）；host 只在任一能力启用时监听并写 mcp.json，两者都关时停监听并注销。工具按开关条件注册：只为已启用能力注册，**host 存活 ≠ 能力启用**。
- 只读工具免审批；写工具 fail-closed（无 approval handler / 超时 / 拒绝即不执行）。页面与屏幕内容是不可信输入；工具输出不得包含凭据，日志不得写页面文本或截图内容。
- 禁止扩展成通用宿主控制通道：不得暴露任意 JS 执行、文件系统、shell、任意 HTTP 代理、会话/模型控制；新增工具必须逐条列入本例外并说明审批归属。内置浏览器工具不得绕过 `isAllowedBrowserPanelUrl`、不得注入 preload / 放开 allowpopups、不得改 webview 安全档位。
- 详见 `docs/browser-agent-plan.md`（工具面、快照契约、风险与合并门禁）。

## 目录结构与跨层契约

本项目只维护项目根这一份 `AGENTS.md`；不要再在子目录生成规则文件。规则冲突时以本文件和实际类型/API 为准。

```
src/
├── main/              # Electron 主进程（唯一可访问 Node/主进程能力）
│   ├── pi/            # pi RPC 进程管理、认证、模型请求快照端点
│   ├── sessions/      # 会话扫描、导入、SessionRuntimeCoordinator
│   ├── git/           # GitService；git 子进程收口在 git/gitRun.ts
│   ├── prompts/ skills/ extensions/ settings/   # 各领域 Manager
│   ├── terminal/      # node-pty 终端会话
│   ├── feishu/ pet/ web/ ipc/                   # 飞书/桌宠/Web 服务/IPC 域
│   └── ipc/           # ★ IPC 域注册（*Ipc.ts 只做输入校验和适配）
├── preload/           # contextBridge 暴露最小 PiDesktopApi
├── renderer/src/      # atoms/ components/(ui-shadcn|session|sidebar|workspace|app) hooks/ i18n/ styles/
└── shared/            # 主/渲染共享契约：types/*.ts 按域拆分 + ipc.ts 通道定义
```

- `shared/` 是纯契约层：类型按域拆文件，IPC 名称只在 `shared/ipc.ts`；`shared` 不得反向依赖任何运行时层。
- `main/` 的领域行为放 `main/<domain>/`，`main/ipc/*Ipc.ts` 只做校验适配，`main/index.ts` 只增装配不增业务。
- `renderer/` 只经 `desktopApi`/preload 调桌面能力；跨组件状态用 Jotai atom，副作用放 hook，视图放 component；不得直接 import Node/Electron 或引入第二种全局状态方案。
- `SessionRecord.id` 是跨重启的稳定会话身份，`agentId` 仅表示当前 pi 子进程；所有 runtime 命令和事件带 `sessionId + agentId + runtimeGeneration`，拒绝旧 runtime 的迟到结果。
- 持久化结构、设置、session catalog 变更必须兼容旧数据；listener/timer/子进程/terminal/watcher 必须在同一模块找到配对清理路径。

## 架构规则（硬性）

1. **session-first**：会话是一等公民，新功能优先挂 session/runtime 链路，不退回「围绕 agent tab 堆全局 state」。
2. **状态管理用 Jotai**：跨组件状态放 `atoms/` 按域建 atom，禁止第二种全局状态方案。
3. **IPC 按域注册**：handler 放 `src/main/ipc/*Ipc.ts`，通道名集中在 `shared/ipc.ts`，禁止散落字符串字面量；新增通道三处同步——通道常量、main handler、preload 白名单，漏一处运行时 undefined。
4. **类型共享走 `shared/types/`**：三个进程不得各自重复定义同一结构。
5. **单向依赖**：`main`/`preload`/`renderer` 只依赖 `shared`；`renderer` 不能直接 import Node/Electron；`main` 不 import renderer。
6. **文件体量红线**：单文件目标 ≤400 行，超 600 行必须评估拆分；`App.tsx`、`main/index.ts` 只增装配；为省 import 把逻辑塞回大文件视为架构倒退。

## 模块内聚与低耦合（硬性）

> 默认标准：高内聚、低耦合、可单测、装配层不长胖。功能能跑 ≠ 结构合格。

1. **一个模块一件事**：状态机/策略/解析放纯函数，UI 只做呈现与事件转发，hook 拥有该域状态。禁止把完整域逻辑散落在 `App.tsx` 匿名回调里；新增交互优先抽 `hooks/useXxx` 或 atoms。
2. **按域抽 hook，不按屏幕堆 props**：跨子树的同一域应有明确 owner；禁止 30+ 字段「props 袋」层层透传；视图 props 只留身份与 chrome 开关。
3. **选中 ≠ 呈现**：`selectSession` 只负责「当前会话是谁」；Tab 预览/分屏/拖拽属于 chrome 域，在边界组合，不渗进通用 selection API。
4. **多实例按 session 订阅**：分屏/多栏只订本栏 `sessionId` 的 atom family，禁止非聚焦栏订阅 `currentSession*` 全局原子。
5. **纯策略可单测**：落点边、预览替换等产品规则写成纯函数配 `tests/*.test.mjs`，禁止只活在 JSX lambda。
6. **异步与拖放用快照/稳定入口**：`drop`/`close`/定时器不闭包过期状态；用 ref 快照、`useCallback` 或单一 `dispatch`；依赖数组禁止写整个 `props` 对象。
7. **同一 UI 能力一个挂载点**：共享 chrome 放外层，避免 solo/split 两套父级各挂一份。
8. **改前自检**：改动是否让 `App.tsx` 更懂业务？新状态是否有单一 owner？多会话下订阅是否按 `sessionId` 隔离？核心规则能否离开 React 单独测绿？

## 代码风格

- TypeScript strict；禁止新增 `any`（第三方交互用 `unknown` + 收窄并注释）；禁止 `as` 强转绕过类型错误，测试数据用工厂函数构造完整对象。
- 命名：类型/类 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE，IPC 通道 `domain:action`。
- React：函数组件 + hooks；副作用必须有清理；派生状态用 `useMemo`，可计算值不进 state。
- 文案：用户可见文本一律走 i18n（`rendererCopy.zh-CN.ts` + `en-US.ts` 同步加 key；繁体词典是生成物，改完 zh-CN 必须重跑 `node scripts/genZhTwCopy.mjs`），JSX 禁止硬编码中英文。
- 日志走主进程 logging 模块，不留调试 `console.log`。

### 格式化（biome，硬性）

- 配置在根 `biome.jsonc`，覆盖 `src/`、`tests/`、`scripts/`、`e2e/`；`docs-site/`、`resources/extensions/`、CSS 不参与。
- 规则：tab 缩进、双引号、分号、尾逗号、LF；`lineWidth` 320 刻意不折行（仓库 >80 字符行占 54%，折行会打破源码正则扫描契约测试）——改配置前先确认不破坏测试。
- 提交前 `npm run format`；CI 跑 `npm run check:format`，未格式化红灯。
- **新增源码正则扫描契约测试时，正则必须空白容忍**（`\s*` 而非字面空格、定位代码块用 `^[\t ]*` 锚点），否则改一次格式整组断言失败。
- `linter` 仍为 `enabled: false`；lint 规则按触达面增量启用，不一次性引入存量告警。

## 注释要求

- 对核心逻辑、复杂判断、业务规则、状态流转、权限校验、数据转换、异常处理注释「为什么、对应什么规则、边界是什么」，不逐行解释显而易见的代码。
- 新增函数/类/模块加简短功能说明；改旧代码时缺上下文的顺手补。

## 测试标准（硬性门禁）

测试在 `tests/*.test.mjs`（node --test）。日常只跑**针对性测试**；全量 `npm test` 仅跨域大改动或合并前最终确认时运行。

1. **必过门禁**：合并前 `npm run typecheck` + 改动涉及的针对性测试全绿，不许「先合再修」。
2. **何时必须写测试**：修 bug 先写复现测试（红）再修到绿，回归测试永久保留；新增主进程业务逻辑、数据转换/解析/状态机逻辑必须有单测；交互状态流转的 hook 应有测试，纯 UI 布局可不强求。
3. **测试写法**：测行为不测实现（从公开接口/IPC 边界断言）；不依赖执行顺序、真实网络、真实 pi 进程；一个测试验证一件事，命名即意图。
4. **加载生产 TS 模块用现成 helper，禁止手写 vm 加载器**：完整依赖图用 `tests/helpers/loadTsCommonJs.mjs`；自定义 sandbox 全局用 `tests/helpers/createTsSandbox.mjs`。两者的相对 import 按源文件目录解析——手写沙箱把 specifier 丢给 `require(specifier)` 会以 `tests/` 为基准，生产代码新增本地 import 就整片 MODULE_NOT_FOUND（2026-09 连踩三次）。沙箱不注入 Node 全局（`setTimeout`/`clearTimeout` 等），被 vm 加载的生产模块用定时器时必须显式 `import { setTimeout } from "node:timers"`，否则测试内 ReferenceError。
5. **红名单归属判定**：全量测试出现失败时，先用 `git worktree add` 在改动前基线 commit 复跑同一批测试文件——基线也红的是上游/并行改动，不顺手修也不算进自己的回归；只修自己引入的（2027-02 全量核对验证）。
6. **禁止**：放宽断言、注释掉失败测试、改成恒真。

## 安全约束

1. **IPC 最小权限**：preload 只暴露页面需要的 API，禁止 `ipcRenderer` 透传。
2. **输入校验在边界**：IPC handler 第一行职责是校验入参（类型/路径合法性/枚举范围）；渲染层数据一律不可信。
3. **路径安全**：文件读写限制在项目目录或应用数据目录内；拼接前规范化 + 逃逸检查，禁止直接拼用户输入。
4. **进程调用**：spawn/exec 参数必须数组形式，禁止字符串插值拼 shell；子进程环境变量经 `sanitizePiChildEnv` 类函数清洗；所有 spawn（含 fire-and-forget 的 `open`/`taskkill`/安装器）必须挂 `error` 监听或等价兜底——未处理的 `error` 事件会直接崩主进程；可能长时间不返回的外部命令（如 `reg query /s`）必须带超时 kill（2027-02 三处兜底修复）。
5. **Webview**：禁止加载 `file://` 以外任意本地内容；`allowpopups`/node integration 保持最小化，新增 webview 属性需评审。
6. **密钥与令牌**：Auth 配置只经 `config/` 模块读写；日志/错误上报/遥测禁止输出 token/key。
7. **依赖引入**：新增依赖需说明理由，优先用已有能力，禁止为小功能引重型库。

## Electron 开发规范

> 改动 `main/index.ts`、窗口创建、preload、打包配置前必读。每条都是踩坑结论。

**启动与生命周期**：`commandLine.appendSwitch`/`app.setPath`/单实例判断必须在 `app.whenReady()` 前；关键节点（窗口创建、load、preload、pi 启动）必须写 `appLogger`；窗口隐藏时先 `maximize()` 再加载避免布局跳变，`zoomFactor` 在 `did-finish-load` 后应用；单实例用自研按版本互斥 `acquireVersionSingleInstance`（不用 `requestSingleInstanceLock`，原生锁会阻止不同版本并行），第二实例 `app.exit(0)`；dev 模式 userData 追加 `-dev` 后缀；quit 路径覆盖 pi 子进程、node-pty、watcher、锁文件，新增常驻资源同步登记。

**窗口与 webview**：主窗口基线 `contextIsolation: true` + `nodeIntegration: false` + `webviewTag: true`（仅主窗口），新增窗口逐项评估禁止默认全开；Chromium 沙箱默认关闭是刻意的（Windows 安全软件/旧驱动在沙箱初始化触发 0x80000003），关闭时显式 `appendSwitch("no-sandbox")`，开关改动需整应用重启；`setWindowOpenHandler` 主窗口与 webview guest 都要注册（走 `openExternalUrl` 并 deny）；webview 用专属 `partition` 强制 `sandbox: true`/`nodeIntegration: false`/`webSecurity: true`，删除外部传入的 `preload`/`allowpopups`（见 `configureBrowserPanelWebviewHost`），`did-attach-webview` 校验 partition 不符立即 close，导航白名单 `will-frame-navigate`/`will-redirect`/`setWindowOpenHandler` 三层都要过（只拦一层会被重定向绕过）；自定义标题栏改动要验证三平台控制按钮、拖拽区、双击最大化。

**E2E 测试窗口（不打扰模式）**：`PIDECK_E2E=1` 时主窗口默认摆到屏幕外（`src/main/e2eWindowMode.ts`：`setPosition(-32000,-32000)` + `setSkipTaskbar(true)` + `showInactive`），并关闭后台节流（`backgroundThrottling: false` 与 `disable-background-timer-throttling`/`disable-renderer-backgrounding`/`disable-backgrounding-occluded-windows` + `disable-features=CalculateNativeWinOcclusion`）——否则 Windows 遮挡判定会把屏幕外窗口当不可见、节流渲染，Playwright 点击/截图随机卡死。**跑 e2e 不得把窗口弹到用户桌面最前或抢焦点**：新增窗口/新 fixture 必须沿用同一开关，禁止 `show()`/`focus()`/`maximize()` 抢前台；需要真实窗口位置/几何断言的用例（如 `window-memory`、`quick-task`）必须 `test.use({ e2eWindowMode: "visible" })`（fixture 下发 `PIDECK_E2E_WINDOW_MODE=visible`），调试时想看窗口同样设该环境变量。摆放失败必须静默回退，不允许阻断 e2e（守卫：`tests/e2eWindowMode.test.mjs` + `e2e/window-background.spec.ts`）。

**IPC 与 preload**：preload 不做业务，只做校验后的转发与订阅封装；事件推送 preload 侧返回 unsubscribe 函数，渲染层卸载必须退订。

**原生模块与打包**：node-pty 等原生模块必须 `asarUnpack` 并 postinstall 修权限（`scripts/fix-pty-permissions.js`）；afterPack 删 node_modules 冗余文件必须有对应测试（`tests/afterPackCleanup.test.mjs`）；资源路径用 `process.resourcesPath`/`app.getAppPath()` 推导，禁止裸 `__dirname` 假设 asar 可读，preload 路径走 `preloadPath.ts`。**安装器完成页的「运行 PiDeck」必须直接启动 `$INSTDIR\${APP_EXECUTABLE_FILENAME}`**（`build/installer.nsh` 的 `customFinishPage`）——electron-builder 默认用 `$launchLink`，它优先取开始菜单 `PiDeck.lnk`，那条 .lnk 可能被指向另一份同名同版本的 PiDeck（解包构建/旧安装目录，实例 2026-10），装完点运行会跑错程序且版本号看着是对的；守卫测试 `tests/nsisFinishPageLaunch.test.mjs`。**原生模块禁止顶层静态 import**——JS 包装可能在模块求值时同步加载对应平台二进制（koffi 即如此），跨 arch 打包时可选依赖（`@koromix/koffi-*`）不会自动跟随，缺二进制环境启动即崩（issue #313）；必须经专属模块函数内 `createRequire` 惰性加载 + try/catch 降级，守卫测试见 `tests/cua/cuaKoffiFallback.test.mjs`。

**跨平台**：禁止硬编码 `/` 或 `\`；平台特判集中在专属模块（如 `linuxDisplayBackend.ts`）；Windows「偶发失败」优先怀疑路径空格/杀毒锁文件/长路径/权限弹窗，日志带足上下文；**WSL 项目的 git 一律走发行版内 git**——cwd 是 `\\wsl.localhost\...` UNC 时经 `wsl.exe -d <distro> … git` 执行（见 `src/main/git/gitWsl.ts`），理由：宿主 git.exe 经 9P 会被判 dubious ownership，且两套 git 索引视角不一致会让仓库反复「整树改动」；**git 子进程只有两个入口**——`execGit`（读类）与 `runGitCommand`（写类）都在 `src/main/git/gitRun.ts` 收口，新增 git 调用不得绕过。

## 稳定性与可扩展性约束

1. **错误处理分层**：主进程 catch 后写日志 + 返回结构化错误（不抛裸异常跨 IPC）；渲染层用户可感知错误走 toast/内联文案（i18n）；异步函数禁止无 catch 的裸 promise。
2. **生命周期配对**：注册 listener/timer/子进程/watcher 的地方，同一模块必须有清理路径。
3. **资源边界**：大文件读取、会话扫描、diff 计算要有大小上限或流式处理；渲染进程不做全量日志/历史的主存。
4. **向后兼容**：设置项、会话文件、缓存格式变更必须有迁移或默认值兜底；删除旧字段前保留一个版本读取兼容。
5. **特性开关**：高风险/实验功能必须可从设置关闭/回退，默认取保守项。
6. **扩展点**：新增能力优先做成注册式（IPC 域注册、面板注册），不在既有 switch/if 链上加分支。

## 验证命令

| 场景 | 命令 |
|------|------|
| 类型检查（每次改动后） | `npm run typecheck` |
| 针对性单测（改动涉及的测试文件，日常必跑） | `node --test tests/<相关>.test.mjs` |
| 全量单测（仅跨域大改动/合并前最终确认） | `npm test` |
| 单测串行（排查并发干扰） | `npm run test:serial` |
| E2E（窗口默认屏幕外、不打扰；需要看窗口时设 `PIDECK_E2E_WINDOW_MODE=visible`） | `npx playwright test e2e/<相关>.spec.ts` |
| 验证退出码（硬性） | 门禁命令禁止用管道吞 rc：`npm run typecheck \| tail` 返回的是 tail 的 0。用 `set -o pipefail` 或重定向到文件后查 `$?`（测试经沙箱 TS 转译对语法错误容错，可能假绿，typecheck/format 是唯一门禁——2026-10 实际漏过一个缺括号） |

改动影响主进程/IPC/会话链路：typecheck + 相关针对性测试；纯 UI 样式微调至少 typecheck。

## UI 与样式约定

- 新增 UI 复用 `components/ui-shadcn/` 共享原语，不用原生 `<select>`、不裸写 `<input>`；图标统一 `lucide-react`，品牌 Logo 用 `LogoMark`；颜色/圆角/字号复用 `styles/` 语义 token，暗色模式自然适配；布局保持桌面工作台结构（左列表/中会话/右抽屉/底终端）。

### CSS 双轨（硬性）

旧轨 = 手写语义 class（`styles/{foundation,timeline,surfaces,integrations,workspace}.css`），新轨 = Tailwind v4 + shadcn（`styles/tailwind.css`、`components/ui-shadcn/`）。**禁止 big-bang 全量重写，禁止第三套视觉语言。** 口诀：视觉上「新学旧」，代码上「改到哪，旧迁新到哪」。

1. Token/长相以旧 foundation 为准，新栈经 `@theme` 桥接同一套 token，不另起平行色板。
2. 新改动只写 Tailwind + shadcn；禁止新增手写 CSS class（token、keyframes、既有 `tone-*`/`status-*` 锚点除外）；改某块 UI 时把抢同属性的旧规则删掉或收窄。
3. Cascade 层序不可改错（`tests/cssCascadeLayers.test.mjs`）：`theme < base < components < vendor < legacy < utilities`。legacy 必须高于 base（否则 preflight 冲掉手写外观）、低于 utilities（否则 Tailwind 不生效）；旧文件只在入口用 `layer(legacy)` 引入，禁止文件内部再包 `@layer`。
4. `!important` 会反转层优先级：碰到旧规则的 `!important` 删掉或收窄，不给 utility 堆 `!`。半吊子 utility 比没写更糟——utility 必须对齐原视觉再删冗余 legacy 声明。
5. `--color-accent` 是「面」不是「字」：`text-accent` 会解析成悬停面色（亮暗色都是字底同色 → 文字消失）。面上的正文用 `text-accent-foreground`；主题强调色文字用 `text-primary`（守卫：`tests/storeSuggestionChipContrast.test.mjs`）。
6. **限高 flex 列的子项必须 `shrink-0`**（2027-01 排版事故）：`overflow-y-auto` + `max-h-*` 容器里，子项带 `overflow:hidden` 后 `min-height:auto` 被清零 → 内容被线性压缩成横条且滚动条不出现。给限高容器子项加 `overflow-hidden` 时必须同步 `shrink-0`（守卫：`tests/sessionTodoStrip.test.mjs` + `e2e/todo-strip-scrollbar.spec.ts`）。
7. utility「看不见」时用 DevTools 看胜出规则来自哪一层，先处理冲突源再改 class。

### beUI 组件迁移

- 安装走 CLI（`npx shadcn add @beui/<name>`），不手动复制源码；文件存在加 `--overwrite`。
- `lib/ease.ts` / `lib/utils.ts` / `agents/agent-disclosure.tsx` 保持官方原版，禁止存私有曲线值（历史上曾改私有值导致每次安装被 CLI 连坐覆盖）；运动常量统一从 `@/lib/ease` 取。
- 迁移惯例：文件放 `components/<域>/`，头部保留 `// beui.dev/components/<path>` 注释，文案走 i18n。

## 领域硬约束速查（改到哪，读哪节）

> 完整细节、事故背景与流程步骤见 `docs/maintenance-domains.md` 对应小节（按小节标题定位）；本表只放改代码前必须知道的一行底线。

| 领域 | 硬约束 | 详见 maintenance-domains.md 小节 |
|------|--------|------|
| README/官网共用图片 | 唯一数据源 `docs/images/`，不复制到 docs-site | README 与官网共用图片 |
| 公告 | 只编辑 `announcements-md/*.md`，json 由脚本生成，禁止手写 | 公告维护与发布 |
| 提示词库 xueprompts.db | db 远程拉取双源成套（sha256+db 同源）；检索走 xue-index Go sidecar，缺失降级 sql.js（应用层 gunzip，SQL LIKE 中文恒不命中）；改 db 走 publish 脚本+Release 资产 | 商店提示词库维护 |
| 跨会话正文搜索 | session-index Go sidecar（纯标准库）；语料+快照落 `<userData>/session-index/`；roots = 全局 + 全局 sessionDir + **各项目项目级 sessionDir**（WSL 不支持）；查询多词 AND（每词必中）；任何失败 IPC 返回 null 降级标题过滤；**会话内查找绑定 Ctrl/Cmd+Shift+F（Ctrl+F 仍是「搜索会话」，别复用）：IPC 入参是 SessionRecord.id，主进程按 catalog 后端分派——pi 走同 sidecar 的 `search-session`，DSH 走 host 历史投影（`DshAgentManager.searchSessionMessages`）**；`SESSION_INDEX_OS/ARCH` 必须进三平台 workflow | 跨会话正文搜索 |
| 文件抽屉搜索 | 名字走 file-index Go sidecar（不可用回退 `FileSystemService.searchNames` 扫盘）；**拼音检索只存在于 sidecar 通道**：纯字母查询（2–24）按 首字母整名 > 首字母前缀 > 全拼 > 跳字 计分（含异读首字母：`cq`/`zq` 都能命中「重庆」），全拼不覆盖异读、内容检索不参与；正文搜索 `files:search-content` 失败/未就绪/WSL 返回 null、UI 隐藏内容分区；内容扫描有扩展名白名单/忽略目录/单文件 1MiB/总 64MiB 预算；`FILE_INDEX_OS/ARCH` 必须进三平台 workflow，`native/file-index/go.sum` 必须入库 | 工作区文件搜索 |
| 会话标题拼音 | 侧栏搜索是渲染层本地过滤（拿不到 sidecar 索引）：拼音表是**生成物** `src/renderer/src/utils/pinyinTable.ts`（`native/tools/pinyin-table` 从 go-pinyin 抽，改字典版本必须 `npm run gen:pinyin-table`，生成物禁手改）；分数与 file-index 逐值对齐（700/680/640/560），装配点 `SidebarContent` 的 `pinyin: pinyinKeys(title)`（漏喂＝拼音静默失效，`tests/morphingSearchFilter.test.mjs` 兜） | 工作区文件搜索 |
| 会话数据面 sidecar | session-store（`get-index` 条目表 + parity 双向全绿 + **条目录盘，默认开启**）：`settings.sessionStoreEnabled` 置 false 即回退纯 TS 解析（无 UI）；`state.bin` 只存文件级记账（`size` 只推进到完整行、行 > 64MiB 只探前缀），条目表落 `<userData>/session-store/tables/<sha1>.table`（256 文件/512MiB 上限，`size+mtimeMs` 版本键，变长且上次停在换行边界→尾扫增量）；重启首次打开大会话 14–20ms（TS 冷建表 99–188ms，见计划 §8.11）；roots 逐请求不带进 spawn；构建链 `npm run build:session-store` + `extraResources` + `SESSION_STORE_OS/ARCH` 三平台 workflow，缺一即打包后 binary-missing | 会话数据面 sidecar（session-store）|
| Go sidecar 宿主客户端 | 一律继承 `src/main/sidecar/GoSidecarClient.ts`；禁止复制 NDJSON 行泵/boot 计时器/pending Map/进程身份核对；新增 sidecar 必须有复用键、协议版本校验、fail-open 降级与共享层测试 | Go sidecar 宿主客户端（共享传输层）|
| 技能商店安装 | 商店搜索必须走注入的 `fetchImpl`（Electron net.fetch），禁裸全局 fetch（undici 不读代理，境外 API 挂到超时）；安装用 spawn+流式解析（禁 execFile 等终态输出）、进度走 `skillHub:install-progress`、子进程必注入代理 env（CLI 内部 git 不读 npm proxy） | 技能商店安装链路 |
| 内置扩展热更新 | 判据是逐文件 sha256 不是版本号；覆盖层必须完整快照 + vendored 依赖；磁盘根统一走 `resolveBuiltInExtensionRoots()` | 内置扩展热更新 |
| 生图存储 | **base64 不进 JSONL**（只存 ref）；读取永远有字节上界；`<img src>` 只走 `imageContentSrc()` | 生图会话存储 |
| 智能体 / 划词工具 | 配置只落 `<userData>/agent-profiles.json`（内置 `builtin-translate` / `builtin-pideck-helper` / `builtin-pideck-diagnostic` / `builtin-pideck-plugin-dev` 只补种不覆盖用户编辑）；一次性调用 `agent-profiles:invoke` 的 systemPrompt 只能由主进程按 agentId 解析（渲染层禁传），侧车必须**独立实例**（单飞语义，共用会打断输入框增强）；「使用」= 会话绑定（`sessionAgentBindings`），每次发送由主进程注入隐藏 `agentMessage`（DSH 退化为可见前缀），时间线只显示用户输入，会话输入框上方常驻可展开的角色设定条（只读展示，不写会话文件）；「智能体」与「定时任务」都是**会话 Tab 栏里的页面式 Tab**（不是弹窗、不是会话 Tab：切会话只失活、关闭才卸载），标题固定走 i18n、不参与自动会话标题（普通会话标题仍由内置扩展按提示词模板生成）；划词设置只在设置页；划词浮钮 mousedown 必须 preventDefault，与时间线「引用并提问」浮层共存时只能有一个浮层（时间线浮层内提供翻译动作）；系统级划词目前隐藏且默认关闭（`SYSTEM_SELECTION_TOOL_ENABLED=false`、默认设置 false；设置页/快捷键页不展示；复制监听、原生捕获、快捷键全部不启动），恢复后才按“选区/复制即触发”启用； | 智能体与划词工具（agent-profiles.json + 一次性补全侧车 + 系统级划词浮窗） |
| 内置浏览器 Agent | 只经 `pideck-cua` MCP host 暴露 `browser_*`（例外六）；页面文本不可信、写动作默认自动放行（可关闭改为逐次审批）；guest 不缓存（抽屉/全屏会重建）；CDP 被 DevTools/内存探针占用时降级并标 degraded；不注入 preload、不改 webview 安全档位 | docs/browser-agent-plan.md §7/§9/§12 |
| 会话消息编辑/删除/重发 | 编辑/删除写 pi 原生 `context_edit`（原文不改写、费用不回退；被移出的条目界面直接不显示，原始文件仍保留）；重发仍用 `deleted` 墓碑截断分支；追加条目的 parentId 必须取当前 leaf，pi 活着禁改会话文件，三道闸不许放宽 | 会话消息编辑/删除/重发 |
| Markdown 渲染 | 唯一引擎 MarkdownStream，禁止再引 marked/react-markdown；流式与 settle 是两条路径，**复现要看最终态**；HTML 一律过 `markdownSanitize.ts`（raw→摘毒→sanitize，不开 harden），模型回复里的 `<style>` 会污染整页图标（#397） | 会话 Markdown 渲染管线 |
| 宿主插件 | 与 pi 扩展是两套系统（`src/main/plugins/`，不依赖 pi 进程）；授权按内容 sha256 指纹不按版本，指纹变即重新授权；历史读取 64MiB/10 万条硬预算；改 API/权限面必须同步 `src/preload/hostPlugin.ts` + `docs/host-plugin-dev-guide.md` + 脚手架（生成物过同一套 manifest 校验）；`service.local` 只给「点名权」（命令/参数/端口在主进程适配器里，id 白名单 `src/shared/localServices.ts`）；内置示例 `resources/host-plugins/` 由 `seedBuiltin` 落位（内容没被手改过才随新版刷新，手改过的永不覆盖；`seeded` 的 id 拒绝卸载）；`.pideck-plugin` NDJSON 归档逐文件 sha256；GitHub 安装只走 `codeload.github.com` 的 tar.gz + 自写 tar 解析（`src/main/plugins/hostPluginGitHub.ts`），禁为不可信输入引入第三方解压依赖，三条安装路径共用 `HostPluginManager.installFiles` 同一套预算与信任判定；pi-context 适配器 seam 是 fail-closed 契约 | 宿主插件 |
| Web 端流式链路 | 流式事件源必须按后端分别注入 `WebEventStreamRouter`：pi 走 `subscribePiEvents`，DSH 等非 pi 后端走 `subscribeAgentChannelEvents`（`DshChannelToPiEvents` 把通道载荷翻成 pi 事件形状，复用同一套 UIMessageStream 适配器）；漏挂的后端在 Web 端退化成「轮询 + 磁盘重拉」（输出慢、整轮无 finish 帧 → 察觉不到结束/停止）；回合边界只认 `turnEnded: true` | Web 端流式链路 |
| i18n 文案 | 改任何 zh-CN 词典（rendererCopy / mainProcessCopy / WebI18n / FeishuI18n）后必须重跑 `node scripts/genZhTwCopy.mjs`；四份 `*.zh-TW.ts` 是生成物禁止手改（漏跑：先 typecheck 报 TS2739，改值不加键则由 `source-sha256` 指纹门禁拦下） | 繁体中文（zh-TW 四份词典 + locale 分支点） |
| 发版 | CHANGELOG 中英一致 → sync-release-notes → sync-workflow-choices → 打包人工 smoke | docs/release-process.md |

## 协作流程

### Issue 修复

1. 直接在当前开发分支（通常 `dev`）上改，**不要**为单个 issue 另拉 `fix/issue-*` 分支（多 agent 并行会互相踩工作区）。
2. 先定位根因，记录影响范围；涉及启动、环境检测、会话恢复等核心流程时，同步检查相邻路径同类问题。
3. 修复聚焦单一问题，`fix:` 前缀提交，关联 issue；PR 描述写清原因、修复摘要、验证命令，写 `Closes #<number>`。

### 提交规则

> **不要自以为是地提交代码。只有用户明确要求时，AI 助手才可以执行 `git add`、`git commit` 或 `git push`。**

1. 工作过程中不自动 commit，完成一步后也不提交。
2. 只有用户明确说「提交吧」「commit」「push」等意图时才执行。
3. 完成后简要总结，询问「需要我提交吗？」。
4. 用户同意时，一个功能/修复的全部变更放一个 commit，不拆小 commit（用户另有要求除外）。

### 多 agent 并行开发（硬性）

> 背景：本仓库常被多个 agent 同时操作。无隔离时，A 的选择性 `git restore`/`clean` 会清掉 B 的未提交改动、`npm install` 会重建 `node_modules/.bin` 打断他人 typecheck、暂存区互相覆盖（2026-10 两轮实战事故）。总目标：**任何人的未提交工作不被另一个 agent 破坏**。

**编排层（发起并行前先定）**

1. 两个以上 agent 同时改 `src/` → 优先每人一个 `git worktree` + 独立分支，合并由单一收口人执行；不允许两个「写」agent 长期共享同一工作树。
2. 无法 worktree 时按目录划 ownership，各 agent 只在指派目录内写；公共汇聚文件（`AGENTS.md`、`src/main/index.ts`、`src/shared/types/settings.ts`、i18n copy、`package*.json`）同一时刻只许一个写者。
3. 只读任务（调研/评审/搜索）不受限，任意并行。

**agent 行为红线（共享工作树时全部生效）**

1. 开始写代码前先 `git status` 留基线，归属存疑时对照基线判断。
2. **git 操作必须路径精确**：只许 `git add <本任务文件列表>`；禁止 `git add -A/-a/.`、对非本任务文件 `git restore`/`checkout --`、任何形式的 `git clean`、`git reset --hard`、`git stash`（stash 会收走他人改动）。要还原某文件，先确认其全部改动都是本任务产生的。
3. `git status` 里非本任务产生的改动：不暂存、不还原、不删除、不评判——那是别人进行中的工作；同文件混着他人改动时用 hunk 级暂存（`git apply --cached`）或停下报告。
4. 并行期间禁止 `npm install`/删改 `node_modules`（重建 .bin 会打断他人 typecheck 与 dev server）；依赖增删集中交给单一收口 agent。
5. 不 kill 不认识的进程、不占他人 dev 端口、不清理 `.git/` 下不认识的文件（可能是别人的 checkpoint）；自己的工作文件不放 `.git/`。
6. 提交前 `git diff --cached --stat` 自查只含本任务文件，混入立即按路径精确 unstage。
7. 任务收尾时工作树应只剩他人改动——自己的全部已提交；带着未提交改动离开视为事故。

### 长期重构纪律

- 大重构先写对照计划（能力 parity 表 + 合并门禁），文档放 `docs/` 并注明状态；落地后收口（更新状态行或删除），不留悬空计划文档。
- 域迁移的固定门禁（App.tsx/AgentManager/index.ts 拆分验证过，方法详见 skill `pideck-large-file-domain-migration`）：源码整块迁出 + 原文件留薄包装或依赖注入，行为零变化，不顺手改语义；每步迁完 `grep -rl "旧文件路径" tests/` 找出 readFileSync 源码契约测试同步改读新模块（含断言里的旧标识符前缀，如 `feishuBridge` → `deps.feishuBridgeRef.current`）；跨文件共享的可变单例用 `{ current }` ref 槽位，不复制第二份状态；目标文件行数单调下降才算一个 wave 完成。
- 禁止无对照表的长期分叉分支；main 的用户可感知改动当周回填到进行中重构分支。
- 重构期间禁止 `-X theirs`/`-X ours` 静默吞掉对方改动；每个冲突都要确认能力归属。
