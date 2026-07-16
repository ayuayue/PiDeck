# PiDeck Markdown 渲染优化计划（精简版）

> 目标：优化 PiDeck 聊天中 Markdown 正文及最终结果的显示效果，重点是普通文本排版、行内代码样式、文件链接样式。
> 本次计划不包含：表格、代码块（用户已自行调整）。
> 当前状态：仅做计划，不执行代码修改。

---

## 1. 本次优化范围

根据需求，只修改以下三类：

1. **输出 MD 文件样式**：即聊天正文中 heading、paragraph、list、blockquote、hr、img、strong/em/del 等普通 Markdown 元素的排版与颜色。
2. **行内代码自定义样式**：即反引号包裹的 `<code>`，区别于代码块 `<pre>` 里的 code。
3. **文件链接样式**：即由 `remarkLinkifyPaths` 自动生成的 `file://` 链接，点击后打开文件，需要单独设计样式。

---

## 2. 为什么当前不够好看

### 2.1 普通文本元素缺失样式

`src/renderer/src/styles.css` 中的 `.markdown-body` 只定义了：

```css
.markdown-body p { ... }
.markdown-body ul, .markdown-body ol { ... }
.markdown-body li { ... }
.markdown-body pre { ... }
.markdown-body table { ... }
.markdown-body th, .markdown-body td { ... }
.markdown-body code { ... }
```

**缺失**：`h1~h6`、`a`、`blockquote`、`hr`、`img`、`strong`、`em`、`s`。

这些元素走浏览器默认样式，导致：

- heading 字号和间距不可控，与 PiDeck 整体排版不统一。
- 链接走浏览器默认蓝色，暗色模式下刺眼。
- 引用块没有样式，和正文混在一起。
- 图片没有 `max-width` 和圆角，可能撑破布局。
- strong/em 依赖浏览器默认粗细，可能过细或不够明显。

### 2.2 行内代码没有独立样式

```css
.markdown-body code {
  font-family: var(--font-family-mono);
  font-size: 0.92em;
}
```

这条规则同时作用于 `pre > code` 和行内 `<code>`。行内代码没有：

- 背景色
- 圆角
- padding
- 独立颜色

导致行内代码在正文里不突出，阅读体验差。

### 2.3 文件链接没有特殊样式

当前文件链接由 `remarkLinkifyPaths` 插件生成：

```markdown
[some/path/file.ts](file://encoded-path)
```

然后 `MarkdownLink` 组件处理点击：

```tsx
function MarkdownLink(props) {
  return <a {...anchorProps} onClick={handleClick} />;
}
```

它没有任何特殊 class，和普通外链一样走默认蓝色，用户无法一眼看出“这是可点击的文件路径”。

---

## 3. 具体修改计划

### 3.1 普通 Markdown 文本样式

在 `src/renderer/src/styles.css` 中新增 `.markdown-body` 下缺失元素的样式。

#### 3.1.1 标题

```css
.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  margin: 1.4em 0 0.5em;
  line-height: 1.35;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}

.markdown-body h1 {
  font-size: 1.65em;
  border-bottom: 1px solid var(--color-border-subtle);
  padding-bottom: 0.2em;
}
.markdown-body h2 { font-size: 1.4em; }
.markdown-body h3 { font-size: 1.2em; }
.markdown-body h4 { font-size: 1.08em; }
.markdown-body h5 { font-size: 1em; }
.markdown-body h6 { font-size: 0.95em; color: var(--color-text-secondary); }
```

> Paseo 的 heading 也会用 `border-bottom` 区分 h1/h2，字号更大（1.6~2.6em）。PiDeck 的聊天正文不宜过大，所以这里采用相对正文 1.65em 起步，更克制。

#### 3.1.2 链接

```css
.markdown-body a {
  color: var(--color-accent);
  text-decoration: none;
}
.markdown-body a:hover {
  text-decoration: underline;
}
.markdown-body a:focus-visible {
  outline: var(--focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
```

> 用 `--color-accent` 替代浏览器默认蓝色，在暗色模式下更协调。

#### 3.1.3 引用块

```css
.markdown-body blockquote {
  margin: 0.8em 0;
  padding: 0.6em 1em;
  border-left: 3px solid var(--color-border-strong);
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.markdown-body blockquote p:last-child { margin-bottom: 0; }
```

#### 3.1.4 分隔线

```css
.markdown-body hr {
  margin: 1.5em 0;
  border: none;
  border-top: 1px solid var(--color-border-subtle);
}
```

#### 3.1.5 图片

