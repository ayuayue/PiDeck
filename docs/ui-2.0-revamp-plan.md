# PiDeck UI 2.0 重构计划（shadcn + Tailwind + 流式渲染 + 测试体系）

> 独立立项，**不属于 #113 parity 范围**。#113 仍按「功能 parity → 合并门禁」推进；
> 本计划在 parity 收尾后启动（或并行分支推进），落地前逐项评审。
>
> 总原则：**用成熟方案替代自研兼容层**。凡社区已有维护良好、被大规模验证的组件/协议，
> 一律采用并删掉我们自己的 workaround，而不是在其旁边再写一套。

## 0. 现状盘点：我们在哪些事情上"自研过度"

| 领域 | 现状（痛点） | 自研负担 |
|---|---|---|
| 样式体系 | 手写 CSS 按域拆分（foundation/surfaces/timeline/workspace/integrations），语义 token 自维护 | 暗色适配、组件一致性全靠纪律 |
| 基础组件 | `components/ui/` 自造 Button/IconButton/SelectField/TextField/Modal | 可访问性、焦点管理、键盘导航自己兜底 |
| 确认弹框 | ConfirmDialog 与各面板散装确认样式并存 | 风格不统一，删除类高危操作视觉权重不一致 |
| Markdown/流式 | 自研 markdown 渲染 + 流式增量处理 | 代码块高亮、表格、GFM、链接、流式半截语法全自己兼容 |
| 链接 | 回复中的文件路径/URL 识别、点击打开自研 | 边界 case 痛苦（用户原话） |
| 内置浏览器 | `<webview>` tag | 官方半弃维护、API 割裂、进程模型受限、样式隔离问题多 |
| 终端 | node-pty + 自研前端渲染 | 自绘终端兼容性差（控制序列、IME、选区、滚动） |
| 测试 | node:test 源码正则断言为主 | 脆、测实现不测行为，UI 交互无覆盖 |

---

## 1. 设计基座：Tailwind CSS v4 + shadcn/ui

**选型：Tailwind v4（CSS-first 配置）+ shadcn/ui（Radix 内核，copy-in 组件）**

- Tailwind v4 用 `@theme` 在 CSS 里定义 token，可把现有 `--color-*` 语义 token **整体平移**为 Tailwind theme，
  旧样式逐步删除而非一夜重写；暗色模式走 `data-theme` 自定义 variant（与现有机制兼容）。
- shadcn 组件是**复制进仓库的源码**（`components/ui/`），不是黑盒依赖 —— 与 AGENTS.md
  「新增 UI 优先复用共享组件」的规则天然兼容，只是把自造组件换成 Radix 级质量的实现。
- Radix 内核自带焦点圈定、ESC 关闭、aria 属性、键盘导航 —— 删掉我们自研 Modal/Select 的全部 a11y 兜底代码。
- 图标继续 `lucide-react`（shadcn 官方默认），无迁移成本。

**平移顺序（每步独立可交付）：**
1. 引入 Tailwind v4 + `@theme` token 映射（新旧样式共存，不改任何组件）
2. shadcn init + 首批原子组件：Button / Input / Textarea / Select / Dialog / AlertDialog / Tooltip / DropdownMenu / ScrollArea / Resizable
3. 逐域替换（见 §6 拆分），旧 `components/ui/*` 与旧 CSS 在替换完成后删除

**备选与放弃理由：**
- Mantine/MUI：主题黑盒、包体大，与"组件源码归我们"原则冲突 —— 放弃
- Tailwind v3：v4 已稳定且配置更简，新项目直接 v4 —— 放弃 v3

## 2. 流式渲染：Streamdown（Vercel AI Elements）

**选型：`streamdown`（Vercel 开源，AI SDK/Elements 的 markdown 流式渲染器）**

