# UI 与样式（Tailwind v4 + shadcn + 旧轨迁移）

> **Status: Current（2026-10-31 核对；以代码与测试为准）**


> 改渲染层布局、颜色、组件样式、引入 UI 依赖前读本文。

## 基本约定

- 新增 UI 复用 `src/renderer/src/components/ui-shadcn/` 共享原语；不用原生 `<select>`、不裸写 `<input>`。
- 图标统一 `lucide-react`；品牌 Logo 用 `LogoMark`。
- 颜色/圆角/字号复用 `styles/` 语义 token，暗色模式自然适配。
- 布局保持桌面工作台结构：左列表 / 中会话 / 右抽屉 / 底终端。
- 跨组件状态只用 Jotai（`atoms/` 按域建 atom）；副作用放 hook，视图放 component；禁止引入第二种全局状态方案。
- 文案走 i18n（见 `docs/engineering-standards.md` §i18n）。
- **顶部 40px 是拖拽热区，不是可用布局区**：frameless 自绘标题栏下 `.window-drag-layer` 是一条 `-webkit-app-region: drag` 的 fixed 透明矩形。拖拽命中**与 z-index 无关**：Electron 把页面报上来的 app-region 矩形按顺序合成一张 SkRegion（drag 并集 / no-drag 差集，后出现的矩形覆盖先出现的，见 `ui/gfx/draggable_region.h`），矩形由 Blink 按布局树（DOM 顺序）收集，所以压在热区上的浮层「画得上去却点不动」，抬 z-index 也没用。两条必做：① portal 到 body 的 Radix 浮层显式 `no-drag`（`foundation.css` 的 `[data-radix-popper-content-wrapper] *`，与 toast 同款；portal 排在 shell 之后，所以能反超热区）；② 靠 Radix 排布的菜单把热区高度算进碰撞边界——`titlebarCollisionPadding()`（`lib/titlebarInset.ts`）返回 `{ top: 热区高度 }`（正好一个热区，不加呼吸间距，否则标题栏按钮的下拉菜单会被推离触发器）。坑：`.custom-titlebar-enabled` 作用域规则对 portal 出来的浮层一律失效；子菜单 `SubContent` 不走 portal 也拿不到该 padding，全靠 ① 兜底；非 Radix 的 `createPortal` 浮层（FeishuLinkIndicator / morphing-search 等）不在 ① 的选择器内，压在热区上需各自声明。守卫：`tests/titlebarFloatingHitTest.test.mjs`（规则/取值）+ `e2e/titlebar-floating-menu.spec.ts`（真实窗口里的菜单几何）。

## CSS 双轨

旧轨 = 手写语义 class（`styles/{foundation,timeline,surfaces,integrations,workspace}.css`）；新轨 = Tailwind v4 + shadcn（`styles/tailwind.css`、`components/ui-shadcn/`）。

**禁止 big-bang 全量重写，禁止第三套视觉语言。** 口诀：视觉上「新学旧」，代码上「改到哪，旧迁新到哪」。

