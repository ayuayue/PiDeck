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

**例外二：GUI 扩展桥（`pi-deck-gui-bridge` + `pi-deck-model-trace`，只允许 UI 帧、交互事件、模型请求快照）**

- pi 的 `ctx.ui` 声明式方法在 RPC 模式下被降级成空实现（见 pi `docs/rpc-extension-ui.md`），要接回只能在 pi 进程内拦截。主进程起只绑 `127.0.0.1` 的端点（`src/main/pi/bridge/BridgeServer.ts`，每 agent 一份 token，spawn 时注入 `PIDECK_BRIDGE_URL`/`PIDECK_BRIDGE_TOKEN`）；pi 侧由随包分发、`-e` 注入的桥扩展（`resources/extensions/pi-deck-gui-bridge*.ts`）推拉数据。`/bridge/<token>/model-trace` 子路由承载模型请求快照（`resources/extensions/pi-deck-model-trace.ts`，完整请求体落 `userData/logs/model-traces/`，时间线只留摘要 + traceId）。
- 线格式唯一来源：宿主侧 `src/shared/types/bridge.ts`，桥侧 `resources/extensions/pi-deck-gui-bridge-types.ts` 逐字段对齐，由 `tests/guiBridge*.test.mjs` 与 `tests/modelTraceExtension.test.mjs` 兜底。
- 与 pi 内部的耦合已收敛到**路径定位**：`pi-deck-gui-bridge-tui.ts` 只解析 pi-tui 的安装路径（给 ext-points 做 types.d.ts 种子 + 诊断日志），不再加载模块；组件识别走实例原型链上的构造器名（serialize 的逐级匹配），不依赖 pi 安装布局。pi 升级挪动位置时定位失败只影响扩展点目录的一种子来源，必须静默降级而非报错。
- fail-safe：端点起不来 → 不注入 env → 桥静默不工作；桥抛错 → 最多某落点缺席；两种都不得影响 pi 会话与其余功能。生命周期配对：`registerAgent` ↔ `unregisterAgent`（统一走 `AgentManager.unregisterBridgeSession`），stop/restart/删会话/退出都要注销。用户可在扩展设置页整体关掉桥（`removedBuiltInExtensions` → 不再注入），行为回到「没有桥」。

**例外三：standby 运行时池（预热 + 只读命令预览；「消费池进程」仍然只有「提前起进程」一个用途）**

- 一次 pi RPC 激活约 8.5s（实测 ≈ node/pi boot 0.5s + 用户 npm 扩展 5s + 内置 16 个 TS 扩展 2.4s），全部发生在 spawn→握手段。池的用法：草稿创建/激活完成后 `AgentManager.ensureStandbyAgent(projectId)` 后台起一个完整握手的进程待命（`src/main/pi/StandbyAgentPool.ts`：单槽位、容量 1、10min TTL 自动回收）；新会话激活经 `SessionRuntimeCoordinator.claimStandbyAgent` 认领，认领后照常走 applyLatestPreferences/mergePendingPermissionSettings，模型与权限热更新语义不变。
- 只服务新会话（noSession/恢复历史会话不认领）；spawn 输入指纹（`src/main/pi/standbyFingerprint.ts`：扩展根/禁用集/offline/noExt/noSkills/customPiPath/WSL/代理/launchArgs）任一变化即丢弃回退普通 spawn，改设置无需重启池；信任走 `resolveTrustWithoutPrompt`，含资源未决策不池化（绝不后台弹 trust 弹窗）。
- 已知限制：池化进程不带 PIDECK_SESSION_ID，安检门按默认档工作，per-session 安全覆盖对认领会话要重启才生效；池化 agent 对 agents:list/agent:state-changed 不可见。开关 `settings.standbyRuntimeEnabled`（默认开，开发者页可关）。启动耗时探针：`scripts/probePiStartup.mjs`（JITI_DEBUG=1 出逐模块 trace）。
- 只读借用（Issue #316）：草稿会话斜杠命令预览 `AgentManager.draftCommands` 经 `StandbyAgentPool.peek(projectId)` 查同项目池进程的 `get_commands`（不认领、不消费、进程须 idle、指纹须新鲜）；链路 `sessions:draft-commands` IPC → 渲染层优先预览、空/失败回退本地技能/提示词发现；dsh/browser/preview 模式返回 null。

**例外四：提示词增强侧车（`pi-enhance-host.mjs`，只允许「一次性单条补全请求」这一用途）**

