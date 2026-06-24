# PR：feat: 输入区 contentEditable 行内 chip 渲染 & 光标感知触发系统

## 概述

本次 PR 对 PiDeck 的输入区域进行了重大重构，将原有的 `<textarea>` 升级为 `contentEditable` 行内 chip 渲染系统，同时将 `@` / `/` 建议菜单的触发机制从「整段文本末尾分词」改为「光标位置感知」。

**涉及文件**：`src/renderer/src/` 下 4 个文件，新增 867 行，删除 88 行。

| 文件 | 变更 |
|------|------|
| `components/app/RichInput.tsx` | **新增**（500 行）— contentEditable 输入组件 |
| `App.tsx` | 204 行变更 — textarea → RichInput 集成 |
| `components/app/AppParts.tsx` | 140 行变更 — 光标感知触发/建议/消息 chip 渲染 |
| `styles.css` | 111 行变更 — chip 样式、布局修复 |

---

## 改动详解

### 1. 🎨 输入区：textarea → contentEditable 行内 chip（核心变更）

**新增 `RichInput` 组件**，将 `@path` 和 `/command` 以可视化 chip 行内渲染在输入框中，替代纯文本 textarea。

- **文件 chip**（蓝底，`@` 前缀）：`@src/main.ts`、`@components/ui/Button.tsx`
- **Skill chip**（紫底，`/` 前缀）：`/skill:ppt-master`、`/compact`

**技术要点**：

- DOM 保持「文本节点 + chip span」的扁平结构，`white-space: pre-wrap` 保证换行行为
- Chip 元素设置 `contenteditable="false"`，不可编辑但仍是光标遍历路径的一部分
- 光标偏移统一用纯文本偏移（与 textarea `selectionStart` 语义一致），chip 通过 `data-raw` 属性贡献偏移长度
- 受控渲染：外部 `value` 为单一数据源，`useLayoutEffect` 检测 DOM 与 value 一致性，不一致时重渲染并恢复光标
- 边界处理：IME 中文输入期间锁定不回写、粘贴强制纯文本、Enter 手动插入 `\n`、光标在 token 内部时过滤该 token 以允许继续编辑
- URL 中的路径段（如 `https://example.com/foo`）不会被误识别为 chip

**效果图**：

> *（请在此放置：输入框中 @文件 和 /skill chip 行内渲染的截图）*

---

### 2. 🎯 建议菜单：光标位置感知触发

将 `@` / `/` 建议菜单的触发逻辑从「取整段 prompt 最后一个空白分词」改为「以光标为锚检测触发器」。

**问题**：原实现完全忽略光标位置，光标停在文字中间时，末尾分词在光标之后，文件/skill 菜单无法弹出。例如在 `"帮我检查 @main.ts 和 @utils.ts"` 中间 `@main.ts` 处无法唤出文件建议。

**改动**：

- 新增 `detectTrigger(text, cursor)` 函数：从光标位置向前查找 `@` 或 `/`，验证触发符到光标之间连续无空白、无其他触发符，且前一字符非 `:` `/` 避免误判 URL 协议和路径分隔符
- `buildSuggestionItems()`、`applySuggestion()`、`clearSuggestionTrigger()` 均改为接收 `cursor` 参数，以光标为锚替换触发符区间
- 新增 `ComposerSuggestionResult` 和 `ComposerTrigger` 类型
- 新增 `composerCursor` 状态和 `pendingComposerCaretRef` 用于程序化光标恢复

**效果图**：

> *（请在此放置：文字中间 @ 唤起文件建议面板的截图）*

---

### 3. 📌 建议面板：光标跟随定位

建议面板不再固定位置显示，改为锚定到光标所在位置的屏幕坐标：

- 新增 `getRichInputCaretCoords()` 函数：通过 `document.createRange().getBoundingClientRect()` 计算光标屏幕坐标
- `PromptSuggestions` 组件新增 `anchorStyle` prop，接收绝对定位样式
- 面板优先显示在光标下方，空间不足时显示在上方
- 通过 `onMouseDown` + `preventDefault` 阻止 blur 时序问题，确保面板可点击选择
- 标题由 `isCommand`（首项 value 是否以 `/` 开头）推导，不再依赖触发符检测

