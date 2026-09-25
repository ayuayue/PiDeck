import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 低成本体验包（借鉴 Vercel AI Elements）：
 * 1. Shimmer 微光文本——RespondingIndicator 进行态标签用渐变扫光提示活动进行中；
 * 2. 思考耗时人性化——ThinkingBlock 展示「思考了 Xs / Thought for Xs」，不再裸显工程化数字。
 */

const shimmerSource = readFileSync("src/renderer/src/components/session/ShimmerText.tsx", "utf8");
const cardsSource = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
const webTimeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("ShimmerText 零依赖 CSS 实现：bg-clip-text + Tailwind 动画，不新增手写 CSS class", () => {
	assert.match(shimmerSource, /export function ShimmerText/);
	assert.match(shimmerSource, /bg-clip-text text-transparent/);
	// 动画走 Tailwind 工具类 + motion-safe（reduced-motion 退化为静态文本）
	assert.match(shimmerSource, /motion-safe:animate-\[shimmer-sweep/);
	// 明暗取语义 token，暗色模式自适应
	assert.match(shimmerSource, /--color-text-tertiary/);
	assert.match(shimmerSource, /--color-text-primary/);
	assert.match(shimmerSource, /--color-warning/);
	// 不引第三方动画库（零依赖约束）
	assert.doesNotMatch(shimmerSource, /from "(framer-motion|motion|gsap)/);
});

test("shimmer-sweep keyframes 定义在 timeline.css（规则允许 keyframes）", () => {
	assert.match(timelineCss, /@keyframes shimmer-sweep/);
});

test("RespondingIndicator 使用 beUI ReasoningText（swap）轮播状态短语", () => {
	// 短语组常量与函数体分开截取（中间隔着 export type）
	const phrasesStart = cardsSource.indexOf("const RESPONDING_PHRASES");
	const phrases = cardsSource.slice(phrasesStart, cardsSource.indexOf("\n};", phrasesStart) + 3);
	const fnStart = cardsSource.indexOf("export function RespondingIndicator");
	const fn = cardsSource.slice(fnStart, cardsSource.indexOf("\nexport ", fnStart + 10) || undefined);
	assert.ok(fn, "RespondingIndicator must exist");
	// 五种状态各有 i18n 短语组（compacting/waiting 单条 = 不轮播）
	assert.match(phrases, /agent\.loading\.starting1/);
	assert.match(phrases, /agent\.loading\.executing1/);
	assert.match(phrases, /agent\.loading\.responding1/);
	assert.match(phrases, /agent\.loading\.compacting/);
	assert.match(phrases, /agent\.loading\.waiting/);
	// 组件使用 beUI ReasoningText + swap 变体；状态切换 key 重建从第一条重新轮播
	assert.match(fn, /ReasoningText/);
	assert.match(fn, /variant="swap"/);
	assert.match(fn, /key=\{kind\}/);
	// 状态判定抽到 deriveRespondingKind（pi / DSH 共用），组件只接线
	assert.match(fn, /deriveRespondingKind/);
	assert.match(fn, /liveTextStreaming/);
	assert.match(fn, /liveThinkingStreaming/);
});

test("RespondingIndicator 短语文案中英同步", () => {
	// 只列状态条真正会渲染的 key。executing2/3、responding2 已随「猜测轮播」下线，
	// 不再断言它们存在（key 仍保留在 i18n，删掉会制造两个大文件的无效 diff）。
	for (const suffix of ["starting1", "starting2", "starting3", "executing1", "responding1", "responding3", "compacting", "waiting"]) {
		const key = `agent.loading.${suffix}`;
		assert.match(zhCN, new RegExp(`"${key}":`));
		assert.match(enUS, new RegExp(`"${key}":`));
	}
});

test("状态条只在观测不到子阶段的 starting 轮播，其余状态单条不轮播", () => {
	// 轮播每 1.8s 换一句与后台无关的猜测文案（思考中 → 组织回答 → 撰写回复），
	// 用户反馈「经常轮询展示、不能真实反映后台」。契约：只有 starting 允许多条。
	const start = cardsSource.indexOf("const RESPONDING_PHRASES");
	const table = cardsSource.slice(start, cardsSource.indexOf("\n};", start) + 3);
	const multi = [...table.matchAll(/^\s*(\w+):\s*\[([^\]]*)\],/gm)].filter(([, , body]) => body.split("t(").length - 1 > 1).map(([, kind]) => kind);
	assert.deepEqual(multi, ["starting"], "只有 starting 可以轮播；其余状态必须单条，否则文案会与后台脱节");
	// 已下线的猜测短语不得回到表里
	assert.doesNotMatch(table, /executing2|executing3|responding2/);
	// 思考与正文是两个独立条目，各自对应真实阶段
	assert.match(table, /thinking:\s*\[t\("agent\.loading\.responding1"\)\]/);
	assert.match(table, /responding:\s*\[t\("agent\.loading\.responding3"\)\]/);
});

test("ThinkingBlock 耗时改人性化 i18n 文案，不再裸显数字", () => {
	const block = cardsSource.match(/function ThinkingBlock[\s\S]*?\n\t\},\n/)?.[0] ?? "";
	assert.ok(block, "ThinkingBlock must exist");
	assert.match(block, /thinking\.duration/);
	// 耗时仍由 startedAt/endedAt 计算（c73f05c7 重构后变量名 durationMs → durationText）
	assert.match(block, /formatDuration\(props\.endedAt - props\.startedAt\)/);
});

