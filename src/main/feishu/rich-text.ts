/**
 * 飞书富文本渲染 — 从 pi-feishu-lark 移植
 *
 * 根据文本内容智能选择飞书消息类型：
 * - text：纯文本（短消息，无格式）
 * - post：飞书富文本（中等长度，含表格、列表、加粗等）
 * - interactive：卡片消息（长消息，含代码块、标题等，支持 markdown 渲染）
 *
 * 飞书卡片的 markdown 不支持表格，所以含表格的短消息改用 post 格式。
 */

const POST_LENGTH_THRESHOLD = 250;
const INTERACTIVE_LENGTH_THRESHOLD = 1200;
const MAX_POST_CHARS = 3500;
const MAX_CARD_BYTES = 29 * 1024;

export type FeishuMessageMode = "text" | "post" | "interactive";

/** 根据内容特征自动选择最佳消息模式 */
export function chooseMessageMode(text: string): FeishuMessageMode {
	const trimmed = text.trim();
	if (!trimmed) return "text";
	const metrics = analyzeText(trimmed);
	if (
		trimmed.length >= INTERACTIVE_LENGTH_THRESHOLD ||
		metrics.hasTable ||
		metrics.codeBlockCount > 0 ||
		metrics.headingCount >= 3 ||
		metrics.listItemCount >= 8 ||
		metrics.linkCount >= 5
	) {
		return "interactive";
	}
	if (metrics.lineCount >= 2 && (metrics.looksLikeMarkdown || trimmed.length >= POST_LENGTH_THRESHOLD)) return "post";
	return "text";
}

/** 构建 post 富文本消息（飞书原生表格支持） */
export function buildPostMessages(text: string, language: "zh" | "en" = "zh") {
	return splitText(text.trim() || "(empty response)", MAX_POST_CHARS).map((chunk, index, chunks) => {
		const parsed = markdownToPost(chunk, language);
		const title = chunks.length > 1 ? `${parsed.title} (${index + 1}/${chunks.length})` : parsed.title;
		const locale = language === "en" ? "en_us" : "zh_cn";
		const post = {
			title,
			content: parsed.content.length ? parsed.content : [[{ tag: "text", text: chunk }]],
		};
		return {
			[locale]: post,
			[fallbackLocale(locale)]: post,
		};
	});
}

/** 构建 markdown 卡片消息（含智能分片和复制原文按钮） */
export function buildMarkdownCards(text: string, language: "zh" | "en" = "zh") {
	return buildMarkdownCardParts(text, language).map((part) => part.card);
}

export type MarkdownCardPart = {
	card: object;
	markdown: string;
};

export function buildMarkdownCardParts(text: string, language: "zh" | "en" = "zh"): MarkdownCardPart[] {
	const trimmed = text.trim() || "(empty response)";
	const { title, body } = extractMarkdownTitle(trimmed, language);
	const fullCard = createMarkdownCard(title, body || trimmed);
	if (byteSize(fullCard) < MAX_CARD_BYTES) {
		const markdown = body || trimmed;
		return [{ card: createMarkdownCard(title, markdown), markdown }];
	}

	const parts = splitMarkdownToFit(body || trimmed, title);
	if (parts.length === 1) return [{ card: createMarkdownCard(title, parts[0]), markdown: parts[0] }];
	return parts.map((part, index) => ({
		card: createMarkdownCard(`${title} (${index + 1}/${parts.length})`, part),
		markdown: part,
	}));
}

// ===== 内部工具函数 =====

type PostElement = {
	tag: "text" | "a";
	text: string;
	href?: string;
	style?: string[];
};

type LocaleKey = "zh_cn" | "en_us";

