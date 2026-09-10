/**
 * Composer / 时间线共用的 chip 解析与路径格式化。
 * 纯函数模块：无 React / 无编辑器依赖；与 detectTrigger 规则对齐。
 */

import { createQuoteTokenRe } from "./quoteChip";

export type ComposerChip = {
	start: number;
	end: number;
	raw: string;
	// quote：会话内「引用追问」chip，raw 是 #q<id> 短 token，全文快照在 session 域 atom
	kind: "file" | "skill" | "session" | "quote";
	label: string;
};

/** 展示前缀：渲染层拼在 label 前的触发符（与旧字符 icon 一致，构成区分信号之一）。
 * 发送/解析仍用 raw，此常量只影响展示；parseHTML/readChipFromDom 重建节点时
 * 需按同一映射剥前缀，避免 attrs.label 污染导致双前缀。 */
export const CHIP_PREFIX: Record<ComposerChip["kind"], string> = {
	file: "@",
	skill: "/",
	session: "&",
	quote: "❝",
};

/**
 * chip 的展示文本。
 *
 * 对齐 Proma：只有文件引用保留 `@`（用户敲进去的引用语法），`/`、`&`、`❝` 一律交给图标
 * 表达，避免图标与字符双前缀；pi 的 `/skill:名称` 是 wire 细节，展示层只留技能名。
 */
export function formatChipDisplayLabel(
	kind: ComposerChip["kind"],
	label: string,
): string {
	if (kind === "file") return `@${label}`;
	if (kind === "skill") return label.replace(/^skill:/, "");
	return label;
}

/**
 * 从 DOM 展示文本还原 chip label（parseHTML / readChipFromDom 用）。
 *
 * 必须按类型剥：展示层只有 file 带 `@`，skill 的旧版 wire 前缀是 `/skill:`（技能名本身不可能以 `/` 开头）。
 * session/quote 的 label 可能本身就以 `&`、`/`、`@`、`❝` 开头（例如引用一段 `/src/foo` 路径），
 * 旧实现统一 `replace(/^[@/&❝]/)` 会把 label 的首字符吃掉。
 */
export function stripChipDisplayPrefix(
	kind: ComposerChip["kind"],
	text: string,
): string {
	if (kind === "file") return text.replace(/^@/, "");
	if (kind === "skill") return text.replace(/^\/(?:skill:)?/, "");
	return text;
}

/**
 * 文件 chip 的展示文本：只显示文件名（对齐 Proma FilePathChip 的 `truncate max-w-[240px]`
 * + tooltip 全路径），完整路径仍保留在 raw 里用于打开文件与悬浮查看。
 */
export function formatFileChipLabel(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const segments = normalized.split("/").filter(Boolean);
	return segments.at(-1) ?? normalized;
}

/** raw 是否为目录引用（`@src/` 或 `@"my docs/"`）：据此换成文件夹图标。 */
export function isDirectoryFileChip(raw: string): boolean {
	const body = raw.replace(/^@/, "").replace(/^"|"$/g, "");
	return /[/\\]$/.test(body);
}

/** @deprecated 兼容旧名；新代码用 ComposerChip */
export type RichInputChip = ComposerChip;

/** 提取文本中所有 URL 区间，后续 chip 解析跳过这些区间。 */
function findUrlSpans(text: string): { start: number; end: number }[] {
	const urlRe = /https?:\/\/\S+/g;
	const spans: { start: number; end: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = urlRe.exec(text)) !== null) {
		spans.push({ start: m.index, end: m.index + m[0].length });
	}
	return spans;
}

/** 判断区间是否与任一 URL 区间重叠（含部分重叠）。 */
function overlapsUrl(
	start: number,
	end: number,
	urlSpans: { start: number; end: number }[],
): boolean {
	return urlSpans.some((s) => start < s.end && end > s.start);
}

/**
 * 从 file chip 的 raw 取出真实路径。
 * 支持 @path、@path/、@"path with space" 三种写法。
 * 目录引用的尾斜杠会剥离，便于 open/showInFolder 使用真实路径。
 */
export function unwrapFileChipPath(raw: string): string {
	const body = raw.startsWith("@") ? raw.slice(1) : raw;
	let path =
		body.length >= 2 && body.startsWith('"') && body.endsWith('"')
			? body.slice(1, -1)
			: body;
	// 统一去掉目录标记尾斜杠（含 Windows 反斜杠），避免 FS API 拿到 "src/"
	path = path.replace(/[/\\]+$/, "");
	return path;
}

/**
 * 将路径格式化为消息中的 @ 引用。
 * 目录必须带尾斜杠（@src/），否则 chip 规则要求路径含 /\. 时，
 * 裸名 @src 不会渲染为文件 chip，模型也容易当成「智能体/人」mention。
 */
