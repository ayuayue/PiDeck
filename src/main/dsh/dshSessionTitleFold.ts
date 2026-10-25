/**
 * 只读折叠 DSH 会话标题（与 `@deepseek-ai/dsh-session-title` 同构，不启动 host）。
 *
 * 官方规则（dsh-session-title README / foldSessionTitle）：
 * - 已接受标题是日志里最后一条 `session/title`（last-wins），不在 header 里；
 * - 还没有这条事件时，用第一条真人 `user/message` 文本做确定性回退
 *   （dsh-base cordis.patch.yml：5 词 / 40 字节 / 总上限 80 字节）。
 *
 * 投影缓存（session_projcache）是 dsh-web 热路径；冷会话常常还没写进缓存
 * （本机实测 22 条磁盘会话只有 13 条缓存）。首次安装若只读缓存，
 * 侧栏就会全是「DSH 会话」/目录名。这里只读日志补标题，不写缓存、不 attach。
 */

/** 与 dsh-base `session-title` 配置一致，禁止另起一套截断规则。 */
export const DSH_TITLE_FALLBACK_MAX_WORDS = 5;
export const DSH_TITLE_FALLBACK_MAX_BYTES = 40;
export const DSH_TITLE_MAX_BYTES = 80;

/** 日志折叠状态：last-wins 标题 + 首条真人提示（仅缓存未命中时用）。 */
export type LoggedTitleFold = {
	title?: string;
	fallback?: string;
};

/** 去掉控制符/方向符并压成单行空白（与官方 cleanTitleText 同构）。 */
export function cleanTitleText(input: string): string {
	return input
		.replace(/(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu, "")
		.replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/\u001B[@-_]/gu, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
		.replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
}

/** UTF-8 字节截断且不劈开码点（与官方 truncateTitleUtf8 同构）。 */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
	if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
	let used = 0;
	let output = "";
	for (const character of input) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (used + bytes > maxBytes) break;
		output += character;
		used += bytes;
	}
	return output;
}

/** 官方确定性回退：首条提示的前 N 词，再受字节上限约束。 */
export function fallbackSessionTitle(input: string): string {
	const words = cleanTitleText(input).split(" ").filter(Boolean).slice(0, DSH_TITLE_FALLBACK_MAX_WORDS).join(" ");
	return truncateTitleUtf8(words, DSH_TITLE_FALLBACK_MAX_BYTES).trimEnd();
}

/** 从一条 JSONL 行取出 session/title 或首条真人 user/message。 */
export function consumeTitleEvent(line: string, state: LoggedTitleFold): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (!parsed || typeof parsed !== "object") return;
	const record = parsed as Record<string, unknown>;
	if (record.type === "session/title") {
		const data = record.data;
		if (!data || typeof data !== "object") return;
		const title = (data as { title?: unknown }).title;
		if (typeof title === "string" && title.trim()) state.title = title.trim();
		return;
	}
	if (state.fallback || record.type !== "user/message") return;
	const data = record.data;
	if (!data || typeof data !== "object") return;
	const source = (data as { source?: { kind?: unknown } }).source;
	// 官方 collectSessionTitleMessages 只收 source.kind === "user"，系统/工具注入不算。
	if (source && source.kind !== "user") return;
	const content = (data as { content?: unknown }).content;
	if (!Array.isArray(content)) return;
	const text = content
		.filter((block): block is { type: string; text: string } => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join("\n");
	const fallback = fallbackSessionTitle(text);
	if (fallback) state.fallback = fallback;
}

/** 一段明文 JSONL（可含多行/多帧拼接）→ last-wins 标题，否则首条提示回退。 */
export function foldLoggedSessionTitle(text: string): string | undefined {
	const state: LoggedTitleFold = {};
	for (const line of text.split(/\r?\n/)) consumeTitleEvent(line, state);
	return state.title ?? state.fallback;
}

/** 结算：已 fold 的 session/title 优先；没有才用首条提示回退。 */
export function resolveFoldedTitle(state: LoggedTitleFold): string | undefined {
	return state.title ?? state.fallback;
}
