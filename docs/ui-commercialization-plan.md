# PiDeck 商业化 UI / UX 统一规划

> 状态：**Wave 1–7 已落地（2026-10-31 合入 origin/dev；实施记录见 archive/plans/ui-commercialization-impl-*）；本文件保留为剩余页面清单与验收基线，未完成项按文中“待执行/未覆盖”标记为准。**
> 适用端：PiDeck 桌面端（Electron renderer）。Web 远端界面保持其独立设计体系，不在本次合并范围内。
> 关联文档：`DESIGN.md`、`docs/archive/plans/ui-unification-plan.md`、`docs/ui-and-css.md`、`docs/architecture.md`、`docs/engineering-standards.md`。

## 0. 这份文档怎么使用

- 本文是给后续执行 Agent 的**总任务书**：先按 Wave 顺序施工，再按页面清单逐项核销，不把“更高级、更美观”当成无法验收的描述。
- 每个 Wave 都必须可独立验证、独立回滚；涉及共享组件时先改共享契约，再改业务页面，禁止多个 Agent 同时重写同一个公共汇聚文件。
- 页面排查表中的“现状”来自代码与既有交互路径；“目标”是需要实施的改动。执行前若代码已变化，以最新代码和用户最新决策为准，并更新对应行，不照搬旧结论。
- 不借 UI 统一顺手增加产品功能、重构数据层或修改后端契约。确需行为变化时，在该项单独写明验收路径。

## 1. 执行摘要

PiDeck 已经有明确的 **The Ink Workbench** 设计方向和较完整的语义 token，商业化改造不应再做一套皮肤，而应解决更高一层的问题：

1. **同一种对象在不同页面长得不同、操作不同**：项目、会话、Agent、模型、分支、连接状态需要统一的展示与选择模式。
2. **同一种操作缺少统一反馈**：保存、检测、刷新、删除、关闭、重试、加载、空态、错误态需要可预期的行为。
3. **信息密度与视觉权重不稳定**：上下文、主操作、辅助信息不能争夺同一层级；不能靠增加底色、边框和阴影制造层级。
4. **设置与复杂弹窗的认知成本偏高**：需要统一分组、字段行、保存语义、高级项折叠、危险操作和未保存保护。
5. **页面“正常态”之外的完成度决定商业质感**：空、加载、失败、禁用、长文本、窄窗口、键盘操作、暗色与不同配色都必须纳入验收。

目标不是增加装饰，而是形成一套**安静、专业、可信、高效**的桌面工作台：默认克制，层级清楚，操作直接，状态透明，异常可恢复。

## 2. 已有基础与冻结决策

### 2.1 直接复用，不重复建设

- `DESIGN.md` 已定义中性墨阶、字号、间距、圆角、阴影和组件原则；继续沿用，不引入第二套视觉语言。
- `docs/archive/plans/ui-unification-plan.md` 的字号、间距、颜色、圆角和渲染态扫描 Wave 0–4 已完成；本计划进入**组件模式、信息架构和交互体验**阶段，不重复做 token 大扫除。
- 新改动使用 Tailwind + `components/ui-shadcn/`；旧样式按“改到哪、迁到哪”处理，禁止 big-bang 重写。
- 样式（`data-appearance`）与配色（`data-palette`）分离，状态色、身份色和 Markdown 色继续遵守既有边界。
- 已有 E2E、节点单测、隔离 renderer 预览和截图机制优先复用，不为设计验收另起重型工具链。

### 2.2 最近已确认的起始页 / Composer 决策，后续不得反复推翻

- 初始页与新建页继续共用 `SessionStartSurface`，已有消息的会话继续共用 `ComposerArea`，不复制第三套输入卡。
- 大 Logo 保持静态品牌标识；后端选择位于输入卡左下；Git 分支位于右下并可切换。
- 目录在输入卡顶部紧凑展示，无常驻异色背景、无下拉 chevron；引导页可切换项目，真实会话与历史会话目录只读。
- 可点击但无 chevron 的文本选择器，必须通过 hover、focus-visible、tooltip/可访问名称补足可发现性，不再靠恢复常驻背景解决。
- 后续 Wave 只统一这些控件的共享状态、反馈和跨页面一致性，不重新开展起始页布局竞标。

### 2.3 已有专项方案不重开

- MCP 已完成智能添加、认证简化、状态与删除反馈等专项改造；后续只做共享视觉模式和遗留一致性检查，流程继续遵循 `docs/archive/plans/mcp-config-ux-redesign.md`。
- 项目位置、远程访问等涉及产品模型或后端的事项，不因“UI 统一”被顺带改写。

## 3. 商业化设计目标与原则

### 3.1 体验目标

- **首次进入能理解**：项目、Agent、模型、输入区和发送动作一眼可辨，主要路径没有死端。
- **相同对象有相同表达**：名称、图标、状态、选择入口、只读态和错误态在各页面一致。
- **常用动作直接，高级动作渐进披露**：主区域每屏一个视觉主行动；低频操作进入菜单或高级区，不与主按钮竞争。
- **操作结果可预期**：保存是否生效、是否需要重启、是否可撤销、失败如何恢复必须明确。
- **密集但不拥挤**：通过字号、间距、对齐和弱层级组织信息，不通过层层卡片与彩色背景切分信息。
- **键盘和鼠标同等可用**：焦点可见、顺序合理、弹窗可关闭并归还焦点，图标按钮有可访问名称。

### 3.2 统一模式

| 模式 | 统一目标 | 禁止做法 |
|---|---|---|
| Page / Panel Header | 标题、必要说明、主操作和辅助操作位置稳定 | 同一区域堆多个同权重按钮 |
| Toolbar | 左侧上下文，右侧动作；中间只放确有必要的筛选或模式 | 上下文与动作混成一排同权重 chip |
| List Row | 固定 leading / title / metadata / trailing 区域；选中、hover、只读、危险态一致 | 每页发明一套行高、图标和隐藏动作 |
| Field Row | 标签、说明、控件、错误和生效说明对齐；窄宽可纵向降级 | 只有 placeholder 没有标签；错误仅靠 toast |
| Selector | 触发器、搜索、选中、禁用、加载、空态、错误态一致 | 同一对象一处 Select、一处自绘菜单且无理由 |
| Dialog | 标题/说明/内容/footer 结构一致，主次按钮和关闭行为可预期 | 危险确认与信息提示共用含糊文案 |
| Feedback | 行内错误用于字段/面板，toast 用于全局结果，进行中状态靠近触发动作 | 每个开关都弹成功 toast；失败静默 |
| Empty / Loading / Error | 解释当前状态并给一个明确下一步；保留布局稳定 | 空白、无限 spinner、只显示技术错误 |
| Danger Zone | 说明对象、影响、可逆性；危险按钮只用于真正破坏性动作 | 普通删除也要求输入确认，或高危操作无确认 |

## 4. 优先级与完成定义

