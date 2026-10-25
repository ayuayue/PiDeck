/**
 * 主题 token 对比度全量守卫（WCAG）：
 * 基础设施见 foundation.css 的 :root（浅色）与 :root[data-theme="dark"]（暗色）两套色板。
 * 本测试解析两套色板、解析 var() 引用链，按「App 实际绘制的 token 组合」矩阵计算对比度：
 * - 正文对（AA 4.5:1）：text-primary/secondary/tertiary × 各面色；状态色/chip 身份色 × 页面底
 * - 徽章对（AA 4.5:1）：状态色文字 × 同族浅底（danger/success-soft；warning 无 soft 用 15% 透明底近似）
 * - UI 构件对（3:1）：边框 × 底色、过程层图标色 × 底色
 * - 过程层 faint（刻意压暗一档）：地板 2.5:1（可见但从属）
 * 新增 token 时把「App 里真实出现的文字/底色组合」补进 PAIRS，不追求数学全组合。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const source = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
/** 文件树行名的着色映射：被测 token 由它派生，改映射（例如 untracked→text-warning）即换被测 token。 */
const { fileTreeGitStatusClass } = loadTsCommonJs("src/renderer/src/utils/fileTreeGitStatus.ts");
const FILE_TREE_GIT_STATUSES = ["modified", "added", "untracked", "conflict"];
/** `text-info` → `info`；洗淡档 `text-info/65` → `info/65`（带 alpha 的前景在 resolveText 里混到底色上再算）。 */
const fileTreeToken = (status, muted) => fileTreeGitStatusClass({ status, muted }).replace(/^text-/, "");

/** 从 CSS 源码抽取指定块（selector 精确匹配到下一个 `}`）内的 --token 声明。 */
function extractBlock(selector) {
	const start = source.indexOf(`${selector} {`);
	if (start === -1) throw new Error(`selector not found: ${selector}`);
	const end = source.indexOf("}", start);
	const body = source.slice(start, end);
	const map = {};
	for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
		map[m[1]] = m[2].trim();
	}
	return map;
}

