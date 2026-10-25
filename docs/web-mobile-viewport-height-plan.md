# Web 移动端可视区高度方案

> 状态：**已实现（B + C1），e2e 未在本机跑通**。起草于 2026-10-18，基于 `dev` @ `226c8663`（version 0.9.0），实现同样基于该提交。
> 2026-10-18 按源码复核修订 5 处：C1 需双处改 min-height、顶栏收起态可达性、滚动容器表述、e2e 门禁权重、输入区高度推算。C1 的「折叠态隐藏模型 pill」已由用户确认可接受。
> 实施结果见「实施结果（已落地）」节；门禁与 e2e 现状见该节末尾。
> 实现完成后按 `AGENTS.md` 收口：更新本状态行或删除本文件。

## 背景

手机浏览器打开 PiDeck Web 服务后，聊天正文的可见高度明显偏小。用户报告的三个现象：

1. 上滑时 Chrome 地址栏不自动收起；
2. 顶栏不自动隐藏；
3. 输入框与其上方的功能选项合计占用过高。

三者不是同一个问题。1 是页面滚动架构的结果，2 是功能从未实现，3 是输入区固定三段布局。分开处理。

## 现状证据

| 事实 | 位置 |
|---|---|
| `body` 禁止滚动 | `src/renderer/src/styles/foundation.css:825-827` `body { margin: 0; overflow: hidden; }` |
| 根容器固定视口高且裁剪 | `src/renderer/src/web/WebChatApp.tsx:1017` `flex h-[100dvh] w-full overflow-hidden` |
| 聊天主区唯一滚动容器是时间线（侧栏抽屉另有 `.conversation-list` 滚动容器，见 `WebSidebar.tsx`） | `src/renderer/src/web/WebTimeline.tsx:658` `message-timeline h-full min-h-0 flex-1 overflow-y-auto` |
| 顶栏是普通 flex 子项，无 sticky、无随滚动位移 | `WebChatApp.tsx:1034` 直接渲染 `<WebHeader>`；`WebHeader.tsx:73` `header` 无 `sticky` |
| 无任何滚动方向检测 | `grep -rn "lastScrollTop\|scrollDirection\|hideOnScroll\|scrollingDown" src/renderer/src/web/` 无命中 |
| 输入区三段常驻 | `src/renderer/src/web/WebComposer.tsx:145`（操作行）、`:181`（模型行），与 textarea 纵向堆叠 |
| 三段行容器均无 `justify-between` | `WebComposer.tsx:108`（图片预览行）、`:145`（操作行）、`:181`（模型行） |
| 移动端生效最小高度 96px | `src/renderer/src/web/web.css:340-342`（`@media (max-width: 760px)`）`.app.wechat-shell .composer-box { min-height: 6rem; }`。该文件在 `web-main.tsx:11` 是**未分层** import，unlayered 声明压过所有 layer，所以这一条盖住组件上的 `min-h-[7rem]` |
| 组件自带最小高度 112px | `src/renderer/src/web/WebComposer.tsx:106` `composer-box ... min-h-[7rem]`：桌面端生效（与下一行同值），移动端被上一行覆盖 |
| 桌面基线最小高度 | `src/renderer/src/styles/timeline.css:1245-1247` `.composer-box { min-height: 112px; }` |
| 键盘压缩视口 | `src/renderer/web.html:6` `interactive-widget=resizes-content` |

## 根因

### 1. 地址栏不收起

Chrome Android 的地址栏（top controls）只跟随**根滚动器**的滚动位置变化。本页 `body` 与根 div 都是 `overflow: hidden`，`document.scrollingElement` 的 `scrollHeight === clientHeight`，根滚动器没有滚动量，浏览器收不到收起信号。

连带结果：`100dvh` 的 `dvh` 恒等于 `svh`（小视口），页面永久停在「地址栏可见」那一档高度。

判定状态：代码事实为**实测**（读源码）；Chrome 行为为**已知浏览器行为**，未在真机复验。可自行验证：在手机上执行 `document.scrollingElement.scrollHeight === document.scrollingElement.clientHeight`，返回 `true` 即证明。

### 2. 顶栏不隐藏

`WebHeader` 没有随滚动收起的实现。唯一挂在 `main` 上的触摸监听（`WebChatApp.tsx:277-293`）服务于侧栏抽屉手势，不涉及头部。