| 优先级 | 判定标准 | 示例 |
|---|---|---|
| P0 | 阻塞任务、造成误解或数据风险、核心反馈缺失、键盘/焦点不可用 | 未保存丢失、危险对象不清、失败无恢复、弹窗焦点失控 |
| P1 | 不阻塞但显著增加学习成本或视觉噪音，影响核心页面统一性 | 设置分组混乱、控件/列表/弹窗不一致、主要动作不突出 |
| P2 | 精细度、动效、插画、低频增强 | 微交互、额外空态美术、非必要快捷入口 |

**商业化验收底线：核心流程无 P0；本计划 P1 全部核销；P2 可延期，但不得留下半完成的视觉试验。**

## 5. 全量排查结果

### 5.1 主要页面与核心交互

| 页面 / 区域 | 主要实现与当前能力 | 可证实的问题与改造方向 |
|---|---|---|
| 应用壳 / 标题栏 / 导航 | `components/app/AppShell.tsx`、`components/AppHeader.tsx`；左列表、中会话、右抽屉，支持拖宽、折叠、pin 和紧凑布局 | 建立统一 Page/Panel Header、Toolbar 和选中态；主操作、上下文、窗口动作分层，窄窗口优先保留会话主路径 |
| 项目与会话侧栏 | `components/sidebar/` 的 `AppSidebar`、`SidebarContent`、`ProjectTree`、`SessionTree`、`ActiveSessionsTree`、`RecentSessionsSection`；支持搜索、置顶/归档、状态、右键和拖拽 | 统一 ResourceRow 的图标、标题、摘要、状态点、hover 动作与右键菜单；活动/最近继续共享 `SidebarParts.tsx`，不要让同类会话行在不同分组漂移 |
| 引导页 / 新建会话 | `components/session/ProjectEmptyState.tsx`、`SessionStartSurface.tsx` | 保留已冻结布局；补全项目/模型不可用、Git 不可用、加载失败、长项目名等状态，不再重新设计输入卡结构 |
| 会话聊天 / 时间线 | `ChatSessionPane`、`SessionView`、`SessionSurfaceStage`、`SessionMessageTimeline`、`OwnedSessionMessageTimeline` 与 `components/session/turn/` | 保持 Flat Timeline；统一流式、工具、思考、错误、重试、空历史、历史恢复的位置与反馈，不用更多卡片/阴影切割阅读 |
| 会话 Tab / 分屏 | `components/session/SessionTabsBar.tsx`、`SessionSplitStage.tsx`；预览晋升、pin、关闭、溢出、拖放和边缘/中心落点 | 统一 TabChrome 的预览、dirty、pin、关闭、拖放预览和键盘焦点；明确会话 Tab、文件 Tab、面板 Tab 的层级，避免多重选中态互相竞争 |
| Composer | `components/session/ComposerArea.tsx`、`ComposerComponents.tsx`、`ComposerPanels.tsx`、`ComposerPickerHost.tsx`、`composer/TipTapComposer.tsx`；行为在 `hooks/useSessionComposerController.ts` | 保持唯一 Composer；统一后端/模型/分支/安全/附件/补全的触发器、忙碌、禁用、错误与未知投递反馈；保留 IME、历史回溯、发送键和拖放能力 |
| 文件树 / 编辑器 / 文件 Tab | `components/workspace/WorkbenchContent.tsx`、`WorkbenchFileTabs.tsx`、`DrawerSurface.tsx`，`components/session/FileTreeRows.tsx`、`CodeMirrorEditor.tsx`、`FileDiffViewer.tsx`、`CodeDiffView.tsx`，`components/app/ExternalEditorOverlay.tsx` | **P0：** `FileTreeRows.tsx` 部分读取失败回退空数组，需区分“空目录 / 无结果 / 加载失败”并重试；统一 dirty、只读、外部变化、保存失败与关闭保护；本地/远端只共享视觉和状态，不合并领域逻辑 |
| Git 面板 | `components/workspace/GitDrawerHost.tsx`、`components/app/GitPanel.tsx`、`components/app/git/GitGraph.tsx`、`GitPanelControls`；远端为 `RemoteGitPanel`、`RemoteGitCompareSection` | 统一面板工具行、分支/变更行、刷新/同步 busy、操作确认和错误恢复；图谱层叠纳入 overlay 规范；本地/远端状态表达一致 |
| 终端 | `components/terminal/TerminalDockPanel.tsx`、`TerminalDock.tsx`；多 Tab、搜索、主题、会话/项目 cwd | 统一 Tab、空态、连接/退出/错误和启动反馈；终端搜索与会话/侧栏搜索保持各自语义，但入口、快捷键提示和关闭行为一致 |
| 内置浏览器 | `components/workspace/BrowserSurface.tsx`、`components/app/BrowserPanel.tsx`；多 Tab、导航、缩放、UA、独立窗口 | **P0：** `did-fail-load` 仅处理 `-3`，缺少通用加载错误页与重试；自绘按钮/面板和 document `mousedown` 关闭迁移到共享菜单，统一焦点、Esc 和外点行为 |
| 活动 / 历史 / 右侧栏 | 活动与最近列表、`components/session/SessionHistoryPanel.tsx`、`components/workspace/RightSidebarStack.tsx`、`WorkspaceDrawerHost.tsx`、`WorkspaceDrawerRail.tsx`、`DrawerSurface.tsx`、`session/statusPanel/SessionStatusPanel.tsx` | 右 rail、会话 Tab、浏览器/终端 Tab、底部状态 Tab 同时出现时，需明确主次与当前上下文；统一历史搜索、选择、批量操作、空态和加载反馈 |
| 收藏 / 自动化 / Agent 市场 | `components/favorites/FavoritesPage.tsx`、`automation/AutomationPage.tsx`、`agents/AgentMarketPage.tsx`；共享 `components/common/BulkSelectionBar.tsx` | 复用 PageHeader、ResourceRow、Toolbar、BulkSelectionBar、AsyncState；独立页面只做领域内容，不继续复制列表壳和批量条 |
| 搜索 / 命令 / 全局异常 | `components/overlays/CommandPalette.tsx`、`session/SessionFindOverlay.tsx`、`app/AppErrorBoundary.tsx`；侧栏实体搜索、时间线内容搜索、命令搜索各有专用链路 | 不合并不同搜索语义；统一入口说明、快捷键提示、空结果和关闭行为。崩溃页保留重试/自动刷新/次数耗尽，样式迁移到同一状态模板 |

#### 主页面共性问题

