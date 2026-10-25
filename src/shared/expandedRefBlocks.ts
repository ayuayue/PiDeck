/**
 * 自包含引用块的纯解析层（主进程 / 渲染进程共用）。
 *
 * 用户消息里会持久化四类自包含块（发送时展开，模型读全文；展示时折叠成 chip）：
 *   <quoted_context label="…" message_id="…">…</quoted_context>
 *   <referenced_session name="…">…</referenced_session>
 *   <skill name="…">…</skill>                    （pi 展开 /skill:名称）
 *   <prompt_template name="…">…</prompt_template>（PiDeck 展开 /模板名）
 * 另有一族方括号视觉桥块（pi-deck-vision 扩展在 input 阶段把图片转文字后写入）：
 *   [图片 #N（视觉桥已查看…）]＋描述 / [图片 #N 视觉桥转换失败…] / [图片 #N 未发送给模型…]
 * 标题派生同样必须剥它们（extractVisionBridgeBlocks，本模块自包含、零 import：
 * tests/sessionScannerTitleBackfill 的手写加载器按 tests/ 目录解析相对 import，新增依赖会整片 MODULE_NOT_FOUND）。
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

// 视觉桥块解析在独立模块（块结构与本模块的四类 XML 块无关，避免正则/类型交叉）。
// 视觉桥块的内联解析（原先独立在 shared/visionBridgeText，但本模块必须零 import：
// tests/sessionScannerTitleBackfill 的手写加载器把相对 import 按 tests/ 目录解析，新增依赖会整片 MODULE_NOT_FOUND）。
export type VisionBridgeBlock =
	| { kind: "success"; index: number; description: string }
	| { kind: "failed"; index: number; reason: string }
	/** 图片未进入转换流程（桥没开/没选模型）：中性提示卡，不是错误 */
	| { kind: "skipped"; index: number; reason: string };