1. **Token 以旧 foundation 为准**：新栈经 `@theme` 桥接同一套 token，不另起平行色板。
2. **新改动只写 Tailwind + shadcn**：禁止新增手写 CSS class（token、keyframes、既有 `tone-*` / `status-*` 锚点除外）；改某块 UI 时把抢同属性的旧规则删掉或收窄。
3. **Cascade 层序不可改错**（`tests/cssCascadeLayers.test.mjs`）：`theme < base < components < vendor < legacy < utilities`。legacy 必须高于 base（否则 preflight 冲掉手写外观），低于 utilities（否则 Tailwind 不生效）；旧文件只在入口用 `layer(legacy)` 引入，禁止文件内部再包 `@layer`。
4. **`!important` 会反转层优先级**：碰到旧规则的 `!important` 删掉或收窄，不给 utility 堆 `!`。半吊子 utility 比没写更糟——utility 必须对齐原视觉再删冗余 legacy 声明。
5. **`--color-accent` 是「面」不是「字」**：`text-accent` 会解析成悬停面色（亮暗色都是字底同色 → 文字消失）。面上的正文用 `text-accent-foreground`；主题强调色文字用 `text-primary`。守卫：`tests/storeSuggestionChipContrast.test.mjs`。
6. **限高 flex 列的子项必须 `shrink-0`**（近期排版事故）：`overflow-y-auto` + `max-h-*` 容器里，子项带 `overflow:hidden` 后 `min-height:auto` 被清零 → 内容被线性压缩成横条且滚动条不出现。给限高容器子项加 `overflow-hidden` 时必须同步 `shrink-0`。守卫：`tests/sessionTodoStrip.test.mjs` + `e2e/todo-strip-scrollbar.spec.ts`。
7. **utility「看不见」时用 DevTools 看胜出规则来自哪一层**，先处理冲突源再改 class。
8. **常驻循环动画走 CSS keyframes，不用 Motion 的 `repeat: Infinity`**：Motion 只把 opacity/backgroundColor 交给 WAAPI，`transform` 仍由自己的 rAF 循环每帧写内联样式（issue #510 实测：一个九点等待指示器 2s 内 1006 次 style 写入 → 改 CSS 后 0 次）。写法：`@theme { --animate-xxx: xxx 1.1s cubic-bezier(...) infinite; @keyframes xxx {...} }` + `animate-xxx`；错峰用 `animation-delay`，并在 token 里带 `backwards` 填充，否则延迟期会先显示基准样式。token 里的缓动**写字面量**，不要 `var(--ease-*)`——Tailwind 只输出被 utility 直接引用的 theme 变量，引用未输出的变量会让整条 `animation` 简写静默失效。守卫：`tests/runStateAnimation.test.mjs`。

## Markdown 语义色（`--color-md-*`）

Markdown 渲染（streamdown）的颜色一律走 `--color-md-*` 语义 token，**不要在组件里写死颜色，也不要新增手写 md CSS class**。`foundation.css` 的 `:root` 默认值等于改造前的写死值（标题/行内码=正文色、链接=正文色、引用=次级文字），所以加 token 本身零观感变化。

| token | 作用 | `:root` 默认 |
|---|---|---|
| `--color-md-heading` | h1–h5 标题（h6 仍是 `text-secondary`） | `var(--color-text-primary)` |
| `--color-md-link` | 正文链接 | `var(--color-text-primary)` |
| `--color-md-code` | 行内码（代码块内文字由 Shiki inline style 决定，不受此 token 影响） | `var(--color-text-primary)` |
| `--color-md-quote` | 引用文字 | `var(--color-text-secondary)` |
| `--color-md-quote-border` | 引用左侧竖条 | `color-mix(in srgb, var(--color-text-secondary) 30%, transparent)` |
| `--color-md-list-bullet` | ul `::marker` / ol `::before` 序号 | `var(--color-text-primary)` |
| `--color-md-hr` | 分割线 | `var(--color-border-default)` |
| `--color-md-strong` | 加粗 `<strong>` | `inherit`（跟随所在文字色） |
| `--color-md-em` | 斜体 `<em>` | `inherit` |
| `--color-md-del` | 删除线 `<del>` | `var(--color-text-secondary)` |
| `--color-md-inline-code-bg` | 行内码底色 | `var(--color-bg-muted)` |
| `--color-md-frame` | 表格 / 代码块外框线 | `var(--color-border-subtle)` |
| `--color-md-table-border` | 表格单元格分隔线 | `var(--color-border-subtle)` |
| `--color-md-table-head-bg` | 表头底色 | `var(--color-surface-ink-subtle)` |
| `--color-md-table-head-text` | 表头文字 | `var(--color-text-secondary)` |
| `--color-md-task-accent` | 任务列表勾选框（`accent-color`） | `var(--color-accent)` |
| `--color-md-image-border` | 图片边框 | `transparent` |
| `--font-family-md` | Markdown 正文字体 | `var(--font-family-base)` |

