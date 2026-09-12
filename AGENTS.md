# AGENTS.md

## 项目简介

PiDeck 是一个面向本地开发工作的 Electron 桌面应用，用于在多个项目目录之间管理和运行 pi RPC Agent。应用提供多项目工作区、会话时间线、历史会话恢复、文件抽屉、Git 面板、模型选择、工具调用展示、内置浏览器、中文提示词精选、技能/扩展商店以及打包发布能力，目标是让用户可以在桌面端更稳定地管理多个 pi 编码助手会话。

技术栈：Electron 38 + React 19 + TypeScript + Vite。

**核心边界（不可逾越）：**

- pi 负责 Agent 行为、工具调用、会话读写、模型调用 —— **pi 的事不要替它做**。
- PiDeck 负责窗口管理、进程生命周期、会话浏览/导入、Git 面板、终端、设置 —— **UI 框架的事 pi 也不要做**。
- 两者通过 stdio JSON-RPC 通信，禁止引入第二条通信通道（如直接 HTTP 到 pi 内部）。

## 代码结构与跨层契约

本项目只维护项目根目录这一份 `AGENTS.md`；除非用户明确要求，不要再在子目录生成同名规则文件。`docs/开发规范.md` 中仍有历史架构表述，若与本文件或实际类型/API 冲突，以本文件和代码为准。

- `src/shared/` 是跨进程纯契约层：共享类型按 `shared/types/*.ts` 拆分，`shared/types.ts` 仅做兼容导出；IPC 名称只定义在 `shared/ipc.ts`。
- `src/main/` 是唯一可访问 Node/Electron 主进程能力的业务层。`main/<domain>/` 拥有领域行为，`main/ipc/*Ipc.ts` 只做输入校验和适配，`main/index.ts` 只增装配，不新增业务。
- `src/preload/index.ts` 通过 `contextBridge` 暴露最小 `PiDesktopApi`；新增 IPC 必须同步共享通道、main handler、preload 方法三处，订阅 API 必须返回 unsubscribe。
- `src/renderer/` 只通过 `desktopApi`/preload 调用桌面能力。跨组件状态使用 Jotai atom，副作用放 hook，视图放 component；不得直接 import Node/Electron 或新增第二种全局状态方案。
- `SessionRecord.id` 是跨重启的稳定会话身份，`agentId` 仅表示当前 pi 子进程。所有 runtime 命令和事件都必须带 `sessionId + agentId + runtimeGeneration`，拒绝旧 runtime 的迟到结果。
- pi 只通过 stdio JSON-RPC 与 PiDeck 通信；PiDeck 不复刻 pi 的 Agent/工具/会话行为，也不为访问 pi 引入第二条通信通道。
- 持久化结构、设置和 session catalog 变更必须兼容旧数据；listener、timer、子进程、terminal 和 watcher 必须在同一模块找到配对清理路径。


```
src/
├── main/              # Electron 主进程
│   ├── pi/            # pi RPC 进程管理、消息解析
│   ├── sessions/      # 会话扫描、导入、摘要缓存、SessionRuntimeCoordinator
│   ├── git/           # GitService（status/diff/commit/cherry-pick 等）
│   ├── prompts/       # PromptManager（本地模板）+ XuePromptManager（SQLite 中文精选）
│   ├── skills/        # SkillManager
│   ├── extensions/    # ExtensionManager
│   ├── settings/      # SettingsStore + DesktopProxy
│   ├── terminal/      # 终端会话管理（node-pty）
│   ├── pet/           # 桌面宠物
│   ├── feishu/        # 飞书集成（FeishuBridge + FeishuConnection）
│   ├── ipc/           # ★ IPC 域注册（sessionIpc/systemIpc/gitIpc/storeIpc/...）
│   └── web/           # Web 服务管理
├── preload/           # preload 脚本，经 contextBridge 暴露受限 IPC API
├── renderer/
│   └── src/
│       ├── atoms/         # Jotai 状态（session-first）
│       ├── components/
│       │   ├── ui-shadcn/  # 共享 UI 原语（button/dialog/input/select 等）
│       │   ├── session/   # 会话视图族（SessionView/Composer*/Timeline*）
│       │   ├── sidebar/   # 左侧栏
│       │   ├── workspace/ # 右侧抽屉（files/git/browser/editor）
│       │   └── app/       # 业务组件
│       ├── hooks/         # 渲染层 hooks（useWorkspacePanels/useSessionComposerController 等）
│       ├── i18n/          # 文案（zh-CN / en-US，rendererCopy.*.ts）
│       └── styles/        # 按域拆分的样式 + 语义 token
└── shared/            # 主/渲染共享类型（按域拆分）与 IPC 通道定义
```