```css
.markdown-body img {
  max-width: 100%;
  border-radius: var(--radius-sm);
}
```

#### 3.1.6 文字格式

```css
.markdown-body strong { font-weight: 600; }
.markdown-body em { font-style: italic; }
.markdown-body s { text-decoration: line-through; color: var(--color-text-secondary); }
```

---

### 3.2 行内代码自定义样式

需要让行内 `<code>` 与 `pre > code` 分开。

```css
.markdown-body code {
  font-family: var(--font-family-mono);
  font-size: 0.92em;
}

.markdown-body :not(pre) > code {
  padding: 0.15em 0.35em;
  background: var(--color-bg-muted);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
}

.markdown-body pre code {
  padding: 0;
  background: transparent;
  border-radius: 0;
  font-size: 0.9em;
  line-height: 1.55;
}
```

> 如果用户调整了代码块样式，只需要确保 `.markdown-body pre code` 不被行内代码样式覆盖即可。`:not(pre) > code` 选择器天然隔离。

---

### 3.3 文件链接样式

这是本次重点。文件链接收 `MarkdownLink` 组件处理，需要给文件链接加特殊标识和样式。

#### 3.3.1 当前文件链接生成逻辑

1. `remarkLinkifyPaths` 插件在 mdast 层扫描文本，匹配文件路径。
2. 生成 `link` 节点，URL 为 `file://encoded-path`，children 为原文本路径。
3. `MarkdownLink` 接收 `href` 和 `children`，点击时：
   - 如果是 `file://`，解码路径并调用 `onOpenFile(path)`。
   - 否则调用 `onOpenExternal(url)` 用系统浏览器打开。

#### 3.3.2 方案 A：仅加 CSS 类（最轻量）

修改 `MarkdownLink`：

```tsx
function MarkdownLink(props) {
  const { onOpenExternal, onOpenFile, ...anchorProps } = props;
  const isFileLink = props.href?.startsWith('file://');
  const handleClick = (e) => { ... };
  return (
    <a
      {...anchorProps}
      className={`markdown-link ${isFileLink ? 'markdown-link-file' : ''}`}
      onClick={handleClick}
    />
  );
}
```

新增 CSS：

```css
.markdown-link-file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-family-mono);
  font-size: 0.92em;
  color: var(--color-accent);
  background: var(--color-bg-muted);
  padding: 0.1em 0.4em;
  border-radius: var(--radius-sm);
  text-decoration: none;
  overflow-wrap: anywhere;
  transition: background-color 0.15s, color 0.15s;
}
.markdown-link-file:hover {
  background: var(--color-bg-hover);
  text-decoration: underline;
}
.markdown-link-file::before {
  content: "📄";
  font-size: 0.85em;
}
```

优点：无新增依赖，改动小。

缺点：emoji 图标风格可能和 PiDeck 不统一。

#### 3.3.3 方案 B：用 lucide-react 图标（推荐）

PiDeck 已依赖 `lucide-react`，可以引入 `FileText` 图标。

修改 `MarkdownLink`：

```tsx
import { FileText } from "lucide-react";

function MarkdownLink(props) {
  const { onOpenExternal, onOpenFile, children, ...anchorProps } = props;
  const isFileLink = props.href?.startsWith('file://');
  const handleClick = (e) => { ... };

  return (
    <a
      {...anchorProps}
      className={`markdown-link ${isFileLink ? 'markdown-link-file' : ''}`}
      onClick={handleClick}
      title={isFileLink ? decodeURIComponent(props.href.slice(7)) : props.href}
    >
      {isFileLink ? (
        <>
          <FileText size={12} className="markdown-link-file-icon" />
          <span>{children}</span>
        </>
      ) : (
        children
      )}
    </a>
  );
}
```

新增 CSS：

```css
.markdown-link-file {
  display: inline-inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-family-mono);
  font-size: 0.92em;
  color: var(--color-accent);
  background: var(--color-bg-muted);
  padding: 0.1em 0.4em;
  border-radius: var(--radius-sm);
  text-decoration: none;
  overflow-wrap: anywhere;
  transition: background-color 0.15s, color 0.15s;
}
.markdown-link-file:hover {
  background: var(--color-bg-hover);
  text-decoration: underline;
}
.markdown-link-file-icon {
  flex-shrink: 0;
  vertical-align: middle;
}
```

优点：图标风格与 PiDeck 整体一致。

缺点：需要修改组件结构，增加少量 JSX。

#### 3.3.4 方案 C：给文件链接加下划线和颜色，不做图标

