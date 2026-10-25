# ZCode 视觉质感分析与反哺计划

> 状态：**Phase 1 已落地**（2026-10，d4e60c97c / 730579b0b / 6a45b179f）；**Phase 2 已落地**（2026-10，31792faf0，边框墨水化 + 圆角降档 + 语义色审计）；**Phase 3 已落地**（2026-10，25e4e7284，忙碌色结论 + 阴影降档）；**Phase 4 已落地**（2026-10，字号/等宽纪律 + 守卫测试）；后续按「改到哪，旧迁新到哪」增量推进，不做 big-bang。
> 分析来源：`zai-org/ZCode`（Apache-2.0，main 分支 2026-10 浅克隆）。核心文件：`DESIGN.md`（设计宪法）、`packages/ui/src/styles.css`（Zai Light/Dark 主题值）。

## 一、ZCode 质感的六个机制（带证据）

### 1. 灰阶零色相 + 墨水相对色

ZCode 所有中性色是纯 R=G=B 灰，或「墨水 alpha」相对色：

- 边框：`--color-border: rgba(13,13,13,0.1)`（亮）/ `rgba(255,255,255,0.1)`（暗）——**不是不透明灰线**，是 10% 墨水。好处：叠在任何表面上色相永远一致，hover 只需把 alpha 0.05→0.15。
- hover/selected：`rgba(13,13,13,0.05)`；surface（低层容器）：`rgba(13,13,13,0.03)`——「材质感」来自半透明墨水罩染，不是另一块不透明灰。
- 文字三级：`neutral-800` 实色 / 60% alpha / 40% alpha，同一墨水不同浓度 → 层级天然协调。

PiDeck 现状：边框已中性（#e5e5e5 系），但 hover/active 带锌蓝调（#e5e7eb、#dfe3e8），文字 secondary/tertiary 是 slate（#4b5563 B−R=24）。**本次已改**：hover/active/muted/文字三级全部纯中性化。

### 2. 表面阶梯单向且步长克制

Zai Light：page `#f8f8f8` → sidebar `#f0f0f0` → panel/card/popover `#ffffff`。
Zai Dark：bg/sidebar `#161616` → panel `#202020` → card/menu/popover `#2b2b2b` → menu-hover `#363636`。

暗色比浅色**步长更大**（+0x0a 一档），这是暗色下「层次感」的关键——PiDeck 原暗色 panel→popover 都是 #171717（零步长），菜单像贴在内容上。**本次已改**：暗色 popover 换 `color-mix(in srgb, var(--color-bg-panel) 95%, white)` 相对浮层色（经典 #1a1a1a→#252525，与 ZCode #202020→#2b2b2b 同构），graphite/sea-blue/warm-beige 不覆盖该 token，继承相对派生自动获得正确方向（守卫：`tests/sidebarChromeHierarchy.test.mjs`）。

### 3. 品牌/语义色极度克制

- Zai 品牌色就是黑（亮）/白（暗）：`--color-brand: #000000`、`--color-primary: #000000`。强调是「墨水加深」不是「刷颜色」。
- accent 是**面色**不是字色：`--color-accent: #ebf4ff`（浅蓝罩染）只用于弱强调块。
- 语义色（success/warning/destructive）只用于真实语义状态，DESIGN.md 原话："Do not borrow success, warning, or destructive colors just to make a block feel louder."
- 身份色（文件蓝/技能紫/会话青）统一 10% alpha 底 + 深实色字。

### 4. 深度靠底色对比和边框，不靠阴影

DESIGN.md「Elevation and Depth」：Base 无阴影（结构来自底色对比）；Surface 细边框；Overlay 才 `shadow-md`（菜单/弹窗）；`shadow-lg` 只给 toast。原则："Background layering is usually more important than shadow strength."

### 5. 圆角按嵌套层级递减，与重要性无关

- 第一个可见圆角容器 `rounded-xl`，嵌套逐级 `lg → md → sm`，`rounded-sm` 是下限。
- `rounded-2xl` 是**白名单例外**（主输入框/toast/对话框壳），「尺寸大」不构成理由。
- 控件圆角跟随最近的圆角父容器，不跟控件类型走。
- `rounded-full` 只给刻意的胶囊/圆。

### 6. 字号三级制 + 等宽克制

- 界面字号全部从单一 `--ui-font-size`(14px) 派生：base/−1/−2/−4 四档，**禁止** Tailwind 内建 `text-sm` 和任意 `text-[13px]`——字号是「可读性设置」的派生量，不是自由变量。
- 等宽只用于天然技术内容：路径/命令/代码/标识符/快捷键/commit hash/模型 ID。
- 层级靠字重与颜色，不靠缩小字号：h3–h6 同字号靠 semibold/medium/normal 区分。