- **P0：错误不能被显示成空数据。** 文件树和浏览器先补真实错误、重试与 stale 内容语义，再做空态美化。
- **P1：Panel、Row、Toolbar、Menu、Tab、AsyncState 重复实现。** 抽共享模式，但不把本地/远端、文件/Git 等不同领域逻辑硬合并。
- **P1：菜单实现双轨。** 自绘 outside-click 与 Radix/shadcn 并存，焦点、Esc、触发器和关闭语义容易漂移；新增代码不得再增加自绘菜单。
- **P1：视觉实现双轨。** `app-*` 旧 CSS 与 Tailwind token 并存；按页面触达范围迁移，并删除或收窄冲突旧规则，不做全仓机械替换。
- **P2：空态插画与微动效最后处理。** 不得先于错误恢复、导航层级和共享状态模板。

### 5.2 设置中心：逐 Tab / 逐功能组

设置入口为 `src/renderer/src/components/app/SettingsModal.tsx`，共享行原语为 `src/renderer/src/components/app/settings/SettingRows.tsx`。实际包含 **22 个系统设置 Tab + Pi/DSH 配置管理**；没有独立“关于”Tab，版本与更新位于“开发”。

#### 先解决的设置壳问题

当前并存四种合理但未被清楚区分的语义：顶栏草稿保存、独立配置草稿、选择/动作立即生效、只读状态与运维动作。目标不是强迫全部使用一个保存按钮，而是让用户始终知道“是否已生效、能否取消、何时生效”。

- **P0：dirty 统计不完整。** `SettingsModal.tsx` 的直接关闭、保存关闭、安装前检查漏算 `videoGenDirty/acpDirty`，未保存摘要漏生视频；必须建立统一 dirty 注册，而不是继续手工堆条件。
- **P0：编辑器草稿可静默丢失。** `src/renderer/src/ConfigModal.tsx`、`src/renderer/src/config/DshConfigTab.tsx` 的 Raw 切文件无保护；技能/提示词编辑器关闭与背板点击的未保存行为不一致。
- **P0：错误反馈缺失。** DSH Raw 保存失败仅 `console.error`；用量安装失败也需要可见错误，不得只写日志。
- 顶栏保存只应服务于真正的草稿；即时 IPC、资源管理、统计和运维页不显示无意义保存动作。即时动作标记“立即生效”，新会话/reload/重启项标明真实时机。

#### 系统设置 22 Tab

| Tab / 实现 | 设置项与功能组 | 统一与易用性改造 |
|---|---|---|
| 常用 `settings/CommonTab.tsx` | 语言；语音转写（引擎、设备、语言、Whisper 模型/运行时、云端凭据）；提示词增强/输入预测；划词工具；会话 Tab、草稿板、自动标题、TPS、发送键、默认后端、忙碌投递、链接/内容打开、过程展开；快捷消息与回复规则；闲置 Agent；悬浮球；CUA/浏览器自动化权限；系统菜单；窗口模式、托盘、单实例 | 按“顶栏保存 / 立即生效”拆清 Section；快捷清单采用明确的完成/自动保存说明；重启项显示实际生效时机；高频偏好优先，语音、自动化等长表单避免全部挤在常用页 |
| 快捷键 `settings/ShortcutsTab.tsx` | 通用/开发快捷键录制、单项恢复、全部恢复；冲突与缺修饰键校验 | dirty 精确到实际快捷键行；全部恢复显示影响数量并确认；保留就地校验和保存阻断 |
| 通知 `settings/NotificationTab.tsx` | 系统通知总开关/仅失焦/Ask/Agent 数/公告；Toast 时长/历史；声音开关/音量；完成、错误、等待音效及试听；自定义音频导入删除 | 补齐 dirty；试听提供行内状态；音频导入删除明确为即时文件动作，删除需确认，不能让用户误以为顶栏取消可恢复 |
| 外观 `settings/AppearanceTab.tsx` + `ModuleVisibilitySection.tsx` + `ComposerFeaturesSection.tsx` | 导航、明暗、Logo/应用名、定时主题、样式/配色/主题包、背景图/Wallpaper/透明度；窗口缩放、UI/Tab/聊天/输入字号、字体；聊天宽度/状态/回底/冻结标题；原生窗口；各模块与 Composer 入口显示 | 保留可取消的实时预览；原生 range 换共享 Slider；统一 Select 宽度与 dirty；背景清除等即时文件动作移出“可取消”错觉；模块开关按会话、工具、生成、系统分组 |
| 终端 `settings/TerminalTab.tsx` | 主题、padding、字号/跟随全局、字体、scrollback、光标、选中复制、关闭确认、启动命令 | 保留热更新及“新终端生效”说明；短数字控件不再整行 stacked；统一终端预览与设置行宽 |
| 代理 `settings/ProxyTab.tsx` | Pi/ACP/桌面代理开关、URL、NO_PROXY；Pi 测试与按模型代理名单 | 测试必须明确使用“当前草稿”还是“已保存配置”；若保持现状，按钮直接命名“测试已保存代理”；解释模型名单与总开关的禁用关系 |
| 连接 `settings/ConnectionsTab.tsx` | SSH 扫描/添加/连接/断开/刷新/诊断/修复；远端项目信任 | 信任与连接拆成清晰步骤；撤销信任说明“下次启动生效”和影响项目并确认；诊断结果就近展示 |
| IM `settings/ImTab.tsx` + `WeChatSection.tsx` | 飞书 Bot 凭据/连接/绑定/默认后端；微信登录/账号/默认工作区/后端/模型优先级/绑定 | 微信自定义 Label、卡片、裸 Switch 收敛到 `SettingRow/SettingsSection`；解绑、删除模型链补充影响说明；ConfirmDialog 只保留共享实现 |
| 桌宠 `settings/PetTab.tsx` | 启用、置顶、巡逻、间隔、缩放、宠物包、动画预览、通知测试 | 两条原生滑杆换共享 Slider；预览与配置草稿状态一致；通知测试结果显示在行内 |
| 视觉桥 `settings/VisionBridgeSettingsTab.tsx` | 开关、模型、API 格式、URL/Key、tokens/并发/超时、提示词模板；路径与日志刷新/清空 | 配置与日志动作分区；清空日志是即时危险动作，需确认；未选模型的禁保存原因靠近按钮 |
| 生图 `components/config/ImageGenSection.tsx` | 供应商名称/URL/Key、尺寸/格式/水印、参考图、API 方言、模型拉取/多选/手填/删除、供应商管理 | 保留“用当前草稿凭据拉取模型”的合理行为；统一供应商编辑器、模型列表和删除反馈；高级字段渐进披露 |
| 生视频 `components/config/VideoGenSection.tsx` | 供应商与协议、分辨率/时长/画幅、单价、模型列表、提交前费用确认 | **P0** 补齐所有关闭路径 dirty；费用说明与模型/单价关系清晰；其余控件与生图供应商编辑器同模式 |
| ACP `settings/AcpToolsTab.tsx` | 总开关、CLI 预设检测/预填/安装/卸载、自定义工具名称/命令/args/env/权限、无进展与静默超时 | **P0** 将 ACP dirty 纳入统一关闭保护；总开关/超时即时与工具草稿分区；args 需要可表达带空格参数的编辑器；无效 env 不得静默丢弃 |
| PiDeck 插件 `config/HostPluginsTab.tsx` | zip/目录/GitHub 安装、脚手架、重扫、目录、启停、卸载、面板与权限 | 保留权限/指纹和卸载确认；全局 busy 改为插件级 busy；权限字段按网络/本地服务/界面能力分组 |
| Web / 远程 `settings/WebTab.tsx` + `WebRemoteAccessSection.tsx` | 本地 Web/Token/有效期/host/port/网卡/二维码；Cloudflare；Tailscale；EasyTier CLI/IP/network/secret/peers/托管与分享 | 即时 Token 与服务草稿分区；EasyTier 不得让“未保存草稿启动”与取消语义冲突；外网表单统一 SettingRow。该区域有并行改动，执行前必须重读最新代码 |
| 外部编辑器 `settings/EditorsTab.tsx` | 各编辑器启用、命令、浏览、清除、重新检测 | 启用统一 Switch；命令、检测和清除的行宽/操作位置一致；空命令与检测失败就地说明 |
| Git `settings/GitTab.tsx` | 管理开关、Git 路径、检测/浏览/清空/系统路径、提交模型与提示词 | 补 dirty；保留“检测当前路径草稿”；路径状态和提交辅助分区 |
| 开发与更新 `settings/DevTab.tsx` + `AppUpdateCard.tsx` + `UpdateSourceSetting.tsx` | Pi/DSH 环境、WSL、路径；应用版本/通道/日志/下载/安装/更新源；dev 数据、模型目录、RPC timeout、文件上限、sandbox、offline/no-extensions/no-skills、standby、诊断、遥测 | 偏好、环境状态、停止/重启和更新运维分区；数字草稿允许逐字编辑；恢复目录等即时动作确认；WSL 检测不得暗中持久化不一致草稿 |
| 用量 `UsageStatsTab.tsx` | 日志路径、刷新、pi-tracker 安装；tokens/cost/turns、热力图及每日/模型/项目统计 | 作为只读统计页隐藏保存概念；安装与加载失败可见；统一时间范围、空态、单位与加载骨架 |
| 进程 `ProcessMetricsTab.tsx` | Agent 数、内存、pi/DSH host 表、刷新、停止 | 作为运维页隐藏保存；保留停止 danger 确认；局部 busy、刷新时间和进程消失状态清楚 |
| 存储 `SettingsStorageTab.tsx` | localStorage/RPC/粘贴文件/通知/应用日志清理及查看 | 全部即时动作继续确认；按数据类型说明影响与可逆性；执行中与完成结果就近显示 |
| 备份 `SettingsBackupTab.tsx` | 立即备份、脱敏详情、按文件恢复、单项/批量删除 | 保持恢复中禁止关闭；备份/恢复/删除分区，显示时间、范围与结果；不使用顶栏草稿保存 |

