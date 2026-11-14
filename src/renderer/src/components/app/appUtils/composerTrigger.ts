/**
 * 从 AppUtils 拆出的「输入框建议触发」域：@ / & 触发符识别、建议应用与关闭。
 * 与 chips.ts 的 lookbehind 规则必须同口径，改动时两边一起看。
 */

/* ── 输入框建议 ── */

export type ComposerSuggestionResult = {
	text: string;
	cursor: number;
};

export type ComposerTrigger = {
	start: number;
	char: string;
	query: string;
};

/**
 * 触发符是否落在「可开建议」的边界上。
 * 与 chips.ts 的 lookbehind 对齐，并额外挡住 word&name / user@host，
 * 避免正文里的普通符号把建议框钉住。
 */
function isComposerTriggerBoundary(prev: string, char: string): boolean {
	if (!prev) return true;
	if (char === "&") {
		// chip 的 ampStartRe 已排除 :/.#!~?=&
		// 建议框再排除 \w：cmd&x、100%& 这种不当会话引用
		return !/[:/.#!~?=&\w]/.test(prev);
	}
	// @ / 与 parseRichInputChips 的 (?<![:/.\w#!~]) 一致
	return !/[:/.\w#!~]/.test(prev);
}

/**
 * & 后的查询是否仍像「正在输入某个已知会话名」。
 * 会话名可含空格（&beta long），所以不能一遇到空格就关；
 * 但必须是某个白名单名字的前缀，否则 Tom & Jerry 会永远开着建议框。
 */
function isSessionTriggerQuery(query: string, validSessionRefs: Set<string>): boolean {
	if (validSessionRefs.size === 0) return false;
	if (query.length === 0) return true;
	const needle = query.toLowerCase();
	for (const ref of validSessionRefs) {
		if (ref.toLowerCase().startsWith(needle)) return true;
	}
	return false;
}

export function detectTrigger(text: string, cursor: number, validSessionRefs?: Set<string>): ComposerTrigger | null {
	if (cursor < 0 || cursor > text.length) cursor = text.length;
	const before = text.slice(0, cursor);
	const atIdx = before.lastIndexOf("@");
	const slashIdx = before.lastIndexOf("/");
	const ampIdx = before.lastIndexOf("&");
	const start = Math.max(atIdx, slashIdx, ampIdx);
	if (start < 0) return null;
	const char = before[start];
	const segment = before.slice(start + 1);
	const prev = start > 0 ? before[start - 1] : "";
	if (char === "&") {
		if (/\n/.test(segment)) return null;
		if (!isComposerTriggerBoundary(prev, "&")) return null;
		// 传入 Set（含 empty）= 严格白名单；未传则只认刚敲的孤立 &，
		// 避免「A & B」这种正文被当成未完成的会话引用。
		if (validSessionRefs) {
			if (!isSessionTriggerQuery(segment, validSessionRefs)) return null;
		} else if (segment.length > 0) {
			return null;
		}
		return { start, char, query: segment };
	}
	if (char === "/") {
		// 检查 / 是否属于 @file 路径（@ 在前且路径段内无空白），是则当作 @ 触发而非命令。
		// 关键：路径完成后光标后有空格/后续文本时（@src/ 说明…），必须关闭，
		// 否则路径中的每个 / 都会把建议框永久钉住。
		const beforeSlash = before.slice(0, start);
		const atBefore = beforeSlash.lastIndexOf("@");
		if (atBefore >= 0 && !/\s/.test(beforeSlash.slice(atBefore))) {
			const fileSegment = before.slice(atBefore + 1);
			if (/\s/.test(fileSegment)) return null;
			const atPrev = atBefore > 0 ? before[atBefore - 1] : "";
			if (!isComposerTriggerBoundary(atPrev, "@")) return null;
			return { start: atBefore, char: "@", query: fileSegment };
		}
	}
	if (/[\s@/&]/.test(segment)) return null;
	if (!isComposerTriggerBoundary(prev, char)) return null;
	return { start, char, query: segment };
}

export function applySuggestion(current: string, cursor: number, value: string, validSessionRefs?: Set<string>, options?: { noTrailingSpace?: boolean }): ComposerSuggestionResult {
	const trigger = detectTrigger(current, cursor, validSessionRefs);
	// 目录引用（@dir/）不带尾随空格：插入后用户继续输入路径段时，
	// 建议框会随每次按键重新评估打开，形成连续向下钻取；
	// 文件/命令引用保持默认空格，避免与后续正文粘连。
	const suffix = options?.noTrailingSpace ? "" : " ";
	if (!trigger) {
		// 无触发时插在光标处，而不是一律拼到文末——否则误开的建议框选中后
		// 会把光标/正文一起拽到结尾。
		const text = `${current.slice(0, cursor)}${value}${suffix}${current.slice(cursor)}`;
		return { text, cursor: cursor + value.length + suffix.length };
	}
	const text = `${current.slice(0, trigger.start)}${value}${suffix}${current.slice(cursor)}`;
	return { text, cursor: trigger.start + value.length + suffix.length };
}

/**
 * 关闭建议框时的文本处理。
 * 默认只关面板、不改输入——用户可能已在 @path 后继续写说明文字，
 * 若删掉从触发符到光标的整段，会把正文一起清掉（Esc 全没了）。
 * 仅当「触发后还没有任何有效查询」时（刚输入 @ / &）才去掉触发符本身，避免残留孤立符号。
 */
export function clearSuggestionTrigger(current: string, cursor: number, validSessionRefs?: Set<string>): ComposerSuggestionResult {
	const trigger = detectTrigger(current, cursor, validSessionRefs);
	if (!trigger) return { text: current, cursor };
	// 已有查询内容：保留全文，只表示关闭菜单
	if (trigger.query.length > 0) {
		return { text: current, cursor };
	}
	// 空触发符（单独的 @ / &）：去掉触发符，避免占位
	const text = `${current.slice(0, trigger.start)}${current.slice(cursor)}`;
	return { text, cursor: trigger.start };
}
