import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// UI 2.0（#115 U2）：Streamdown 为唯一 markdown 引擎，内置能力交给官方插件。
// 2026-08 曾因内存移除 @streamdown/code（shiki 双主题 + 全语言 grammar 常驻），
// 2026-08 恢复：@streamdown/code 1.x 为 JS 引擎 + 按语言懒加载（不复现全语言常驻），
// 代码块不再包 details 折叠（Chrome 中文会露出默认「详情」disclosure）。
// 锚点：mermaid/math 由 @streamdown/* 插件接管；a 仍走 MarkdownLink
// （file:// 打开 + 系统浏览器）；Tailwind 已扫描 streamdown 类名保证控件样式完整。
const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const link = readFileSync("src/renderer/src/components/session/MarkdownLink.tsx", "utf8");
const linkCore = readFileSync("src/renderer/src/components/session/MarkdownLinkCore.ts", "utf8");
const tailwind = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
const main = readFileSync("src/renderer/src/main.tsx", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const surfacesCss = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

test("streamdown pipeline delegates to official plugins (code/mermaid/math) and keeps link override", () => {
  // 官方插件接管：代码高亮、mermaid、数学
  assert.match(stream, /import \{ code \} from "@streamdown\/code"/);
  assert.match(stream, /import \{ mermaid \} from "@streamdown\/mermaid"/);
  assert.match(stream, /import \{ createMathPlugin \} from "@streamdown\/math"/);
  // 数学插件开启单美元行内公式（singleDollarTextMath: true）：
  // AI 输出 $...$ 是常态，默认关闭会整句原样输出（2026-08 修复，防回归锚点）
  assert.match(stream, /createMathPlugin\(\{ singleDollarTextMath: true \}\)/);
  assert.match(stream, /plugins: \(effectiveLight/);
  assert.match(stream, /IncrementalMarkdownFrontier/);
  assert.match(stream, /FrozenMarkdownChunk/);
  assert.match(stream, /UNSTABLE_TAIL_BLOCKS/);
  assert.match(stream, /math: mathPlugin/);
  // 公式复制走事件委托浮层（FormulaCopyLayer）：rehype-katex 产物不进组件 map，
  // 旧 p 层拦截只能覆盖“单一行内公式独占一段”，已删除（2026-08 通用化）
  assert.match(stream, /<FormulaCopyLayer \/>/);
  assert.doesNotMatch(stream, /MathBlockParagraph/);
  // 非 light 分支注册 code 插件；light（更新日志等轻场景）保持无高亮
  assert.match(stream, /\bcode,\n/);
  // 不再用 details 折叠代码块（会露出浏览器默认「详情」）；行号沿用 streamdown 默认开启
  assert.doesNotMatch(stream, /collapseCodeBlocks/);
  assert.doesNotMatch(stream, /lineNumbers=\{false\}/);
  // 链接覆盖保留（file:// 打开 + 外链拦截是项目核心能力）
  assert.match(stream, /a: \(linkProps\) =>/);
  assert.match(stream, /MarkdownLink/);
  assert.match(stream, /remarkLinkifyPaths/);
  // 自定义 pre/span 覆盖移除：mermaid 由插件渲染、公式由 math 插件
  assert.doesNotMatch(stream, /pre: \(preProps\) => <CodeBlock/);
  assert.doesNotMatch(stream, /span: \(spanProps\) => <MathSpan/);
  // 流式也走 static：streaming 模式的 useTransition 会合并帧导致蹦字
  assert.match(stream, /mode="static"/);
  assert.doesNotMatch(stream, /mode=\{props\.isStreaming \? "streaming" : "static"\}/);
  // mermaid 主题跟随明暗
  assert.match(stream, /theme: isDark \? "dark" : "default"/);
});

test("streamdown chat prose density overrides official space-y-4 / heading scale", () => {
  // Streamdown 根节点 space-y-4、标题 text-3xl/mt-6 在 utilities 层，
  // 不在同层覆盖就会把会话正文撑成文档站密度。契约：覆盖必须挂 .markdown-body。
  const streamdownChrome = readFileSync("src/renderer/src/styles/streamdownChrome.css", "utf8");
  assert.match(
    streamdownChrome,
    /\.markdown-body :is\(\.space-y-4\) > :not\(:last-child\):not\(\[data-streamdown\^="heading-"\]\)/,
  );
  // 2026 排版优化（beui 流式观感）：段距 0.55em→0.7em、行高 1.5→1.6、列表/标题留白微增。
  assert.match(streamdownChrome, /margin-block-end:\s*0\.7em/);
  assert.match(
    streamdownChrome,
    /\.markdown-body :is\(\.space-y-4\) > \[data-streamdown\^="heading-"\]/,
  );
  assert.match(streamdownChrome, /\[data-streamdown="heading-1"\][\s\S]*?font-size:\s*1\.5em/);
  assert.match(streamdownChrome, /list-style-position:\s*outside/);
  const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
  assert.match(foundation, /--line-height-chat:\s*1\.6/);
  const timeline = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
  assert.match(timeline, /line-height:\s*var\(--line-height-chat\)/);
  assert.doesNotMatch(timeline, /line-height:\s*1\.68/);
});

test("streamdown code/table chrome uses faded action controls", () => {
  const streamdownChrome = readFileSync("src/renderer/src/styles/streamdownChrome.css", "utf8");
  assert.match(streamdownChrome, /\[data-streamdown="code-block-actions"\]/);
  assert.match(streamdownChrome, /opacity:\s*0\.5/);
  assert.match(streamdownChrome, /\[data-streamdown="code-block"\]:hover \[data-streamdown="code-block-actions"\]/);
  assert.match(streamdownChrome, /\[data-streamdown="code-block-copy-button"\][\s\S]*?order:\s*1/);
  assert.match(streamdownChrome, /\[data-streamdown="code-block-download-button"\][\s\S]*?order:\s*2/);
  // 表格与代码块同皮（utilities 层）
  assert.match(streamdownChrome, /\[data-streamdown="table-wrapper"\]:hover > div:first-child/);
  // 回归（表格复制/下载下拉菜单文字重叠）：顶栏按钮样式只命中触发器结构
  // （全屏=顶栏直接子级；复制/下载=div.relative 内直接子级），不能把菜单里的
  // 格式选项（Copy as Markdown/CSV/TSV）一起锁成 1.6rem 图标尺寸，否则三个
  // 菜单项挤在同一位置文字重叠。
  assert.match(
    streamdownChrome,
    /\[data-streamdown="table-wrapper"\] > div:first-child > div > button/,
  );
  assert.doesNotMatch(
    streamdownChrome,
    /\[data-streamdown="table-wrapper"\] > div:first-child button/,
  );
  // 顶栏整条 opacity 会建立层叠上下文，鼠标移出后打开的菜单被压到表格内容下面
  // （按 § 取行规则块再断言，避免 regex 越过块边界误伤按钮里的 opacity）
  const rowRuleStart = streamdownChrome.indexOf(
    '[data-streamdown="table-wrapper"] > div:first-child {',
  );
  const rowRuleBrace = streamdownChrome.indexOf("{", rowRuleStart);
  let depth = 0;
  let rowRuleEnd = rowRuleBrace;
  for (; rowRuleEnd < streamdownChrome.length; rowRuleEnd++) {
    if (streamdownChrome[rowRuleEnd] === "{") depth++;
    else if (streamdownChrome[rowRuleEnd] === "}") {
      depth--;
      if (depth === 0) {
        rowRuleEnd++;
        break;
      }
    }
  }
  const rowRule = streamdownChrome.slice(rowRuleStart, rowRuleEnd);
  assert.doesNotMatch(rowRule, /opacity:/);
  assert.doesNotMatch(surfacesCss, /\.sd-code-collapse\b/);
  assert.doesNotMatch(streamdownChrome, /\.sd-code-collapse\b/);
});

test("Tailwind scans streamdown + plugin classes; styles.css imports vendor streamdown layer", () => {
  assert.match(tailwind, /@source "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/streamdown\/dist\/\*\.js"/);
  // @streamdown/code 已恢复（JS 引擎懒加载高亮），继续扫描其类名
  assert.match(tailwind, /@source "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@streamdown\/code\/dist\/\*\.js"/);
  assert.match(tailwind, /@source "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@streamdown\/mermaid/);
  assert.match(tailwind, /@source "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@streamdown\/math/);
  // streamdown 经 styles.css layer(vendor) 引入，避免 unlayered 压过 surfaces 覆盖
  const stylesEntry = readFileSync("src/renderer/src/styles.css", "utf8");
  assert.match(stylesEntry, /@import\s+"streamdown\/styles\.css"\s+layer\(vendor\)/);
  assert.doesNotMatch(main, /import "streamdown\/styles\.css"/);
  // 高亮插件进 devDependencies（渲染层依赖随 vite 打包，与分支重构模式一致）
  assert.match(packageJson, /"@streamdown\/code"/);
  assert.match(packageJson, /"@streamdown\/mermaid"/);
  assert.match(packageJson, /"@streamdown\/math"/);
  // shiki 声明为直接依赖（beUI agents/file-diff 的 agent-code 高亮需要直接 import，
  // 此前由 @streamdown/code 传递引入，声明后不增加实际安装体积）；react-markdown 不可回归
  assert.match(packageJson, /"shiki"/);
  assert.doesNotMatch(packageJson, /"react-markdown"/);
});

test("link handling is the single shared implementation (no react-markdown import)", () => {
  // 单份实现：所有管线从共享模块 import，不允许本地重复定义
  assert.match(surface, /from "\.\/MarkdownStream"/);
  assert.doesNotMatch(surface, /function MarkdownLink\(/);
  assert.doesNotMatch(surface, /const remarkLinkifyPaths = /);
  assert.match(link, /export function MarkdownLink/);
  // 纯逻辑（remarkLinkifyPaths/FILE_PATH_RE/isLocalPathRef）在 MarkdownLinkCore.ts
  assert.match(linkCore, /export const remarkLinkifyPaths/);
  assert.match(linkCore, /export function isLocalPathRef/);
  assert.match(link, /from "\.\/MarkdownLinkCore"/);
  assert.match(linkCore, /export function markdownUrlTransform/);
  // 链接安全过滤已本地复刻，不再依赖 react-markdown 包
  assert.match(linkCore, /export function defaultUrlTransform/);
  assert.doesNotMatch(linkCore, /from "react-markdown"/);
});

test("Streamdown is the only markdown engine (switch, settings field, dependency removed)", () => {
  // AssistantText 无开关分流，直接渲染 MarkdownStream
  assert.doesNotMatch(surface, /useStreamdownRendererAtom/);
  assert.doesNotMatch(surface, /ReactMarkdown/);
  assert.doesNotMatch(surface, /from "react-markdown"/);
  assert.match(surface, /<MarkdownStream/);
});

test("markdown-bearing static scenes share the Streamdown engine", () => {
  const diffViewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
  const scratchPad = readFileSync("src/renderer/src/components/scratchPad/ScratchPadPanel.tsx", "utf8");
  assert.doesNotMatch(diffViewer, /ReactMarkdown/);
  assert.doesNotMatch(scratchPad, /ReactMarkdown/);
  assert.match(diffViewer, /MarkdownStream/);
  assert.match(scratchPad, /MarkdownStream/);
  // 更新迁移为状态卡片，不再展示任意 Release Markdown；它仍不得引入第二个 markdown 引擎。
  const updateCard = readFileSync("src/renderer/src/components/app/settings/AppUpdateCard.tsx", "utf8");
  assert.doesNotMatch(updateCard, /(?:ReactMarkdown|MarkdownStream)/);
  assert.match(updateCard, /<Progress/);
  // 静态场景保留各自插件（草稿本的高亮 mark 与 GFM task list 覆盖）
  assert.match(scratchPad, /rehypeHighlightMark/);
  assert.match(scratchPad, /remarkBreaks/);
});

test("streaming overlong guard: plain-text fallback above STREAM_LIGHT_MAX_CHARS", () => {
  const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
  const policy = readFileSync("src/renderer/src/components/session/markdownStreamPolicy.ts", "utf8");
  // 阈值常量迁到纯策略模块（行为单测见 markdownStreamPolicy.test.mjs），MarkdownStream 兼容再导出
  assert.match(policy, /export const STREAM_LIGHT_MAX_CHARS = 40_000/);
  assert.match(policy, /export const STREAM_UNFREEZABLE_MIN_CHARS = 8_000/);
  assert.match(policy, /export const SETTLE_FULL_MAX_CHARS = 150_000/);
  assert.match(stream, /export \{ STREAM_LIGHT_MAX_CHARS \} from "\.\/markdownStreamPolicy"/);
  // 回退节点：纯文本 + pre-wrap（排版由容器 markdown-body 接管）
  assert.match(stream, /streamPlain =\s*\n?\s*isStreamingNow && displayText\.length > STREAM_LIGHT_MAX_CHARS/);
  // 不可冻结（prefixEnd=0，未闭合围栏等）且超过小阈值：流式期间同样回退纯文本，
  // 避免每帧全量重渲染（大代码块流式输出时 GC 追不上、原生内存爬升）
  assert.match(stream, /frozenSplit !== undefined && frozenSplit\.prefixEnd === 0 && displayText\.length > STREAM_UNFREEZABLE_MIN_CHARS/);
  // settle 全量渲染上限：超大内容保持轻量插件（防逐 token 高亮留下 GB 级 DOM）
  assert.match(stream, /shouldKeepLightOnSettle\(props\.text\.length\)/);
  // 回退必须发生在 Streamdown 之外（不建解析树），且依赖链含 streamPlain
  assert.match(stream, /whitespace-pre-wrap break-words/);
  assert.match(stream, /if \(streamPlain\)/);
  assert.match(stream, /pipe, streamPlain/);
  // 超长兜底对思考同样生效（ThinkingBlock 走同一 MarkdownStream），无需额外开关
  const thinking = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
  assert.match(thinking, /<MarkdownStream/);
  // 流式轻渲染契约不回退：static 模式 + 流式精简插件仍是默认；
  // 精简插件必须是模块级稳定引用（NO_STREAM_*），不能内联 []——
  // 否则 pipe 每帧重建，冻结 prefix chunk 的 memo 失效，每帧全量重解析
  assert.match(stream, /mode="static"/);
  assert.match(stream, /resolvedRemarkPlugins = isStreamingNow\s*\n\s*\?\s*NO_STREAM_REMARK_PLUGINS/);
  assert.match(stream, /resolvedRehypePlugins = isStreamingNow\s*\n\s*\?\s*NO_STREAM_REHYPE_PLUGINS/);
  assert.doesNotMatch(stream, /isStreamingNow\s*\?\s*\[\]/);
});

test("settle full render is deferred to idle (no long task during interaction)", () => {
	const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
	// settle 全量渲染（元素树+高亮，实测 70-100ms 长任务）必须延迟到浏览器空闲，
	// 避免在用户滚动/交互期间卡帧造成滚动跳动
	assert.match(stream, /wasStreamingRef = useRef\(false\)/);
	assert.match(stream, /requestIdleCallback\(schedule, \{ timeout: 1500 \}\)/);
	// 静态场景（从未流式，如 FileDiffViewer）不得延迟：立即全量
	assert.match(stream, /if \(!wasStreamingRef\.current\) \{\s*\n\s*\/\/ 静态场景/);
	assert.match(stream, /setSettleFull\(true\);\s*\n\s*return;/);
	// settle 等待期保持轻量渲染（effectiveLight 含 !settleFull），并继续走冻结渲染
	assert.match(stream, /const effectiveLight = props\.light \|\| isStreamingNow \|\| !settleFull/);
	assert.match(stream, /const usingFrozen = isStreamingNow \|\| !settleFull/);
	assert.match(stream, /if \(!usingFrozen\) frontierRef\.current\.reset\(\)/);
});

test("AnswerOutput live path renders through MarkdownStream (no dual typewriter)", () => {
  const answer = readFileSync("src/renderer/src/components/session/AnswerOutput.tsx", "utf8");
  // live 分支把打字机/超长兜底委托给 MarkdownStream，不自持 useSmoothStream
  assert.match(answer, /<MarkdownStream/);
  assert.doesNotMatch(answer, /from "\.\.\/\.\.\/utils\/useSmoothStream"/);
  // live 容器保留 e2e typewriter 选择器锚点
  assert.match(answer, /execution-interim markdown-body/);
  assert.match(answer, /data-is-streaming=\{props\.isStreaming \? "1" : "0"\}/);
});