### 公告维护与发布（announcements-md → announcements.json）

- 公告的**唯一编辑入口**是 `announcements-md/*.md`（front matter + markdown 正文；目录内 `README.md` 是维护说明，脚本显式跳过）。**禁止手写仓库根 `announcements.json`**，客户端实际拉取的文件必须由脚本生成。
- 发布流程：改 md → `npm run build:announcements`（`node scripts/build-announcements.js`）生成 json → md 与 json 一起 commit 到 `main` 分支。`npm run check:announcements`（`--check`）断言 json 与 md 逐字节一致，用于 CI 防手工改动漂移。
- md 格式：front matter 必填 `id` / `title` / `level`(info|warn|critical) / `publishedAt` / `effectiveUntil`（ISO 8601），可选 `minVersion`（仅向更低版本客户端展示）；`id` 必须稳定唯一（渲染层已读去重 key）且不含空白；下线公告 = 删除对应 md 文件重新生成，或等 `effectiveUntil` 自然过期。
- 渲染安全边界：公告是外部数据。**列表卡片只展示 `announcementExcerpt()` 清洗后的短摘要（不渲染 md）**；「查看详情」弹窗复用 `MarkdownStream`（light 模式）渲染完整正文——与会话消息同一套 streamdown sanitize 管线。禁止在列表卡片直接渲染 md 或引入第二条公告渲染链。

### 商店提示词库维护（resources/xueprompts.db）

- 数据文件 `resources/xueprompts.db` 通过 `extraResources` 直接打进安装包（dev 读 `app.getAppPath()/resources`，打包版读 `process.resourcesPath`）。**改了 db 必须重新打包**，否则用户升级后仍看到旧数据。
- 内置模板写入入口是 `scripts/add-builtin-prompts.mjs`（源文件 `docs/pi-prompt-templates/*.md`，跳过 README），归入分类 `编程提示词`，可重复执行（`INSERT OR REPLACE` + 分类 count 全量重算）。
- `npm run check:xueprompts`（`scripts/check-xueprompts.mjs`）断言分类 count 与实际分组一致、内置模板全部落库且正文可解压，已挂进 `npm run build`，用于挡住「产物带旧库」这类问题。
- **查询边界**：`content` / `description` 都是 gzip BLOB，**SQL 的 `LIKE` 对 BLOB 只做字节比较，中文关键词恒不命中**。所有涉及这两个字段的文本搜索必须在应用层 `gunzipSync` 解压后匹配（见 `XuePromptManager.list` 的 search 分支）；`title` 是明文 TEXT，可以走 SQL。

### 内置扩展热更新（resources/extensions + userData 覆盖层）