#### Pi / DSH 配置管理

入口为 `src/renderer/src/ConfigModal.tsx`。顶栏“保存”只保存当前 Tab，“保存并关闭”遍历全部 dirty，这两个动作必须在文案和关闭保护中保持一致。

| 分组 / 实现 | 当前内容 | 改造重点 |
|---|---|---|
| 模型 `config/ModelsTab.tsx` / `ModelsTable.tsx` | 供应商 URL/API/Key/UA/compat、测试、模型拉取；模型上下文/tokens/思考/reasoning/image/计费/梯度/UA | 明确供应商草稿与隐藏/排序即时设置的差别；宽表优先保证关键列、详情编辑和错误定位，不盲目压缩 |
| 认证 `config/AuthTab.tsx` | 预设/自定义供应商、api_key/oauth、Secret、隐藏/排序/复制/删除、用量查询 | Secret 的隐藏/复制/清除统一；删除保留确认；用量配置与认证主流程分层 |
| Pi 设置 `config/SettingsTab.tsx` | enabledModels、默认供应商/模型、思考、quiet、steering/follow-up、信任、transport、defaultTools、codemode、sessionDir、retry、compaction、扩展键 | 标明新会话或 `/reload` 生效；非法 JSON 不得静默回退；布尔统一 Switch；高级原始键与常用项分层 |
| 信任 `config/TrustTab.tsx` | 路径添加、trusted/ignored、删除 | 统一路径行与删除反馈；说明信任对工具权限的影响 |
| MCP `config/McpTab.tsx` | stdio/http、URL/命令、headers/auth、env/cwd、exposure、timeout、检测/OAuth、模板与智能添加 | 遵循已完成专项设计；只统一表单/状态模式，并解释表单草稿与 enabled/智能添加即时落盘的边界 |
| Raw `config/RawTab.tsx` | 五类 JSON CodeMirror | **P0** 切文件/关闭草稿保护；语法错误、保存失败、外部变化就地显示；不能用静默重置代替恢复 |
| 安全 `components/config/SecuritySection.tsx` | 安全门/默认等级、工具 allow/ask/deny、Bash/pathPolicy、目录、defaultAction、敏感路径 | 权限矩阵统一标签与危险说明；明确保存后约 2 秒热更新；高风险默认值变化需确认 |
| 技能/提示词/扩展 `SkillsTab.tsx` / `PromptsTab.tsx` / `ExtensionsTab.tsx` | scope、本地/商店、新建、启停、编辑、重命名、删除、更新、导入、目录 | 即时资源管理不显示伪保存；编辑器统一 dirty/关闭保护；保留商店项目作用域，避免误改安装目标 |
| DSH `config/DshConfigTab.tsx` | runtime/host、自动导入、DSH_HOME、归档、模型、预设、插件、安全、Raw YAML | 即时 Switch 与统一保存分区；停止 host、改 HOME 等终止/重启动作二次确认；Raw **P0** 草稿保护与可见保存错误 |

#### 所有设置项共同验收

- 布尔统一 Switch，选项统一 Select，连续数值使用共享 Slider，短数字使用紧凑数字输入；密钥统一隐藏/复制/清除与错误反馈。
- dirty 精确到实际字段；保存中、成功、失败、禁用原因和生效时机一致；测试/检测明确使用草稿还是已保存配置。
- 即时动作不强行纳入草稿，但必须有“立即生效”语义；不可撤销删除、恢复默认、解绑、清日志、停止 host 均有匹配风险等级的确认。
- 代码编辑器有本地草稿、语法校验、切换/关闭保护和就地错误；运维/统计页只保留状态、刷新与动作。

### 5.3 弹窗、浮层、选择器与全局反馈

#### 已有共享原语