### 3. 输入区过高

三段纵向常驻。移动端另有 96px 的最小高度，但当前内容高 ≈159px，因此这 96px **当前不生效**——它只在折叠后才成为下限，所以 C1 必须连它一起改（见「移动端 min-height 的处理」）。高度推算（**依据 CSS 声明计算，未在浏览器实测**）：

| 区块 | 推算高度 | 依据 |
|---|---|---|
| 头部 | ≈ 55px | py-2（8×2）+ 标题块（text-sm 20 + gap 2 + text-micro 16）+ 边框 1 |
| 分支条 `WebBranchBar` | 0 或 ≈ 33px | 仅 fork 家族 >1 时渲染 |
| 变更/子代理条 `WebSessionStrips` | 0–64px | 有数据才渲染，每个 32px |
| 输入区 | ≈ 159px | textarea min-h-14 56 + 操作行 41（32 + pt-2 8 + 边框 1）+ 模型行 48（32 + pt-1.5 6 + pb-2.5 10）+ 边框 2 + 表单 pb-3 12 |
| **合计常驻** | **≈ 214px** | 不含分支条与 strip |

在 375×812 视口下正文可用高度 ≈ 598px；键盘弹出后按 `interactive-widget=resizes-content` 再压缩 250–300px。

## 目标

- 移动端（≤760px）正文可用高度至少增加 120px（不含 PWA 带来的地址栏收益）。
- 桌面端（>760px）行为与视觉零变化。
- 顶栏收起/展开的判定可单元测试，不依赖浏览器。

## 非目标

- **不把滚动容器提升到根**（方案 D）。收益与方案 B 相同（≈ +56px 地址栏），但要重写 `timelineRef` 周边的全部逻辑：`stickToBottom`（`WebTimeline.tsx:625-643`）、scroll anchoring 依赖、`scrollToMessage`（`WebChatApp.tsx:271`）的 `scrollIntoView`、`scroll-mt-24` 预留高度、搜索跳转。长会话与流式滚动最易回归，收益不抵风险。
- 不改桌面端 `App.tsx` / `ComposerArea`。
- 不改 Web 服务端的任何逻辑（`src/main/web/`）。
- 不做地址栏相关代码改动。地址栏是浏览器行为，代码侧只能通过方案 D 影响，已否决。

## 方案对比

| 方案 | 收益 | 代价 | 风险 | 结论 |
|---|---|---|---|---|
| A. 装到主屏（PWA） | 地址栏整体消失 ≈ +56px | 零代码，`src/renderer/public/manifest.webmanifest` 已配 `display: standalone` | 无地址栏与前进后退；iOS/Android 表现有差异 | 采纳为**用户侧临时措施**，写进文档不写代码 |
| B. 顶栏随滚动方向收起 | ≈ +55px | 新增 1 个 hook + 1 个纯函数，`WebTimeline` 加 1 个可选回调 | 低，不动滚动架构 | 采纳 |
| C1. 输入区空态折叠为单行 | ≈ +90px（未聚焦时） | 改 `WebComposer` 显隐 + 移动端 min-height | 中，需处理焦点/键盘/streaming | 采纳 |
| C2. 输入区常驻单行，工具行收进 BottomSheet | ≈ +90px（恒定为真） | 重写工具行交互，`WebBottomSheet` 已有可复用 | 高，需重写移动端 e2e 断言 | 暂不实施（C1 已确认） |
| D. 滚动容器提升到根 | ≈ +56px（地址栏） | 重构滚动与跳转链路 | 高 | 否决 |

## 详细设计

### B：顶栏随滚动方向收起

**纯函数**（新增 `src/renderer/src/web/headerAutoHide.ts`）：

```
type HeaderAutoHideInput = { scrollTop: number; delta: number; viewportWidth: number; forceVisible: boolean };
resolveHeaderHidden(previous: boolean, input): boolean
```

规则，按优先级：

1. `viewportWidth > 760` → 恒 `false`（桌面不参与）。
2. `forceVisible` → `false`。由调用方在以下时机置真：输入框聚焦、打开任一弹层（侧栏抽屉/搜索/技能扩展/DSH 工具/工作区抽屉/文件预览）、切换会话。
3. `scrollTop <= 0` → `false`（回顶必然露出）。
4. `delta < -8`（向上滚 8px 以上）→ `false`，立即显示。
5. `delta > 24`（向下滚 24px 以上）→ `true`。
6. 其余情况保持 `previous`。阈值不对称是为了避免手指微抖导致顶栏闪烁。