function analyzeText(text: string) {
	const lines = text.split(/\r?\n/);
	const lineCount = lines.filter((line) => line.trim()).length;
	const tableLineCount = lines.filter((line) => /^\s*\|.+\|\s*$/.test(line)).length;
	const hasTableSeparator = lines.some((line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line));
	return {
		lineCount,
		looksLikeMarkdown: looksLikeMarkdown(text),
		hasTable: tableLineCount >= 2 && hasTableSeparator,
		codeBlockCount: (text.match(/```/g) || []).length >= 2 ? Math.floor((text.match(/```/g) || []).length / 2) : 0,
		headingCount: lines.filter((line) => /^#{1,6}\s+\S/.test(line.trim())).length,
		listItemCount: lines.filter((line) => /^\s*([-*+]|\d+\.)\s+\S/.test(line)).length,
		linkCount: (text.match(/\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/g) || []).length,
	};
}

function looksLikeMarkdown(text: string) {
	return [
		/^#{1,6}\s+\S/m,
		/^\s*[-*+]\s+\S/m,
		/^\s*\d+\.\s+\S/m,
		/^>\s+\S/m,
		/```[\s\S]*?```/,
		/\*\*[^*\n][\s\S]*?\*\*/,
		/`[^`\n]+`/,
		/\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/,
		/^\s*\|.+\|\s*$/m,
	].some((pattern) => pattern.test(text));
}

function markdownToPost(text: string, language: "zh" | "en") {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const titleIndex = lines.findIndex((line) => line.trim());
	const firstLine = titleIndex >= 0 ? lines[titleIndex].trim() : "";
	const heading = firstLine.match(/^#{1,6}\s+(.+)$/);
	const title = cleanInlineMarkdown(heading?.[1] || firstLine || (language === "en" ? "Pi reply" : "Pi 回复")).slice(0, 120);
	const content: PostElement[][] = [];
	let inCodeBlock = false;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const trimmed = raw.trim();
		if (!trimmed) continue;
		if (i === titleIndex) continue;
		if (/^```/.test(trimmed)) {
			inCodeBlock = !inCodeBlock;
			continue;
		}

		if (inCodeBlock) {
			content.push([{ tag: "text", text: raw }]);
			continue;
		}

		const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
		if (headingMatch) {
			content.push([{ tag: "text", text: cleanInlineMarkdown(headingMatch[1]), style: ["bold"] }]);
			continue;
		}

		const quoteMatch = trimmed.match(/^>\s+(.+)$/);
		if (quoteMatch) {
			content.push([{ tag: "text", text: `> ${cleanInlineMarkdown(quoteMatch[1])}` }]);
			continue;
		}

		const listMatch = trimmed.match(/^([-*+]|\d+\.)\s+(.+)$/);
		if (listMatch) {
			content.push([{ tag: "text", text: `${listMatch[1].match(/\d+\./) ? listMatch[1] : "•"} ${cleanInlineMarkdown(listMatch[2])}` }]);
			continue;
		}

		// 表格行 → 用特殊分隔符保留表格结构
		if (/^\s*\|.+\|\s*$/.test(raw)) {
			content.push([{ tag: "text", text: formatTableLine(raw) }]);
			continue;
		}

		content.push(parseInlineElements(trimmed));
	}

	return { title, content };
}