| 类型 | 现有实现与复用边界 |
|---|---|
| Dialog / Confirm | `components/ui-shadcn/dialog.tsx` 支持居中、`size="xl"`、关闭按钮和外点豁免；`alert-dialog.tsx` + `ConfirmDialog.tsx` 负责确认和 danger，`layer="drawer"` 处理抽屉叠层 |
| Menu / Popover / Tooltip | `dropdown-menu.tsx`、`context-menu.tsx`、`popover.tsx`、`tooltip.tsx`；业务坐标菜单可复用隐藏 Trigger，不再自绘一套键盘模型 |
| Picker / Command | `select.tsx` 管短枚举，`combobox.tsx` 管搜索选择，`command-picker.tsx` 的 `CommandPickerPanel` 已有搜索、分组、空态、选中定位；`command.tsx` / `CommandDialog` 有焦点圈定与归还 |
| Toast / Inline feedback | `utils/notice.ts` + `notice-toast.tsx` / `sonner.tsx` 提供稳定 id、详情、操作和历史；`approval-card.tsx`、`progress.tsx`、`alert.tsx` 负责审批、进度和内联反馈 |
| 特殊浮层 | `components/motion/drawer.tsx`、`popover-morph.tsx`、`morphing-search.tsx`；Web 使用 `web/WebBottomSheet.tsx`，保留容器差异但应共享语义 |

#### 业务弹窗分组盘点

| 分组 | 实际组件 | 统一方向 |
|---|---|---|
| 设置 / 配置工作台 | `components/app/SettingsModal.tsx`、`src/renderer/src/ConfigModal.tsx` 各自维护 `80vw×80vh`、最大 1300px；`ProjectResourcesModal.tsx` 为 `80vw×min(760px,100vh-32px)` | 抽共享 WorkbenchDialog 尺寸、侧栏 Tabs、关闭与未保存保护；不在每个壳里复制尺寸常量和 dirty 逻辑 |
| 会话管理 / 历史 / 导入 | `sidebar/SidebarComponents.tsx` 的 `SessionManagerModal`、`session/SessionHistoryPanel.tsx`、`app/ImportModals.tsx`；导入已共用泛型 `SessionImportModal` | 统一搜索、选择、批量动作、进度与结果报告；归档删除使用统一危险确认；保留现有泛型导入能力 |
| 信任 / 数据 / 环境 / 授权 | `TrustConfirmModal.tsx`、`DataModeChoiceDialog.tsx`、`DataImportProgressDialog.tsx`、`DataEnvMismatchDialog.tsx`、`overlays/OverlayComponents.tsx`、`ProviderLoginModal.tsx` | 强制流程可以禁止被动关闭，但必须提供明确安全出口；不得把 Esc 默认解释成“继续”；登录关闭保留取消语义与可见状态 |
| 远端 / 重命名 / 表单 | `RemoteProjectEnrollDialog.tsx`、`RemoteProjectEntryDialogs.tsx`、`RenameModals.tsx`、`WorktreeCreateDialog` | 单字段与多阶段表单共用 FormDialog；Enter 提交继续避开 IME；删除/清空回收站迁到 AlertDialog 模板 |
| 内容选择 / 分享 / 反馈 | `SessionReferenceModal.tsx`、`MessageShareModal.tsx` 共用 `MessageSelectionTree`；`features/feedback/FeedbackDialog.tsx` 为四页反馈台 | 复用选择树、步骤指示、主行动和结果反馈；统一内容高度、长文本和复制成功反馈 |
| 插件 / 信息 / 更新 | `HostPluginPanelHost.tsx`、`HostPluginDockButtons.tsx`、`HostPluginPageOverlay.tsx`、`AboutPopover.tsx`、`ChangelogDialog.tsx`、`PiChangelogDialog.tsx`、`SupportPiDeckDialog.tsx`、`UpdateInstallUnsavedDialog.tsx` | 插件按 manifest 选共享尺寸；两个 Changelog 合并阅读壳；更新安装三操作保持明确主次和未保存处理 |
| 模型 / Agent / 分支 | `ComposerComponents.tsx` 的 `ModelPicker`、`DshAgentPresetControl.tsx`、`ComposerBackendPicker`、`ComposerBranchSwitcher`、`SessionBranchBar.tsx` | 模型大选择器保留搜索/收藏/供应商/用量；短枚举用 Select，长列表用 CommandPickerPanel；分支切换继续先确认，会话 fork 与 Git 分支不可混称 |
| 审批 / 公告 / 轻量覆盖 | `CuaApprovalDialog.tsx`、`SecurityConfirmCard.tsx`、`SessionRuntimeUiOverlay.tsx`、`AnnouncementCenter.tsx`、`ImageLightbox.tsx`、`SessionFindOverlay.tsx`、`AskPanelOverlay.tsx` | 阻塞会话的审批保留内联/ApprovalCard，不能降级为自动消失 Toast；公告 Dialog+Drawer、Lightbox 和查找统一叠层、焦点与关闭规则 |

#### P0 / P1 明确问题

- **P0：可访问名称缺失。** `DshAgentToolsPanel.tsx`、`WebDshToolsPanel.tsx` 的 Dialog 缺少 Title/aria-label；`SessionProxyDialog.tsx` 只有手写 `h2`；`SessionHistoryPanel.tsx` 渲染空 `DialogTitle`。
- **P0：焦点与键盘模型不统一。** `WebBottomSheet.tsx`、`motion/drawer.tsx` 缺焦点圈定/归还；`ExternalEditorOverlay.tsx` 自绘 `role="menu"` 但无方向键管理；`AskPanelOverlay.tsx` 的关闭控件是 `tabIndex=-1` 的 `span role="button"`。
- **P0：取消/推进语义有风险。** 共享 `ConfirmDialog.tsx` 的 Root `onOpenChange(false)` 与 Cancel 都调用 `onCancel`，需保证单次取消；`DataEnvMismatchDialog.tsx` 将 Esc/被动关闭等同“继续”，必须改成显式选择。
- **P0：危险确认分裂。** `RemoteProjectEntryDialogs.tsx` 使用普通 Dialog + destructive Button，其他域用 AlertDialog/ConfirmDialog；统一对象、后果、错误区、busy 锁关闭和危险按钮。
- **P1：通知旁路。** `CustomThemeSection.tsx`、`WallpaperVideoLayer.tsx`、`useSessionTimelineController.ts` 直接调用 sonner，绕过 `showNotice` 的历史、详情、复制与统一时长；应收敛到唯一通知入口。
- **P1：选择器与壳重复。** `PickerDialog` 与 `CommandPickerPanel` 并存；Prompt/Skill 迁移到共享面板，桌面/Web 只保留容器差异。
- **P1：叠层缺少统一分级。** MorphPopover `z-9999`、GitGraph `z-1800`、CUA `z-50` 与共享 token 并存；Dialog、Drawer、Popover、Toast、审批和插件覆盖需要明确 layer 顺序及外点规则。

#### 统一为五类模板