**接线**：

- `WebTimeline` 新增可选 prop `onScrollTopChange?: (scrollTop: number, delta: number) => void`，在既有 `updateScrollState`（`WebTimeline.tsx:622-630`）里顺带调用。不新增事件监听器。
- `WebChatApp` 持有 `headerHidden` 状态与 `forceReveal` 计数，把 `headerHidden` 传给 `WebHeader`。
- `WebHeader` 外层加一个 slot：`grid grid-rows-[1fr] transition-[grid-template-rows] duration-200`，收起时 `grid-rows-[0fr]`，内层 `min-h-0 overflow-hidden`。用 `fr` 过渡而不是 `max-height`，因为顶栏真实高度依赖标题换行，`max-height` 需要一个拍脑袋的上限。
- `scroll-mt-24`（`WebTimeline.tsx:689`）在顶栏收起时失去意义。改为由 `WebChatApp` 通过 CSS 变量注入 `--web-scroll-mt`，收起时 0、展开时 96px。`scrollToMessage` 用 `scrollIntoView`，依赖 `scroll-margin-top`，改变量即可，不必改跳转逻辑。
- **收起态必须不可聚焦**：`grid-rows-[0fr]` + `overflow-hidden` 只裁剪，不改变可聚焦性——收起后顶栏里的会话菜单、溢出菜单、上下文环仍能被 Tab 聚焦，焦点会进入视觉上不存在的区域。收起时给 slot 内层加 `inert`（React 19 原生支持该属性）或 `visibility: hidden`，展开时移除。仓库已有同类修复先例（`b539f520`「模态 Escape 与键盘可达性修复」）。单测需覆盖「收起 → 内层元素不可聚焦」。

**流式期间**：自动贴底算程序化滚动，**不参与方向判定**——用户没滑屏，顶栏就不动。判定用两层：`programmaticScrollRef`（每次 `scrollTo` 前标记）+「跟底模式下正向位移一律视为自动跟随」（滚动事件可能晚于下一次 `scrollTo` 到达，单次标记挡不住）。用户自己上滑即离开跟底，之后的方向判定恢复正常。

### C1：输入区空态折叠

**折叠条件**（`WebComposer` 内计算）：`draft === "" && images.length === 0 && !streaming && !focused`。

折叠态渲染：只保留 textarea 与发送按钮，隐藏操作行（`:145`）与模型行（`:181`）；`composer-box` 的最小高度改由组件按状态控制——折叠 `min-h-14`（56px）、展开 `min-h-[7rem]`（112px）。`WebComposer.tsx:106` 已硬编码 `min-h-[7rem]`，必须改成条件类，只改 CSS 不够（见下节）。

展开触发：textarea 聚焦、有草稿、有图片、`streaming` 为真。

产品取舍：折叠态隐藏模型/思考 pill **已确认可接受**（2026-10-18 用户确认）——用户没在输入时不需要这两个 pill，聚焦后立即展开。若后续推翻，改走 C2。

**与键盘的交互**：`interactive-widget=resizes-content` 下键盘弹出压缩视口。折叠态（未聚焦）不需要处理键盘；聚焦后展开是必然的，此时正文区被压缩属预期。C1 的收益主要来自「读历史时输入区只占 56px」。

### 移动端 min-height 的处理

`web.css` 在 `web-main.tsx:11` 是**未分层** import，因此 `web.css:340-342` 的 `.app.wechat-shell .composer-box { min-height: 6rem; }` 压过所有 layer（含 utilities；见 `src/renderer/src/styles.css:1-27` 的 cascade 契约，其中第 2 条踩坑记录正是「旧规则保持 unlayered 则永远压过 utilities」）。两处都要改，缺一处 C1 就失效：

1. `web.css:340-342` 的 `min-height: 6rem` → `min-height: 0`，解除 96px 下限。
2. `WebComposer.tsx:106` 的 `min-h-[7rem]`（112px）→ 条件类 `min-h-14` / `min-h-[7rem]`。**只做第 1 步时，折叠态会被这条 utility 撑到 112px**，收益从 ≈90px 掉到 ≈46px。