- 内置扩展（`resources/extensions/*.ts`）随包分发，RPC 启动时经 `-e <绝对路径>` 注入 pi。打包态 `resources` 只读，扩展出 bug 原本只能等下次发版；**热更新**把这条例外路径补上：拉远端清单 → 写 `<userData>/builtin-extensions/` 覆盖层 → 路径解析覆盖层优先 → 重启会话即生效。
- 清单 `resources/extensions/extensions-manifest.json`（schemaVersion / version / bundleSha256 / 每文件 name+sha256+bytes）由 `scripts/generate-extensions-manifest.mjs` 生成并**提交到仓库 main 分支**，`npm run generate:extensions-manifest` 生成、`npm run check:extensions-manifest` 校验，已挂进 `npm run build` / `build:fast`。版本号 `version` 是**包级**版本（`--set-version` bump），**不跟 PiDeck 应用版本走**。
- **`package.json` 的 `extraResources` filter 必须同时包含 `*.ts` 与 `extensions-manifest.json`**，否则打包版没有清单，扩展页看不到内置版本（漏了就只剩目录扫描兜底）。
- 更新/检测入口在扩展设置页的「内置扩展」面板（`BuiltInExtensionsUpdatePanel`）+ `extensions:builtin-update-*` 通道；默认源 AtomGit（`api.atomgit.com/api/v5/repos/.../contents/...` 返回 base64，匿名可读），`settings.updateSource=github` 时 GitHub raw 直连优先。分支只接受 main/dev 白名单。
- **判据是逐文件 sha256，不是版本号**：改了扩展却忘记 bump 版本也必须能检出更新；远端清单里出现**本地不认识的新文件名一律忽略**（注入清单 `BUILT_IN_EXTENSIONS` 编译在应用代码里，热更新不该也无法凭空引入新代码）。
- **覆盖层必须是完整自洽快照**：扩展之间存在相对 import（`pi-deck-todo.ts` → `./pi-deck-todo-state.ts`，后者不在 `BUILT_IN_EXTENSIONS` 里但在清单内）。因此更新写的是「变化文件取远端 + 未变化文件从当前生效源复制」的全集，且 `resolveBuiltInExtensionPath` 只在 `readVerifiedArtifact` 整份校验通过时才认覆盖层——半截覆盖层（缺文件/被外部改动）会让 pi 报模块找不到。
- 安全底线：先下载校验、后原子替换（tmp → `.bak` 换位 → rename，失败回滚）；`invalidateBuiltInExtensionsOverlayCache()` 必须在写盘/还原后调用，否则本次更新要等重启才参与注入。
- 三处磁盘根（`ExtensionManager` 列表/版本、热更新器写盘、`-e` 注入解析）必须同源，统一走 `src/main/index.ts` 的 `resolveBuiltInExtensionRoots()`；各拼一次路径迟早漂移成「更新成功但会话仍加载旧扩展」。

## 架构规则（硬性）

1. **session-first**：会话是一等公民。新功能优先挂在 session/runtime 链路上，不要退回“围绕 agent tab 堆全局 state”。
2. **状态管理用 Jotai**：新增跨组件状态放 `atoms/`，按域建 atom；禁止再引入第二种全局状态方案。
3. **IPC 按域注册**：主进程 handler 一律放 `src/main/ipc/*Ipc.ts`，`index.ts` 只做装配；通道名集中在 `shared/ipc.ts` 定义，禁止散落字符串字面量。
4. **类型共享走 `shared/types/`**：按域拆文件；主进程、preload、渲染进程不得各自重复定义同一结构。
5. **单向依赖**：`main`、`preload`、`renderer` 只能依赖 `shared` 契约；`renderer` 通过 preload 暴露的 API 访问主进程，不能直接 import Node/Electron；main 不得 import renderer 代码；`shared` 不得反向依赖任何运行时层。
6. **文件体量红线**：
   - 组件/模块单文件目标 ≤ 400 行，超过 600 行必须评估拆分。
   - `App.tsx`、`main/index.ts` 只增装配代码，不增业务逻辑；新业务先建新模块。
   - 为“省一次 import”把逻辑塞回大文件，视为架构倒退，评审应拒绝。

## 模块内聚与低耦合（硬性）

> 写代码的默认标准：**高内聚、低耦合、可单测、装配层不长胖**。功能能跑不等于结构合格。

