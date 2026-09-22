/**
 * 自包含引用块的纯解析层（主进程 / 渲染进程共用）。
 *
 * 用户消息里会持久化四类自包含块（发送时展开，模型读全文；展示时折叠成 chip）：
 *   <quoted_context label="…" message_id="…">…</quoted_context>
 *   <referenced_session name="…">…</referenced_session>
 *   <skill name="…">…</skill>                    （pi 展开 /skill:名称）
 *   <prompt_template name="…">…</prompt_template>（PiDeck 展开 /模板名）
 *
 * 任何面向人的纯文本出口（侧栏会话 preview、Web 端消息、子代理转录、会话定位轴标题、
 * 复制/队列预览）都必须先折叠成 `❝label` / `&名称` / `/名称`，不能漏出 XML 原文。
 *
 * 放在 shared 而不是 renderer：主进程（SessionScanner / WebServiceManager）同样需要，
 * 且不能反向依赖渲染层。本模块无 React / 无 Node 依赖，可被 node:test 直接加载。
 */

/** XML 属性转义（label / name / messageId 可能含引号、尖括号）。 */
export function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** XML 属性反转义（仅处理本模块生成的四种实体）。 */
export function decodeXmlAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

/** 正文里的闭合标签会提前截断解析：写入前改写成无害形态。 */
export function sanitizeBlockClosingTag(value: string, tagName: string): string {
	return value.replace(new RegExp(`</${tagName}>`, "gi"), `</${tagName}_>`);
}

/**
 * 模板命令的发送/存储形态。
 * 模板正文仍完整发给模型，但 name 同时持久化，因此会话重载后不必依赖当前模板列表
 * （模板被改名、删除或切换项目时也能还原原来的 /name chip）。
 */
export function formatPromptTemplateBlock(name: string, content: string): string {
	const safeName = escapeXmlAttribute(name);
	const safeContent = sanitizeBlockClosingTag(content, "prompt_template");
	// 不 trim 模板正文：空行也可能是提示词的刻意结构；仅在 tag 边界补必要换行。
	const openingBreak = /^\r?\n/.test(safeContent) ? "" : "\n";
	const closingBreak = /\r?\n$/.test(safeContent) ? "" : "\n";
	return `<prompt_template name="${safeName}">${openingBreak}${safeContent}${closingBreak}</prompt_template>`;
}

/** 解析后的命名消息块（skill / prompt_template 共用）。 */
export type ExpandedNamedReferenceBlock = {
	name: string;
	text: string;
	start: number;
	end: number;
};

function parseNamedReferenceBlocks(text: string, tagName: "skill" | "prompt_template"): ExpandedNamedReferenceBlock[] {
	if (!text.includes(`<${tagName}`)) return [];
	const re = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, "gi");
	const blocks: ExpandedNamedReferenceBlock[] = [];
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const attrs = match[1] ?? "";
		const name = /\bname="([^"]*)"/i.exec(attrs)?.[1];
		if (!name) continue;
		blocks.push({
			name: decodeXmlAttribute(name),
			text: (match[2] ?? "").replace(/^\r?\n|\r?\n$/g, ""),
			start: match.index,
			end: match.index + match[0].length,
		});
	}
	return blocks;
}

/** 从 pi 展开的 `<skill name="…">…</skill>` 块恢复技能名。 */
export function parseExpandedSkillBlocks(text: string): ExpandedNamedReferenceBlock[] {
	return parseNamedReferenceBlocks(text, "skill");
}

/** 从 PiDeck 展开的 `<prompt_template name="…">…</prompt_template>` 块恢复模板名。 */
export function parseExpandedPromptTemplateBlocks(text: string): ExpandedNamedReferenceBlock[] {
	return parseNamedReferenceBlocks(text, "prompt_template");
}

/** 解析结果：引用块（含在原文中的区间）。 */
export type ExpandedQuoteBlock = {
	label: string;
	messageId: string;
	text: string;
	start: number;
	end: number;
};