判定状态：**实测**（`web.css` 未被 `@layer` 包裹；`styles.css:1-27` 明确记录 unlayered 旧规则会压过 utilities）。

## 影响文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/web/headerAutoHide.ts` | 新增，纯函数 |
| `src/renderer/src/web/WebHeader.tsx` | 外层 slot + 收起过渡 + 收起态 `inert`（约 +18 行） |
| `src/renderer/src/web/WebTimeline.tsx` | 加 1 个可选 prop 并在 `updateScrollState` 内调用（约 +5 行） |
| `src/renderer/src/web/WebChatApp.tsx` | 状态、`forceReveal` 时机、CSS 变量注入（约 +30 行） |
| `src/renderer/src/web/WebComposer.tsx` | 折叠判定、两行显隐、`min-h-[7rem]` 改条件类（约 +15 行） |
| `src/renderer/src/web/web.css` | 移动端 `composer-box` min-height 改 0；新增 slot 过渡样式 |
| `tests/webHeaderAutoHide.test.mjs` | 新增，覆盖 6 条规则与边界 |

不改 i18n：本次不新增任何面向用户的文案。

## 测试与验证

**单元测试**（`node --test`，与仓库现有机制一致）：`tests/webHeaderAutoHide.test.mjs` 覆盖阈值边界（delta = ±8/24）、`scrollTop = 0`、桌面断点、`forceVisible` 优先于一切。

**既有 e2e 的影响**：

| 用例 | 影响 |
|---|---|
| `e2e/web-mobile-ui.spec.ts:49` | 断言工具行内模型 pill 与发送按钮同排、同高 32px、同中心线。C1 折叠后模型 pill 不可见 → **必须改为先聚焦 textarea 再断言**，或改为断言展开态 |
| `e2e/web-service.spec.ts:138` | 只断言无横向溢出，不受影响 |
| `e2e/web-visual-snapshot.spec.ts` | 截图基线 `e2e/.snapshots/web-mobile-*.png` 会因高度变化失配，需重新生成 |

**已发现的既有缺陷（与本次改动无关）**：`e2e/web-mobile-ui.spec.ts:74` 的定位器 `.composer-box div.items-center.justify-between` 在当前 `dev` 上匹配不到任何元素——`913288cf`（2026-10-07「手机 Web 端交互与渲染优化」）把工具行的 `justify-between` 删掉了，`WebComposer.tsx` 里三个行容器（`:108`、`:145`、`:181`）都不含该类。同一文件 `:103`、`:130` 复用同一类名，一并失效。该用例会在 `await expect(toolbar).toBeVisible()` 处超时失败。

判定状态：**静态推断**（逐层比对选择器与源码，未运行 e2e，本机缺 `node_modules`）。实施前应先修这条定位器，否则无法用 e2e 验证本次改动。

**门禁权重**：e2e **不在 CI**——`.github/workflows/ci.yml` 只跑 `check:*`、`test:serial`、`typecheck`、`build`、`pack`；`npm run test:e2e` 是手动脚本。因此上面那条失效定位器不会让 CI 红灯，它只挡住本地验证。修它仍有必要（否则本次改动无法用 e2e 复核高度收益），但不算 CI 门禁。

**门禁**：`npm run typecheck` + 上述单测（CI 内）+ 本地手动移动端 e2e。命令不得用管道吞返回码（`AGENTS.md` 硬性要求）。

## 实施顺序

1. 修 `e2e/web-mobile-ui.spec.ts` 的失效定位器，确认该用例在改动前为绿（手动跑，非 CI）。
2. 纯函数 `headerAutoHide.ts` + 单测。不接线，零行为变化。
3. B 接线：`WebTimeline` 回调 → `WebChatApp` 状态 → `WebHeader` slot（含收起态 `inert`）。桌面端人工确认无变化。
4. C1：`WebComposer` 折叠 + `WebComposer.tsx:106` 的 `min-h-[7rem]` 改条件类 + `web.css:340-342` min-height 改 0（三处同改，漏任一处折叠失效）。
5. 更新 e2e 断言与截图基线，并量折叠态 `composer-box` 实际高度。

## 风险与未确定项