## 二、PiDeck 差距与落地状态

| 维度 | ZCode | PiDeck 现状 | 动作 |
|---|---|---|---|
| 中性灰色相 | 全部 R=G=B / 墨水 alpha | hover/active/文字带锌蓝调 | ✅ Phase 1 已改 |
| 亮色 chrome 层次 | sidebar #f0f0f0 vs panel 白 | sidebar #f7f7f7（过弱） | ✅ Phase 1 已改 #f0f0f0 |
| 暗色表面阶梯 | 每档 +0x0a | panel=popover=#171717 零步长 | ✅ Phase 1 已改（相对浮层色） |
| 边框墨水化 | rgba(ink,0.1) 全站 | 不透明灰 hex | ✅ Phase 2 已改（经典浅/暗色块；皮肤保留带色相边框作为身份色） |
| 圆角纪律 | 嵌套递减 + 2xl 白名单 | 混用，部分组件按「感觉」 | ✅ Phase 2 已改（消息流卡片降档，白名单见下） |
| 阴影克制 | 四级阶梯 | 尚可，个别重投影 | ⏳ Phase 3：抽查 shadow-lg 使用 |
| 字号派生制 | --ui-font-size 四档 | 已有 --font-size-chat 派生制（过程层两档），接近 | 无需大动 |
| 语义色借用 | 严令禁止 | 审计结论：无装饰性滥用，全部绑定真实状态 | ✅ Phase 2 已审计 |

## 三、Phase 1 变更明细（本次）

`src/renderer/src/styles/foundation.css`：

- 浅色：sidebar `#f7f7f7→#f0f0f0`；muted `#f4f4f5→#f4f4f4`；hover `#e5e7eb→#e4e4e4`；active `#dfe3e8→#dcdcdc`；text-secondary `#4b5563→#4a4a4a`；text-tertiary `#636b79→#666666`；text-faint `#9fa3ac→#9a9a9a`；chat-muted-bg 同步 `#f4f4f4`。
- 暗色：panel `#171717→#1a1a1a`；popover → `color-mix(in srgb, var(--color-bg-panel) 95%, white)`；input → `var(--color-bg-panel)`；chat-card-bg/chat-table-bg 同步 `#1a1a1a`。
- 测试：`themeContrast` 的 `resolve()` 支持 color-mix 相对派生；`lightNeutralBackground` 钉值更新（含文字墨水中性钉）；`wallpaperMode` popover 钉值换相对色；`darkFixedChatColors` 钉值同步；`sidebarChromeHierarchy` 新增「暗色浮层阶梯」守卫（含皮肤继承链解析）。

对比度核算（themeContrast 矩阵实测全绿）：secondary #4a4a4a 白底 8.9:1；tertiary #666666 白底 5.7:1 / muted 底 5.2:1 / hover 底 4.5:1；faint #9a9a9a 白底 2.8:1（≥2.5 地板）。

## 四、Phase 2 变更明细（本次）

### 4.1 边框墨水化（foundation.css 经典浅/暗色块）

- 浅色：`--color-border-subtle/default/strong` #e5e5e5/#dfdfdf/#d7d7d7 → `rgba(13,13,13, 0.10/0.13/0.17)`（白底上渲染 ≈ #e6e6e6/#dedede/#d5d5d5，视觉等值）。
- 暗色：#262626/#2e2e2e/#3a3a3a → `rgba(255,255,255, 0.05/0.09/0.14)`（panel #1a1a1a 上 ≈ #262626/#2f2f2f/#383838）。
- 机制收益：边框叠在任何表面（侧栏 #f0f0f0、壁纸半透明面板、皮肤色底）色相永远中性一致；暗色边框自动跟随底色形成正确亮度（与既有 `--shadow-border: rgba(255,255,255,0.08)` 同构）。
- 皮肤（fresh-green/graphite/sea-blue/warm-beige）自带带色相边框，作为皮肤身份色保留不动。

### 4.2 圆角白名单（嵌套递减纪律）

消息流内容卡片从 rounded-2xl 降档（ZCode：内容卡跟父容器递减，2xl 只给壳）：

- `agents/message-bubble.tsx` 气泡 2xl→lg；`agents/code-block.tsx` 代码块 2xl→md（气泡内再递减）；
- `agents/todo-list.tsx` 卡片 2xl→lg、卡头按钮 →md；`agents/approval-card/index.tsx`、`agents/tool-approval.tsx` 审批卡 →lg；
- `web/WebTimeline.tsx` 用户/助手气泡 ×2 →lg；`agents/market/AgentMarketGrid.tsx` 图标底板 →xl。

