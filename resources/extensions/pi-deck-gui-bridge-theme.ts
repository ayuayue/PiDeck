/**
 * pi-deck-gui-bridge —— 主题与样式。
 *
 * 桥给扩展一份**自己的 theme 对象**，其 `fg`/`bg` 不产 ANSI，而是包上哨兵：
 *   `{§accent§}text{§/§}`
 * 翻译器识别哨兵 → `StyleToken` → PiDeck 映射成 CSS 变量（§6.5）。
 *
 * 为什么要这样：扩展写的是 `theme.fg("accent", text)`，与 TUI 完全同形；
 * 但输出既不是 ANSI 也不是具体色值，而是**语义档**，因此
 * 「扩展不能指定颜色值」这条铁律（§7.3）在 pi-tui 那条路上也自动成立。
 *
 * **兜底**：扩展可能自己拼 ANSI，或第三方组件内部拼 ANSI。
 * 这时做 SGR 解析 → 最近语义 token；解析不了就剥掉转纯文本。
 */

import type { StyleToken, Tone } from "./pi-deck-gui-bridge-types";

/** 哨兵边界：用不可能出现在正常文本里的控制字符对，避免误伤用户内容。 */
const OPEN = "\u0001\u00a7"; // \x01§
const CLOSE = "\u00a7\u0001"; // §\x01
/**
 * 哨兵名允许的字符：字母/数字/`-`/`_`/`.`/`:`/`/`。
 *
 * 必须包含 `/` 与 `:` —— 闭合标记是 `/fg`、`/bold`，背景是 `bg:accent`。
 * （早期版本漏了这两个字符，导致闭合哨兵不被消费、残留在文本里。）
 */
const SENTINEL_NAME = "[a-zA-Z0-9_:/.-]+";
const OPEN_RE = new RegExp(`\\u0001\\u00a7(${SENTINEL_NAME})\\u00a7\\u0001`, "g");
const CLOSE_RE = /\u00a7\u0001/g;

/** pi-tui 主题的色档名 → 桥的语义 tone。 */
const TONE_ALIASES: Record<string, Tone> = {
	accent: "accent",
	primary: "accent",
	success: "success",
	ok: "success",
	warning: "warning",
	warn: "warning",
	error: "danger",
	danger: "danger",
	muted: "muted",
	dim: "muted",
	gray: "muted",
	grey: "muted",
	text: "default",
	foreground: "default",
	default: "default",
};

/** 归一化一个色档名到语义 tone（未知 → default）。 */
function toTone(name: string): Tone {
	return TONE_ALIASES[name.trim().toLowerCase()] ?? "default";
}

/**
 * 用哨兵包住文本。
 *
 * 同时产出「前景色」与「背景色」两类哨兵，翻译时分别映射到文字色与容器底色。
 */
function wrap(name: string, text: string): string {
	return `${OPEN}${name}${CLOSE}${text}${OPEN}/fg${CLOSE}`;
}