| 项 | 状态 |
|---|---|
| 高度收益的实际数字 | **已实测**（Chromium 375×812，见「实测高度」）：折叠 +89px、顶栏收起 +55px、合计 +144px。真机与 iOS 仍未测 |
| C1 折叠态隐藏模型 pill | **已确认可接受**（2026-10-18）。折叠态收益 ≈90px，聚焦后回落到 0 |
| C1 漏改 `min-h-[7rem]` 导致折叠无效 | **已识别**，两处必须同改（见「移动端 min-height 的处理」）。验收标准：折叠态 `composer-box` 实测高度 ≈66px（textarea 56 + legacy 内边距 8 + 边框 2；草案按 58px 推算，偏低 8px） |
| 顶栏收起态仍可 Tab 聚焦 | **已识别**。必须加 `inert` 或 `visibility: hidden`，否则是可访问性回归 |
| C2（常驻单行 + BottomSheet）是否值得 | **暂不实施**。C1 已确认，C2 的「收益不受焦点状态影响」不构成实施理由 |
| iOS Safari 表现 | **未验证**。`interactive-widget` 只有 Chromium 支持，iOS 的键盘处理走 `dvh` 自身；`grid-template-rows` 的 `fr` 过渡在旧版 Safari 的插值支持未确认，必要时降级为 `max-height` 过渡 |
| 顶栏收起时用户是否失去会话状态可见性 | 未评估。运行态指示器（`WebHeader.tsx:86-88`）会随顶栏一起消失。可选缓解：收起时在时间线顶部保留 2px 状态色条，成本低但需要设计确认 |
| 长时间流式输出时顶栏常驻收起 | 属期望行为，但未在真机确认不会与 `scrollToBottom` 按钮（`WebTimeline.tsx:737`）视觉冲突 |

## 参考

- 移动端既有实现：`0729a984`（可用性与监控面板）、`3b492e01`（composer 工具行与头部布局对齐）、`326d85a3`（覆盖层系统返回）
- cascade 层序契约：`src/renderer/src/styles.css:1-27`

## 实施结果（已落地）

实施于 2026-10-18，分支 `fix/web-mobile-viewport-height`。落地与草案的差异逐条列出，便于复核。

### 文件清单（实际）

| 文件 | 状态 | 内容 |
|---|---|---|
| `src/renderer/src/web/webViewport.ts` | 新增 | `WEB_MOBILE_MAX_WIDTH = 760`、`isMobileViewport`、`readViewportWidth`（纯模块，不引 React） |
| `src/renderer/src/web/useIsMobileViewport.ts` | 新增 | `matchMedia` 订阅 hook（跨断点时重算） |
| `src/renderer/src/web/headerAutoHide.ts` | 新增 | `resolveHeaderHidden` 纯函数（6 条规则） |
| `src/renderer/src/web/composerCollapse.ts` | 新增 | `resolveComposerCollapsed` 纯函数（折叠判定） |
| `src/renderer/src/web/WebHeader.tsx` | 改 | slot（`grid-rows-[1fr]`/`[0fr]`）+ 收起态 `inert` + `aria-hidden` |
| `src/renderer/src/web/WebTimeline.tsx` | 改 | 新增 `onScrollTopChange`，在既有 `onScroll` 里上报 `(scrollTop, delta)` |
| `src/renderer/src/web/WebChatApp.tsx` | 改 | `headerHidden` 状态、露出时机（弹层/切会话/聚焦/跨断点）、`data-header-hidden` 注入 |
| `src/renderer/src/web/WebComposer.tsx` | 改 | 折叠判定 + 两行显隐 + `min-h` 条件类 + 折叠态浮动发送钮 + 焦点跟踪 |
| `src/renderer/src/web/web.css` | 改 | 移动端 `composer-box` 的 `min-height: 6rem` → `0`；收起态 `scroll-margin-top: 0` |
| `tests/webHeaderAutoHide.test.mjs` | 新增 | 9 条纯函数用例 + 接线契约 + CSS/JS 断点同源守卫 |
| `tests/webComposerCollapse.test.mjs` | 新增 | 折叠判定用例 + 三处同改契约（行显隐 / `min-h` / CSS 下限） |
| `e2e/web-mobile-ui.spec.ts` | 改 | 失效定位器改为 `data-testid`（`web-composer-ops-row` / `-model-row` / `-send`），新增折叠态用例 |

### 与草案的差异

