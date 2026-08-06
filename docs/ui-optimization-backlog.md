# PiDeck UI 优化任务与进度

> 目标：在不改变 pi RPC 边界、Jotai 状态模型和 session-first 架构的前提下，统一 PiDeck 的视觉语言、交互原语和会话信息层级。
>
> 每个任务完成后必须通过 `npm run typecheck` 和 `npm test`。涉及会话时间线、工具调用或设置持久化的任务，还需要补充对应行为测试或手测项。

## 总体原则

1. pi 负责 Agent 行为、工具调用和会话读写，renderer 只负责展示和交互转发。
2. 优先复用已有 shadcn 源码组件；缺少组件时先评估是否真的需要，不为替换而替换。
3. 用户可感知的状态必须有明确层级：项目、工作区、运行中会话、历史会话、子 Agent 不混在同一层。
4. 动画服务于状态变化，不用于装饰；布局尺寸不能因切换内容而无预期抖动。
   - motion token 统一：三档时长（120ms 微反馈 / 200ms 常规 / 320ms 面板级）+ 统一缓动
     （ease-out-quint 进场、ease-in 离场），进 Tailwind `@theme`，全站禁止裸写 `transition: all`。
   - 布局动画只动 transform/opacity（合成器线程）；width/height 动画是 layout 抖动与掉帧主因，列为评审红线。
   - 列表进入 stagger 限流：只对前 8–12 个元素 stagger，其余直接出现（大列表 stagger 是掉帧重灾区）。
   - 加载态（会话激活、项目展开）用骨架屏代替白屏或跳动，与「状态尺寸固定」同一条线。
5. 用户可见文案全部进入中英文 i18n；新增复杂逻辑必须写“为什么”和边界条件注释。
6. 性能预算与视觉同级：渲染进程内存、切会话耗时、流式帧率有可量化门禁（见 Batch 6），
   超出预算的视觉/动画改动不得合并；内存分析基线见 `docs/memory-profile-analysis.md`。

## 优先级总表

状态：`✅ 已完成`、`🟡 部分完成/待收口`、`⬜ 待开始`、`🔍 待评估`。