1. **信息阅读型**：标题、摘要、可滚动内容、单一关闭动作，适用于 Changelog/公告/详情。
2. **表单型**：字段校验、步骤、错误区、取消/保存、dirty 保护，适用于重命名、远端、授权和配置。
3. **工作台型**：共享尺寸、侧栏/Tab、顶栏动作和未保存保护，适用于设置、配置、资源和会话管理。
4. **选择器型**：搜索、分组、空态、选中定位、键盘导航，短枚举与长列表只选一种合适容器。
5. **危险确认型**：对象、不可逆后果、取消、危险确认、执行中与失败；高危操作不允许 Esc/外点变相确认。

## 6. 分轮施工计划

### 依赖关系

`Wave 0 基线 → Wave 1 安全修缺 → Wave 2 共享模式 → Wave 3/4/5/6/7 分域改造 → Wave 8 商业化验收`。

- Wave 1 只修真实风险，不等待视觉系统重做。
- Wave 3–7 可在共享模式冻结后并行；每个 Agent 只认领一个页面/领域，不共同改汇聚文件。
- 后续所有 Wave 遵守：先读后改、最小迁移、行为变化配针对性测试；不得为通过新代码而改写旧测试或放宽断言。
- 每轮提交前：`npm run typecheck`、相关 `node --test tests/<相关>.test.mjs`、相关窄 E2E、`git diff --check`；改 zh-CN 后必须运行 `node scripts/genZhTwCopy.mjs`。
- UI 完成后仅对本轮变更目标运行一次 `impeccable.cmd detect --json <changed targets>`；detector 空结果不替代人工看图和交互验证。
- 禁止全量 `npm run build`；全量单测仅在最终跨域验收运行。不得顺手改无关缺陷、重构公共状态或改变设置语义。

### Wave 0 — 建立可回归的商业化基线（P0，纯准备）

**目标：** 让后续每轮有对照、有责任人、有完成标准，而不是凭感觉换样式。

**施工：**

1. 以本文件 §5 为页面/设置/弹窗清单，为每项记录 Owner、依赖、验收命令和状态；不得另写一份脱离本文件的长期状态表。
2. 建立最小截图矩阵：应用壳、引导页、空会话、有消息会话、文件、Git、终端、浏览器、收藏、自动化、Agent 市场、22 个设置 Tab、五类 Dialog；覆盖浅色/暗色、窄窗口和最长真实文案。
3. 建立键盘路径基线：新建会话、切换项目、发送/停止、切换模型/分支、打开设置、编辑未保存、打开/关闭 Dialog、菜单方向键、Toast 详情。
4. 记录待收敛数量：缺失 Dialog 可访问名称、直接 sonner 调用、自绘菜单、绕过语义 token 的颜色/阴影/z-index；后续只要求触达范围归零，不搞全仓计数运动。

**交付：** 基线截图/交互清单与每轮 Owner 表。

**验收：** 任一页面修改都能找到 before/after 对照；任一 P0 缺陷都有可复现路径。此波不改 UI。

### Wave 1 — 先修数据、信任与可访问性风险（P0）

**目标：** 在美化前消除丢草稿、误推进、错误变空态、键盘不可用等商业发布阻断项。

**施工：**

1. **设置草稿与错误：** 修正 `SettingsModal.tsx` 对 `videoGenDirty`、`acpDirty` 的关闭保护；为 Pi Raw、技能 Markdown、DSH 提示词与 DSH 配置编辑器补 dirty/丢弃确认；DSH Raw 保存失败必须可见并保留草稿。
2. **Dialog 安全：** 补齐 `DshAgentToolsPanel.tsx`、`WebDshToolsPanel.tsx`、`SessionProxyDialog.tsx`、`SessionHistoryPanel.tsx` 的可访问名称；保证 `ConfirmDialog.tsx` 取消只触发一次；`DataEnvMismatchDialog.tsx` 的 Esc 不得等同继续。
3. **焦点与键盘：** 为 `WebBottomSheet.tsx`、`motion/drawer.tsx` 补焦点圈定/初始聚焦/归还；`ExternalEditorOverlay.tsx` 使用具备键盘能力的菜单；`AskPanelOverlay.tsx` 关闭控件改为正常 Button。
4. **危险动作：** 远端删除/清空回收站、权限提升、归档删除、更新安装采用同一危险确认语义，明确 busy 时是否允许关闭。
5. **真实错误态：** `FileTreeRows.tsx` 区分空目录和读取失败并允许重试；`BrowserPanel.tsx` 补非 `-3` 加载失败页面、错误说明与重试，不能把失败留在无反馈的空白页。

**验收：**

- 未保存修改在关闭、切换会话/运行时、保存失败后均不会静默丢失；成功/失败反馈与来源一致。
- 所有上述 Dialog 有可读名称；Tab/Shift+Tab/Esc/方向键和焦点归还符合容器类型。
- 危险流程只能由显式按钮推进；取消只执行一次；busy 状态不制造重复操作。
- 文件读取失败和浏览器加载失败均显示错误与重试，空数据只在真实为空时出现。

### Wave 2 — 冻结共享 UI 模式，不再新增局部样式体系（P1）

**目标：** 用现有 shadcn、语义 token 和 `components/design-system/` 承载统一，而不是再建第三套组件库。

**施工：**

1. 从至少三处真实重复中抽取 Page/Panel Header、Toolbar、ResourceRow、AsyncState、TabChrome；优先扩展现有 `WorkspaceCard`、`AsyncState`、`BulkSelectionBar` 等，不为了命名整齐新建无调用者的抽象。
2. 统一五类 Dialog 模板和 WorkbenchDialog 尺寸；合并 Settings/Config 重复尺寸常量及两个 Changelog 阅读壳。
3. 统一 Picker：短枚举用 Select，长列表用 `CommandPickerPanel`；共享搜索、分组、空态、选中定位与键盘语义。
4. 所有 Toast 经 `showNotice`；迁移 `CustomThemeSection.tsx`、`WallpaperVideoLayer.tsx`、`useSessionTimelineController.ts` 的 sonner 旁路。审批继续使用 ApprovalCard/内联卡片。
5. 将 Drawer、MorphPopover、GitGraph、CUA、插件覆盖纳入统一 z-layer 与外点规则；新增菜单只能使用 Radix/shadcn。
6. 为共享模式补 concise 用法说明和针对性测试；不修改共享契约来迁就单一页面。

**验收：**

- 每个共享模式至少有三个真实调用点或明确安全收益；无新增平行组件库、无硬编码颜色/阴影替代 token。
- 默认、hover、active、selected、disabled、busy、error、empty 八种相关状态在同一容器内一致。
- 键盘、焦点、Toast 历史/详情、叠层顺序与关闭行为有针对性测试。

### Wave 3 — 应用壳、导航、列表与多面板统一（P1）

**目标：** 用户进入任何页面都能立即识别“我在哪、当前选中什么、主操作是什么”。