| 草案 | 实际 | 原因 |
|---|---|---|
| `--web-scroll-mt` CSS 变量注入 | `data-header-hidden="on"` + web.css 规则 | 避免在 JSX 里写 CSS 变量（仓库只有 3 处 `as CSSProperties` 先例）；`web.css` 是 unlayered，天然压过 `scroll-mt-24` |
| 折叠态「只保留 textarea 与发送按钮」 | 发送钮绝对定位在 `composer-box` 右下，`textarea` 加 `pr-12` | 发送钮原本在操作行里，直接隐藏整行会把发送钮一起删掉；浮动后折叠高度才是 66px |
| 折叠条件含 `!focused` | 同，但失焦后**延迟 250ms** 收起，且两行 `onPointerDown` 阻止焦点转移 | 否则点工具行会先失焦、工具行在 `pointerup` 前被卸载，`click` 丢失（iOS 点按按钮不聚焦，`relatedTarget` 为 null，必须靠延迟兜底） |
| 滚动回调直接用 delta | 首帧不采样；单次位移超过一屏视为程序化跳转，不参与判定 | 否则挂载/切会话/自动贴底会立刻把顶栏收掉（切会话必须露出标题） |
| 折叠判定写在组件里 | 抽成 `resolveComposerCollapsed` 纯函数 | 仓库硬性要求「核心规则能离开 React 单独测绿」 |

### 门禁结果（2026-10-18，本机）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过（rc=0） |
| 格式 | `npm run check:format` | 通过（3032 文件） |
| 新增单测 | `node --test tests/webHeaderAutoHide.test.mjs tests/webComposerCollapse.test.mjs` | 25/25 通过（`step` 累计/翻转、折叠与收起规则、键盘/焦点恢复、接线契约） |
| 相关既有单测 | `webLayout` / `webMessageActionsOptimistic` / `modelRowLabels` / `cssCascadeLayers` | 50/50 通过 |
| 移动端 e2e | `npx playwright test e2e/web-mobile-ui.spec.ts` | **未跑通，属环境既有问题** |

e2e 说明（按 `AGENTS.md` 红名单流程核对）：

- 现象：`electron.launch` 成功后 `app.firstWindow()` 30s 超时；带 `webServiceEnabled` 种子的用例全部卡在这一步。
- 基线核对：`git worktree add` 到 `226c8663`（未改动的提交）复跑同一用例，同样在 `firstWindow()` 超时 → 不是本次改动引入。
- 环境因素：本机已有 PiDeck 实例占用 `127.0.0.1:8765`，且 e2e 应用侧未起窗口；改用 8899 端口复跑时 web 服务同样未就绪。
- 结论：e2e 结论待能在干净环境（无占用实例）中复跑；本次改动未触及窗口创建与 web 服务启动链路。

### 顺带发现的既有问题（未修）

`resources/extensions/extensions-manifest.json` 在 `226c8663` 上已过期：`npm run check:extensions-manifest` 报 artifact is stale（`pi-deck-goal-mode.ts` / `pi-deck-security-gate.ts` / `pi-deck-trash-guard.ts` 的 sha256 与字节数不符）。本次构建重新生成了该文件，已按「非本任务改动不提交」还原，未纳入本次改动。

### 实测高度（Chromium，非 Electron）

测量方法：`npm run build:fast` 产物 `out/renderer/web.html` 由本地静态服务托管，`/api/state`、`/api/models`、`/api/events` 用桩响应；Playwright Chromium（`chromium-1247`）在 375×812 触屏上下文里读 `getBoundingClientRect()`。种子状态含 1 个项目、1 条会话、无消息。

| 状态 | `.composer-box` | 时间线高度 | 顶栏 slot | 头部可聚焦控件 |
|---|---|---|---|---|
| 窄屏空闲（折叠） | 66px | 683px | 55px | 2 |
| 窄屏聚焦/有草稿（展开） | 155px | 594px | 55px | 2 |
| 窄屏顶栏收起（滚动 200px 后稳定） | 66px | **738px** | **0px** | **0** |
| 窄屏上滚 100px（恢复） | 66px | 683px | 55px | 2 |
| 桌面 1280×900 | 155px | — | 55px | 2 |

结论（实测，非推算）：

