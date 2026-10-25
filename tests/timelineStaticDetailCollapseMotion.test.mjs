import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 时间线静态详情卡的折叠动画契约（2026-10 motion 体验优化，第四批）。
 *
 * 背景：这些卡片原本是 `{expanded && <div className="… motion-safe:animate-in motion-safe:fade-in">}`
 * 或 `{expanded ? <div>…</div> : null}`——展开只有淡入或什么都没有，高度 0 → 实测值硬跳，
 * 会把下方内容瞬间顶下去；收起直接卸载无过渡。
 *
 * 它们与流式卡片（ToolCallComponents / TimelineEventCards / ProcessGroupStep）的区别：
 * 展开的都是**定稿文本**（错误原文 / 重试原因 / 通知正文 / 扩展条目载荷 / 泄漏协议 XML），
 * 展开期间高度不再逐帧变化，可以安全走共享折叠原语（Radix Collapsible + tw-animate-css
 * collapsible-down/up：真高度渐变、Presence 等 exit 动画播完再卸载、reduced-motion 自动回退）。
 *
 * 落地形态：卡片根（<article>/<section>/<div>）保留原语义与 data-* 契约，内部加
 * `className="contents"` 的 Collapsible 根（不生成盒子，折叠态零空档）+ CollapsibleContent
 * 承载原样式类（border-t / px / py 等留在折叠体本身）。
 *
 * 共同硬约束：详情体不得再挂 motion-safe:animate-in / fade-in —— cn 走 twMerge，
 * animate-* 判同组，自绘入场会静默盖掉原语的高度动画。
 *
 * 正则一律空白容忍（\s*），格式化不应打红本契约。
 */

const read = (path) => readFileSync(`src/renderer/src/${path}`, "utf8");

/** 静态详情卡：内容定稿、展开期高度稳定，统一走折叠原语。 */
const CARDS = ["components/session/turn/ErrorStep.tsx", "components/session/turn/RetryStep.tsx", "components/session/RawToolCallFallback.tsx", "components/session/NotifyMessageCard.tsx", "components/session/ExtensionEntryCard.tsx", "components/session/turn/ExtensionEntryStep.tsx"];

for (const path of CARDS) {
	test(`${path} 详情折叠走共享折叠原语`, () => {
		const source = read(path);
		assert.match(source, /import \{\s*Collapsible,\s*CollapsibleContent\s*\}\s*from "[^"]*ui-shadcn\/collapsible"/, "必须引入共享折叠原语，不自绘开合");
		// 根必须受控：open 由卡片本地 expanded 驱动；contents 不生成盒子，折叠态零空档
		assert.match(source, /<Collapsible\s+open=\{expanded\}\s+className="contents">/, "折叠根必须受控且不生成盒子");
		assert.match(source, /<CollapsibleContent/, "详情体必须包在 CollapsibleContent 里");
	});

	test(`${path} 不复活瞬时挂载与自绘入场动画`, () => {
		const source = read(path);
		// 详情块本体不得回退条件挂载（chevron 三元不在禁令内：\s*\( 只拦详情块形态）
		assert.doesNotMatch(source, /\{expanded\s*(\?|&&)\s*\(/, "详情体必须常驻 CollapsibleContent 受控开合，不得回退条件挂载");
		assert.doesNotMatch(source, /motion-safe:animate-in/, "自绘 animate-in 会经 twMerge 盖掉 animate-collapsible-down");
	});
}

test("RawToolCallFallback 保留纯 <pre> 渲染契约（不走 markdown）", () => {
	const source = read("components/session/RawToolCallFallback.tsx");
	assert.match(source, /<pre className=/, "leakedToolCallFallback 契约：原文必须纯 pre 渲染");
	assert.doesNotMatch(source, /from "\.\.?\/MarkdownStream"/);
});

test("ErrorStep / RetryStep 保留行语言契约（tool-card 与 aria-expanded）", () => {
	for (const path of ["components/session/turn/ErrorStep.tsx", "components/session/turn/RetryStep.tsx"]) {
		const source = read(path);
		assert.match(source, /tool-card w-full min-w-0 tone-/, "timelineFailureToast 契约：过程行必须复用工具行语言");
		assert.match(source, /aria-expanded=\{expanded\}/, "整行可点展开的可访问性承诺不得顺手删");
	}
});

/**
 * 流式内容卡片刻意不迁移：工具输出 / 思考正文在展开期间仍随流式逐帧长高，
 * 折叠原语的高度测量（ResizeObserver）会被逐帧触发，抖动外层过程面板——
 * 与 config 批次对 ProcessGroupStep 的取舍同源（见 configDisclosureCollapseMotion）。
 */
const STREAMING = ["components/session/ToolCallComponents.tsx", "components/session/TimelineEventCards.tsx", "components/session/turn/ProcessGroupStep.tsx"];

for (const path of STREAMING) {
	test(`${path} 流式折叠体刻意不迁折叠原语`, () => {
		const source = read(path);
		assert.doesNotMatch(source, /ui-shadcn\/collapsible/, "流式内容保持条件挂载 + 淡入：折叠原语的逐帧高度测量会抖动外层面板");
	});
}