**rounded-2xl 白名单**（新增组件不得随意用 2xl；「块大」不构成理由）：

- 主输入壳：`agents/prompt-input.tsx`
- 对话框/浮层壳：`web/WebBottomSheet.tsx`、`agents/chat-app.tsx`（面板根壳）
- 浮层/动画层：`components/motion/*`（dock、preview-rail、animated-sidebar、shared-layout-bg——vendored 动效代码）

### 4.3 语义色审计结论

全量扫描 80 处 success/warning 使用：全部绑定真实状态（安装成败、鉴权关闭警告、导入取消、日志级别、子代理状态），**无 ZCode 所禁的「借语义色让块更响」装饰性滥用**。唯一软性候选：`agentListDisplay.ts` 把 running/starting/pending/waiting（忙碌中）映射到 warning 黄点——「忙碌」不是警告，ZCode 口径下更该是中性活动色（info 或 primary）；但黄色=进行中是广泛惯例，改动影响全局状态点视觉，列为 Phase 3 候选待用户视觉确认后再动。

## 五、Phase 3 变更明细（本次）

### 5.1 忙碌状态色：结论「保留不改」

审计发现黄色=运行中是**文档化的用户约定**（agentListDisplay.ts：「用户语义：idle=蓝、starting/运行中=黄、error=红」；sessionStatusBadge.ts：「颜色语义与用户约定一致」），且三个状态映射器（agentListDisplay / sessionStatusBadge / subagentStatus）口径一致——这不是 ZCode 禁的装饰性借用，是显式产品决策，改了反而违背既有约定。黄色=进行中也是广泛惯例，保留。

### 5.2 阴影克制降档（shadow-lg 只留给 toast）

自研组件 7 处 shadow-lg → shadow-md（浮层/提示条/工具条均为 overlay 档，不是 toast）：

- `overlays/AskPanelOverlay.tsx` 详情浮层 + 拖拽药丸 ×2
- `selectionTool/SelectionInlineToolbar.tsx`、`selectionTool/SelectionToolHost.tsx` 划词浮层
- `session/SessionFindOverlay.tsx` 会话内查找条
- `session/SurfaceComponents.tsx` ctx 详情 tooltip
- `sidebar/UpdateDotHint.tsx` 更新提示浮层
- 另：`session/SessionSurfaceStage.tsx` FAB 删 hover:shadow-lg 升档（悬停加深投影属装饰）；`styles/surfaces.css` file-diff 图片预览 var(--shadow-lg)→md（内容深度靠底色对比，不靠投影）。

保留例外：菜单/FAB/桌面悬浮球 shadow-md ✓、模态导入浮层与 Web 抽屉/bottom-sheet shadow-xl ✓（大 overlay）、vendored shadcn 原语（dialog/chart tooltip）不动（beUI 纪律：官方原版禁改）。自研组件现已零 shadow-lg。

### 5.3 暗色 chat-muted-bg（#202020）与 panel（#1a1a1a）关系

muted 比面板亮一档，方向正确，无需动。

## 六、Phase 4 变更明细（字号/等宽纪律）

### 6.1 任意字号归位语义类（16 处）

- `text-[11px]` → `text-micro`：SelectionToolWindowView ×5、HostPluginRow ×4、TipTapComposer kbd、SelectionToolWindowView reasonHint 等；`text-[13px]` → `text-control`：SelectionInlineToolbar 选区原文、SelectionToolWindowView 结果区；`text-[10px]` → `text-micro`：DshAgentPresetControl 预设 chip（+1px，换来随「界面字号」缩放）；`text-[18px]` → `text-brand`：AppParts/WebBrandLockup 品牌字。
- 保留例外：`text-[9px]` ×4（GitPanel ahead/behind 计数 ×2、SessionSourceBadge、SettingsTab 折叠箭头）——徽标计数器低于 token 下限的刻意微型排版；`text-[40px]` App.tsx 空态 hero 大标题——展示型排版不参与 UI 阶梯。
- 收益：这些文本现在随「界面字号」设置缩放（原来任意 px 完全不缩放， Accessibility 缺口）。

### 6.2 等宽纪律

- 修复 SelectionInlineToolbar 译文结果继承容器 `font-mono`（自然语言禁等宽，源码视图保持 mono 正确）。
- 抽查 ModelsTab/McpTab/AuthTab 等设置页 font-mono 使用：均为模型 ID/URL/env 键/路径，合规。

### 6.3 守卫测试

`tests/fontSizeDiscipline.test.mjs`（3 项）：① 自研组件任意字号扫描（空白容忍正则，9px 徽标与 ≥20px hero 豁免，ui-shadcn/motion 免检）；② foundation 字号阶梯 token 存在性；③ 划词工具条译文 font-sans 钉。