- 折叠收益 **+89px**（594 → 683），与草案的 ≈90px 一致；折叠态实测 66px（草案推算 58px，差值来自 textarea 的 legacy 内边距）。
- 顶栏收起收益 **+55px**（683 → 738），与草案一致。
- 两者叠加 **+144px**，超过「≥120px」目标。
- 收起态 `inert` 生效：头部可聚焦控件从 2 个降到 0 个。
- 桌面端输入区仍是 155px、`min-height: 112px`、模型行常驻，视觉与行为未变。
- 程序化跳转守卫生效：单次 `scrollTop` 跳 2200px 不触发收起（此前一版会收起），跳 200px 触发。

**未覆盖**：真实 pi 会话的流式滚动、iOS Safari、键盘弹出后的 `dvh` 压缩。这三项仍属未验证。

### 首轮真机反馈后的修正（2026-10-18 第二轮）

用户在手机上实测后报了三个问题，其中两个是本次改动的缺陷，已修：

| 反馈 | 根因 | 修正 |
|---|---|---|
| 「顶栏会隐藏，但不是一上滑就隐藏，感觉卡顿」 | ①`handleTimelineScroll` 每帧都 `setHeaderHidden`，触发整个 `WebChatApp`（含 384 条消息的时间线、76 条会话的侧栏）重渲染；②阈值按**单帧 delta** 判定，正常滑动每帧只有几像素，永远到不了 24px，只有快速甩动才收起 | ①改为累计同方向位移，且**仅在状态翻转时** setState（`headerScrollRef` + `applyHeaderHidden`）；②`WebTimeline` 的 `setShowScrollToBottom` 同样加镜像去重（原本每帧一次重渲染） |
| 「只能使用 dsh，切不到 pi」 | ①历史会话的后端是**锁定**的（pi 与 DSH 会话文件格式不同，仅本页新建且无消息的草稿可切）；②C1 折叠把操作行整行卸掉，后端 pill 随之不可见，看起来「没有入口」 | 折叠态浮动区补一个后端 pill（仅草稿期显示，锁定会话不摆死控件），`textarea` 相应加 `pr-28`；浮动区 `onPointerDown` 阻止焦点转移，否则点击会先展开、浮动区在 click 前被卸载，弹层打不开 |
| 「浏览器地址栏不能自动隐藏」 | 页面没有根滚动器（`body`/根 div 都是 `overflow: hidden`），Chrome 只跟随根滚动器收起地址栏 | **未改**：需要方案 D（把滚动容器提升到根），成本与回归风险见「非目标」。用户侧临时措施是装到主屏（PWA `display: standalone`，地址栏整体消失） |

实测复核（dev 实例，真实 384 条消息会话，Chromium 375×812）：

| 场景 | 结果 |
|---|---|
| 慢速下滑 5px × 8 次（累计 40px） | 顶栏收起（修正前：永不收起） |
| 慢速上滑 4px × 3 次（累计 12px） | 顶栏恢复 |
| 程序化跳转 800px（切会话/贴底） | 不触发收起 |
| 历史会话折叠态 | 浮动区只有「发送」（后端锁定，不摆死控件） |
| 新建草稿会话折叠态 | 浮动区 `[Pi][发送]`，点 Pi 打开后端弹层（Pi / DSH / 生图） |

### 追加：输入区随滚动整区收起（第二级，2026-10-18）

用户追问「为什么不让输入区像顶栏一样随滚动隐藏」。评估结论：两者互补而非替代——C1 的收益在**不滚动**时就拿到（66px），滚动隐藏的收益在**翻历史**时才出现（再 74px）。只做后者会让「刚打开会话、停在底部」这个最常见状态从 66px 退回 155px，因此按叠加实现。

判定（纯函数 `resolveComposerHidden`，`src/renderer/src/web/composerCollapse.ts`）：顶栏已收起 **且** 离开底部 **且** 非流式 **且** 未在输入，才整区收起。

四个保护条件对应的产品约束：

| 条件 | 为什么必须露出 |
|---|---|
| 顶栏未收起 | 同一个手势驱动两级；顶栏还露着时输入区不该先消失 |
| 贴近底部（<160px） | 在最新消息处必须能直接打字；「回到底部」按钮/滚到底也会因此同时露出顶栏与输入区 |
| 流式中 | 输入区就是 Stop 按钮，藏起来等于让用户无法中断 |
| 聚焦 / 有草稿 / 有附件 | 不能把用户正在写的内容藏掉（键盘还开着更糟） |