function extractMarkdownTitle(text: string, language: "zh" | "en") {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const titleIndex = lines.findIndex((line) => line.trim());
	if (titleIndex < 0) return { title: language === "en" ? "Pi reply" : "Pi 回复", body: text };
	const firstLine = lines[titleIndex].trim();
	const heading = firstLine.match(/^#{1,6}\s+(.+)$/);
	const title = cleanInlineMarkdown(heading?.[1] || firstLine || (language === "en" ? "Pi reply" : "Pi 回复")).slice(0, 120);
	const body = lines
		.filter((_, index) => index !== titleIndex)
		.join("\n")
		.trim();
	return { title, body };
}

function createMarkdownCard(title: string, content: string) {
	return {
		schema: "2.0",
		config: { wide_screen_mode: true, update_multi: true },
		header: {
			title: { tag: "plain_text", content: title },
			template: "blue",
		},
		body: {
			elements: [
				{ tag: "markdown", content },
			],
		},
	};
}

function splitMarkdownToFit(markdown: string, title: string) {
	const queue = splitMarkdownBlocks(markdown);
	const parts: string[] = [];
	let current = "";

	for (const block of queue) {
		if (!block.trim()) continue;
		const candidate = current ? `${current}\n\n${block}` : block;
		if (fitsMarkdownCard(title, candidate)) {
			current = candidate;
			continue;
		}
		if (current) {
			parts.push(current);
			current = "";
		}
		if (fitsMarkdownCard(title, block)) {
			current = block;
			continue;
		}
		parts.push(...splitOversizedBlock(block, title));
	}

	if (current) parts.push(current);
	return parts.length ? parts : [markdown];
}

function splitMarkdownBlocks(markdown: string) {
	return splitByHeading(markdown, /^##\s+/m)
		.flatMap((block) => splitByHeading(block, /^###\s+/m))
		.flatMap((block) => block.split(/\n{2,}/))
		.map((block) => block.trim())
		.filter(Boolean);
}

function splitByHeading(markdown: string, pattern: RegExp) {
	const lines = markdown.split("\n");
	const blocks: string[] = [];
	let current: string[] = [];

	for (const line of lines) {
		if (pattern.test(line) && current.length) {
			blocks.push(current.join("\n").trim());
			current = [];
		}
		current.push(line);
	}
	if (current.length) blocks.push(current.join("\n").trim());
	return blocks.filter(Boolean);
}

function splitOversizedBlock(block: string, title: string) {
	const parts: string[] = [];
	let current = "";
	for (const line of block.split("\n")) {
		const candidate = current ? `${current}\n${line}` : line;
		if (fitsMarkdownCard(title, candidate)) {
			current = candidate;
			continue;
		}
		if (current) {
			parts.push(current);
			current = "";
		}
		if (fitsMarkdownCard(title, line)) {
			current = line;
			continue;
		}
		parts.push(...splitLongText(line, title));
	}
	if (current) parts.push(current);
	return parts;
}

function splitLongText(text: string, title: string) {
	const parts: string[] = [];
	let rest = text;
	while (rest) {
		let low = 1;
		let high = rest.length;
		let best = 1;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if (fitsMarkdownCard(title, rest.slice(0, mid))) {
				best = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		parts.push(rest.slice(0, best));
		rest = rest.slice(best);
	}
	return parts;
}

function fitsMarkdownCard(title: string, content: string) {
	return byteSize(createMarkdownCard(title, content)) < MAX_CARD_BYTES;
}

function parseInlineElements(text: string): PostElement[] {
	const out: PostElement[] = [];
	const linkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
	let lastIndex = 0;
	for (const match of text.matchAll(linkPattern)) {
		const index = match.index ?? 0;
		if (index > lastIndex) {
			out.push({ tag: "text", text: cleanInlineMarkdown(text.slice(lastIndex, index)) });
		}
		out.push({ tag: "a", text: cleanInlineMarkdown(match[1]), href: match[2] });
		lastIndex = index + match[0].length;
	}
	if (lastIndex < text.length) {
		out.push({ tag: "text", text: cleanInlineMarkdown(text.slice(lastIndex)) });
	}
	return out.length ? out : [{ tag: "text", text }];
}

function cleanInlineMarkdown(text: string) {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.trim();
}

function formatTableLine(line: string) {
	const cells = line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
	// 分隔行（---等）替换为虚线
	if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return "----------------";
	return cells.join("  |  ");
}

function splitText(text: string, max: number) {
	const out: string[] = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut < max * 0.5) cut = max;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).trimStart();
	}
	out.push(rest);
	return out;
}

function byteSize(value: unknown) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fallbackLocale(locale: LocaleKey): LocaleKey {
	return locale === "zh_cn" ? "en_us" : "zh_cn";
}