| 优先级 | 任务 | 当前状态 | 主要落点 | 验收重点 |
|---|---|---|---|---|
| P0 | 左侧项目列表改成 Sidebar | ✅ 已完成 | `components/sidebar/*` | 单一滚动区；项目只出现一次；点击一次切换并展开；展开状态持久化；切换不抖动 |
| P0 | 品牌 Logo 与品牌文字 | 🟡 部分完成 | `AppParts.tsx`、`AppSidebar.tsx`、`AppHeader.tsx` | Logo/文字尺寸、字重、间距、拖拽区和暗色主题一致 |
| P0 | 设置、Pi 管理、反馈页面标题与 label 统一 | 🟡 第一批已完成，继续扩展 | `SettingsModal.tsx`、`config/*`、反馈 overlay、共享组件 | 标题层级、label 字号、字重、描述色、间距统一 |
| P0 | Markdown 渲染后的工具调用展示 | ✅ Batch 2 已完成 | `MarkdownStream.tsx`、`ToolCallComponents.tsx`、`TimelineEventCards.tsx` | 工具 Logo、状态、展开/折叠、详情、错误和流式状态一致 |
| P0 | 会话响应动画与空白页 | ✅ Batch 3 已完成 | `SurfaceComponents.tsx`、`TimelineEventCards.tsx`、`timeline.css` | 响应中、工具执行中、空会话、异常和加载状态不互相跳动 |
| P0 | 性能与内存（渲染进程 1.6GB → ≤800MB） | ⬜ 待开始 | `atoms/session-atoms.ts`、`hooks/useSessionTimelineController.ts`、`main/index.ts`、`MarkdownStream.tsx`、`main/sessions/SessionScanner.ts` | 激活分页、tab keep-alive、shiki 裁剪、scanner 异步；门禁见 Batch 6 |
| P1 | Todo / Plan / Ask | ✅ 已接通 | `ComposerComponents.tsx`（widget）、`ComposerRuntimeIntegrations.tsx`、`TimelineEventCards.tsx`（Ask） | Ask 的 pending/answered/cancelled；todo/plan 走真实 pi widget 事件 |
| P1 | `/theming` 统一 | 🟡 基础已完成 | `themePresets.ts`、`tailwind.css`、`foundation.css` | token 单一来源；明暗、accent、皮肤、背景图和组件状态一致 |
| P1 | Avatar 作为项目 Logo 与状态表达 | ✅ Batch 4 已完成 | `ProjectAvatar`、`AgentAvatar`、项目树 | 项目身份、运行态、错误态、worktree 状态一眼可辨 |
| P1 | Command 用于模型、思考级别和模式选择 | ✅ 基础已完成 | `ComposerComponents.tsx`、`ui-shadcn/command.tsx` | 搜索、分组、键盘导航、当前值和空状态统一 |
| P1 | Context Menu 统一右键菜单 | ✅ 已用 Radix 外壳 | `SidebarParts.tsx`、`SidebarComponents.tsx`、文件树、GitGraph | 右键菜单统一焦点、碰撞定位、危险操作和关闭行为 |
| P1 | Dropdown Menu 统一下拉菜单 | ✅ Batch 5 已完成 | `GitPanelControls.tsx`、`SessionTabsBar.tsx`、Config、Git | 删除自绘定位和重复的 ESC/外部点击逻辑 |
| P1 | Tooltip / Hover Card | 🟡 Tooltip 已有 | `ui-shadcn/tooltip.tsx`、工具卡、项目行、设置项 | Tooltip 只解释图标；复杂详情使用 Hover Card，不滥用 title |
| P1 | Marker 用于思考、工具调用和压缩方向 | ✅ Batch 2 已完成 | `TimelineMarker.tsx`、`TimelineEventCards.tsx`、`ToolCallComponents.tsx` | 时间线中系统事件、思考、工具、压缩有统一的 marker 轨道 |
| P2 | Data Table 会话管理 | ✅ Batch 7 已完成 | `ui-shadcn/table.tsx`、`SidebarComponents.tsx` 的 SessionManagerModal | 表头、来源、批量选择、删除、重命名和空状态 |
| P2 | Pagination | ✅ 已完成 | `ui-shadcn/pagination.tsx`、`YaoPromptTab.tsx` | 分页只负责大列表，不替代时间线滚动和流式加载 |
| P2 | Progress | ✅ Batch 8 已完成 | `ui-shadcn/progress.tsx`、更新 overlay | 下载、安装、批量 Ask 进度统一语义与无障碍属性 |
| P2 | Scroll Area | 🟡 已安装，按需使用 | `ui-shadcn/scroll-area.tsx` | 全局 thin scrollbar 已统一；Radix ScrollArea 会改变滚动条出现时机，仅按需用于新容器 |
| P2 | 其余 shadcn 替换 | 🟡 持续收口 | `components/ui-shadcn/*` 和各业务域 | 先替换有明显交互收益的控件，不替换语义为内容容器的原生 button |

## 执行批次

### Batch 1：视觉基线与标题规范（当前批次）

- [x] 建立本任务文档。
- [x] 标记现有 Sidebar、Command、Ask、Tooltip、主题系统的真实状态。
- [x] 抽取共享的页面区块标题/label 规范，并应用到 Settings、Pi 管理、反馈页面。
- [x] 校验品牌 Logo、品牌文字和设置页面标题在亮暗主题下的字号与字重。
- [x] 运行 typecheck、全量测试并更新本表。

### Batch 2：工具调用与会话状态

- [x] 盘点工具类型与现有图标映射，补齐未知工具的统一 fallback。
- [x] 统一工具卡 trigger、状态、详情、复制、错误和展开折叠。
- [x] 统一 thinking、tool、compaction、diagnostic、ask 的 marker 轨道。
- [x] 收敛响应中动画和空白页，保证 reduced-motion 下不依赖动画表达状态。

### Batch 3：交互原语

- [x] Context Menu：确认侧栏 `MenuShell`、文件树、GitGraph 提交菜单已用 Radix DropdownMenu 统一外壳。
- [x] Dropdown Menu：Git 面板紧凑筛选下拉自绘 listbox 迁移到 shadcn Select（`GitCompactFilter`）。
- [ ] Hover Card / Tooltip：区分短提示和复杂详情。
- [x] Todo / Plan / Ask：确认 todo/plan 由 pi widget 事件驱动 `ExtensionWidgetCard`（折叠/✓ 高亮/按会话持久化），Ask 由 `AskQuestionCard` 驱动，均在 renderer 边界内。

