import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
const mentionChip = readFileSync("src/renderer/src/components/session/composer/tiptap/mentionChip.ts", "utf8");
const surfaceComponents = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");

/**
 * chip 视觉契约（2026-09 对齐 Proma rich-text-input.tsx 的内联 <style>）：
 * 类型色浅底 + 同色文字 + 12px currentColor 图标，无边框、4px 圆角、13px/500、
 * gap 2px、baseline 对齐。改动这套骨架等于改动全站引用 chip 的长相。
 */
test("inline chips follow the Proma skeleton (tinted, borderless, compact)", () => {
	const baseRule = timelineCss.match(/\.composer \.input-chip,\s*\.user-turn-text \.input-chip\s*\{([\s\S]*?)\}/)?.[1] ?? "";
	for (const prop of [
		"display: inline-flex",
		"align-items: center",
		"gap: 2px",
		"padding: 1px 4px 1px 2px",
		"border: none",
		"border-radius: var(--radius-xs)",
		"font-size: var(--font-size-control)",
		"font-weight: 500",
		"white-space: nowrap",
		"vertical-align: baseline",
		"max-width: min(100%, 280px)",
		"overflow: hidden",
	]) {
		assert.ok(baseRule.includes(prop), `shared chip rule must contain "${prop}", got: ${baseRule}`);
	}
	// 图标 12px + inline（不再单独染色，颜色继承文字色）
	const iconRule = timelineCss.match(/\.composer \.input-chip__icon,\s*\.user-turn-text \.input-chip__icon\s*\{([\s\S]*?)\}/)?.[1] ?? "";
	for (const prop of ["display: inline-block", "width: 12px", "height: 12px"]) {
		assert.ok(iconRule.includes(prop), `chip icon rule must contain "${prop}"`);
	}
	// 四类引用各自「底色 + 文字色同源」（Proma bg-primary/10 text-primary 的做法）
	for (const kind of ["file", "skill", "session", "quote"]) {
		const twoScope = timelineCss.match(new RegExp(`\\.composer \\.input-chip--${kind},\\s*\\.user-turn-text \\.input-chip--${kind}\\s*\\{([\\s\\S]*?)\\}`))?.[1];
		const quoteScope = timelineCss.match(new RegExp(`\\.composer \\.input-chip\\.input-chip--${kind}[\\s\\S]*?\\{([\\s\\S]*?)\\}`))?.[1];
		const rule = twoScope ?? quoteScope ?? "";
		assert.ok(rule.includes("background:"), `${kind} chip must set a tinted background`);
		assert.ok(rule.includes("color:"), `${kind} chip must tint its text and icon`);
	}
	// 标签单行省略
	const labelRule = timelineCss.match(/\.composer \.input-chip__label,\s*\.user-turn-text \.input-chip__label\s*\{([\s\S]*?)\}/)?.[1] ?? "";
	for (const prop of ["min-width: 0", "overflow: hidden", "text-overflow: ellipsis"]) {
		assert.ok(labelRule.includes(prop), `chip label rule must contain "${prop}"`);
	}
	// 渲染端 class 拼接与样式选择器保持同名（input-chip--quote）
	assert.match(mentionChip, /input-chip--\$\{kind\}|input-chip--quote/);
});

/**
 * 气泡顺序契约（回归）：引用 chip 必须按原文顺序与各自描述相邻渲染。
 * 曾按 Proma 把引用全部提到正文上方，导致「引用A 描述A 引用B 描述B」被打乱成
 * 「引用A 引用B 描述A 描述B」（发送给模型的文本顺序其实是对的，只有展示层错乱）。
 */
test("bubble renders chips in original order, never lifted above the text", () => {
	assert.match(surfaceComponents, /buildBubbleRefSegments\(cleanText\)/);
	// 第二参已改为展开 props（含 onFileContextMenu 等菜单接线）：只锚定首参不变
	assert.match(surfaceComponents, /renderBubbleSegments\(bubbleSegments,/);
	// 不能再出现「引用单独一行提前」的布局
	assert.doesNotMatch(surfaceComponents, /buildBubbleRefLayout|bubbleLayout\.quotes/);
});

/**
 * 回归（用户实测截图）：气泡 chip 曾退化成「图标独占一行 + 标签第二行 + 每个 chip 各占一行」。
 * 两个必须同时守住的约束：
 * 1) 气泡文本容器挂 user-turn-text —— timeline.css 的 `.user-turn-text .input-chip*`
 *    全靠它生效；漏掉时 chip 没有任何 chip 外观（历史遗留死选择器就是这么来的）。
 * 2) chip 图标 svg 显式 inline-block —— Tailwind preflight 的 `svg { display: block }`
 *    会把图标撑成整行，把 chip 拆成两行。
 */
test("bubble chips opt into the user-turn-text scope and keep icons inline", () => {
	assert.match(surfaceComponents, /user-turn-text[^`]*whitespace-pre-wrap/, "bubble text container must carry user-turn-text (the chip style scope anchor)");
	const iconUsages = surfaceComponents.match(/className="input-chip__icon[^"]*"/g) ?? [];
	assert.ok(iconUsages.length >= 2, `expected chip icons in both bubble render paths, found ${iconUsages.length}`);
	for (const usage of iconUsages) {
		assert.ok(usage.includes("inline-block"), `chip icon must stay inline against preflight's svg{display:block}, got: ${usage}`);
	}
});