**主要文件：** `AppShell.tsx`、`AppHeader.tsx`、`components/sidebar/**`、`SessionTabsBar.tsx`、`SessionSplitStage.tsx`、`components/workspace/RightSidebarStack.tsx`、`WorkspaceDrawerHost.tsx`、`WorkspaceDrawerRail.tsx`、`DrawerSurface.tsx`。

**施工：**

1. 用共享 Page/Panel Header 和 Toolbar 收敛标题、摘要、主行动、上下文动作、窗口动作。
2. 项目/Agent/会话行复用 ResourceRow；活动/最近继续复用 `SidebarParts.tsx`，统一状态点、时间、hover 动作、右键与键盘焦点。
3. 明确会话 Tab、文件 Tab、浏览器/终端 Tab、底部状态 Tab 的层级；统一预览、dirty、pin、关闭、拖放预览与溢出行为。
4. 统一收藏、自动化、Agent 市场的列表、批量选择、空态和页面工具行；独立页只保留领域内容。
5. 保持会话查找、侧栏实体搜索、命令搜索各自语义，只统一入口说明、快捷键提示、无结果和关闭行为。
6. 窄窗口下优先保留会话与主操作；侧栏/抽屉折叠后不丢失当前上下文。

**验收：** 新建/切换/归档/置顶/拖拽/关闭/恢复、面板折叠与拖宽、Tab 溢出和分屏均通过相关测试；长名称、200 项列表、窄窗口、暗色和键盘焦点无错位或状态混淆。

### Wave 4 — 核心会话体验与 Composer 状态统一（P1，结构冻结）

**目标：** 提升发送、等待、失败、恢复和选择的可预期性；不重新设计刚刚定稿的输入卡。

**主要文件：** `ChatSessionPane.tsx`、`SessionView.tsx`、`SessionSurfaceStage.tsx`、`SessionStartSurface.tsx`、`ComposerArea.tsx`、`ComposerComponents.tsx`、`ComposerPanels.tsx`、`composer/TipTapComposer.tsx`、`hooks/useSessionComposerController.ts`、`components/session/turn/**`、`components/timeline/**`。

**施工：**

1. 冻结 §2.2 的 Composer 布局，只修状态与一致性：后端/模型/分支/安全/附件/补全的触发器、disabled、busy、错误和未知投递反馈。
2. 统一流式、工具、思考、审批、错误、重试、空历史、历史恢复的时间线反馈；保持 Flat Timeline，不用嵌套卡片切割阅读。
3. 模型选择器保留搜索、收藏、供应商、隐藏、刷新和用量；Agent/后端/分支/思考选择统一 Picker 语义，Git 分支与会话 fork 文案明确区分。
4. Prompt/Skill 迁移到共享 CommandPickerPanel；QuickMessage、附件、安全菜单继续使用共享 Popover/Menu。
5. 引导页/新建页只补项目不可用、模型不可用、Git 不可用、长目录名等状态；真实/历史会话目录继续只读。
6. 保留 IME、草稿、历史上溯、发送键、拖放、附件、重发/编辑/fork 等现有能力，不做输入框样式翻新。

**验收：** 新建→选择项目/模型/分支→发送→停止→重试→恢复历史全链路状态清晰；草稿、附件、排队消息、分支切换错误不丢失；初始、新建、空历史和有消息会话的 Composer 结构一致。

### Wave 5 — 文件、Git、终端、浏览器的创作工作台统一（P1）

**目标：** 四类工具页面拥有相同的面板骨架与反馈语言，同时保留各领域交互。

**主要文件：** `components/workspace/WorkbenchContent.tsx`、`WorkbenchFileTabs.tsx`、`GitDrawerHost.tsx`、`components/app/GitPanel.tsx`、`components/app/git/**`、`components/terminal/**`、`BrowserSurface.tsx`、`BrowserPanel.tsx`、`components/session/FileTreeRows.tsx`、`CodeMirrorEditor.tsx`、`FileDiffViewer.tsx`、`CodeDiffView.tsx`。

**施工：**

1. 统一 Panel Header、工具行、Tab、内容边界、状态区和右键菜单；浏览器自绘菜单迁到共享模式。
2. 文件统一 dirty、只读、外部变化、保存失败、关闭保护和重试；空目录/无搜索结果/错误严格区分。
3. Git 统一分支、变更、同步、图谱、操作确认和错误恢复；本地与远端保持视觉/状态一致，但不合并领域逻辑。
4. 终端统一 Tab、启动、连接、退出、搜索和错误反馈；启动命令与 cwd 状态清晰可见。
5. 浏览器统一导航、缩放、UA、独立窗口、加载失败与重试；错误页延续产品语言，不使用 WebView 默认空白。
6. 按触达范围迁移旧 `app-*` 样式并删除冲突规则，禁止全局机械替换。

**验收：** 文件打开/编辑/保存/外部变化/关闭，Git 刷新/切换/提交前后状态，终端新建/搜索/退出，浏览器导航/失败/重试均有针对性验证；本地与远端对应页面状态一致、能力差异明确。

### Wave 6 — 设置与配置工作台全量统一（P0 修缺后做 P1）

**目标：** 22 个系统 Tab、Pi/DSH 配置都遵循同一套“即时生效 / 保存生效 / 新会话生效 / 需重启”语义和 dirty 生命周期。

**主要文件：** `components/app/SettingsModal.tsx`、`components/app/sections/**`、`src/renderer/src/ConfigModal.tsx`、`components/config/**`。

**施工：**

1. **6A 即时偏好：** General、Appearance、Titlebar、Sidebar、Background、Chat/Usage 等复用 SettingsSection/Field 和状态反馈；导入、编辑、实时预览、恢复默认有明确结果。
2. **6B 项目与系统：** Git、Projects、Env、Update、Data 等统一路径控件、保存动作、平台提示和危险操作；不因统一 UI 擅自改变既有设置语义。
3. **6C 引擎与扩展：** Tools/Plugins/MCP/Pi/DSH/ACP/生图/生视频统一连接、权限、发现、Raw、保存、重启与错误状态；弹窗中的第三方执行能力必须保留显式同意。
4. 顶部或分组级显示生效方式；有 dirty 才显示保存，保存中锁定重复提交，失败后不清空编辑值。
5. 所有自动保存域/标签页切换必须 flush 或保护；无 change 回调的编辑区接入统一草稿生命周期。
6. 统一表单控件宽度、标签/帮助/错误、Toggle/Checkbox/Radio/Select 的使用场景；危险区与普通设置视觉分离。
7. 若确需改变保存模型、默认值或公共配置语义，先另给实施计划并取得确认；本 Wave 默认只统一呈现和交互。

**验收：** 为 §5.2 每一行建立“修改→即时/保存→成功/失败→切换 Tab→关闭→重开”的检查记录；22 个 Tab 无未标注的丢失草稿路径，危险项无绕过确认，窄窗口与暗色下表单完整可用。

### Wave 7 — 弹窗、导入、分享与高级流程收尾（P1）