**为什么有一半规则写在 `streamdownChrome.css`**：streamdown 给元素自带 utility 颜色（链接 `text-primary`、引用 `text-muted-foreground`、hr `border-border`），同样在 `utilities` 层，legacy 层的高 specificity 规则也压不住。所以这些覆盖必须写在 `streamdownChrome.css`（`@layer utilities`，且 `@import` 排在 `tailwind.css` 之后）；标题、行内码没有 utility 颜色，仍由 `timeline.css` 负责。
文件链接（`data-md-file-link`，`MarkdownLink.tsx` 为可点击本地/文件引用加的自定义属性）固定为 `--color-accent`，不跟随 `--color-md-link`，避免改 md 链接色时连带改掉「可打开文件」这一语义。
代码块里的 token 颜色由 Shiki 生成的 inline style 决定，CSS 变量管不到；`tui` 配色另带一套 Shiki 主题（`src/renderer/src/components/session/markdown/piTuiShikiThemes.ts`，`MarkdownStream` 用 `useDocumentPalette()` 订阅 `data-palette` 后换 `createCodePlugin`）——代码 token 色是颜色，归配色维度不归样式维度。移植 TUI 语法高亮时就改那个文件。

## 外观（样式 × 配色）与自定义主题

外观拆成两维，互不影响，任意组合都成立（`terminal` 样式 + `graphite` 配色、`classic` 样式 + `tui` 配色都合法）：

| 维度 | dataset 属性 | 定义位置 | id 来源 | 管什么 |
|---|---|---|---|---|
| 样式 style | `data-appearance` | `foundation.css`（`:root[data-appearance="terminal"]`）+ `styles/terminalSkin.css` | `STYLE_PRESETS`（`themePresets.ts`）/ `APP_STYLE_IDS`（`shared/themeSkinMigration.ts`） | 形状、排版、装饰：字体、圆角、消息标记、表头标签 |
| 配色 palette | `data-palette` | `foundation.css`：`:root[data-palette="x"]` 浅色 + `:root[data-theme="dark"][data-palette="x"]` 暗色 | `PALETTE_PRESETS` / `APP_PALETTE_IDS` | 只写颜色：面/字/边框/chat/Markdown |

- **分工是硬约束，守卫双向查**：`tests/appearanceThemes.test.mjs` 断言样式块里没有任何 `--color-*` 声明、配色块里没有任何 `--radius-*`/`--font-family-*`。想加形状就改样式，想加颜色就改配色——写错维度会让「换配色不换形状」这个能力直接失效。
- 为什么拆：旧模型是单维 `themeSkin`（一套皮肤同时定形状和颜色），结果是纯换色的条目与真换形状的条目并列在同一个列表，用户看不出区别；靠半透明面色伪装的「毛玻璃」在分栏布局下根本看不出磨砂质感。
- 迁移：`shared/themeSkinMigration.ts` 的 `LEGACY_SKIN_MAP` 把每个旧 id 落到 (样式, 配色)——`terminal → terminal + tui`（观感不变）、纯配色皮肤 → `classic + 同名`、已下线的 `glass`/`liquid-glass` → 默认观感。`SettingsStore.load()` 迁移后 `delete themeSkin`。守卫要求旧 id 全覆盖：漏一个等于升级后静默丢掉用户的皮肤选择。
- `classic` 样式与 `classic-green` 配色都**不声明 CSS 块**：它们的观感就是 `:root` 本身，声明块会掩盖默认值缺陷。
- 内置 `terminal` 样式 + `tui` 配色是 pi 终端主题的**成套移植**（不是只借几块 md 色）：配色取 TUI 的 `pageBg/cardBg`、`text/muted/dim`、`border/borderAccent`、`userMessageBg` 与全套 `mdHeading/mdLink/mdCode/mdQuote/mdListBullet`；样式给 `--font-family-base/md` 换等宽（整屏等宽）、`--radius-*` 全归零成方框，再加 `terminalSkin.css` 的 `⏺`（助手轮）/`❯`（用户消息）标记、表头大写标签、代码块头部等宽。
  移植硬约束：**状态语义色（`--color-info`/`--color-warning`/`--color-danger`/`--color-success` 及其 soft/strong）不许被样式或配色覆盖**（状态灯跨配色恒定，守卫 `tests/appearanceThemes.test.mjs`），只能改装饰色（面/字/边框/md/代码/chip）。
