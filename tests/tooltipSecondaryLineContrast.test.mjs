import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 回归：会话 Tab 悬停 Tooltip 里第二行「工作区 · 目录/路径」在明暗主题下都看不清
 * （用户反馈「移入后 title 和下面的目录、路径是黑色的看不清」）。
 *
 * 根因是 token 用错了面：ui-shadcn/tooltip.tsx 的 TooltipContent 是**反色面**
 * （bg-foreground + text-background）——浅色主题下近黑底（--color-text-primary #202124）、
 * 暗色主题下近白底（#ecece7）。在反色面上写 `text-muted-foreground`
 * （= --color-text-secondary：#4b5563 / #b8b8b2）等于拿「页面次要文字色」画反色面：
 *   - 浅色：#4b5563 on #202124 ≈ 2.0:1
 *   - 暗色：#b8b8b2 on #ecece7 ≈ 1.6:1
 * 两者都远低于 WCAG AA 4.5:1。正确写法是从反色面前景 token 派生：`text-background/75`
 * （与首行 text-background 同族，只降低不透明度），两种主题下都保持可读。
 *
 * 例外：SurfaceComponents 的 ctx-detail-tooltip 用 `!bg-popover !text-popover-foreground`
 * 把面换成了普通面板，那里的 text-muted-foreground 属于面板语义，合法（见下方 surfaceOverridden）。
 */

const RENDERER_SRC = "src/renderer/src";
const TABS_BAR = `${RENDERER_SRC}/components/session/SessionTabsBar.tsx`;

/** 递归收集渲染层源码文件（跳过 i18n 文案目录）。 */
function rendererSources(dir = RENDERER_SRC) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (full.includes("i18n")) continue;
			files.push(...rendererSources(full));
		} else if (/\.tsx?$/.test(full)) {
			files.push({ name: full.replace(/\\/g, "/"), source: readFileSync(full, "utf8") });
		}
	}
	return files;
}

/**
 * 抽出所有 TooltipContent 区块（含开标签，便于判断该块是否自行换掉了反色面）。
 * 非贪婪 + 允许任意空白，格式化变更不会让断言失效；`ChartTooltipContent` 这类
 * 更长的组件名不会被 `<TooltipContent\b` 命中。
 */
function tooltipBlocks(source) {
	return [...source.matchAll(/<TooltipContent\b[\s\S]*?<\/TooltipContent>/g)].map((match) => match[0]);
}

/**
 * 去掉块内 JSX 注释再断言：注释里可能为了说明问题而引用被禁 token 名（例如
 * `text-muted-foreground`），断言只应针对真正生效的 className。
 */
function stripJsxComments(block) {
	return block.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/** 反色面上会与底色同值/近似同值的「页面文字色」token。 */
const PAGE_TEXT_TOKENS = ["text-foreground", "text-muted-foreground", "text-text-secondary", "text-text-primary"];

test("Tooltip 反色面上不得使用页面文字色 token", () => {
	const offenders = [];
	for (const { name, source } of rendererSources()) {
		for (const block of tooltipBlocks(source)) {
			const code = stripJsxComments(block);
			// 该块把面换成了普通面板（popover）时，块内回归面板 token 语义。
			if (code.includes("!bg-popover")) continue;
			for (const token of PAGE_TEXT_TOKENS) {
				if (code.includes(token)) offenders.push(`${name}: ${token}`);
			}
		}
	}
	assert.deepEqual(offenders, [], `TooltipContent 反色面上出现页面文字色（会与近黑/近白底撞色）：\n${offenders.join("\n")}`);
});

test("会话 Tab 悬停提示的第二行（工作区目录/路径）用反色面前景派生色", () => {
	const tabsBar = readFileSync(TABS_BAR, "utf8");
	const blocks = tooltipBlocks(tabsBar);
	// 默认标签模式的 SessionTab、简洁模式的 SessionTab、以及文件 Tab，共三处悬停提示。
	assert.equal(blocks.length, 3, "SessionTabsBar 应保留 默认/简洁会话 Tab 与 文件 Tab 三处悬停提示");

	for (const block of blocks) {
		const code = stripJsxComments(block);
		// 反色面前景派生：text-background/NN（首行继承 text-background，次行降透明度保持次要层级）。
		assert.match(code, /text-background\/\d+/, `提示第二行应使用 text-background/NN 派生色：${block}`);
		assert.doesNotMatch(code, /text-muted-foreground/, `提示内不得用页面次要文字色：${block}`);
	}
});

test("会话 Tab 悬停提示保留两行结构（标题 + 目录/路径）", () => {
	const tabsBar = readFileSync(TABS_BAR, "utf8");
	const blocks = tooltipBlocks(tabsBar);
	// 首行标题（font-medium，继承反色面前景色）与次行路径都必须存在，避免改动中丢掉路径行。
	for (const block of blocks) {
		assert.match(block, /font-medium/, `提示首行应保留标题字重：${block}`);
		assert.match(block, /text-\[11px\]/, `提示次行应保留 11px 次要字号：${block}`);
	}
});