解决的核心痛点：流式中途的半截 markdown（未闭合的 ```、表格、加粗）自研处理永远有边角 case。
Streamdown 专为该场景设计：容错解析未终结语法、内置 GFM/表格/数学公式、内置代码块高亮（Shiki）、
内置"复制代码"按钮，且样式走 Tailwind，与 §1 基座统一。

- 只替换**渲染层**：pi 的 RPC 事件流/消息模型不动，Agent 行为边界不破。
- `memo` 化 + 增量 append 的现有性能策略保留（Streamdown 官方推荐按消息块粒度 memo）。
- 替换后删除：自研 markdown 解析、流式半截兼容补丁、代码高亮初始化、复制按钮实现。

**链接能力（用户点名痛点）随 Streamdown 一并解决：**
- URL 自动识别、安全 `target=_blank rel=noreferrer` 开箱即用；
- 文件路径链接：用 Streamdown/react-markdown 的 `components.a` 自定义渲染点接 `api.files.open/viewFilePath`，
  **一处注册全局生效**，替换现在散落多处的路径识别正则。

**备选与放弃理由：**
- `react-markdown` 裸用：流式容错要自研 —— 放弃
- `marked`+sanitizer 自组：等于继续自研 —— 放弃
- Vercel AI SDK 的 `useChat` 协议层：**不引入**。我们的数据源是 pi RPC，不是 HTTP SSE；
  强套协议会违反「pi 的事不替它做」边界。只取渲染组件，不取数据层。

## 3. 内置浏览器：`<webview>` → `WebContentsView`

**选型：Electron 官方 `WebContentsView`（主进程持有，渲染层只留占位矩形）**

- `<webview>` tag 官方明确"不推荐使用，考虑 WebContentsView"；它基于过时的 OOPIF 嵌入模型，
  是我们当前大量安全收口代码（did-attach 校验、三层导航拦截、partition 注入防护）的根源。
- `WebContentsView` 由主进程创建并 `setBounds` 叠加在窗口上：**安全策略（partition、
  导航白名单、setWindowOpenHandler）集中在主进程一处**，渲染层零信任面。
- 交互模型变化：渲染层浏览器面板区域放一个占位 div，通过 IPC 上报其屏幕矩形
  （ResizeObserver + scroll/resize 同步），主进程 `view.setBounds()` 跟随。
  全屏/最小化 = 主进程改 bounds 或 `setVisible(false)`，比 webview 的 CSS 变换可靠得多。
- 收益清单：删掉 `configureBrowserPanelWebviewHost` 整层防护、webview 属性白名单评审项、
  guest 样式冲突 workaround；地址栏/导航按钮 UI 收进我们的 React 树（风格统一白得）。

**风险与对策：** bounds 同步在窗口 resize/抽屉动画期间可能滞后一帧 → 动画期间
`setVisible(false)` 或跟随 `will-resize` 事件，验收清单单列一条。

**备选与放弃理由：** 继续 webview = 继续养防护层 —— 放弃；第三方浏览器内核方案（CEF 等）过重 —— 放弃。

## 4. 终端：xterm.js 官方组件

**选型：`@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links`（+ 可选 `addon-search`/`addon-unicode11`）**

- VS Code 同款前端，控制序列/IME/选区/滚动的兼容性是业界天花板，直接替代自研渲染。
- node-pty 后端保留不动（它是主进程能力，与前端渲染解耦），只换渲染层：
  pty data → `term.write()`，键盘输入 → pty write，resize → `fitAddon` + pty resize。
- 主题统一：xterm theme 对象从 Tailwind/shadcn token 生成一份映射函数，明暗切换跟随 `data-theme`。
- Web Links addon 直接解决终端里 URL 可点（与 §2 的链接策略同源）。

**备选与放弃理由：** 自绘 canvas 终端（现状）= 无尽兼容 —— 放弃；`ttyd`/hterm 生态弱于 xterm —— 放弃。

## 5. 文件栏、确认弹框与全局 UI 统一

- **文件树**：保留自研树（业务耦合深：多选、拖放、粘贴、会话过滤），但交互件全部换 shadcn：
  行内按钮 → Button(icon)、右键菜单 → ContextMenu、新建/重命名 → Dialog+Input。
- **确认弹框统一**：全站删除/丢弃/覆盖等高危确认收敛到 shadcn `AlertDialog` 单一组件，
  危险操作统一 `variant="destructive"`。盘点清单：会话删除、文件删除、git discard/drop/reset/revert、
  扩展卸载、技能删除、提示词删除 —— 现状至少 3 套样式并存，全部替换并删除旧实现。
- **右键/下拉**：ContextMenu / DropdownMenu 统一替换自研 `adjustMenuPos` 定位逻辑
  （Radix 自动碰撞检测，删掉我们手写视口避让）。
- **布局原语**：`PanelGroup`（react-resizable-panels，shadcn 官方 Resizable）替换自研
  splitter + grid 列宽 CSS 变量体系 —— 左栏/右抽屉/底终端三向拖拽一处实现，
  折叠态、最小宽度、持久化全由组件负责，删掉 `startResize` 手撕代码与 `--drawer-col-w` 等机制。

## 6. 拆分迁移批次（每批 = 独立 PR + 回归门禁）

> **进度（2025-01 更新）**：U0–U5 全部完成并推送（分支 `refactor/issue-113-structure`）。
> U5 收尾三个线上 bug 已修复并验证：
> 1. `index.html` 启动画面内联 `* { margin:0; padding:0 }` 无层级规则压过全部
>    Tailwind `@layer utilities` 间距类（菜单/弹窗失去内边距）→ reset 限定到
>    `#boot-overlay`（`7276281`）；
> 2. 设置页 Select 点开无反应 → 旧 `.modal-backdrop` z-index 100/940 盖住 Radix
>    portal z-50，SettingsModal 外壳换 shadcn Dialog（`9fc6e4e`）；
> 3. SettingsModal 双 Button import 导致 vite 500（`@ts-nocheck` 掩盖），已修（`7276281`）。
> 另：ConfigModal 全域（pi管理/模型/认证/技能等 16 个 tab 文件）完成 shadcn 化
> （`6cceda9`）；抽屉 tab 条从竖排 rail 回归横排（`9fc6e4e`）。
> 新增 E2E 视觉巡检 `e2e/visual-tour.spec.ts`（明暗两色 × 11 面，`145cadd`），
> 截图经人工审查全部正常。剩余：U6 扩展（mock pi 的 #113 手动清单覆盖）、
> 视觉统一收口（间距/圆角/token 最终统一）。