/** 块内 var() 引用解析（--color-tool: var(--color-info) 这类同块派生）。 */
function resolve(tokens, name, seen = new Set()) {
	const raw = tokens[name];
	if (raw === undefined) throw new Error(`token not found: --${name}`);
	// `color-mix(in srgb, var(--x) N%, white)` 相对派生色（暗色 popover 浮层）：
	// 按同口径 sRGB 直混；oklab 写法也近似为 sRGB——色阶差在一档透明度内，不影响阈值判定。
	const mix = raw.match(/^color-mix\(in (?:srgb|oklab),\s*var\(--([a-z0-9-]+)\)\s*([\d.]+)%,\s*(#[0-9a-fA-F]{3,8}|white|black)\)$/);
	if (mix) {
		if (seen.has(mix[1])) throw new Error(`circular var ref: --${mix[1]}`);
		seen.add(mix[1]);
		const tint = mix[3] === "white" ? "#ffffff" : mix[3] === "black" ? "#000000" : mix[3];
		return blend(resolve(tokens, mix[1], seen), tint, Number(mix[2]) / 100);
	}
	const varRef = raw.match(/^var\(\s*--([a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/);
	if (!varRef) return raw;
	const [_, ref, fallback] = varRef;
	if (seen.has(ref)) throw new Error(`circular var ref: --${ref}`);
	seen.add(ref);
	if (!(ref in tokens) && fallback) return fallback.trim();
	return resolve(tokens, ref, seen);
}

/** #hex / rgb() → [r,g,b]（0-255）。 */
function parseColor(value) {
	const hex = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
	if (hex) {
		let h = hex[1];
		if (h.length === 3)
			h = h
				.split("")
				.map((c) => c + c)
				.join("");
		return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	}
	const rgb = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
	if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
	throw new Error(`unsupported color form: ${value}`);
}

/** WCAG 相对亮度与对比度。 */
function contrast(a, b) {
	const lum = (rgb) => {
		const [r, g, bl] = rgb.map((c) => {
			const s = c / 255;
			return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const l1 = lum(parseColor(a));
	const l2 = lum(parseColor(b));
	const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * 前景 token 解析：`name/alpha`（Tailwind 的 `text-info/65` 洗淡档）按 alpha 混到底色上再算对比度，
 * 与 bg-warning/15 同一 sRGB 近似口径（Tailwind 实际用 color-mix in oklab，近似误差小于一档透明度）。
 */
function resolveText(tokens, textToken, bg) {
	const [name, alpha] = textToken.split("/");
	const base = resolve(tokens, `color-${name}`);
	return alpha ? blend(base, bg, Number(alpha) / 100) : base;
}

/** alpha 混合近似（Tailwind bg-warning/15 这类透明底：前景按 alpha 混到底色上）。 */
function blend(fgHex, bgHex, alpha) {
	const fg = parseColor(fgHex);
	const bg = parseColor(bgHex);
	const mixed = fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
	return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const LIGHT = extractBlock(":root");
// CSS 级联真值：变体块只写覆盖项，未覆盖的 token 逐级继承（appearance 继承 dark，dark 继承 :root）。
// 测试必须模拟继承，否则会把「变体下实际生效的残留值」漏掉——warning 漏暗色覆盖就是这么发现的。
const DARK = { ...LIGHT, ...extractBlock(':root[data-theme="dark"]') };

// 全部用户可选色板：亮/暗 × accent(5)，亮/暗 × appearance 皮肤(4)。
// accent 只覆盖 accent 族 token、appearance 只覆盖面色/灰阶——两轴交叠组合的 token/面
// 配对已由这 20 块成对覆盖（跨轴组合不产生新配对），不展开 60 组全叉积。
const ACCENTS = ["green", "blue", "purple", "amber", "rose"];
const APPEARANCES = ["fresh-green", "graphite", "sea-blue", "warm-beige"];
const PALETTES = [
	{ label: "浅色", tokens: LIGHT },
	...ACCENTS.map((a) => ({ label: `浅色+${a}`, tokens: { ...LIGHT, ...extractBlock(`:root[data-accent="${a}"]`) } })),
	{ label: "暗色", tokens: DARK },
	...ACCENTS.map((a) => ({
		label: `暗色+${a}`,
		tokens: { ...DARK, ...extractBlock(`:root[data-theme="dark"][data-accent="${a}"]`) },
	})),
	...APPEARANCES.flatMap((a) => [
		{ label: `浅色皮肤·${a}`, tokens: { ...LIGHT, ...extractBlock(`:root[data-appearance="${a}"]`) } },
		{ label: `暗色皮肤·${a}`, tokens: { ...DARK, ...extractBlock(`:root[data-theme="dark"][data-appearance="${a}"]`) } },
	]),
];

/** 面色集合：正文会真实落在这些底上（列表 hover/active 也是完整文字底）。 */
const FACES = ["bg-app", "bg-panel", "bg-sidebar", "bg-popover", "bg-input", "bg-muted", "bg-hover", "bg-active"];

/**
 * 对比度契约矩阵。[textToken, faceToken, 阈值, 用途说明]
 * faceToken 特殊形态："@blend15:<face>" 表示以 15% 透明度混到 face 上的近似底（bg-warning/15 类）。
 */
const PAIRS = [
	// 正文主/次级：所有真实面色都要 AA
	...FACES.flatMap((face) => [
		["text-primary", face, 4.5, `正文 × ${face}`],
		["text-secondary", face, 4.5, `次级文字 × ${face}`],
	]),
	// 三级辅助文字：不出现在 hover/active 完整文字底（那里是 primary），主底/面板/浮层需 AA
	["text-tertiary", "bg-app", 4.5, "辅助文字 × 页面底"],
	["text-tertiary", "bg-panel", 4.5, "辅助文字 × 面板"],
	["text-tertiary", "bg-popover", 4.5, "辅助文字 × 浮层"],
	["text-tertiary", "bg-muted", 4.5, "辅助文字 × 弱底"],
	// 过程层 faint：刻意从属，地板 2.5（看得见但不抢正文层级）
	["text-faint", "bg-app", 2.5, "过程层文字地板 × 页面底"],
	["text-faint", "bg-panel", 2.5, "过程层文字地板 × 面板"],
	// 主按钮（accent 是"面"：text-inverse 落在 accent/accent-strong 上）
	["text-inverse", "accent", 4.5, "主按钮文字 × accent 面"],
	["text-inverse", "accent-strong", 4.5, "主按钮 hover 文字 × accent-strong 面"],
	// 状态色作为正文（LogViewer warn 行、导入取消提示、终端徽标都是真实文字用途）
	["danger", "bg-app", 4.5, "危险态文字 × 页面底"],
	["danger", "bg-panel", 4.5, "危险态文字 × 面板"],
	["success", "bg-app", 4.5, "成功态文字 × 页面底"],
	["success", "bg-panel", 4.5, "成功态文字 × 面板"],
	["warning", "bg-app", 4.5, "警告态文字 × 页面底"],
	["warning", "bg-panel", 4.5, "警告态文字 × 面板"],
	["info", "bg-app", 4.5, "信息态文字 × 页面底"],
	["info", "bg-panel", 4.5, "信息态文字 × 面板"],
	// 文件树行名 Git 着色（FileNode）：token 由着色映射派生，改映射即换被测 token。
	// 实色档（文件 + 直接父目录）走正文 AA 4.5；洗淡档（更远祖先，`text-info/65`）是「更深处有变化」的
	// 过程层提示，按 text-faint 同款地板 2.5——65% 是四色 × 21 套色板里定出来的最差值（2.65，55% 只有 2.24）。
	...FILE_TREE_GIT_STATUSES.flatMap((status) => [[fileTreeToken(status, false), "bg-muted", 4.5, `文件树 Git 着色（${status} 实色） × hover/按下底`], ...["bg-app", "bg-panel", "bg-muted"].map((face) => [fileTreeToken(status, true), face, 2.5, `文件树 Git 着色（${status} 洗淡档） × ${face}`])]),
	// 状态徽章（WebRemoteAccessSection: bg-success/15 text-success 等真实组合）
	["danger", "danger-soft", 4.5, "危险徽章文字 × danger-soft 底"],
	["success", "success-soft", 4.5, "成功徽章文字 × success-soft 底"],
	["warning", "@blend15:bg-app", 4.5, "警告徽章文字 × warning 15% 透明底"],
	// 引用 chip 身份色（file/skill/session：文字即身份色，落在页面/面板底上）
	["chip-file", "bg-app", 4.5, "file chip × 页面底"],
	["chip-file", "bg-panel", 4.5, "file chip × 面板"],
	["chip-skill", "bg-app", 4.5, "skill chip × 页面底"],
	["chip-skill", "bg-panel", 4.5, "skill chip × 面板"],
	["chip-session", "bg-app", 4.5, "session chip × 页面底"],
	["chip-session", "bg-panel", 4.5, "session chip × 面板"],
	// 代码块（code-bg 两主题都是深底）
	["code-text", "code-bg", 4.5, "代码文字 × 代码底"],
	// 过程层图标（非文字）：3:1——注意边框不进矩阵：装饰性分隔线是刻意低对比设计（WCAG 只要求
	// 「唯一视觉指示」的构件边 3:1，本应用输入控件用聚焦环作主要指示）
	["thinking", "bg-panel", 3, "思考过程图标 × 面板"],
	["tool", "bg-panel", 3, "工具行图标 × 面板"],
];

function resolveFace(tokens, face) {
	const blendMatch = face.match(/^@blend15:(.+)$/);
	if (blendMatch) {
		const base = resolve(tokens, `color-${blendMatch[1]}`);
		// 混合基准取 bg-app（徽章都出现在页面级面板上，bg-app/app-panel 暗浅几乎一致）
		return blend(resolve(tokens, "color-warning"), base, 0.15);
	}
	return resolve(tokens, `color-${face}`);
}

for (const { label, tokens } of PALETTES) {
	test(`主题 token 对比度矩阵：${label}`, () => {
		const failures = [];
		for (const [textToken, faceToken, min, usage] of PAIRS) {
			const bg = resolveFace(tokens, faceToken);
			const fg = resolveText(tokens, textToken, bg);
			const ratio = contrast(fg, bg);
			if (ratio < min) {
				failures.push(`  ✗ ${usage} [${textToken}=${fg} on ${bg}]: ${ratio.toFixed(2)}:1 < ${min}:1`);
			}
		}
		assert.deepEqual(failures, [], `${label}主题对比度违规 ${failures.length} 处:\n${failures.join("\n")}`);
	});
}