### Batch 4：身份与主题

- [x] Project Avatar：项目 Logo、worktree、运行态、错误态。
- [x] Agent Avatar：运行态和来源状态统一。
- [ ] `/theming` token 复核和组件状态色清理。
- [ ] 明暗主题、accent、皮肤、背景图手测巡检。

### Batch 5：大列表和迁移收尾

- [x] Session Manager 使用 Data Table（新增 `ui-shadcn/table.tsx`，列表体表格化并保留全部选择/批量操作）。
- [x] 清理 SessionManager 迁移后孤儿化的 `.session-manager-*` 死 CSS。
- [x] 分页、进度、Scroll Area 统一：新增共享 `Pagination` 接入 YaoPrompt；ScrollArea 原语已就绪，滚动容器保留全局统一样式（避免与 Radix 滚动条行为冲突）。
- [x] 全量死 CSS 扫描：删除 30 条零引用规则（含 `:hover`/`:focus-visible` 变体），共享选择器列表保守保留。
- [ ] 更新 E2E 视觉巡检和手测清单。

### Batch 6：性能与内存（渲染进程预算）

> 背景：2026-08 实测打包版渲染进程 1.6GB（私有内存）、切会话卡顿、展开项目同步扫描卡顿，
> 详见 `docs/memory-profile-analysis.md`。U2 Streamdown 引入 shiki 双主题全语言常驻，
> 内存账单需在本批次回收。
>
> 门禁（写入 ui-2.0 §9）：活跃 3 会话时渲染进程私有内存 ≤800MB；切会话 P95 ≤150ms；
> 展开项目首屏回显 ≤300ms（骨架屏先行，后台刷新）。

- [ ] 会话激活 IPC 分页：激活只下发最近 50–100 条，历史按需经 `prependSessionMessagePageAtom` 拼接
      （`main/index.ts` activateRuntime 链路 + `useSessionTimelineController`）。
- [ ] tab keep-alive + 延迟卸载：最近 2–3 个会话 tab 以 visibility 保活，空闲/内存压力回收更老的；
      切回保活 tab 不重渲染（切 tab 动画的前提）。
- [ ] shiki 语言裁剪 + 懒加载：`@streamdown/code` 全语言 grammar 常驻裁为常用子集，冷门语言动态 import。
- [ ] markdown 静态产物按内容 hash 缓存，切回秒开（Streamdown 官方推荐粒度）。
- [ ] `SessionScanner.list` 异步化 + 摘要缓存先回显，展开项目不阻塞 UI。
- [ ] 大工具输出（bash/diff）超阈值截断存储，内存与渲染双降压。
- [ ] motion token 落地 Tailwind `@theme`，timeline 长列表 `content-visibility: auto` + `contain-intrinsic-size`。
- [ ] FileDiffViewer 关闭 tab 时 dispose monaco editor/model（验证现有实现）。

## 本次变更记录

### 2026-08：新增 Batch 6 性能与内存批次 + motion 规范

- 打包版实测渲染进程 1.6GB（私有内存）、切会话卡顿、展开项目同步扫描卡顿（`docs/memory-profile-analysis.md`）。
- 优先级总表新增 P0「性能与内存」任务；Batch 6 立项：激活分页、tab keep-alive、shiki 裁剪、markdown 缓存、scanner 异步、工具输出截断、motion token、monaco dispose 验证。
- 总体原则第 4 条扩写为 motion 规范（三档时长/统一缓动/transform-only/stagger 限流/骨架屏），新增第 6 条性能预算原则。
- `docs/ui-2.0-revamp-plan.md` §9 验收标准加第 6 条性能门禁（≤800MB / P95≤150ms / 首屏≤300ms）。

### 2026-08：建立优化清单

