import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 主次分明守卫（2026-10 对齐 ZCode 排版）：左右两侧 chrome 与正文面板必须有底色层次。
 *
 * - 经典浅色：sidebar 极浅灰退一档，正文面板保持纯白（白卡浮在 chrome 上）。
 * - 经典暗色：方向相反，sidebar 更暗、正文面板更亮。
 * - 右抽屉 .detail-drawer 必须与左侧栏共用 --color-bg-sidebar，两侧 chrome 对称。
 * - 暗色浮层阶梯：popover 必须比 panel 亮一档（含皮肤继承链），菜单不能像「暗洞」。
 *
 * 皮肤（fresh-green 等）自带更深分层，不在本测试断言范围。
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const foundation = readFileSync(path.join(root, "src/renderer/src/styles/foundation.css"), "utf8");
const timeline = readFileSync(path.join(root, "src/renderer/src/styles/timeline.css"), "utf8");

function tokenFrom(block, name) {
	return block.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
}

function rootBlock() {
	return foundation.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
}

function darkBlock() {
	return foundation.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
}

test("classic light keeps sidebar recessed below the pure-white content panel", () => {
	const block = rootBlock();
	const sidebar = tokenFrom(block, "color-bg-sidebar");
	const panel = tokenFrom(block, "color-bg-panel");
	assert.ok(sidebar, "浅色 --color-bg-sidebar 必须存在");
	assert.equal(panel, "#ffffff", "浅色正文面板必须保持纯白（内容浮在 chrome 之上）");
	assert.notEqual(sidebar, panel, "浅色侧栏必须与正文面板拉开底色层次");
});

test("classic dark keeps sidebar darker than the content panel", () => {
	const block = darkBlock();
	const sidebar = tokenFrom(block, "color-bg-sidebar");
	const panel = tokenFrom(block, "color-bg-panel");
	assert.ok(sidebar && panel, "暗色 sidebar/panel token 必须存在");
	assert.notEqual(sidebar, panel, "暗色侧栏必须与正文面板拉开底色层次");
});

test("right drawer shares the sidebar chrome tone", () => {
	const rule = timeline.match(/(?:^|\n)\.detail-drawer \{([\s\S]*?)\n\}/)?.[1] ?? "";
	assert.match(rule, /background:\s*var\(--color-bg-sidebar\)/, ".detail-drawer 底色必须走 --color-bg-sidebar（与左栏同档 chrome）");
});

/* ===== 暗色浮层阶梯守卫（2026-10 对齐 ZCode 深度阶梯） ===== */

function hexToRgb(hex) {
	let h = hex.slice(1);
	if (h.length === 3)
		h = h
			.split("")
			.map((c) => c + c)
			.join("");
	return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
}

function luminance(rgb) {
	const [r, g, b] = rgb.map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function tokensOf(block) {
	const map = new Map();
	for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) map.set(m[1], m[2].trim());
	return map;
}

/** 解析浮层 token：支持 hex、var() 引用、color-mix(in srgb, var(--x) N%, white) 相对派生。 */
function resolveSurface(tokens, name) {
	const raw = tokens.get(name);
	if (!raw) throw new Error(`token missing: --${name}`);
	const mix = raw.match(/^color-mix\(in (?:srgb|oklab),\s*var\(--([a-z0-9-]+)\)\s*([\d.]+)%,\s*(#[0-9a-fA-F]{3,8}|white|black)\)$/);
	if (mix) {
		const base = resolveSurface(tokens, mix[1]);
		const tint = mix[3] === "white" ? [255, 255, 255] : mix[3] === "black" ? [0, 0, 0] : hexToRgb(mix[3]);
		const alpha = Number(mix[2]) / 100;
		return base.map((c, i) => Math.round(c * alpha + tint[i] * (1 - alpha)));
	}
	const varRef = raw.match(/^var\(\s*--([a-z0-9-]+)\s*\)$/);
	if (varRef) return resolveSurface(tokens, varRef[1]);
	if (/^#[0-9a-fA-F]{3,8}$/.test(raw)) return hexToRgb(raw);
	throw new Error(`unsupported surface form: ${raw}`);
}

function skinDarkBlock(skin) {
	// 普通字符串拼接（模板字面量会把 \[ \s 等转义折叠掉，正则就坏了）
	const pattern = ':root\\[data-theme="dark"\\]\\[data-appearance="' + skin + '"\\] \\{([\\s\\S]*?)\\n\\}';
	return foundation.match(new RegExp(pattern))?.[1] ?? "";
}

test("dark popovers float one step above panels in every palette", () => {
	// 浮层阶梯（ZCode：panel #202020 → menu/card #2b2b2b）：菜单/弹窗必须比内容面亮一档，
	// 否则暗色下菜单像「暗洞」。graphite/sea-blue/warm-beige 不覆盖 popover/input，
	// 继承经典暗色块的 color-mix 相对派生——本测试同时校验继承链解析结果。skin 列表与
	// foundation.css 的 data-appearance 面板一一对应，新增皮肤会自动纳入。
	const base = tokensOf(darkBlock());
	const palettes = [
		["classic", base],
		...["fresh-green", "graphite", "sea-blue", "warm-beige"].map((skin) => {
			const merged = new Map(base);
			for (const [k, v] of tokensOf(skinDarkBlock(skin))) merged.set(k, v);
			return [skin, merged];
		}),
	];
	for (const [label, tokens] of palettes) {
		const popoverLum = luminance(resolveSurface(tokens, "color-bg-popover"));
		const panelLum = luminance(resolveSurface(tokens, "color-bg-panel"));
		assert.ok(popoverLum > panelLum, `${label} 暗色 popover 必须比 panel 亮一档（浮层阶梯）：${popoverLum.toFixed(4)} <= ${panelLum.toFixed(4)}`);
	}
});