test("thinking.duration 文案中英同步", () => {
	assert.match(zhCN, /"thinking\.duration": "思考了 \{duration\}"/);
	assert.match(enUS, /"thinking\.duration": "Thought for \{duration\}"/);
});

test("ThinkingBlock 折叠态把耗时和预览放在同一行，流式默认单行打字机", () => {
	const block = cardsSource.match(/function ThinkingBlock[\s\S]*?\n\t\},\n/)?.[0] ?? "";
	assert.ok(block, "ThinkingBlock must exist");
	// 对齐 dsh-web：默认永远收起；流式不 setExpanded(true)，点开才展开正文
	assert.match(block, /useState\(props\.defaultExpanded \?\? false\)/);
	assert.doesNotMatch(block, /defaultExpanded \?\? Boolean\(props\.isStreaming\)/);
	assert.doesNotMatch(block, /if \(props\.isStreaming\) setExpanded\(true\)/);
	assert.doesNotMatch(block, /if \(props\.endedAt\)/);
	// 折叠预览吃打字机输出 + 尾部跟随（一行跑马灯）；展开正文走 MarkdownStream 自己的打字机
	assert.match(block, /disabled: !props\.isStreaming,/);
	assert.match(block, /<SingleLinePreview[\s\S]*text=\{displayedContent\}/);
	assert.match(block, /<MarkdownStream[\s\S]*text=\{props\.text\}/);
	assert.match(block, /!expanded && \(?/);
	assert.match(block, /<SingleLinePreview/);
	assert.match(block, /showSweep=\{false\}/);
	assert.match(block, /<ChevronRight/);
	assert.doesNotMatch(block, /border-dashed/);
});

test("WebThinkingBlock stays collapsed by default and does not auto-expand while streaming", () => {
	const block = webTimeline.match(/function WebThinkingBlock[\s\S]*?^\}\);/m)?.[0] ?? "";
	assert.ok(block, "WebThinkingBlock must exist");
	assert.match(block, /useState\(false\)/);
	assert.doesNotMatch(block, /Boolean\(props\.running\)/);
	assert.doesNotMatch(block, /if \(props\.running\) setExpanded\(true\)/);
	assert.match(block, /<SingleLinePreview/);
});

test("thinking Brain logo uses thinking-row-icon instead of gray text utilities", () => {
	const block = cardsSource.match(/function ThinkingBlock[\s\S]*?\n\t\},\n/)?.[0] ?? "";
	assert.ok(block, "ThinkingBlock must exist");
	assert.match(block, /<Brain size=\{16\} className="thinking-row-icon shrink-0"/);
	assert.doesNotMatch(block, /<Brain[^>]*text-text-secondary/);
});

test("thinking markdown is one size smaller than chat body", () => {
	assert.match(timelineCss, /\[data-marker-kind="thinking"\] \.markdown-body[\s\S]*?font-size:\s*var\(--font-size-control\)/);
	assert.doesNotMatch(timelineCss, /\[data-marker-kind="thinking"\] \.markdown-body[\s\S]*?font-size:\s*var\(--font-size-chat\)/);
});

test("interim answers share chat body size; process variant only adds gap from tool/thinking rows", () => {
	assert.match(timelineCss, /\.execution-interim \{[\s\S]*?font-size:\s*var\(--font-size-chat\)/);
	assert.doesNotMatch(timelineCss, /\.execution-interim\[data-variant="process"\]/);
	const answer = readFileSync("src/renderer/src/components/session/AnswerOutput.tsx", "utf8");
	assert.match(answer, /execution-interim markdown-body my-3 text-chat/);
	assert.match(answer, /execution-interim markdown-body text-chat text-text-primary/);
	assert.doesNotMatch(answer, /mt-3 text-chat/);
});