const QUOTED_CONTEXT_RE = /<quoted_context\s+label="([^"]*)"\s+message_id="([^"]*)">\r?\n([\s\S]*?)\r?\n<\/quoted_context>/g;

/**
 * 从消息文本中解析已展开的引用块（formatQuoteBlock 的逆操作）。
 * 块自带 label/messageId/全文，展示时可直接渲染 chip；找不到块时返回空列表。
 * 兼容旧消息：旧格式 markdown 引用块（`> 行`）不匹配，保持展开文本展示（无法追溯）。
 */
export function parseExpandedQuoteBlocks(text: string): ExpandedQuoteBlock[] {
	const blocks: ExpandedQuoteBlock[] = [];
	const re = new RegExp(QUOTED_CONTEXT_RE.source, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		blocks.push({
			label: decodeXmlAttribute(m[1] ?? ""),
			messageId: decodeXmlAttribute(m[2] ?? ""),
			text: m[3] ?? "",
			start: m.index,
			end: m.index + m[0].length,
		});
	}
	return blocks;
}

/** 已展开的会话引用块（&会话名 发送时由 resolveSessionReferences 展开为 XML）。 */
export type ExpandedSessionBlock = {
	/** 会话展示名（xml name 属性，解码后）。 */
	name: string;
	/** 引用的会话上下文全文（发给模型的原始内容，可能很长）。 */
	text: string;
	start: number;
	end: number;
};

const REFERENCED_SESSION_RE = /<referenced_session\s+name="([^"]*)">\r?\n([\s\S]*?)\r?\n<\/referenced_session>/g;

/**
 * 从消息文本中解析已展开的会话引用块（`&会话名` → `<referenced_session name="…">…</referenced_session>`）。
 * 发送时 resolveSessionReferences 把 `&会话名` 替换为完整上下文块（模型需要看到引用内容）；
 * 展示时折叠回 session chip（label = 会话名），避免大段 XML 原文展开。
 */
export function parseExpandedSessionBlocks(text: string): ExpandedSessionBlock[] {
	if (!text.includes("<referenced_session")) return [];
	const blocks: ExpandedSessionBlock[] = [];
	const re = new RegExp(REFERENCED_SESSION_RE.source, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		blocks.push({
			name: decodeXmlAttribute(m[1] ?? ""),
			text: m[2] ?? "",
			start: m.index,
			end: m.index + m[0].length,
		});
	}
	return blocks;
}

/** 统一后的引用块（quote / session / skill）。 */
export type ExpandedRefBlock = { kind: "quote"; label: string; messageId: string; text: string; start: number; end: number } | { kind: "session"; name: string; text: string; start: number; end: number } | { kind: "skill"; label: string; text: string; start: number; end: number };

/**
 * 统一解析消息文本中所有需要折叠展示的自包含块。
 *
 * `referenced_session` 的上下文可能包含历史的 quoted_context/skill 块；排序后必须跳过
 * 已被外层块覆盖的内层结果，否则展示层会重复插入 chip 并漏出一截 XML 正文。
 */
export function parseExpandedRefBlocks(text: string): ExpandedRefBlock[] {
	const blocks: ExpandedRefBlock[] = [
		...parseExpandedQuoteBlocks(text).map((b) => ({
			kind: "quote" as const,
			label: b.label,
			messageId: b.messageId,
			text: b.text,
			start: b.start,
			end: b.end,
		})),
		...parseExpandedSessionBlocks(text).map((b) => ({
			kind: "session" as const,
			name: b.name,
			text: b.text,
			start: b.start,
			end: b.end,
		})),
		...parseExpandedSkillBlocks(text).map((b) => ({
			kind: "skill" as const,
			// pi 的 XML 只保存 skill 名；还原为输入框一致的 /skill:name 形态。
			label: `skill:${b.name}`,
			text: b.text,
			start: b.start,
			end: b.end,
		})),
		...parseExpandedPromptTemplateBlocks(text).map((b) => ({
			kind: "skill" as const,
			// 模板在 composer 中本来就是 /模板名，复用 skill chip 的斜杠视觉语义。
			label: b.name,
			text: b.text,
			start: b.start,
			end: b.end,
		})),
	];
	blocks.sort((a, b) => a.start - b.start || b.end - a.end);

	const topLevel: ExpandedRefBlock[] = [];
	let coveredEnd = -1;
	for (const block of blocks) {
		if (block.start < coveredEnd) continue;
		topLevel.push(block);
		coveredEnd = block.end;
	}
	return topLevel;
}

