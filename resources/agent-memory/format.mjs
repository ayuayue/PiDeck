/**
 * 记忆条目的序列化/反序列化。
 *
 * 文件就是一串由 `\n§\n` 分节的纯文本块——刻意保持「用户用任意编辑器都能改」的形态，
 * 所以解析必须宽容：多余空行、首尾空白、CRLF 都不应该破坏条目。
 *
 * `failure` 目标多一层分类前缀（`[correction] ...`），对齐 hermes 的按类计数与
 * 「纠正 > 教训」的优先级；其他目标就是纯文本块。
 */

import { ENTRY_DELIMITER, FAILURE_CATEGORIES } from "./paths.mjs";

/** 把文件内容拆成条目数组；空块与纯空白块丢弃。 */
export function parseEntries(text) {
	if (typeof text !== "string" || text.length === 0) return [];
	return text
		.split(ENTRY_DELIMITER)
		.map((block) => block.replace(/\r\n/g, "\n").trim())
		.filter((block) => block.length > 0);
}

/** 把条目数组拼回文件内容；保留末尾换行，便于用户编辑器与 diff 工具。 */
export function renderEntries(entries) {
	if (entries.length === 0) return "";
	return `${entries.join(ENTRY_DELIMITER)}\n`;
}

/**
 * 去重键：折叠所有空白。这样「同一句话多打了空格/换行」不会被当成两条新记忆，
 * 也让 `replace` 能在不改写其他条目的前提下定位目标。
 */
export function normalizeKey(content) {
	return String(content)
		.replace(/\r\n/g, "\n")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** 去重：保留首次出现的顺序，后来的重复项被丢弃。 */
export function dedupeEntries(entries) {
	const seen = new Set();
	const result = [];
	for (const entry of entries) {
		const key = normalizeKey(entry);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

/** 超预算裁剪：从**最老的**开始丢（文件按追加顺序排列），返回被丢掉的条数。 */
export function trimEntries(entries, budget) {
	let kept = entries.slice();
	let dropped = 0;
	while (kept.length > 0 && (kept.length > budget.maxEntries || renderEntries(kept).length > budget.maxChars)) {
		kept.shift();
		dropped += 1;
	}
	return { entries: kept, dropped };
}

/** `failure` 条目 → `{ category, content }`；没有合法前缀时按 `insight` 归。 */
export function parseFailureEntry(block) {
	const match = /^\[([a-z-]+)\]\s*([\s\S]*)$/.exec(block.trim());
	if (match && FAILURE_CATEGORIES.includes(match[1])) return { category: match[1], content: match[2].trim() };
	return { category: "insight", content: block.trim() };
}

/** `{ category, content }` → `failure` 条目文本。 */
export function formatFailureEntry(category, content) {
	const safeCategory = FAILURE_CATEGORIES.includes(category) ? category : "insight";
	return `[${safeCategory}] ${content.trim()}`;
}

/** 从任意条目文本里取分类（非 failure 目标返回空串）。 */
export function entryCategory(block) {
	return parseFailureEntry(block).category;
}