```css
.markdown-link-file {
  color: var(--color-accent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
  font-family: var(--font-family-mono);
  font-size: 0.92em;
}
.markdown-link-file:hover {
  text-decoration-color: var(--color-accent);
}
```

优点：最极简。

缺点：识别度不如带背景或图标的方案。

---

## 4. 不涉及本次修改的内容

以下内容用户已自行调整，本计划不再涉及：

- 表格样式（`.table-wrap`、`th`/`td` 等）
- 代码块样式（`.code-block-wrap`、`<pre>` 等）
- 代码语法高亮

但需要注意：如果表格和代码块使用了硬编码颜色（如 `#FFFFFF`），它们仍然可能在暗色模式下不协调。本次不处理，但建议用户确认。

---

## 5. 改动文件清单

### 5.1 `src/renderer/src/styles.css`

新增/修改：

- `.markdown-body h1~h6`
- `.markdown-body a`
- `.markdown-body blockquote`
- `.markdown-body hr`
- `.markdown-body img`
- `.markdown-body strong` / `.markdown-body em` / `.markdown-body s`
- `.markdown-body :not(pre) > code`
- `.markdown-body pre code`
- `.markdown-link-file`
- `.markdown-link-file-icon`

### 5.2 `src/renderer/src/components/app/AppParts.tsx`

修改：

- `MarkdownLink` 组件，给文件链接加 `markdown-link-file` className。
- 如选择方案 B，还需引入 `FileText` 图标并渲染在文件链接前。

### 5.3 不新增依赖

- 方案 A、C：无需新增依赖。
- 方案 B：使用已有 `lucide-react`，无需新增依赖。

---

## 6. 验证方案

### 6.1 静态验证

```bash
npm run typecheck
```

### 6.2 手动验证用例

在聊天中输入以下 Markdown，分别在亮色和暗色模式下查看：

```markdown
# 一级标题
## 二级标题
这是正文段落，包含 **加粗**、*斜体*、`行内代码` 和 [普通链接](https://example.com)。

> 这是引用块，用来测试引用样式。

---

- 列表项 1
- 列表项 2
  - 嵌套项

1. 有序项 1
2. 有序项 2

src/renderer/src/components/app/AppParts.tsx 这是一个文件路径链接。

![示例图片](data:image/png;base64,...)
```

### 6.3 检查点

- [ ] heading 在亮色/暗色下层次分明，不突兀。
- [ ] 普通链接颜色为 `--color-accent`，hover 有下划线。
- [ ] 文件链接有明显样式（背景/图标/颜色），点击能打开文件。
- [ ] 行内代码有背景、圆角、等宽字体，不破坏行高。
- [ ] 引用块有左侧边框和背景，和正文区分明显。
- [ ] 图片不撑破布局，有圆角。
- [ ] strong/em/s 样式正常。
- [ ] 编译通过 `npm run typecheck`。

---

## 7. 风险与注意事项

### 7.1 全局样式影响

`.markdown-body` 类在 PiDeck 中至少用于：

- 聊天消息正文（`AssistantText`）
- 设置页 release notes（`update-notes markdown-body`）
- 可能还有其他地方（需全局搜索确认）

修改 `.markdown-body` 是全局影响，需确保所有使用点都能接受新的 heading/link 样式。

### 7.2 文件链接识别

当前判断依据是 `href.startsWith('file://')`。如果将来文件链接协议变化，需要同步更新 `MarkdownLink` 和 CSS 选择器。

### 7.3 行内代码与代码块隔离

`:not(pre) > code` 选择器能正确隔离行内代码和代码块，但要确保代码块内部没有嵌套结构导致 `pre > code` 失效。

### 7.4 图标方案 B 的 JSX 改动

如果文件链接的文字原本包含复杂结构（如嵌套元素），直接包 `<span>` 可能会破坏原有结构。需要测试。

---

## 8. 参考来源

- Paseo `packages/app/src/components/markdown/renderer.tsx` — 自定义 RenderRules
- Paseo `packages/app/src/styles/markdown-styles.ts` — Markdown 样式 token 化
- PiDeck `src/renderer/src/components/app/AppParts.tsx` — `AssistantText`、`MarkdownLink`、`remarkLinkifyPaths`
- PiDeck `src/renderer/src/styles.css` — 当前 Markdown 样式

---

## 9. 下一步行动

1. 确认本计划（特别是文件链接方案 A/B/C）。
2. 按阶段执行：先改普通文本样式，再改行内代码，最后改文件链接。
3. 运行 `npm run typecheck` 并手动验证。

---

*计划状态：待确认，未执行代码修改*