/** 桥的主题对象：与 pi-tui Theme 同形（`fg` / `bg` / `bold` / `dim` / …）。 */
export type BridgeTheme = {
	fg: (name: string, text: string) => string;
	bg: (name: string, text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	underline: (text: string) => string;
	strikethrough: (text: string) => string;
	dim: (text: string) => string;
	/** 兼容：某些扩展读 theme.colors / theme.name */
	colors?: Record<string, string>;
	name?: string;
};

/**
 * 创建桥主题。
 *
 * `fg` / `bg` 一律产哨兵；装饰类（bold 等）产对应的样式哨兵，
 * 由翻译层统一转成 `StyleToken[]`。
 */
export function createBridgeTheme(): BridgeTheme {
	const theme: BridgeTheme = {
		fg: (name, text) => wrap(toTone(name), text),
		bg: (name, text) => `${OPEN}bg:${toTone(name)}${CLOSE}${text}${OPEN}/bg${CLOSE}`,
		bold: (text) => `${OPEN}bold${CLOSE}${text}${OPEN}/bold${CLOSE}`,
		italic: (text) => `${OPEN}italic${CLOSE}${text}${OPEN}/italic${CLOSE}`,
		underline: (text) => `${OPEN}underline${CLOSE}${text}${OPEN}/underline${CLOSE}`,
		strikethrough: (text) => `${OPEN}strike${CLOSE}${text}${OPEN}/strike${CLOSE}`,
		dim: (text) => `${OPEN}muted${CLOSE}${text}${OPEN}/fg${CLOSE}`,
		colors: {},
		name: "pideck-gui-bridge",
	};
	return theme;
}

/** 一个文本片段 + 其生效样式。 */
export type StyledRun = { text: string; styles: StyleToken[] };

/** 哨兵名称 → StyleToken。 */
function sentinelToStyle(name: string): StyleToken | null {
	const lower = name.trim().toLowerCase();
	if (lower.startsWith("bg:")) return null; // 背景色不进 style token（容器底色另处理）
	switch (lower) {
		case "bold":
			return "bold";
		case "italic":
			return "italic";
		case "underline":
			return "underline";
		case "strike":
		case "strikethrough":
			return "strikethrough";
		case "code":
			return "code";
		case "/fg":
		case "/bold":
		case "/italic":
		case "/underline":
		case "/strike":
		case "/code":
		case "/bg":
			return null; // 闭合标记由解析器处理
		default:
			return toTone(lower);
	}
}

/**
 * 把带哨兵的字符串解析成若干 `StyledRun`。
 *
 * 解析器是**栈式**的：`{§bold§}a{§accent§}b{§/bold§}c` 里，`b` 同时带 bold + accent。
 * 遇到认不出的哨兵名按 tone 处理（`default` 兜底），**绝不抛错**。
 */
export function parseSentinelText(input: string): StyledRun[] {
	if (!input) return [];
	// 没有哨兵 → 快速路径（绝大多数纯文本走这里）
	if (!input.includes("\u0001\u00a7")) return [{ text: input, styles: [] }];

	const runs: StyledRun[] = [];
	const stack: StyleToken[] = [];
	let cursor = 0;
	OPEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null = OPEN_RE.exec(input);
	while (match) {
		const raw = input.slice(cursor, match.index);
		if (raw) runs.push({ text: raw, styles: [...stack] });
		const name = match[1];
		if (name.startsWith("/")) {
			// 闭合：弹出最近一个同名（或任意）样式
			const target = sentinelToStyle(name.slice(1)) ?? null;
			if (target === null) {
				// 闭合 fg/bg 这类"组"标记：弹出最近的 tone
				const idx = findLastToneIndex(stack);
				if (idx >= 0) stack.splice(idx, 1);
			} else {
				const idx = stack.lastIndexOf(target);
				if (idx >= 0) stack.splice(idx, 1);
			}
		} else {
			const token = sentinelToStyle(name);
			if (token) stack.push(token);
		}
		cursor = match.index + match[0].length;
		match = OPEN_RE.exec(input);
	}
	const tail = input.slice(cursor);
	if (tail) runs.push({ text: tail, styles: [...stack] });
	return mergeRuns(runs);
}

function findLastToneIndex(stack: StyleToken[]): number {
	const tones = new Set(["default", "muted", "accent", "success", "warning", "danger"]);
	for (let i = stack.length - 1; i >= 0; i -= 1) {
		if (tones.has(stack[i])) return i;
	}
	return -1;
}

/** 合并相邻同样式片段，减少节点数。 */
function mergeRuns(runs: StyledRun[]): StyledRun[] {
	const out: StyledRun[] = [];
	for (const run of runs) {
		if (!run.text) continue;
		const prev = out[out.length - 1];
		if (prev && sameStyles(prev.styles, run.styles)) {
			prev.text += run.text;
		} else {
			out.push({ text: run.text, styles: [...run.styles] });
		}
	}
	return out;
}

function sameStyles(a: StyleToken[], b: StyleToken[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
	return true;
}

// ── ANSI 兜底（§6.5）────────────────────────────────────────────

/** ANSI SGR 转义序列。 */
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** SGR 前景色码 → 语义 tone（粗粒度映射，够用即可）。 */
function sgrToTone(code: number): Tone | null {
	if (code === 30 || code === 90) return "muted";
	if (code === 31 || code === 91) return "danger";
	if (code === 32 || code === 92) return "success";
	if (code === 33 || code === 93) return "warning";
	if (code === 34 || code === 94 || code === 36 || code === 96) return "accent";
	if (code === 35 || code === 95) return "accent";
	if (code === 37 || code === 97) return "default";
	return null;
}

/**
 * 把真 ANSI 文本降级成 `StyledRun[]`。
 *
 * 识别 SGR 前景色/粗体/斜体/下划线；其余序列一律剥掉。
 * 这是**保命路径**：任何解析失败都退化成「纯文本」而不是抛错。
 */
export function parseAnsiText(input: string): StyledRun[] {
	if (!input) return [];
	if (!input.includes("\u001b")) return [{ text: input, styles: [] }];

	const runs: StyledRun[] = [];
	const stack: StyleToken[] = [];
	let cursor = 0;
	ANSI_RE.lastIndex = 0;
	let match: RegExpExecArray | null = ANSI_RE.exec(input);
	while (match) {
		const raw = input.slice(cursor, match.index);
		if (raw) runs.push({ text: raw, styles: [...stack] });
		const body = match[0].slice(2, -1); // 去掉 ESC[ 与 m
		const codes = body === "" ? [0] : body.split(";").map((s) => Number.parseInt(s, 10) || 0);
		for (const code of codes) {
			if (code === 0) {
				stack.length = 0;
			} else if (code === 1) {
				if (!stack.includes("bold")) stack.push("bold");
			} else if (code === 2) {
				if (!stack.includes("dim")) stack.push("dim");
			} else if (code === 3) {
				if (!stack.includes("italic")) stack.push("italic");
			} else if (code === 4) {
				if (!stack.includes("underline")) stack.push("underline");
			} else if (code === 9) {
				if (!stack.includes("strikethrough")) stack.push("strikethrough");
			} else if (code === 22 || code === 23 || code === 24 || code === 29) {
				// 关闭粗体/斜体/下划线/删除线：近似处理为清掉对应样式
				const target: StyleToken = code === 22 ? "bold" : code === 23 ? "italic" : code === 24 ? "underline" : "strikethrough";
				const idx = stack.lastIndexOf(target);
				if (idx >= 0) stack.splice(idx, 1);
			} else if (code === 39) {
				const idx = findLastToneIndex(stack);
				if (idx >= 0) stack.splice(idx, 1);
			} else {
				const tone = sgrToTone(code);
				if (tone) {
					const idx = findLastToneIndex(stack);
					if (idx >= 0) stack.splice(idx, 1);
					stack.push(tone);
				}
			}
		}
		cursor = match.index + match[0].length;
		match = ANSI_RE.exec(input);
	}
	const tail = input.slice(cursor);
	if (tail) runs.push({ text: tail, styles: [...stack] });
	return mergeRuns(runs);
}

/**
 * 统一入口：先解哨兵，再把残余 ANSI 也解掉。
 *
 * 顺序有意为之 —— 桥自己产的哨兵优先，扩展/第三方拼的 ANSI 兜底。
 */
export function parseStyledText(input: string): StyledRun[] {
	const runs = parseSentinelText(input);
	const out: StyledRun[] = [];
	for (const run of runs) {
		if (!run.text.includes("\u001b")) {
			out.push(run);
			continue;
		}
		for (const ansiRun of parseAnsiText(run.text)) {
			out.push({ text: ansiRun.text, styles: [...run.styles, ...ansiRun.styles] });
		}
	}
	return mergeRuns(out);
}

/** 剥掉全部样式（哨兵 + ANSI），得到纯文本。 */
export function stripStyledText(input: string): string {
	let out = input.replace(OPEN_RE, "").replace(CLOSE_RE, "");
	out = out.replace(ANSI_RE, "");
	return out;
}

/** 从哨兵文本里读出「容器背景色」（`bg:` 哨兵），供 Box 适配器使用。 */
export function readBgTone(input: string): Tone | null {
	const match = input.match(/\u0001\u00a7bg:([a-zA-Z0-9_-]+)\u00a7\u0001/);
	return match ? toTone(match[1]) : null;
}