1. **一个模块一件事**：状态机/策略/几何/解析放纯函数（`utils/` 或同域 helper），UI 只负责呈现与事件转发，hook 拥有该域状态与命令。禁止把「Tab / 预览 / 分屏 / 拖拽落点」这类完整域逻辑散落在 `App.tsx` 匿名回调里。
2. **装配层只装配**：`App.tsx` / `main/index.ts` 只做依赖注入与布局拼装。新增交互或状态流转时，优先抽 `hooks/useXxx`、组件宿主或 atoms；若改动让 `App.tsx` 再长出大段 `if/else` 业务，视为未完成拆分。
3. **按域抽 hook，而不是按屏幕堆 props**：跨多个子树的同一域（例如会话工作区 chrome、composer、timeline）应有明确 owner（如 `useSessionWorkspaceChrome`）。禁止用 30+ 字段的「共享 props 袋」在 App → Pane → Injector → View 之间层层透传；稳定回调与服务用窄接口 / context / 工厂，视图 props 只留身份与 chrome 开关。
4. **选中 ≠ 呈现**：`selectSession` / 打开会话记录只负责「当前会话是谁」；Tab 预览/常驻、分屏布局、拖拽 MIME 属于 chrome 域。不要把 `preview | permanent | keep` 之类 UI 模式长期渗进通用 selection API；chrome 应在边界组合「选中 + 登记」。
5. **多实例必须按 session 订阅**：分屏/多栏挂载时，runtime / messages / sendState 只订本栏 `sessionId` 的 atom family。禁止非聚焦栏订阅 `currentSession*` 全局原子，以免一栏流式更新拖垮另一栏重渲染。
6. **纯策略可单测**：落点边、预览替换、分屏关闭晋升等规则写成纯函数并配 `tests/*.test.mjs`；闭包回调里的产品策略（「第三个 Tab 替换聚焦栏」）应回到同一 chrome/reducer，禁止只活在 JSX lambda 中。
7. **异步与拖放用快照/稳定入口**：`drop` / `close` / 定时器不要闭包过期的 `tabs`/`previewId`；用 ref 快照、`useCallback` 稳定命令，或单一 `dispatch`。组件依赖数组禁止写整个 `props` 对象。
8. **同一 UI 能力一个挂载点**：如会话 Tab 栏、右侧抽屉开关，避免 solo/split 两套父级各挂一份导致「有的栏有、有的栏没有」。共享 chrome 放外层；栏内只保留本会话操作（停/重启等）。
9. **改前自检（合并前过一遍）**：
   - 这个改动是否让 `App.tsx` 更懂业务细节？若是，先抽出。
   - 新状态是否有单一 owner？还是 App + 侧栏 + Tab 栏各写一份？
   - 多会话场景下订阅是否按 `sessionId` 隔离？
   - 核心规则能否离开 React 单独测绿？

## 代码风格

- TypeScript strict；禁止新增 `any`（与第三方交互不得不用时，用 `unknown` + 收窄，并注释原因）。
- 禁止用 `as` 强转绕过类型错误；测试数据需要部分字段时用工厂函数构造完整对象。
- 命名：类型/类 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE；IPC 通道用 `domain:action` 格式。
- React：函数组件 + hooks；副作用必须有清理函数；派生状态用 `useMemo`，禁止把可计算值存进 state。
- 文案：所有用户可见文本走 `i18n`（`i18n/rendererCopy.zh-CN.ts` + `en-US.ts` 同步加 key），JSX 中禁止硬编码中英文。
- 日志/调试输出/内部标识符可硬编码，但日志用主进程 logging 模块，不散落 `console.log`（调试残留需删除）。

## 注释要求

- 对核心逻辑、复杂判断、业务规则、状态流转、权限校验、数据转换、异常处理添加必要注释。
- 注释解释“为什么这样做”“对应什么业务规则”“边界条件是什么”，不要逐行解释显而易见的代码。
- 新增函数、类、模块添加简短功能说明。
- 修改旧代码时，相关逻辑缺上下文说明的应顺手补注释。

## 测试标准（硬性门禁）

测试位于 `tests/*.test.mjs`（node --test）。日常改动只跑**针对性测试文件**（`node --test tests/<相关>.test.mjs`）；全量 `npm test` 仅在必要时机运行（见下方「验证命令」）。

1. **必过门禁**：任何合并前 `npm run typecheck` 与本次改动涉及的**针对性测试**（`node --test tests/<相关>.test.mjs`）必须全绿；全量 `npm test` 仅在改动影响面大（IPC/会话链路/装配层等跨域改动）或合并前最终确认时运行；不许“先合再修”。
2. **何时必须写测试**：
   - 修复 bug：先写复现测试（红），再修到绿。回归测试永久保留。
   - 新增主进程业务逻辑（sessions/git/settings/extensions/prompts 等）：必须有单测。
   - 新增数据转换/解析/状态机逻辑：必须有单测。
   - 纯 UI 布局调整可不强求，但涉及交互状态流转的 hook 应有测试。
3. **测试写法**：
   - 测行为不测实现：从公开接口/IPC 边界断言结果，不断言内部私有函数调用次数。
   - 不依赖执行顺序、不依赖真实网络/真实 pi 进程；外部依赖用 mock/替身。
   - 一个测试只验证一件事，命名即意图（如 `agentCreateTimeout.test.mjs`）。
4. **禁止**：为通过测试而放宽断言、注释掉失败测试、把测试改成恒真。

## 安全约束