- 根据当前 renderer 代码和已安装 shadcn 组件盘点功能现状。
- 确认 Sidebar 已完成结构重排，但需要继续做视觉验收。
- 确认 Command 已用于模型/思考级别；Ask、Tooltip、Dropdown、主题系统已有部分实现。
- 确认 Context Menu、Hover Card、Avatar、Marker、Data Table、Pagination、Progress 仍需要按业务域补齐。
- 新增 `ui-shadcn/section-heading.tsx`，统一 Settings Storage、Pi 管理 SettingsTab、Feedback 弹窗的标题和描述层级。
- Feedback 弹窗合并重复 header，补齐可访问的 `DialogTitle`，并统一描述、复现步骤、环境信息的区块标题。
- 新增 `tests/uiSectionHeading.test.mjs`，锁定共享组件接入范围和标题层级契约。
- 新增 `TimelineMarker`，统一 thinking、tool、compaction、diagnostic、ask 的类型标记、状态色和左侧连接轨道。
- ToolCard 保留现有图标映射、状态、详情复制和展开折叠行为，只把运行/成功/警告/错误映射到统一 marker tone。
- 新增 `tests/timelineMarker.test.mjs`，锁定 marker 类型、工具状态映射和折叠行为契约。
- 响应指示器固定最小宽度，waiting 状态保留文案占位，避免流式/工具状态切换导致时间线重新排版。
- 增加 `prefers-reduced-motion: reduce` 降级：状态仍通过颜色、图标和文案表达。
- 空白页增加 `data-empty-state` 语义标记，区分“已有项目可创建会话”和“尚无项目”。
- 新增 `tests/sessionVisualStates.test.mjs`，锁定响应状态尺寸、reduced-motion 和空白页契约。
- ProjectAvatar 根据项目下 Agent 状态显示统一的 idle/running/starting/error 角标；点击尺寸不变。
- AgentAvatar 复用同一状态集合和主题 token，未知状态安全降级为 idle。
- `GitCompactFilter` 自绘 listbox 迁移到 shadcn Select：删除 `getViewportBoundMenuPlacement` 手写定位、portal、scroll/resize 监听和 ESC/外部点击处理，交互由 Radix 接管；触发器和选中勾保持原样。
- 新增 `tests/gitCompactFilterMenu.test.mjs`，锁定无手写定位、紧凑触发器和 aria-label 契约。
- 清理 `GitCompactFilter` 迁移后孤儿化的死 CSS：`.git-compact-filter` / `.git-compact-filter-btn` / `.git-compact-filter-label` 规则（源码零引用）。
- 新增 `ui-shadcn/table.tsx`（项目 token 语义化），`SessionManagerModal` 列表体表格化：表头（会话/操作）+ 行选择态，全部交互逻辑保留。
- 清理 `.session-manager-*` / `.session-source-btn` 死 CSS；共享选择器拆分保留 `.rpc-log-modal--embedded` / `.update-modal--embedded`。
- 新增 `tests/sessionManagerTable.test.mjs`，锁定表格结构、交互保留和死 CSS 清理契约。
- 新增 `ui-shadcn/progress.tsx`（Radix 内核，aria-valuenow 语义，填充走主题绿 `bg-primary`）。
- 更新下载进度改用 `Progress`，并删除 `.update-progress-track` / `.update-progress-bar` 死 CSS。
- 新增 `tests/uiProgress.test.mjs`，锁定 aria 语义、更新 overlay 接入和死 CSS 清理契约。
- 新增共享 `ui-shadcn/pagination.tsx`（带 aria-label 的上一页/页码·总页数/下一页），`YaoPromptTab` 内联分页替换为共享组件，删除 `.yao-pagination` 死 CSS。
- 死 CSS 全量扫描（源码+测试零引用、模板前缀防护、共享选择器保守保留）：删除 30 条规则约 137 行，覆盖 archived-message、config-model-chip、math-copy、git 面板多组。
- Scroll Area：原语已安装且全局 thin scrollbar 已统一；Radix ScrollArea 会改变滚动条出现时机并与全局滚动样式冲突，按需用于新容器，不盲转现有 `overflow-*` 容器。
- 新增 `tests/uiPaginationAndDeadCss.test.mjs`，锁定共享分页接入与死类消失契约。
- 新增 `tests/avatarStatus.test.mjs`，锁定项目和 Agent Avatar 的状态契约。

## 门禁

- 每个 Batch 完成：`npm run typecheck`、`npm test`。
- 涉及 renderer 交互状态：至少增加一个行为回归测试。
- 涉及主题或布局：至少检查亮色/暗色，以及 Sidebar、设置、会话三类关键页面。
- 不自动提交；只有用户明确要求时才执行 commit/push。