- 样式专属的形状 chrome 放 `styles/terminalSkin.css`（`@import … layer(utilities)` 排在 `streamdownChrome.css` 之后，才能压过 Tailwind 布局 utility），色值仍在 `foundation.css` 的配色块里。
- 新增**配色**：`foundation.css` 加 `:root[data-palette="<id>"]` + 暗色变体（必须带齐 16 个必需 token），再同步 `PALETTE_PRESETS` 与 `APP_PALETTE_IDS`；守卫 `tests/appearanceThemes.test.mjs`（id 集合、token 完整性、无多余块）、`tests/themeContrast.test.mjs`（把 id 加进 `PALETTE_IDS`，按 WCAG 校验正文/md 文字对）。
- 新增**样式**：`foundation.css` 加 `:root[data-appearance="<id>"]`（只写形状），chrome 放 `styles/terminalSkin.css` 或新文件，再同步 `STYLE_PRESETS`、`APP_STYLE_IDS`、`CUSTOM_THEME_BASE_SKINS`。
- 主色：配色自带推荐 `accent`（`PALETTE_PRESETS[].accent`），选配色时设置页联动写入 `settings.accent` 并落到 `data-accent`；`custom` 配色没有推荐主色，交回用户自己的 `settings.accent`。
- 用户侧可定制范围由 `src/shared/customThemes.ts` 的 `CUSTOM_THEME_TOKEN_GROUPS` 决定（颜色值必须是 `#hex`/`rgb()`/`hsl()`/`oklch()` 静态形式）；`markdown` 组让自定义主题包也能改标题/链接/行内码/引用/列表符/分割线/加粗斜体删除线/表格/任务勾选/图片边框颜色，`font` 组让主题包改字体，指南页由 groups 自动生成。
- **主题包 `base` 继承内置样式**：主题包可写 `"base": "terminal"`（可选值 = `CUSTOM_THEME_BASE_SKINS`，即 `classic` / `terminal`）。应用时写 `themePalette: "custom"` + `themeStyle: base ?? 用户当前样式`——**颜色归主题包独占、形状继承 base**，因此主题包只管自己的颜色，形状 chrome（等宽/方角/`⏺`）整套继承。旧主题包的 base 写的是皮肤 id（`graphite`/`glass`…），经 `normalizeThemeAppearance` 归一成样式，不报错也不静默丢弃。生效判定在 `useAppAppearance.ts` 的 `activeCustomTheme()`（只看 `themePalette === "custom"`），守卫：`tests/appearanceThemes.test.mjs`（`CUSTOM_THEME_BASE_SKINS` 与 `STYLE_PRESETS` 逐项相等 + 应用侧源码契约）。
- **字体 token**：`--font-family-base` / `--font-family-mono` / `--font-family-md`，值走独立白名单 `FONT_VALUE_PATTERN`（字母/数字/空格/逗号/引号/连字符/下划线/点，≤120 字符，排除 `;(){}:/` 等注入面），内部快照键是 `font-family-*`（不是 `--color-*`），注入时由 `customThemeCssVar()` 拼回 `--font-family-*`。
- 字体优先级：**设置页里显式选的自定义字体 > 主题包字体 > 内置皮肤/默认值**，集中在 `applyFontFamilyTokens()`（`hooks/appearance/useAppAppearance.ts`）算一次最终值，`applyCustomThemeTokens()` 末尾也调它，避免两处 `removeProperty` 互相抹掉。

## beUI 组件迁移

- 安装走 CLI（`npx shadcn add @beui/<name>`），不手动复制源码；文件存在加 `--overwrite`。
- `lib/ease.ts` / `lib/utils.ts` / `agents/agent-disclosure.tsx` 保持官方原版，禁止存私有曲线值（历史上曾改私有值导致每次安装被 CLI 连坐覆盖）；运动常量统一从 `@/lib/ease` 取。
- 迁移惯例：文件放 `components/<域>/`，头部保留 `// beui.dev/components/<path>` 注释，文案走 i18n。