1. **IPC 最小权限**：preload 只暴露当前页面需要的 API；新增通道必须加进类型定义，禁止 `ipcRenderer` 透传。
2. **输入校验在边界**：所有 IPC handler 的第一行职责是校验入参（类型、路径合法性、枚举范围）；渲染层来的数据一律不可信。
3. **路径安全**：文件读写必须限制在项目目录或应用数据目录内；拼接路径前做规范化与逃逸检查，禁止直接拼用户输入。
4. **进程调用**：spawn/exec 的参数必须数组形式传递，禁止字符串插值拼 shell 命令；子进程环境变量经 `sanitizePiChildEnv` 类函数清洗。
5. **Webview/浏览器面板**：禁止加载 `file://` 以外的任意本地内容；`allowpopups`、node integration 等属性保持最小化，新增 webview 属性需评审。
6. **密钥与令牌**：Auth 配置只经 `config/` 模块读写；日志、错误上报、遥测中禁止输出 token/key。
7. **依赖引入**：新增依赖需说明理由；优先用已有依赖能力，禁止为一个小功能引重型库。

## Electron 开发规范与经验总结

> 本节沉淀本项目在 Electron 上的硬性规范与踩坑经验。改动 `main/index.ts`、窗口创建、preload、打包配置前必读。

### 启动与进程生命周期

1. **app.ready 前的配置窗口**：`commandLine.appendSwitch`、`app.setPath("userData")`、单实例判断等必须在 `app.whenReady()` 之前完成；错过时机一律无效，不要试图在 ready 后补救。
2. **启动失败要可诊断**：主进程关键节点（窗口创建、load 开始/结束、preload 路径、pi 启动）必须写 `appLogger`，黑屏/白屏排查只靠日志。
3. **首帧体验**：窗口保持隐藏时先 `maximize()` 再加载页面，避免 `ready-to-show` 后再最大化造成布局跳变；`zoomFactor` 等用户设置在 `did-finish-load` 后应用，防止被加载过程覆盖。
4. **单实例用自研按版本互斥，不用 `requestSingleInstanceLock`**：原生锁按 userData 全局互斥，会导致不同版本无法并行。本项目实现见 `acquireVersionSingleInstance`（同版本复用窗口、不同版本并存）；第二实例用 `app.exit(0)`（未 ready，比 `quit()` 快）。
5. **开发/正式数据目录隔离**：dev 模式 userData 追加 `-dev` 后缀，防止开发调试污染正式数据；追加前判断已有后缀，避免重复拼接。
6. **退出清理**：quit 路径必须覆盖 pi 子进程、node-pty、文件 watcher、单实例锁文件；新增常驻资源时在退出清单里同步登记。

### 窗口与 webContents