**目标：** 所有非主页面流程都能用同一套容器、选择器和反馈完成，不再出现局部 UI 方言。

**施工：**

1. 设置/配置/资源/会话管理迁移到 WorkbenchDialog；重命名/远端/授权迁移到 FormDialog；Changelog/公告/详情迁移到信息阅读壳。
2. 会话导入、消息引用/分享、反馈、插件页、支持/更新流程统一搜索、选择、步骤、进度、结果报告和错误重试。
3. 模型、Agent、Prompt/Skill、ACP 参数及 Web BottomSheet 共享数据和关闭语义，只保留桌面/Web 容器差异。
4. 信任、数据模式、环境不匹配、权限提升等强制流程使用明确安全出口；禁止被动关闭变成默认危险选择。
5. 公告 Dialog+Drawer、ImageLightbox、SessionFind、AskPanel、HostPlugin 覆盖统一 z-layer、焦点、Esc、外点和 Toast 叠层。
6. Web 搜索、技能扩展、DSH 工具、模型/后端/思考选择同步验收，不只检查桌面。

**验收：** 五类模板覆盖全部业务弹窗；导入/分享/授权/更新/远端删除等主流程可用键盘完成；嵌套浮层无遮挡、无焦点逃逸、无误关闭；Toast 均可追踪且审批不会自动消失。

### Wave 8 — 商业化视觉、可访问性与发布验收（P2 + 总门禁）

**目标：** 在功能与模式稳定后做最后一层质感和一致性，不再引入新结构。

**施工：**

1. 全页面检查 Ink Workbench：neutral 表面、Flat Timeline、单一 Composer 浮起阴影；移除触达范围内无意义渐变、玻璃、彩色图标墙和夸张插画。
2. 校准 11/13/14/16/20px 字档、8/10/12/20px 圆角、图标和文本对齐、面板留白、列表密度；只修明确视觉问题，不做全局重排。
3. 覆盖浅色、暗色、自定义主题、壁纸/视频、强调色、低性能模式；所有 token 与自定义主题保持可读对比。
4. 完成键盘、焦点、可访问名称、对比度、减少动效、长文案、缩放与窄窗口检查；动效只服务层级和反馈。
5. 为纯装饰空态/插画做最后润色；任何错误、加载、权限或空数据状态优先保证可行动性。
6. 更新实际使用模式文档与页面覆盖表；不为了文档完整另造未使用规范。

**最终门禁：**

- `npm run typecheck`、最终跨域 `npm test`、相关窄 E2E、格式、`git diff --check` 全绿；禁止未经用户要求的全量 build。
- 逐页 before/after 截图通过；不存在把错误当空态、把取消当确认、把未保存当已保存的回归。
- 核心任务全程不需要理解内部术语：项目、模型、分支、权限、保存生效方式和失败后的下一步均清楚可见。
- 视觉统一不以牺牲会话、文件、Git、终端、浏览器和设置既有能力为代价。

## 7. 跨页面验收矩阵

每个受影响页面/弹窗按风险选择以下状态，不得只截一张默认态就宣称完成：

| 维度 | 必查内容 |
|---|---|
| 控件状态 | default / hover / active / focus-visible / disabled / loading / error |
| 数据状态 | 有数据 / 空 / 首次使用 / 部分失败 / 完全失败 / 重试 |
| 窗口 | 最小可用宽度、1280×800、1440×900、最大化；抽屉展开与折叠 |
| 主题 | 浅色、暗色；涉及 token 时补 terminal 或 custom palette 冒烟 |
| 文案 | zh-CN / en-US；长名称、长错误、无空格字符串的截断与换行；zh-TW 生成物同步 |
| 输入方式 | 鼠标、键盘；必要时覆盖拖放、触摸板滚动和右键菜单 |
| 弹窗 | 打开、确认、取消、Esc、遮罩、焦点归还、未保存关闭、重复提交防护 |
| 稳定性 | 无布局跳动、无重复 toast、无控制台错误、无异步迟到覆盖新页面 |

### 每轮最小门禁

1. `npm run typecheck`。
2. 改动域的针对性 `node --test tests/<相关>.test.mjs` 与 `npx playwright test e2e/<相关>.spec.ts`。
3. 只格式化本任务文件；`git diff --check`；不得放宽或删除既有测试。
4. UI 改动使用相同数据、相同窗口尺寸的前后截图；至少检查浅色与暗色，设计检测器只在该轮最终版本运行一次。
5. 只有跨域大改或最终收口才运行全量测试；禁止全量 build 代替 UI 验证。

## 8. 多 Agent 执行方式

- **Wave 0、共享原语、设置壳、公共 i18n、公共汇聚文件：单写者。** 这些区域不能按页面并行抢写。
- 页面域可在共享契约稳定后并行，按目录划 ownership；两个以上 Agent 同时改 `src/` 时优先使用独立 worktree。
- 每轮采用“实现 → 领域验证 → 集成检查”三段，不让多个 Agent 各自改一套 Button/Dialog/Field。
- 不自动提交、不自动 push；每轮结束列出文件、验证证据和未覆盖项，由用户决定提交。
- 发现并行改动、基线测试失败或设计与最新用户决策冲突时，停在对应项并记录，不覆盖、不顺手修无关问题。

## 9. 总体验收与交付顺序

### 核心任务链

- 添加/选择项目 → 新建会话 → 选择 Agent/模型/分支 → 输入/发送/停止/排队 → 恢复历史。
- 打开文件 → 编辑/保存/处理外部变化 → 查看 Git 状态/diff → 打开终端/浏览器 → 切换或收起抽屉。
- 修改每类设置 → 理解即时/保存后/重启后生效 → 失败恢复 → 未保存关闭保护。
- 打开每类弹窗 → 键盘完成主操作/取消 → 长内容与错误 → 返回原上下文。

### 最终收口条件

- 本计划中的页面、设置分组、弹窗和共享状态均有明确核销记录；没有“其他页面后续再统一”的模糊尾巴。
- 核心流程 P0 清零，P1 完成；所有保留项都有理由和优先级，不以个人审美作为验收结论。
- 组件、文案、焦点、反馈和错误恢复一致；没有新增平行设计体系或第二套 Composer。
- 最终跨域改动完成后，再执行全量单测和必要 E2E；保留最终截图与测试清单。

## 10. 明确不做

- 不更换 UI 框架，不引入新设计系统、新全局状态方案或装饰性渐变/玻璃拟态。
- 不把桌面端 token 强行合并到 Web 远端界面，不统一两套本已独立的产品界面。
- 不重写 pi↔PiDeck 通道、会话文件、后端行为或设置存储格式来服务纯视觉目标。
- 不删除现有设置项或高级能力；确需下线、合并或改变默认值时另立产品决策。
- 不在每个 Wave 重设计起始页，不反复调整已冻结布局，不用全量构建和无关测试拖慢交付。