/** 块折叠后的展示标签（复制/预览/标题共用一套形态，避免各处自造写法）。 */
function expandedRefBlockLabel(block: ExpandedRefBlock): string {
	return block.kind === "quote" ? `❝${block.label}` : block.kind === "session" ? `&${block.name}` : `/${block.label}`;
}

/**
 * 把消息文本中的自包含块替换为 `❝label` / `&会话名` / `/命令` 展示文本。
 * 供复制、队列预览、侧栏 preview、Web 端、子代理转录等所有纯文本出口使用，
 * 避免这些 UI 暴露模型需要的 XML 上下文。顺序按原位置保留。
 */
export function replaceExpandedRefBlocksWithLabels(text: string): string {
	if (!text.includes("<quoted_context") && !text.includes("<referenced_session") && !text.includes("<skill") && !text.includes("<prompt_template")) {
		return text;
	}
	const blocks = parseExpandedRefBlocks(text);
	if (blocks.length === 0) return text;
	const parts: string[] = [];
	let cursor = 0;
	for (const block of blocks) {
		if (block.start > cursor) parts.push(text.slice(cursor, block.start));
		parts.push(expandedRefBlockLabel(block));
		cursor = block.end;
	}
	if (cursor < text.length) parts.push(text.slice(cursor));
	return parts.join("");
}

/**
 * 会话标题专用清洗：只保留块外由用户自己写的文字，块正文（模板全文、引用全文、技能说明）不进标题。
 *
 * 与 preview 的诉求不同：preview 要回答「用户引用了什么」，块标签原地保留即可；
 * 标题只需要一句话概括这次会话要做什么，把两千字的模板正文写进标题就是纯噪声
 *（2026-10 现场：首条消息用 /模板 时占位标题被写成 `<prompt_template …>` 原文）。
 * 块外没有任何文字（只插了 /模板 就发送）时回退到块标签（`/模板名`），保证标题不落空。
 */
export function textForSessionTitle(text: string): string {
	if (!text.includes("<")) return text;
	const blocks = parseExpandedRefBlocks(text);
	if (blocks.length === 0) return text;
	const outside: string[] = [];
	const labels: string[] = [];
	let cursor = 0;
	for (const block of blocks) {
		if (block.start > cursor) outside.push(text.slice(cursor, block.start));
		labels.push(expandedRefBlockLabel(block));
		cursor = block.end;
	}
	if (cursor < text.length) outside.push(text.slice(cursor));
	// 块之间的分隔换行只用于排版，标题里合并成一个空格（存储层仍不截断）。
	const outsideText = outside.join(" ").replace(/\s+/g, " ").trim();
	return outsideText || labels.join(" ");
}

/**
 * 标题是否残留未折叠的自包含块原文（历史脏标题）。
 *
 * 这类标题没有任何信息价值，调用方必须当占位名处理，允许用首条消息/扫描结果重新覆盖；
 * 否则标题一旦被写成 `<prompt_template …>` 就不再是「默认名」，自动命名永远不会再修它
 *（2026-10 现场：总结失败时 XML 标题永久留在侧栏）。
 */
export function looksLikeExpandedRefBlockTitle(title: string | undefined): boolean {
	if (!title?.includes("<")) return false;
	// 完整块（带闭合标签）一定能解析出来，块不在开头（`帮我看看 <quoted_context …>`）也命中。
	if (parseExpandedRefBlocks(title).length > 0) return true;
	// 写入方截断/只落了半个块时没有闭合标签，按「带 name/label 属性的块开标签」判定。
	// 不用裸 `<skill>` 之类无属性形态，避免把用户手写的「<skill> 是什么意思」误判成脏标题。
	return /<(?:quoted_context|referenced_session|skill|prompt_template)\b[^>]*\b(?:name|label)="/i.test(title);
}