/** 成功标记：兼容「（视觉桥已查看）」与「（视觉桥已查看，以下为图片实际内容）」两种后缀。 */
const VISION_SUCCESS_MARK_RE = /\[图片 #(\d+)（视觉桥已查看[^）]*）\]/g;
/** 失败标记：整块自包含（原因 + 修复指引 + 收尾句）。 */
const VISION_FAILED_MARK_RE = /\[图片 #(\d+)\s+视觉桥转换失败：([\s\S]*?)。请检查视觉桥设置[\s\S]*?此图片内容不可见\]/g;
/** 未发送标记：`[图片 #N 未发送给模型：<原因>]`，原因里不应出现 `]`。 */
const VISION_SKIPPED_MARK_RE = /\[图片 #(\d+)\s+未发送给模型：([\s\S]*?)\]/g;
/** 历史遗留：旧版把「视觉桥没开」也写成失败标记，原因固定以「视觉桥未配置」开头，按未发送归一化。 */
const VISION_LEGACY_NOT_CONFIGURED_RE = /^视觉桥未配置/;

/** 剥离三类视觉桥标记块：返回结构化块（渲染层卡片用）与剥除后的剩余正文。 */
export function extractVisionBridgeBlocks(text: string): {
	blocks: VisionBridgeBlock[];
	text: string;
} {
	type Mark = { start: number; end: number; block: VisionBridgeBlock };
	const marks: Mark[] = [];
	for (const m of text.matchAll(VISION_FAILED_MARK_RE)) {
		const reason = m[2].trim();
		marks.push({ start: m.index, end: m.index + m[0].length, block: VISION_LEGACY_NOT_CONFIGURED_RE.test(reason) ? { kind: "skipped", index: Number(m[1]), reason } : { kind: "failed", index: Number(m[1]), reason } });
	}
	for (const m of text.matchAll(VISION_SKIPPED_MARK_RE)) {
		marks.push({ start: m.index, end: m.index + m[0].length, block: { kind: "skipped", index: Number(m[1]), reason: m[2].trim() } });
	}
	for (const m of text.matchAll(VISION_SUCCESS_MARK_RE)) {
		// 描述文本在第二轮按「下一个标记」边界补齐
		marks.push({ start: m.index, end: m.index + m[0].length, block: { kind: "success", index: Number(m[1]), description: "" } });
	}
	marks.sort((a, b) => a.start - b.start);
	if (marks.length === 0) return { blocks: [], text };
	// 成功块的完整区间延伸到下一个标记（或文本末尾），中间即描述。真实链路里描述总被追加在正文后，
	// 该边界对标题剥离安全；描述里出现「[图片 #N」字样会被误当新块，展示层容错，可接受。
	for (let i = 0; i < marks.length; i++) {
		if (marks[i].block.kind !== "success") continue;
		const nextStart = i + 1 < marks.length ? marks[i + 1].start : text.length;
		const block = marks[i].block as Extract<VisionBridgeBlock, { kind: "success" }>;
		block.description = text.slice(marks[i].end, nextStart).replace(/^\n+/, "").trim();
		marks[i].end = nextStart;
	}
	let cleaned = text;
	for (let i = marks.length - 1; i >= 0; i--) {
		cleaned = cleaned.slice(0, marks[i].start) + cleaned.slice(marks[i].end);
	}
	return { blocks: marks.map((m) => m.block), text: cleaned.replace(/\n{3,}/g, "\n\n").trim() };
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

/**
 * 统一后的自包含块（quote / session / skill / template）。
 *
 * `skill` 与 `template` 是两个类型而不是一个：pi 自己就把技能与提示词模板分成两种资源
 * （`get_commands` 的 `source: "skill"` / `source: "prompt"`），转换语义完全不同（技能只重建
 * `/skill:名称`，模板只重建 `/模板名`）。展示层可以共用同一套斜杠视觉，但数据层必须能区分，
 * 否则未来任何「按类型处理」的需求都要靠 label 前缀猜。
 */
export type ExpandedRefBlock =
	| { kind: "quote"; label: string; messageId: string; text: string; start: number; end: number }
	| { kind: "session"; name: string; text: string; start: number; end: number }
	| { kind: "skill"; label: string; text: string; start: number; end: number }
	| { kind: "template"; label: string; text: string; start: number; end: number };

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
			// 独立 kind：与 pi 的资源类型对齐（skill / prompt 两种），展示层再决定复用哪套视觉。
			kind: "template" as const,
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
	// 视觉桥块先剥：图片在 input 阶段被转成「[图片 #N…]＋视觉模型描述」追加在正文后，
	// 标记行与描述都不是用户手写的话；只发图不写字时剥完为空，调用方回退到 assistant 首条文本
	//（2026-10 现场：只发图的消息把会话自动命名为「[图片 #1（视觉桥已查看…）]」）。
	const stripped = extractVisionBridgeBlocks(text).text;
	if (!stripped.includes("<")) return stripped;
	const blocks = parseExpandedRefBlocks(stripped);
	if (blocks.length === 0) return stripped;
	const outside: string[] = [];
	const labels: string[] = [];
	let cursor = 0;
	for (const block of blocks) {
		if (block.start > cursor) outside.push(stripped.slice(cursor, block.start));
		labels.push(expandedRefBlockLabel(block));
		cursor = block.end;
	}
	if (cursor < stripped.length) outside.push(stripped.slice(cursor));
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
	// 视觉桥标记开头的存量脏标题按用户决定不自动重命名（旧会话名保持稳定），
	// 不在此判定；新会话的正确命名由 textForSessionTitle 剥块保证。
	if (!title?.includes("<")) return false;
	// 完整块（带闭合标签）一定能解析出来，块不在开头（`帮我看看 <quoted_context …>`）也命中。
	if (parseExpandedRefBlocks(title).length > 0) return true;
	// 写入方截断/只落了半个块时没有闭合标签，按「带 name/label 属性的块开标签」判定。
	// 不用裸 `<skill>` 之类无属性形态，避免把用户手写的「<skill> 是什么意思」误判成脏标题。
	return /<(?:quoted_context|referenced_session|skill|prompt_template)\b[^>]*\b(?:name|label)="/i.test(title);
}