**效果图**：

> *（请在此放置：建议面板跟随光标定位的截图）*

---

### 4. 🔗 文件 chip 可点击打开

点击输入框中的文件 chip（如 `@src/main.ts`）会自动在系统默认应用中打开对应文件：

- `RichInput` 新增 `onChipClick` 回调
- `App.tsx` 中集成：检测 chip 类型为 `file` 时调用 `openFilePath()`
- Skill chip 点击暂不处理，预留后续扩展

---

### 5. 💬 聊天区用户消息 chip 渲染

新增 `renderChipText()` 函数，将用户消息中的 `@path` 和 `/command` 也渲染为行内 chip（输入框与消息气泡视觉一致）。

- 用户消息中的文件 chip 可点击打开文件（通过 `onOpenFile` 回调）
- Chip 渲染逻辑复用 `parseRichInputChips()`（与输入框同一解析函数）
- 消息气泡 chip 样式通过 `.user-message-text .input-chip` 定义，支持 hover 高亮

**效果图**：

> *（请在此放置：聊天区用户消息中 chip 渲染的截图）*

---

### 6. 🎨 CSS 与样式系统

- **chip 配色系统化**：新增 `--color-brand-purple`（`#7c3aed` 浅色 / `#c4b5fd` 暗色）用于 skill chip，`--color-brand-blue` 用于文件 chip。使用 `color-mix()` 半透明背景 + 边框
- **chip 组件样式**：`.input-chip` 使用 `display: inline` + `box-decoration-break: clone`，确保长 chip 自动折行时视觉完整
- **布局修复**：
  - `.markdown-body` 和 `.agent-run-content` 的 `overflow-x: visible` → `clip`，防止长消息溢出
  - `.markdown-body ul/ol` 新增 `list-style-position: inside`
  - RichInput shell 模式左侧 padding 对齐原 textarea 的 `::before` 指示条
  - RichInput `.bang` / `.bang-bang` 使用与原 textarea 一致的 caret-color
- **微调**：session-info button 字号从 `--font-size-caption` → `--font-size-control`，session-status 从 `--font-size-micro` → `--font-size-caption`

---

## 技术约束说明

| 边界场景 | 处理方式 |
|----------|----------|
| IME 中文输入 | `compositionstart` 锁定，`compositionend` 回写，期间不回写 value |
| 受控回写 | DOM 纯文本与 value 一致时跳过重渲染；不一致时渲染并恢复光标 |
| 粘贴富文本 | 强制 `insertText` 纯文本，图片交给上层处理 |
| Enter 换行 | 未 preventDefault 时手动插入 `\n`，保持 DOM 扁平 |
| 光标在 token 内 | 过滤该 token 不 chip 化，允许继续输入 |
| URL 中的路径段 | 检测 URL 区间，跳过 chip 识别 |
| Email `user@host` | 允许触发（选中文件后自然替换掉 `@`），体验可接受 |

---

## 不兼容变更

- `composerTextareaRef` 类型从 `HTMLTextAreaElement` → `HTMLDivElement`
- 输入框 DOM 选择器从 `.composer-box textarea` → `.composer-box .rich-input`
- `applySuggestion()`、`clearSuggestionTrigger()`、`buildSuggestionItems()` 函数签名变化，新增 `cursor` 参数

---

## 测试方式

```bash
git clone https://github.com/1900EasonJin/pi-desktop.git
cd pi-desktop
npm install
npm run make-icon
npm run dev
```

在输入框中测试：
1. 输入 `@` → 文件建议面板应在光标处弹出
2. 输入 `/` → 命令建议面板应在光标处弹出
3. 选中建议 → chip 应行内渲染，光标后恢复
4. 点击文件 chip → 应在系统编辑器中打开对应文件
5. 在文字中间打 `@` → 建议面板应在中间光标处触发
6. 粘贴 URL → 路径段不应被识别为 chip
7. 长消息 + chip 混排 → 不应溢出
