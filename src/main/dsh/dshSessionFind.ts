import type { ChatMessage, SessionSearchMatch } from "../../shared/types";

/**
 * DSH 会话内查找的匹配层（纯函数，可单测）。
 *
 * 语义必须与 pi 的 Go sidecar（native/session-index/search.go）对齐，否则同一个
 * Ctrl/Cmd+Shift+F 在两种后端上表现不一致（换词就打不中、命中条数对不上）：
 * - 词元按空白拆分，多词 AND（每个词都要出现，顺序无关、可跨段落）；超过 16 个词
 *   时整句当一个词，避免病态长查询；
 * - 大小写只折叠 ASCII A-Z（中文等非 ASCII 不受影响，与 Go 的 asciiLower 同口径）；
 * - 命中锚点优先整句出现处，否则取最早出现的词元；
 * - snippet 取锚点前 48 / 后 96 个字符，换行/制表折叠成空格（浮层单行展示）；
 * - 命中按时间线顺序返回（会话内是「上一条/下一条」导航），超过上限截断。
 *
 * 与 Go 的差异只有「id 形态」：pi 命中回的是会话文件条目 id（渲染层再归一），
 * DSH 没有会话文件条目，直接用投影消息 id（`dsh:<seq>`），jumpToMessage 按消息 id
 * 就能定位。消息正文只取 user/assistant（工具卡片、系统提示不参与），与 host
 * session.search 的面一致。
 */

/** 会话内查找的命中上限（与 pi 的 DEFAULT_IN_SESSION_LIMIT 一致：单会话、按时间线导航）。 */
export const DSH_SESSION_FIND_MAX_MATCHES = 100;

/** 超过该词数就把整个查询当一句（对齐 Go 的 maxQueryTerms）。 */
const MAX_QUERY_TERMS = 16;
/** snippet 窗口（字符数，按码点算，避免切开 emoji 的代理对）。 */
const SNIPPET_BEFORE_CHARS = 48;
const SNIPPET_AFTER_CHARS = 96;

export type DshSessionFindResult = {
	/** 按时间线顺序的命中（最多 limit 条）。 */
	matches: SessionSearchMatch[];
	/** 命中总数（未截断）；界面用它报真实条数。 */
	hitCount: number;
};

/** 会话内查找只需要消息的这几个字段：接受任意投影消息切片，测试可用工厂构造。 */
export type DshFindableMessage = Pick<ChatMessage, "id" | "role" | "text" | "timestamp">;

export function findDshSessionMatches(messages: ReadonlyArray<DshFindableMessage>, query: string, limit = DSH_SESSION_FIND_MAX_MATCHES): DshSessionFindResult {
	const trimmed = query.trim();
	if (!trimmed) return { matches: [], hitCount: 0 };
	const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DSH_SESSION_FIND_MAX_MATCHES;
	const terms = splitQueryTerms(trimmed);
	// 单词查询没有「整句」与「词元」的区别，整句锚点只在多词时有意义。
	const phrase = terms.length > 1 ? trimmed : undefined;
	// 只有查询含 ASCII 字母才需要折叠大小写（含中文的查询零成本走原文匹配）。
	const foldAscii = /[A-Za-z]/.test(trimmed);
	const hayTerms = foldAscii ? terms.map(asciiLower) : terms;
	const hayPhrase = phrase !== undefined && foldAscii ? asciiLower(phrase) : phrase;

	const matches: SessionSearchMatch[] = [];
	let hitCount = 0;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = message.text;
		if (!text) continue;
		const hay = foldAscii ? asciiLower(text) : text;
		const anchor = resolveMatchAnchor(hay, hayTerms, hayPhrase);
		if (anchor < 0) continue;
		hitCount += 1;
		if (matches.length >= max) continue;
		matches.push({
			messageId: message.id,
			role: message.role,
			timestampMs: message.timestamp,
			snippet: buildSnippet(text, anchor),
		});
	}
	return { matches, hitCount };
}

/** 词元拆分：`String.prototype.split(/\s+/)` 覆盖普通空白、制表、全角空格（与 Go strings.Fields 同面）。 */
function splitQueryTerms(query: string): string[] {
	const terms = query.split(/\s+/).filter((term) => term.length > 0);
	// 病态长查询：整句当一个词，避免对每条消息做 N 次 indexOf。
	return terms.length > MAX_QUERY_TERMS ? [query] : terms;
}

/**
 * 命中锚点（UTF-16 下标）：整句出现处优先，否则取最早出现的词元。
 * 任一词元没出现就是不命中（多词 AND）。返回 -1 表示没有命中。
 */
function resolveMatchAnchor(hay: string, terms: readonly string[], phrase: string | undefined): number {
	let first = -1;
	for (const term of terms) {
		const index = hay.indexOf(term);
		if (index < 0) return -1;
		if (first < 0 || index < first) first = index;
	}
	if (phrase !== undefined) {
		const phraseIndex = hay.indexOf(phrase);
		if (phraseIndex >= 0) return phraseIndex;
	}
	return first;
}

/**
 * 命中片段：锚点前后取有界窗口并把控制字符折成空格（snippet 是单行展示，
 * 正文里的换行/制表/段落分隔符不应把浮层撑成多行）。按码点切窗口，
 * 代理对（emoji/生僻字）不会被切成半个字符。
 */
function buildSnippet(text: string, anchor: number): string {
	if (text.length <= SNIPPET_BEFORE_CHARS + SNIPPET_AFTER_CHARS) {
		return foldSnippetWhitespace(text);
	}
	const anchorCodePoints = Array.from(text.slice(0, anchor)).length;
	const points = Array.from(text);
	const start = Math.max(0, anchorCodePoints - SNIPPET_BEFORE_CHARS);
	const end = Math.min(points.length, anchorCodePoints + SNIPPET_AFTER_CHARS);
	return foldSnippetWhitespace(points.slice(start, end).join(""));
}

/** 控制字符（C0/C1、行分隔符）统一折成空格：Go 侧只折 \n\r\t，这里多覆盖不可见字符，展示更稳。 */
function foldSnippetWhitespace(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

/** 只折叠 ASCII A-Z：与 Go 的 asciiLower 同口径（toLowerCase 会动到土耳其 İ 等非 ASCII 字符）。 */
function asciiLower(value: string): string {
	return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}