- 输入框提示词增强需要直接调 pi SDK 的补全（不走 RPC 会话），主进程经常驻单进程 sidecar 实现：`resources/pi-enhance-host.mjs`（stdout 只放 NDJSON 协议，载入 `PIDECK_PI_SDK_ENTRY` 指向的 pi `dist/index.js` 建 `ModelRuntime`），宿主侧收口在 `src/main/pi/enhance/EnhancePromptService.ts`，启动参数定位复用 `piAuthHostLaunch` 的 `resolvePiAuthHostLaunch`，必须列进 `extraResources`。
- 常驻单进程多 run：新 run 打断旧 run、显式 cancel、boot/run 超时、进程意外退出都在服务层结算（每 run 回调恰好一次）；渲染层按 scopeKey 隔离，切会话作废进行中的 run，结果只回填发起方输入框。入口 `enhance:run`/`enhance:cancel`/`enhance:on-event` 在 `src/main/ipc/enhanceIpc.ts`（边界校验；provider/modelId 形态校验只挡空白/控制字符/超长，真实目录的 `builtin:` `https://` `a/b` 形态必须放行）与 preload 白名单；hook 为 `src/renderer/src/hooks/usePromptEnhance.ts`。目标模型优先级见 `src/shared/enhanceModelPreference.ts`：设置固定模型（`settings.enhanceModel`，设置页通用 tab）> 会话记录 > 引导页点选 > 部署/主进程默认，默认跟随会话模型。fail-safe 与 pi-auth 一致：sidecar 起不来只是按钮置灰 + toast，不影响 pi 会话与其余功能。禁止扩展成通用模型 API 桥。

## 目录结构与跨层契约

本项目只维护项目根这一份 `AGENTS.md`；不要再在子目录生成规则文件。规则冲突时以本文件和实际类型/API 为准。

```
src/
├── main/              # Electron 主进程（唯一可访问 Node/主进程能力）
│   ├── pi/            # pi RPC 进程管理、认证、GUI 桥
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
- 文案：用户可见文本一律走 i18n（`rendererCopy.zh-CN.ts` + `en-US.ts` 同步加 key），JSX 禁止硬编码中英文。
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

**IPC 与 preload**：preload 不做业务，只做校验后的转发与订阅封装；事件推送 preload 侧返回 unsubscribe 函数，渲染层卸载必须退订。

**原生模块与打包**：node-pty 等原生模块必须 `asarUnpack` 并 postinstall 修权限（`scripts/fix-pty-permissions.js`）；afterPack 删 node_modules 冗余文件必须有对应测试（`tests/afterPackCleanup.test.mjs`）；资源路径用 `process.resourcesPath`/`app.getAppPath()` 推导，禁止裸 `__dirname` 假设 asar 可读，preload 路径走 `preloadPath.ts`。**原生模块禁止顶层静态 import**——JS 包装可能在模块求值时同步加载对应平台二进制（koffi 即如此），跨 arch 打包时可选依赖（`@koromix/koffi-*`）不会自动跟随，缺二进制环境启动即崩（issue #313）；必须经专属模块函数内 `createRequire` 惰性加载 + try/catch 降级，守卫测试见 `tests/cua/cuaKoffiFallback.test.mjs`。

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
| 提示词库 xueprompts.db | `content`/`description` 是 gzip BLOB，SQL LIKE 中文恒不命中，必须应用层 gunzip 后匹配 | 商店提示词库维护 |
| 内置扩展热更新 | 判据是逐文件 sha256 不是版本号；覆盖层必须完整快照 + vendored 依赖；磁盘根统一走 `resolveBuiltInExtensionRoots()` | 内置扩展热更新 |
| 生图存储 | **base64 不进 JSONL**（只存 ref）；读取永远有字节上界；`<img src>` 只走 `imageContentSrc()` | 生图会话存储 |
| 会话消息编辑/删除/重发 | 编辑/删除写 pi 原生 `context_edit`（原文不改写、费用不回退；被移出的条目界面直接不显示，原始文件仍保留）；重发仍用 `deleted` 墓碑截断分支；追加条目的 parentId 必须取当前 leaf，pi 活着禁改会话文件，三道闸不许放宽 | 会话消息编辑/删除/重发 |
| Markdown 渲染 | 唯一引擎 MarkdownStream，禁止再引 marked/react-markdown；流式与 settle 是两条路径，**复现要看最终态** | 会话 Markdown 渲染管线 |
| 插件开发支持 | 能力目录 `pluginDevCatalog.ts` 镜像桥实现（19 落点/42 kind），新增落点/kind 必须同步目录+契约测试；`resources/plugin-dev` 要在 extraResources；demo 已存在不覆盖 | 插件开发支持 |
| 宿主插件 | 与 pi 扩展是两套系统（`src/main/plugins/`，不依赖 pi 进程）；授权按内容 sha256 指纹不按版本，指纹变即重新授权；历史读取 64MiB/10 万条硬预算；`.pideck-plugin` NDJSON 归档逐文件 sha256；pi-context 适配器 seam 是 fail-closed 契约 | 宿主插件 |
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
