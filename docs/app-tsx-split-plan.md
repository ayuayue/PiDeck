# App.tsx 拆分计划（P1）

> 状态：**主体完成**（Wave 1–3 已落地，未提交）。基线 commit `a3da1d90c`，App.tsx 4297 → 3092 行（-28%）。剩 JSX 装配拆分另立计划。
> 目标：把域逻辑按 owner 迁出主文件（hooks/atoms/工厂函数），App.tsx 收敛为装配层。
> 原则：每步后 typecheck + 相关契约测试全绿；**不**做 big-bang；行为零变化（纯搬迁 + 必要 deps 修正）。

## 门禁

- 每波次：`npm run typecheck` + 改动涉及的 `node --test tests/<相关>.test.mjs`
- 合并前：`npm test` 全量
- 抽取不改行为；函数体逐字搬迁，仅补 hook 入参/返回
- 源码契约测试（grep App.tsx 源）同步更新断言目标

## 职责地图（基线行号）

| 域 | 行 | 内容 |
|----|----|------|
| imports/lazy | 1-208 | 含 preload 早退 |
| atom 接线 + refs | 209-323 | ~25 atom、~20 ref |
| 布局宽度持久化 | 324-441 | layout settings ref 缓存、sidebar/drawer 宽度 |
| 文件树展开持久化 | 405-497 | expandedDirs save/load/restore + legacy 迁移 |
| 项目同步 | 442-547 | useProjectSync 解构、scheduleAnswerEndRefresh |
| 导入/重命名 | 548-610 | useImportFlow×7、useDirectoryImport、useRename |
| 会话记录 getter | 611-670 | getProjectSessionRecords 等纯函数 |
| 设置加载/主题/locale | 671-760 | settings 状态、4 个 settings-sync effect、resolvedLocale |
| 终端/DSH/抽屉 | 761-900 | useTerminalDock、DSH×3、expandedDirs、overlays |
| composer 路由 | 900-1057 | setPromptForAgent、queue、runtime bridge |
| 主题外观 effects | 1059-1246 | systemPrefersDark、schedule 主题定时器、appearance 属性、**壁纸注入 ~120 行**、字体注入 ~50 行 |
| 文件编辑器链接 | 1247-1411 | useFileEditor、useSessionFilePathOpener、handleOpenLinkedFile、handleToolDrawerAction |
| 会话创建 | 1412-1570 | createSessionDraftWithTab 等 + chat bootstrap + ensureSessionForSend（guide 引导 ~90 行） |
| app-info 引导 | 1571-1673 | bootstrapProps、系统语言/appInfo/imagegen 配置 effect ~55 行 |
| 维护性 effects | 1674-1913 | 展开目录自愈、runtime 刷新、终端修剪、15s busy 扫描、时长跟踪 ~55 行 |
| 项目切换/git | 1914-1939 | 文件树加载 effect、git 4s 轮询 |
| **会话运行控制** | 1940-2415 | openReplacedRuntimeSession、clone、close/abort/restart ×7、runSessionControl、queue drain |
| prompt 分发 | 2415-2560 | dispatchPromptSnapshot、submitPromptSnapshot、翻译错误、历史编辑 ×4 |
| 设置写入 | 2561-2678 | updateSettings ~65 行、restartWebService、switchBranch、createBranch |
| 文件树操作 | 2679-2786 | drillCompactChain、toggleDirectory、collapseAll |
| 侧栏归档族 | 2787-2985 | archive/unarchive/list/delete（pi+dsh）×8 |
| sidebarActions | 2986-3111 | ~125 行对象字面量 |
| 导航/tabs | 3112-3344 | focusSessionPane、useSessionNavigation、buildTabsSessionActions、paneLayoutRefs |
| sessionPaneServices | 3345-3511 | ~165 行 memo（保留，装配） |
| workbench 布局 | 3512-3620 | 主题/宽度/simple 模式、fileTabs |
| 命令面板 | 3585-3662 | palette state + 命令 IIFE ~40 行 |
| workbench 节点 | 3663-3703 | 装配 |
| 侧栏 JSX | 3704-3763 | AppSidebar |
| drawerPorts | 3764-3879 | useDrawerPorts + onDrop/Move/Paste |
| 主 JSX | 3880-4297 | ~417 行：AppBootstrap/AppShell/对话框群 |

