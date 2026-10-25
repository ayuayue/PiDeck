import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tailwindCss = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
const foundationCss = readFileSync("src/renderer/src/styles/foundation.css", "utf8");

/**
 * 壁纸模式磨砂块透明化契约（#issue：按钮/卡片磨砂灰白补丁）。
 *
 * 机制分两类：
 * - utilities 层透明化：元素背景来自 utility（bg-background/80、bg-card、bg-muted/60、
 *   bg-bg-panel），必须放 @layer utilities 才能压过（层序 legacy < utilities），
 *   放 legacy 层 = 规则静默失效；
 * - legacy 层透明化：元素背景直接写在 legacy class（project-avatar），放 legacy 层
 *   并用 data-bg-image 提高特异性即可，且要保证选中态（active accent 高亮）不被误杀。
 */

/** 提取所有 @layer utilities { ... } 块的内容 */
function utilitiesCss() {
	const blocks = [];
	const re = /@layer\s+utilities\s*\{([\s\S]*?)\}/g;
	let m;
	while ((m = re.exec(tailwindCss)) !== null) blocks.push(m[1]);
	return blocks.join("\n");
}

/** 判断某选择器在 utilities 层内是否被设为 background: transparent */
function isTransparentInUtilities(selector) {
	const u = utilitiesCss();
	const needle = `:root[data-bg-image="on"] ${selector}`;
	const idx = u.indexOf(needle);
	if (idx === -1) return false;
	const open = u.indexOf("{", idx);
	if (open === -1) return false;
	// 块内容不含闭合 }，取到块尾（无 } 时）或到下一个 }
	const end = u.indexOf("}", open);
	const body = end === -1 ? u.slice(open + 1) : u.slice(open + 1, end);
	return /background:\s*transparent/.test(body);
}

test("wallpaper chrome + content blocks become transparent in utilities layer", () => {
	// chrome 小块（tab 栏/标题/抽屉 tab 栏/窗口控制条）+ 内容层磨砂块（输入框/用户气泡/工具卡片）
	const targets = [".session-tabs-bar", ".chat-header", ".drawer-activity-rail", ".window-controls", ".composer-box", ".user-turn-bubble", ".tool-card"];
	for (const sel of targets) {
		assert.ok(isTransparentInUtilities(sel), `${sel} must be gated by :root[data-bg-image="on"] and set background: transparent in @layer utilities`);
	}
});

test("project-avatar becomes transparent in legacy layer without a parent selected tint", () => {
	// 文件夹图标底：legacy 层 data-bg-image 透明化
	assert.match(foundationCss, /:root\[data-bg-image="on"\] \.project-avatar\s*\{\s*background:\s*transparent;/, "project-avatar must be transparent under wallpaper mode");
	// 父项目不再有选中 accent：dsh-web 只给叶子会话灰底。
	assert.doesNotMatch(foundationCss, /\.project-group\s*>\s*\.conversation\.active:first-child\s+\.project-avatar/);
});

test("transparency rules live only in the intended layer", () => {
	// utilities 层选择器不得在 utilities 层外（legacy）重复声明 transparent
	const outside = tailwindCss.replace(/@layer\s+utilities\s*\{[\s\S]*?\}/g, "");
	for (const sel of [".session-tabs-bar", ".chat-header", ".drawer-activity-rail", ".window-controls", ".composer-box", ".user-turn-bubble", ".tool-card"]) {
		const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		assert.doesNotMatch(outside, new RegExp(`${esc}[\\s\\S]{0,200}background:\\s*transparent`), `${sel} transparency must not be declared outside utilities layer`);
	}
});

test("floating layers (ctx-detail / copy-menu) drop to panel alpha under wallpaper", () => {
	// 上下文详情 tooltip 与消息复制菜单默认 92% 底色（floatingMix），图片背景上像磨砂卡片；
	// 壁纸模式下应降回面板档（--wallpaper-panel-alpha），与 widget-popover 同档。
	// 两个选择器合并为一条规则（逗号分隔共用规则体）。
	const rule = foundationCss.match(/:root\[data-bg-image="on"\] \.ctx-detail-tooltip,[\s\S]*?\.copy-menu-popover\s*\{([^}]*)\}/);
	assert.ok(rule, "ctx-detail-tooltip + copy-menu-popover floating-layer rule must exist");
	assert.match(rule[1], /--color-bg-popover:[^;]*var\(--wallpaper-panel-alpha,\s*30%\)/, "floating layers must drop --color-bg-popover to panel alpha");
});

test("workbench dialogs flatten inner bg layers to avoid double-white", () => {
	// config/settings 等工作台弹框：弹窗自身已有 panel-alpha 底色，内部卡片/列表项
	// 再叠 bg-panel/muted 会形成 ≈51% 双层白（磨砂补丁）；默认态应透明化透出弹窗底色。
	const block = foundationCss.match(/:root\[data-bg-image="on"\] \[data-slot="dialog-content"\]\.config-modal,[\s\S]*?\{[\s\S]*?\}/);
	assert.ok(block, "config-modal wallpaper rule must exist");
	const body = block[0];
	assert.match(body, /--color-bg-panel:\s*transparent/, "bg-panel must flatten to transparent");
	assert.match(body, /--color-card:\s*transparent/, "card must flatten to transparent");
	assert.match(body, /--color-bg-muted:\s*transparent/, "muted must flatten to transparent");
	// hover/active/输入框仍保留底色（交互反馈与边界）
	assert.doesNotMatch(body, /--color-bg-hover:\s*transparent/, "hover must keep its background");
	assert.doesNotMatch(body, /--color-bg-input:\s*transparent/, "input must keep its background");
});