7. **主窗口 webPreferences 基线**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox` 跟随用户设置、`webviewTag: true`（仅主窗口，浏览器面板需要）。新增窗口以此为起点逐项评估，禁止默认全开。
8. **Chromium 沙箱默认关闭是刻意的**：Windows 上部分安全软件/旧 GPU 驱动会在沙箱初始化时触发原生断点（0x80000003）。关闭时必须显式 `appendSwitch("no-sandbox")`；`electronChromiumSandbox` 开关改动需整应用重启生效，不要做成运行时热切换。
9. **`setWindowOpenHandler` 统一收口**：主窗口与 webview guest 都必须注册，走 `openExternalUrl` 并 `deny`；漏注册 = 用户点击链接开出无管控新窗口。
10. **自定义标题栏**：frame/titleBarStyle 相关改动要同时验证三平台窗口控制按钮、拖拽区、双击最大化；全屏式弹层内容不得被窗口控制区遮挡。

### Webview（内置浏览器面板）

11. **独立 partition + 收敛 webPreferences**：webview 用专属 `partition`，强制 `sandbox: true`、`nodeIntegration: false`、`webSecurity: true`、`allowRunningInsecureContent: false`、`webviewTag: false`，并删除外部传入的 `preload`/`preloadURL`/`allowpopups` 等危险参数（见 `configureBrowserPanelWebviewHost`）。
12. **session 校验**：`did-attach-webview` 时校验 guest.session 是否为预期 partition，不是立即 `close()` —— 防止页面注入意外 guest。
13. **导航白名单**：`will-frame-navigate` / `will-redirect` / `setWindowOpenHandler` 三层都要过 `isAllowedBrowserPanelUrl` 白名单；只拦一层会被重定向绕过。

### IPC 与 preload

14. **handle/invoke 成对注册**：新增通道三处同步——`shared/ipc.ts` 通道常量、主进程 `ipc/*Ipc.ts` handler、preload 白名单暴露；漏任何一处就是运行时 undefined。
15. **preload 不做业务**：preload 只做参数校验后的 `invoke` 转发与事件订阅封装，禁止在 preload 里写业务逻辑或缓存状态。
16. **事件推送要可退订**：`webContents.send` 类推送，preload 侧返回 unsubscribe 函数；渲染层组件卸载必须退订，防止向已销毁页面推送导致泄漏。

### 原生模块与打包

17. **node-pty 等原生模块**：必须 `asarUnpack` 并在 postinstall 修权限（`scripts/fix-pty-permissions.js`）；新增原生依赖时同步检查这两项，否则打包后运行时才炸。
18. **afterPack 清理要谨慎**：删除 node_modules 冗余文件（如 `@larksuiteoapi/node-sdk` 的 lib/）必须有对应测试（`tests/afterPackCleanup.test.mjs`）；清理脚本误删运行时必需文件 = 打包能过、用户启动崩。
19. **打包验证分层**：`npm run pack`（--dir 快速验证）→ `dist:win/mac/linux`；发版前至少跑过一次目标平台完整安装包的人工 smoke，不依赖 CI 构建成功即发布。
20. **资源路径**：运行时资源用 `process.resourcesPath` / `app.getAppPath()` 推导，禁止写相对 `__dirname` 的裸路径假设 asar 内可直接读；preload 路径统一走 `preloadPath.ts` 解析。

### 跨平台

21. **路径与命令**：禁止硬编码 `/` 或 `\`；shell 检测、外部编辑器、git 路径查找必须覆盖 win/mac/linux（含 WSL 场景，见 `wslExe.ts`）。
22. **平台 workaround 集中管理**：如 `linuxDisplayBackend.ts`，平台特判写在专属模块并注明触发条件，不散落在业务代码里。
23. **Windows 特有问题优先怀疑**：路径空格、杀毒软件锁文件、长路径、权限弹窗；Windows 上的"偶发失败"大多不是偶发，日志要带足上下文。

## 稳定性与可扩展性约束

1. **错误处理分层**：
   - 主进程：catch 后写日志 + 向渲染层返回结构化错误（不抛裸异常跨 IPC）。
   - 渲染层：用户可感知错误走 toast/内联友好文案（i18n），不只 console。
   - 异步函数禁止无 catch 的“裸 promise”。
2. **生命周期配对**：注册 listener / timer / 子进程 / watcher 的地方，必须能在同一模块找到对应清理路径（unmount、quit、session close）。
3. **资源边界**：大文件读取、会话扫描、diff 计算要有大小上限或流式处理；渲染进程不做全量日志/历史的主存。
4. **向后兼容**：设置项、会话文件、缓存格式变更必须有迁移或默认值兜底；删除旧字段前先保留一个版本的读取兼容。
5. **特性开关**：高风险或实验性功能（如 RPC 启动 flags、沙箱开关）必须可从设置关闭/回退，默认值取保守项。
6. **扩展点**：新增能力优先做成“注册式”（如 IPC 域注册、面板注册），避免在既有 switch/if 链上继续加分支。

## 验证命令

| 场景 | 命令 |
|------|------|
| 类型检查（每次改动后） | `npm run typecheck` |
| 针对性单测（改动涉及的测试文件，日常必跑） | `node --test tests/<相关>.test.mjs` |
| 全量单测（仅必要时：跨域大改动/合并前最终确认） | `npm test` |
| 单测串行（排查并发干扰） | `npm run test:serial` |

改动影响主进程/IPC/会话链路时，跑 typecheck + 相关针对性测试即可；全量单测约 40s+，非必要不执行，避免每次小改动都等全量时长；纯 UI 样式微调至少跑 typecheck。

## UI 约定（简版）

> UI 细节规范（组件用法、图标、弹框尺寸、字体、token）后续会单独整理，本节只保留底线。

- 新增 UI 优先复用 `components/ui-shadcn/` 共享原语（button/dialog/input/select 等），不用原生 `<select>`、不裸写 `<input>`。
- 图标统一 `lucide-react`，不用 emoji 充当功能图标；品牌 Logo 用 `LogoMark`（`AppParts.tsx`），不用通用图标替代。
- 颜色/圆角/字号优先复用 `styles/` 里的语义 token，不写死色值；暗色模式必须自然适配。
- 布局保持桌面工作台结构（左列表 / 中会话 / 右抽屉 / 底终端），不引入营销页式大改版。
- **新样式一律走 Tailwind utility + shadcn 组合**：禁止新增手写 CSS class（token 定义与 keyframes 除外）；动态状态色通过保留锚点类（如 `tone-*`/`status-*`）+ 状态规则实现，不写新的状态 class。

### CSS 双轨与迁移规则（硬性）

渲染层同时存在两套样式，**禁止 big-bang 全量重写**，也**禁止再开第二套视觉语言**。

| 轨 | 是什么 | 落点 |
|---|---|---|
| 旧（legacy） | 手写语义 class | `styles/{foundation,timeline,surfaces,integrations,workspace}.css` |
| 新（UI 2.0） | Tailwind v4 + shadcn | `styles/tailwind.css`、`components/ui-shadcn/` |

**迁移口诀：视觉上「新学旧」；代码上「改到哪，旧迁新到哪」。**

1. **Token / 长相以旧为准**：颜色、圆角、字号、间距继续用 `foundation` 语义变量；新栈通过 `@theme` 桥接同一套 token，不要另起 zinc/indigo 平行色板。
2. **新改动只写 Tailwind + shadcn**：禁止新增手写 CSS class（token、keyframes、既有 `tone-*`/`status-*` 锚点除外）。
3. **按触达面增量收口**：改某块 UI 时，把该块上抢同属性的旧规则删掉或收窄，再依赖 utility；不要开「删光旧 CSS」专项。
4. **Cascade 层序不可改错**（入口 `styles.css`，契约测试 `tests/cssCascadeLayers.test.mjs`）：

   `theme < base(preflight) < components < vendor < legacy < utilities`

   - `legacy` **必须高于** `base`：否则 preflight 冲掉整站手写外观（表现为「CSS 全没了」）。
   - `legacy` **必须低于** `utilities`：否则组件上改 Tailwind 不生效。
   - `vendor`（`streamdown` / `file-icons`）**低于** `legacy`：应用内观感覆盖才能压过第三方默认皮。
   - 旧 5 个域文件只在入口用 `layer(legacy)` 引入；vendor 只在入口用 `layer(vendor)`；**禁止**在文件内部再包 `@layer`（避免嵌套层）。
5. **`!important` 会反转层优先级**：旧规则里的 `!important` 仍可能压住 utility；碰到时删掉 `!important` 或收窄旧规则，不要给 utility 堆 `!`。
6. **半吊子 utility 比没写更糟**：组件上写了 `min-h-11`/`rounded-xl`/Button 默认 `h-9`，分层后会真生效并冲掉旧观感。改 UI 时 utility 必须「新学旧」对齐原视觉，再删掉同属性的冗余 legacy 声明。
7. **排障**：utility「看不见」时用 DevTools 看胜出规则来自哪一层——unlayered / `!important` / 同属性旧选择器；先处理冲突源，再改 class。
8. **`accent` 是「面」不是「字」**：Tailwind 主题里 `--color-accent` = `--color-bg-active`（悬停浅面色，对齐 shadcn 官方 accent 语义），所以 `text-accent` 与 `hover:bg-accent` 解析成同一个值——亮色（#dfe3e8 字 / #dfe3e8 底）、暗色（#333 字 / #333 底）都是「悬停后变色块、文字消失」。面上的正文一律 `text-accent-foreground`；要主题强调色的文字用 `text-primary`（= foundation 的 `--color-accent`）；legacy CSS 里的 `var(--color-accent)` 仍是强调色，不受此影响。回归守卫：`tests/storeSuggestionChipContrast.test.mjs`（扫全渲染层 `text-<面色 token>`）。

### beUI 组件迁移（硬性）

> 项目从 beui.dev 迁移动效组件（`components/motion/`、`components/agents/` 等）。
> 共享模块（`lib/ease.ts` / `lib/utils.ts` / `agents/agent-disclosure.tsx`）已与 beui.dev registry **逐字节一致**（2026-08 统一），CLI 安装时内容相同会自动 skip，无需任何恢复操作。

1. **安装走 CLI，不手动复制源码**：`npx shadcn add @beui/<name>` 即可（`components.json` 已配置 `"registries": {"@beui": "https://beui.dev/r/{name}.json"}`）；文件已存在时加 `--overwrite`。手动复制源码是下策（易漏依赖、注释标记不一致）。
2. **共享文件保持官方原版，禁止存项目私有曲线值**：`lib/ease.ts` / `lib/utils.ts` / `agents/agent-disclosure.tsx` 一律接受 CLI 覆盖（内容一致会 skip；官方更新则同步跟随）。历史上项目曾把 `EASE_OUT`/`SPRING_LAYOUT` 改为私有基线值，导致每次安装都被 CLI 连坐覆盖、需手动恢复——已废弃，不要复辟。
3. **共享运动常量统一从 `@/lib/ease` 取**，禁止在组件里另写曲线值；新组件缺常量时按官方 registry 值补进 `lib/ease.ts`，不要改既有导出值。
4. 迁移惯例：文件放 `src/renderer/src/components/<域>/`，头部保留官方 `// beui.dev/components/<path>` 注释，用户可见文案走 i18n。

## Issue 修复流程

1. 直接在当前开发分支（通常是 `dev`）上改，**不要**为单个 issue 另拉 `fix/issue-*` 分支。多 agent 并行时分叉会互相踩工作区。
2. 先定位根因，记录影响范围；涉及启动、环境检测、会话恢复等核心流程时，同步检查相邻路径同类问题。
3. 修复聚焦单一问题，`fix:` 前缀提交，关联 issue。
4. 需要开 PR 时，描述写清问题原因、修复摘要、验证命令，并写 `Closes #<number>`。

## 发版要求

1. 核对 `README.md` / `README.en.md` 功能与安装说明仍准确。
2. `CHANGELOG.md` / `CHANGELOG.zh-CN.md` 加版本号与日期，条目记录用户可感知变化，中英文一致。
3. GitHub Release notes 写明主要变化，不接受只写版本号。
4. `package.json` 与 `package-lock.json` 版本号一致；发版提交用 `chore: release vX.Y.Z`。
5. docs-site 官网同步更新。
6. 发布说明同步走 `scripts/sync-release-notes.js`，不手改 README 亮点区块 / docs-site：
   - 先更新 `CHANGELOG.md` / `CHANGELOG.zh-CN.md`（中英一致），条目用 `- **标题** — 描述` 格式；
   - `node scripts/sync-release-notes.js` 预览 → `--apply` 应用，自动同步 README.md / README.en.md /
     docs-site/changelog.md 三处亮点（README 取 🚀 前 12 + ✨/🐛 前 4，docs-site 取 🚀 前 15 + ✨ 前 4）；
   - 脚本不更新 README 顶部版本徽章（shields.io badge），需手动改为当前版本；
   - `--apply` 后检查 `git diff`：脚本只清理重复的 v0.6.6 条目，历史条目不允许丢失（2026-08 曾因
     无条件删除逻辑误删唯一一份 v0.6.6 条目，已修复）。
7. 架构级变更（如 session-first 切换）先发 pre-release 观察，再标正式版。

## 提交 commit 规则

> **不要自以为是地提交代码。只有用户明确要求时，AI 助手才可以执行 `git add`、`git commit` 或 `git push`。**

1. 工作过程中不自动 commit；完成一步后也不提交。
2. 只有用户明确说「提交吧」「commit」「push」等意图时才执行。
3. 整个功能/修复完成后简要总结，并询问「需要我提交吗？」。
4. 用户同意提交时，一个功能/修复的全部变更放在一个 commit，不拆多个小 commit（用户另有要求除外）。

### GitHub 协作说明

详见 `docs/PiDeck-协作说明.md`。

## 长期重构纪律

- 大重构必须先写对照计划（参考 `docs/issue-113-main-parity-plan.md`），明确能力 parity 表与合并门禁。
- 禁止无对照表的长期分叉分支；main 的用户可感知改动当周回填到进行中重构分支。
- 重构期间禁止用 `-X theirs`/`-X ours` 静默吞掉对方改动；每个冲突都要确认能力归属。