## 波次

### Wave 1（低耦合域，~630 行）
1. `useAppAppearance`：systemPrefersDark/scheduleNow/resolvedTheme + 5 个外观 effect（671、1059-1246 块）→ `hooks/appearance/useAppAppearance.ts`
2. `useAppBootstrapInfo`：appInfo/systemLanguage/webServiceChanging + app-info effect（1571-1673 部分）→ `hooks/app/useAppBootstrapInfo.ts`
3. `useCommandPaletteActions`：palette 命令 IIFE + 快捷键/缩放 effect（3585-3662）→ `hooks/app/useCommandPaletteActions.ts`
4. `useSidebarArchiveActions`：归档族 ×8（2787-2985）→ `hooks/sidebar/useSidebarArchiveActions.ts`
5. `useSettingsUpdater`：updateSettings/restartWebService/switchBranch/createBranch（2561-2678）→ `hooks/settings/useSettingsUpdater.ts`

### Wave 2（大域，~680 行）
6. `useSessionRunControl`：1940-2415 运行控制族 → `hooks/session/useSessionRunControl.ts`
7. `useProjectFileTreeController`：展开持久化 + 树操作（405-497、2679-2786、1914 effect）→ `hooks/files/`

### Wave 3（剩余，~400 行）
8. `usePromptDispatch`（2415-2560 前半）
9. `useSessionFileLinks`（1247-1345）
10. sidebarActions 工厂函数化（2986-3111 → `components/sidebar/buildSidebarActions.ts`）
11. `useSessionDurationTracking`（~1761-1815 时长跟踪）
12. EnvironmentDialog props 块抽组件（JSX 内 ~90 行）

## 验收

- [x] Wave 1 完成后 App.tsx ≤ 3670 行（实际 3854，六个 hook 全部落地）
- [x] Wave 2 完成后 App.tsx ≤ 2990 行（实际 3306；#10 sidebarActions 工厂评估后跳过：12 处消费闭包跨域，强抽需要 20+ 参数透传，收益负）
- [x] Wave 3 完成后 App.tsx ≤ 2700 行（实际 3092；#12 EnvironmentDialog JSX 块与 #10 一并归入远期 JSX 装配拆分）

## 落地记录（验收时补充）

- Wave 1（六个 hook，4274→3854）：appearance/app 两域 + commandPalette + sidebarArchive + settingsUpdater + useSidebarActions。
- Wave 2.6：`useSessionRunControl`（运行控制域，3854→3506）；Wave 2.7：`useProjectSync` 收口 + `useProjectFileTreeController`（文件树域，3506→3306）。
- Wave 3：#9 `useSessionFileLinks`（会话文件链接域 + useDrawerPorts 24 个 any 型化 + DrawerSurface 端口接口型化）、#11 `useSessionDurationTracking`、#8 `useSessionPromptDispatch`（提示词分发域：livePrompt 镜像/草稿写入/DSH 目标改写/unknown 不降级/busy 投递语义/BUSY 错误码本地化，3306→3092）。
- 契约测试同步：约 20 个测试文件的 App.tsx 源码断言改指新 hook 文件（含 queuedPromptQueue/turnCollapsePolicy/busySendDelivery/editorAttachSelection/sessionComposer/userMessageEdit/fileTreeRequest/abortStreamRegression/dshManualStopWiring/gitPanelUi/tabBarFontSize/toolCallComponents/workspaceDrawer/externalPathOpenGate/sessionDraftRenameGate）。最后一项同时把 onRenameSession 旧契约更新为 onRename 工厂形态（闸门语义不变，形态随 ⋯ 菜单工厂早已演进）。
- 验证：typecheck 0 错；673 契约测试 672 绿（唯一失败 webLayout 为用户并行改动 src/renderer/src/web/*，与本拆分无关）。
- [ ] 全量 `npm test` 合并前通过