| 批次 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| U0 | Tailwind v4 接入 + token 平移表 + shadcn init（不改组件） | 无 | ✅ `43c561c` |
| U1 | 原子组件替换（Button/Input/Select/Dialog/Tooltip/DropdownMenu）+ AlertDialog 统一 | U0 | ✅ `cc95836` `3be11e9` |
| U2 | 流式渲染换 Streamdown + 链接渲染收口 | U1（按钮/复制样式统一） | ✅ `698846b`（灰度开关） |
| U3 | 终端换 xterm.js | U0（主题 token） | ✅ `97a6042` |
| U4 | 浏览器换 WebContentsView（主进程重构，含 bounds 同步） | 无（主进程独立） | ✅ `faa70ec`（灰度开关） |
| U5 | 布局换 Resizable + 文件树交互件替换 + 旧 CSS/旧 ui 组件删除 | U1 | ✅ 见上方进度注记 |
| U6 | 测试体系建设（见 §7），与前序批次并行，U5 完成后强制门禁 | U0 | 🔶 Playwright 骨架+视觉巡检已就位，mock pi 流程用例待扩 |

每批完成后：`npm run typecheck` + `npm test` 全绿 + 该域手测清单勾选。

## 7. 测试体系（用户点名：完整流程 + 自动化）

**三层金字塔：**

1. **单元/集成（保留并改良）**：node:test 继续，但新增规则 —— 禁止源码正则断言新逻辑，
   行为经公开接口断言；现有正则断言测试随各域重构逐步改写。
2. **组件测试**：Vitest + Testing Library（jsdom/happy-dom）覆盖 hooks 与关键组件交互
   （composer 状态机、抽屉切换、队列）。Vitest 与 Vite 构建同源，配置成本最低。
3. **E2E：Playwright Electron（`_electron.launch`）** —— Electron 官方文档推荐的方案：
   - 起真实应用（打 `dev` 构建），按**用户路径**断言：启动建会话 → 发消息 → 抽屉切换 →
     git 面板 → 设置页；
   - 定位符规范用 `data-testid`（新增 UI 组件时同步添加，列入开发规范）；
   - pi 依赖隔离：E2E 用 mock pi 可执行（scripted stdio 应答）跑 CI；
     另设 `e2e:real` 脚本用真 pi 本地跑，不进 CI 门禁；
   - 首批用例直接转化 #113 手测清单 3.1–3.4 —— **把这次 parity 的人工验收永久自动化**。

**流程收口：** `npm run verify` = typecheck + unit + component + e2e(mock) 一条龙，作为合并门禁。

## 8. 明确不做

- 不引入 Vercel AI SDK 数据层 / 不改 pi RPC 边界
- 不换状态管理（Jotai 保留）、不换构建链（Vite 保留）
- 不重写文件树/会话时间线的业务逻辑（只换皮与交互件）
- 不在本计划中做营销页式设计改版；布局维持桌面工作台结构

## 9. 验收标准（计划级）

1. 旧手写 CSS 四文件（foundation/surfaces/timeline/workspace/integrations）与 `components/ui/` 自造组件全部删除
2. 全站确认弹框仅 AlertDialog 一种实现；危险操作视觉统一
3. markdown 流式渲染零自研补丁；回复内文件路径/URL 一处注册全局可点
4. 浏览器面板无主进程外安全代码；终端无自绘渲染代码
5. `npm run verify` 全绿，E2E 覆盖 #113 手测清单全部条目
6. 性能门禁（2026-08 补，基线见 `docs/memory-profile-analysis.md`）：
   活跃 3 会话时渲染进程私有内存 ≤800MB（当前实测 1.6GB）；切会话 P95 ≤150ms；
   展开项目首屏回显 ≤300ms；超出预算的视觉/动画改动不得合并