export function formatFilePathRef(
	path: string,
	options?: { isDirectory?: boolean },
): string {
	// 先规范化：去掉已有尾分隔符，再按 isDirectory 统一追加 /
	let normalized = path.replace(/[/\\]+$/, "");
	if (options?.isDirectory) {
		normalized = `${normalized}/`;
	}
	const needsQuote = /[\s"]/.test(normalized);
	if (!needsQuote) return `@${normalized}`;
	// 路径内若已有双引号，做简单转义；Windows 路径通常不含 "。
	const escaped = normalized.replace(/"/g, '\\"');
	return `@"${escaped}"`;
}

/**
 * 从粘贴文本中识别「单条本地绝对路径」的工具（已不再被 onPaste 自动调用）。
 * 保留为纯函数/测试契约：若未来需要恢复“复制路径 → @引用”能力可复用。
 *
 * 判定规则：trim 后整段即一条绝对路径（允许前缀 @、外层成对引号——兼容 Windows
 * 资源管理器「复制为路径」）。非纯路径（多行 / 夹杂正文）返回 null。
 */
export function extractPastedPath(text: string): string | null {
	if (!text) return null;
	let body = text.trim();
	if (!body || body.includes("\n") || body.includes("\r")) return null;
	if (body.startsWith("@")) body = body.slice(1).trimStart();
	if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) {
		body = body.slice(1, -1).trim();
	}
	if (!body) return null;
	// 只拦截绝对路径：Windows 盘符（C:\… / C:/…），或至少两段的 POSIX 路径（/Users/me）。
	// 单段 /compact、/maestro-next "…" 是斜杠命令：旧规则把任意 / 开头单行当路径，
	// 粘贴进 composer 会被 formatFilePathRef 包成 @"/maestro-next \"…\""。
	if (!isAbsoluteLocalPath(body)) return null;
	return body;
}

/** 粘贴拦截用的绝对路径判定：盘符路径，或 /seg/seg…（排除斜杠命令）。 */
function isAbsoluteLocalPath(body: string): boolean {
	if (/^[a-zA-Z]:[\\/]/.test(body)) return true;
	return body.startsWith("/") && body.includes("/", 1);
}

/**
 * 将 prompt 字符串解析为 chip 列表（展示层，与 detectTrigger 规则对齐）。
 *
 * 规则：
 * - /skill 触发符 / 前一个字符不能是 : / 或字母/数字/下划线（\w），
 *   避免路径段（如 Agent/PiDeck、a/b）被误识别。
 * - @path 触发符 @ 前同样排除 : / 和 \w。
 * - /skill：skill 名只允许字母开头 + 字母数字/连字符（skill 命名规范），
 *   且 token 后一字符不能是 /（排除 /usr/bin 这类路径）。
 * - @path：无空格路径用 @C:\a\b.txt；含空格路径用 @"C:\Users\a b\c.txt"。
 * - &session：传入 validSessionRefs（含空 Set）时仅白名单命中才成 chip；
 *   未传入时（时间线展示）回退为 & 后首个单词。
 * - #q<id> 引用 token：仅在传入 validQuotes（id → 展示 label）时解析；
 *   未传入时保持裸文本（时间线展示的是发送期已展开的文本，不应再出现 token）。
 *
 * URL 中的路径段（如 https://example.com/foo）不会被识别为 chip。
 */
export function parseRichInputChips(
	text: string,
	validCommandNames?: Set<string>,
	validFilePaths?: Set<string>,
	validSessionRefs?: Set<string>,
	validQuotes?: Map<string, string>,
): ComposerChip[] {
	const chips: ComposerChip[] = [];
	const urlSpans = findUrlSpans(text);

	// /skill：前置排除 : / 和 \w；slash 命令 = 命令名 + 可选 :参数名。
	// 后一字符若为 /，说明是路径（如 /usr/bin），不当作 skill。
	const slashRe =
		/(?<![:/.\w#!~])(\/[\p{L}][\p{L}\p{N}_-]*(?::[\p{L}][\p{L}\p{N}_-]*)?)/gu;
	let m: RegExpExecArray | null;
	while ((m = slashRe.exec(text)) !== null) {
		const start = m.index;
		const end = start + m[1].length;
		if (text[end] === "/") continue;
		if (!overlapsUrl(start, end, urlSpans)) {
			const label = m[1].slice(1);
			// pi 的技能调用 wire token 是 /skill:名称；运行时命令清单未必把每个已安装
			// skill 枚举为独立命令，因此除精确白名单外也认这一确定语法。这样 disk 重载后
			// /skill:foo 仍能还原为 chip，而未知普通 /command 继续保持纯文本。
			const isPiSkillInvocation = /^skill:[\p{L}\p{N}_-]+$/u.test(label);
			const baseCommand = label.split(":", 1)[0] ?? label;
			if (
				!validCommandNames ||
				validCommandNames.has(label) ||
				validCommandNames.has(baseCommand) ||
				isPiSkillInvocation
			) {
				chips.push({ start, end, raw: m[1], kind: "skill", label });
			}
		}
		if (m.index === slashRe.lastIndex) slashRe.lastIndex++;
	}

	// @path：无空格 / 引号含空格 / 目录尾斜杠；未加引号的绝对路径可含空格（逐段延伸）；
	// 相对路径走白名单，绝对路径绕过。
	const atRe = /(?<![:/.\w#!~])(@(?:"[^"]+"|[^\s@"]+))/g;
	while ((m = atRe.exec(text)) !== null) {
		const start = m.index;
		let rawToken = m[1];
		let end = start + rawToken.length;
		// 未加引号的绝对路径：空格可能属于路径本身（@C:/Users/…/Tencent Files/…）。
		// 只有「下一段含 / 或 \ 」才并入，避免把后续正文/URL 吞进路径；
		// 引号形式（@"…"）有明确边界，不需要延伸。
		if (!rawToken.includes('"')) {
			const body = rawToken.slice(1);
			const isAbsPrefix = /^[a-zA-Z]:[\\/]/.test(body) || /^\//.test(body);
			if (isAbsPrefix) {
				while (end < text.length) {
					const segMatch = /^ ([^\s]+)/.exec(text.slice(end));
					if (!segMatch) break;
					const seg = segMatch[1];
					if (!/[\\/]/.test(seg) || /^https?:\/\//i.test(seg)) break;
					rawToken += ` ${seg}`;
					end += segMatch[0].length;
				}
			}
		}
		if (!overlapsUrl(start, end, urlSpans)) {
			const body = rawToken.startsWith("@") ? rawToken.slice(1) : rawToken;
			const quoted = body.length >= 2 && body.startsWith('"') && body.endsWith('"');
			const rawPath = quoted ? body.slice(1, -1) : body;
			const isDirectoryRef = /[/\\]$/.test(rawPath);
			// 无分隔符且非目录尾斜杠的裸名（@alice）不渲染为文件 chip
			if (!isDirectoryRef && !/[\\/.]/.test(rawPath)) continue;
			const seg = unwrapFileChipPath(rawToken);
			const normalized = seg.replace(/\\/g, "/");
			const pathKey = normalized.startsWith("./") ? normalized.slice(2) : normalized;
			const isAbsPath =
				/^[a-zA-Z]:[\\/]/.test(pathKey) || /^\/[^/]+\//.test(pathKey);
			if (!isAbsPath && validFilePaths && !validFilePaths.has(pathKey)) continue;
			const baseLabel = pathKey || normalized || seg;
			const fullLabel = isDirectoryRef
				? `${baseLabel.replace(/[/\\]+$/, "")}/`
				: baseLabel;
			// 只展示文件名（Proma 同款），全路径仍在 raw 里，不影响偏移、打开或发送内容。
			const label = formatFileChipLabel(fullLabel);
			// 保留用户实际输入的 raw，不在解析阶段改写成 @"…"：原始 token 的
			// 字符区间必须与 ProseMirror 的纯文本偏移一致，否则 atom 节点长度
			// 与 caret 映射不一致，后续输入可能落到 chip 内部或把文字插入错误位置。
			// 文件粘贴/拖拽仍由 formatFilePathRef 在插入边界统一加引号。
			const raw = rawToken;
			chips.push({ start, end, raw, kind: "file", label });
		}
		if (m.index === atRe.lastIndex) atRe.lastIndex++;
	}

	// &session：逐个 & 起点匹配，命中后把 lastIndex 推到 chip 末尾，
	// 避免旧版 (&[^\n]+) 贪婪吃掉整行导致一行只能出一个 session chip。
	const ampStartRe = /(?<![:/.#!~?=&])&/gu;
	while ((m = ampStartRe.exec(text)) !== null) {
		const start = m.index;
		const captured = text.slice(start + 1);
		let name = "";
		if (validSessionRefs !== undefined) {
			// Composer：传入 Set（可为 empty）= 严格白名单，未命中不成 chip。
			for (const ref of validSessionRefs) {
				if (captured === ref || captured.startsWith(`${ref} `) || captured.startsWith(`${ref}\n`)) {
					if (ref.length > name.length) name = ref;
				}
			}
			if (!name) {
				continue;
			}
		} else {
			// 时间线等未传白名单：回退首词（仅展示）
			name = captured.split(/\s/)[0] ?? "";
		}
		if (!name) continue;
		const raw = `&${name}`;
		const end = start + raw.length;
		if (!overlapsUrl(start, end, urlSpans)) {
			chips.push({ start, end, raw, kind: "session", label: name });
		}
		ampStartRe.lastIndex = end;
	}

	// #q<id> 引用 token：白名单命中才成 chip；正则自带边界（前置非 \w/.#、后继非字母数字），
	// 手工敲出的同形文本只有命中本会话真实快照才会被渲染为引用 chip。
	if (validQuotes) {
		const quoteRe = createQuoteTokenRe();
		while ((m = quoteRe.exec(text)) !== null) {
			const id = m[1] ?? "";
			const label = validQuotes.get(id);
			if (label === undefined) continue;
			const start = m.index;
			const end = start + m[0].length;
			if (!overlapsUrl(start, end, urlSpans)) {
				chips.push({ start, end, raw: m[0], kind: "quote", label });
			}
			quoteRe.lastIndex = end;
		}
	}

	// 去重叠：保留先出现的，剔除被包含的
	chips.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: ComposerChip[] = [];
	let coverEnd = -1;
	for (const c of chips) {
		if (c.start >= coverEnd) {
			merged.push(c);
			coverEnd = c.end;
		}
	}
	return merged;
}