实现复用顶栏 slot 范式：`grid-rows-[1fr]` ↔ `[0fr]` + 收起态 `inert` / `aria-hidden`；`WebTimeline` 新增 `onNearBottomChange`（值变化才回调，避免每帧 setState），`WebComposer` 新增 `hidden` 与 `onEngagedChange`。

实测（dev 实例，真实 384 条消息，Chromium 375×812）：

| 状态 | 顶栏 | 输入区 | 时间线 |
|---|---|---|---|
| 停在底部（空闲折叠） | 55 | 74（box 66） | 683 |
| 慢速下滑 40px 后 | 0 | **0**（`inert`） | **812** |
| 慢速上滑 12px | 55 | 74 | 683 |
| 聚焦输入中再下滑 | 0 | 163（展开，保护生效） | 649 |
| 回到底部 | 55 | 163 | 594 |

读历史时相对基线（594）合计 **+218px**（顶栏 55 + 输入区 74），超过原先的 +144px。

未覆盖：真机手感（`grid-rows` 过渡在 iOS Safari 的插值支持仍未验证）、流式输出中滚动（按约定不隐藏，未实测体感）。

### 收起动效调优（2026-10-18，用户反馈「消失得很生硬」）

两处改动：

1. **缓动与时长**：`ease-out` + 200ms 的实际曲线是「前 60ms 已走完 80%」——肉眼就是「一下没了，然后慢慢收尾」。改为 `cubic-bezier(0.4, 0, 0.2, 1)` + 240ms，并加 `motion-reduce:transition-none`（系统开了减弱动效就直接切换）。
2. **输入区改为下滑出场**：原先靠 `grid-rows` 收缩裁剪，内容贴在顶部被「从下往上吃掉」，方向反了（底部元素应该向下滑出）。现在输入区内容加 `translate-y-full` + `opacity-0`，与高度收缩同步，视觉上向下滑出屏幕；顶栏保持上滑（裁剪方向本来就对），只加同步淡出。

过程中踩到一个 Tailwind v4 细节：`translate-y-*` 设置的是 `translate` 属性（不是 `transform`），所以 `transition-[transform,opacity]` 对位移无效——位移会瞬跳。必须写 `transition-[translate,opacity]`。

实测曲线（375×812，收起方向，采样每帧）：

```
41ms  slot=74  formTop=738
59ms  slot=74  formTop=740   ← 起步平滑（旧曲线此时已走完 46%）
93ms  slot=63  formTop=757
126ms slot=37  formTop=784
176ms slot=12  formTop=802
```

展开方向对称（slot 0→62 用 145ms，透明度 0→0.84 同步）。功能回归未变：贴底 683、收起后 812、上滑恢复 683。

### 评审后按非阻塞项做的收口（2026-10-18）

| 项 | 处理 |
|---|---|
| `web.css` 手写规则压 `scroll-mt-24` | 删掉，改成 `WebTimeline` 上的 `[[data-header-hidden=on]_&]:scroll-mt-0`（Tailwind 任意变体，仓库已有 `[[data-bg-image=on]_&]` 先例） |
| 累计/方向翻转状态机塞在 1100 行组件里 | 抽 `stepHeaderAutoHide` 纯函数 + `useWebHeaderAutoHide` hook；`WebChatApp` 只拿 `{ hidden, reportScroll, reveal }`。新增 4 条 `step` 行为测试（累计、方向翻转清零、forceVisible、零位移） |
| 契约测试正则不是空白容忍 | 9 处字面空格改成 `\s*`（`webHeaderAutoHide` / `webComposerCollapse` 两个文件） |
| 「加载更多历史」前插的正位移误收顶栏 | 增加「内容驱动」判定：位移与 `scrollHeight` 变化量近似相等时视为锚定/前插/分组折叠，不上报 |
| 顶栏收起后键盘/读屏无恢复路径 | 窄屏下监听 `keydown` + `focusin`（capture，配对清理）→ `revealHeader()` |
| 8/24 非对称阈值理由只在文档里 | 在常量上方留一行说明（这是唯一「照着改成对称就会退化」的地方） |
| doc 数字对不上 | 单测 25 条（定向集 61）、折叠态 66px，两处已改 |
