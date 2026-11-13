import type { SessionDisplayEntry } from "../SessionHistoryReader";

/**
 * 单行条目与条目表的解析/校验：预览文本（导轨卡片标题）、session-store sidecar
 * 条目表的字段校验，以及 custom 条目该不该投影成扩展卡片。
 *
 * 只做「解释」，不做 IO：读盘、缓存与索引生命周期都在宿主 `SessionHistoryReader`。
 * 字段清单必须与 `SessionDisplayEntry` 逐字段对齐（Go 侧镜像 native/session-store/table.go）。
 */

/** 分支树预览文本上限（字符）：导航级摘要足够定位消息，不需要全文。 */
export const BRANCH_PREVIEW_MAX_CHARS = 120;

/** 从单条 JSONL 原始行提取消息预览：兼容 message.content 为字符串或内容块数组，
 * 取首个文本块；非消息/无文本返回空串。与 customEntryHeadline 同是「首段信号」思路。 */
export function extractMessagePreviewFromLine(line: string): string {
	if (!line) return "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return "";
	}
	if (!isRecord(parsed)) return "";
	const message = isRecord(parsed.message) ? parsed.message : undefined;
	const content = message?.content ?? parsed.content;
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		for (const block of content) {
			if (isRecord(block) && typeof block.text === "string" && block.text.trim()) {
				text = block.text;
				break;
			}
		}
	}
	return text.replace(/\s+/g, " ").trim().slice(0, BRANCH_PREVIEW_MAX_CHARS);
}

/** 索引预览长度上限：与 Go `previewMaxChars` 一致，导轨卡片一行够用。 */
export const INDEX_PREVIEW_MAX_CHARS = 120;

/**
 * 用户消息预览（索引阶段计算，Go 侧 `messagePreviewText` 与之逐字段对齐）。
 *
 * 规则：content 为字符串；或内容块数组中第一段非空 `text`（不校验 block.type，
 * 与 extractMessagePreviewFromLine 同语义）→ 空白压成单空格 → 按完整码点截 120 字。
 */
/** 预览要跳过的注入型引用块（用户看到的标题应是「他自己打的字」）。 */
export const PREVIEW_REF_TAGS = ["quoted_context", "referenced_session", "skill", "prompt_template"] as const;

/**
 * 跳过消息开头的注入引用块，返回用户真正输入的部分。
 *
 * 为什么必须先剥再截断：预览上限 120 字，引用块正文往往更长——先截断会把
 * `<quoted_context ...>` 切成半截标签，导轨卡片就显示一坨 XML。
 * 开头有引用块但找不到闭合标签（数据损坏/被截）时返回 undefined：宁可不产预览，
 * 也不把半个标签当成标题。
 */
export function stripLeadingRefBlocks(text: string): string | undefined {
	let rest = text;
	for (;;) {
		const trimmed = rest.replace(/^\s+/, "");
		const tag = PREVIEW_REF_TAGS.find((name) => {
			const open = `<${name}`;
			if (!trimmed.startsWith(open)) return false;
			const next = trimmed.charAt(open.length);
			return next === ">" || /\s/.test(next);
		});
		if (tag === undefined) return trimmed;
		const close = trimmed.toLowerCase().indexOf(`</${tag}>`);
		if (close < 0) return undefined;
		rest = trimmed.slice(close + tag.length + 3);
	}
}

export function indexPreviewOf(message: Record<string, unknown> | undefined): string | undefined {
	const content = message?.content;
	let text: string | undefined;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		for (const block of content) {
			if (isRecord(block) && typeof block.text === "string" && block.text.trim()) {
				text = block.text;
				break;
			}
		}
	}
	if (text === undefined) return undefined;
	const human = stripLeadingRefBlocks(text);
	if (human === undefined) return undefined;
	const collapsed = human.replace(/\s+/g, " ").trim();
	if (!collapsed) return undefined;
	const codePoints = Array.from(collapsed);
	return codePoints.length > INDEX_PREVIEW_MAX_CHARS ? codePoints.slice(0, INDEX_PREVIEW_MAX_CHARS).join("") : collapsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * 校验并收窄 session-store sidecar（`get-index`）返回的条目表（Wave 2）。
 *
 * 子进程输出一律不可信（与 IPC 入参同级）：字段名、类型、可空性逐项检查，
 * 任一条目形状不符即整体判为不可用 —— 调用方回退 TS 全量重建，绝不让脏数据进索引
 * （索引错位的代价是历史错乱，比多扫一遍文件高得多）。
 *
 * 字段清单必须与 `SessionDisplayEntry` 逐字段对齐；Go 侧镜像在
 * native/session-store/table.go，两侧同步由 tests/sessionStoreIndexParity.test.mjs 对照。
 */
export function parseIndexTableRows(value: unknown): { entries: SessionDisplayEntry[]; lastEntryId?: string; endsWithNewline: boolean } | null {
	if (!isRecord(value)) return null;
	if (typeof value.endsWithNewline !== "boolean") return null;
	const rawEntries = value.entries;
	if (!Array.isArray(rawEntries)) return null;
	const entries: SessionDisplayEntry[] = [];
	for (const raw of rawEntries) {
		const entry = parseIndexTableEntry(raw);
		if (!entry) return null;
		entries.push(entry);
	}
	const lastEntryId = typeof value.lastEntryId === "string" ? value.lastEntryId : undefined;
	return { entries, lastEntryId, endsWithNewline: value.endsWithNewline };
}

export function parseIndexTableEntry(value: unknown): SessionDisplayEntry | null {
	if (!isRecord(value)) return null;
	if (typeof value.id !== "string" || typeof value.type !== "string") return null;
	if (typeof value.offset !== "number" || typeof value.byteLength !== "number") return null;
	if (typeof value.hasMessage !== "boolean") return null;
	if (value.parentId !== null && typeof value.parentId !== "string") return null;
	const entry: SessionDisplayEntry = {
		id: value.id,
		parentId: value.parentId === null ? null : ((value.parentId as string | undefined) ?? null),
		type: value.type,
		offset: value.offset,
		byteLength: value.byteLength,
		hasMessage: value.hasMessage,
	};
	const model = value.assistantModel;
	if (model !== undefined) {
		if (!isRecord(model) || typeof model.provider !== "string" || typeof model.modelId !== "string") return null;
		entry.assistantModel = { provider: model.provider, modelId: model.modelId };
	}
	if (value.oversized !== undefined) {
		if (value.oversized !== true) return null;
		entry.oversized = true;
	}
	const optionalStrings = ["modelChangeProvider", "modelChangeId", "thinkingLevel", "customType", "role", "toolName", "messageId", "summary", "firstKeptEntryId", "timestamp", "parentSession", "contextEditTargetId", "contextEditText", "preview"] as const;
	for (const key of optionalStrings) {
		const field = value[key];
		if (field === undefined) continue;
		if (typeof field !== "string") return null;
		entry[key] = field;
	}
	const optionalBooleans = ["customDisplay", "contextEditExcludes", "subagentCandidate"] as const;
	for (const key of optionalBooleans) {
		const field = value[key];
		if (field === undefined) continue;
		if (typeof field !== "boolean") return null;
		entry[key] = field;
	}
	const optionalNumbers = ["messageTimestamp", "tokensBefore"] as const;
	for (const key of optionalNumbers) {
		const field = value[key];
		if (field === undefined) continue;
		if (typeof field !== "number" || !Number.isFinite(field)) return null;
		entry[key] = field;
	}
	return entry;
}

/**
 * 从 context_edit 的 replacement.content 内容块里取可见文本（与 pi 的 content
 * 结构一致：`{type:"text", text}` 块）。
 * 无 text 块时返回 undefined：调用方回退到显示原文 + 标记，而不是显示空正文。
 */
export function contextEditTextOf(content: readonly unknown[]): string | undefined {
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object" || Array.isArray(block)) continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.length > 0 ? parts.join("") : undefined;
}

/** 内部记账类 customType 前缀：这些 type:"custom" 条目是 PiDeck / pi-subagents / pi 内置 codemode 的运行
 * 审计与状态持久化（子代理 record、start 锚点、todo 快照、codemode store() 的 KV 写入等）。pi 自身不
 * 给它们注册 entry renderer，正常不会出现在注册集合里；这里无条件排除是防御（扫描不到的路径误放）。 */
export const INTERNAL_CUSTOM_TYPE_PREFIXES: readonly string[] = ["subagents:", "pi-deck-", "codemode-"];

/** 显示读入口（时间线窗口/分页）的投影上下文：entryRendererTypes 是「本次会话加载的扩展源码里
 * registerEntryRenderer 注册的 customType 集合」，由调用方按项目扩展配置扫描（extensionEntryRendererScan.ts）。 */
export type SessionDisplayReadOptions = { entryRendererTypes?: readonly string[] };
/** 扩展输出卡片的 data 载荷上限（序列化后字符数）：超出则不携带原始数据、只带标题，避免大体量快照进渲染层。 */
export const CUSTOM_ENTRY_DATA_MAX_JSON_LENGTH = 16 * 1024;

/**
 * customType 是否投影成时间线扩展输出卡。口径与 pi 对齐（docs/session-format.md）：只有注册了
 * entry renderer 的 custom 条目才算 transcript 内容。PiDeck 在读侧拿不到 pi 进程内的注册表，由
 * 调用方传入静态扫描结果；集合为空/类型未注册 → 不投影（默认隐藏）。此前「黑名单之外全显示」
 * 会让第三方扩展的内部 appendEntry 记账漏成裸 JSON 卡（用户反馈的 codemode-store 只是其一）。
 */
export function isDisplayableCustomEntryType(customType: string | undefined, registeredEntryRendererTypes: readonly string[]): boolean {
	if (!customType) return false;
	if (INTERNAL_CUSTOM_TYPE_PREFIXES.some((prefix) => customType.startsWith(prefix))) return false;
	return registeredEntryRendererTypes.includes(customType);
}

/** 扩展输出卡片的折叠行预览：优先取 data 里首个非空字符串字段（如 pi-plan-btw 的 query），否则退化成截断 JSON。 */
export function customEntryHeadline(data: unknown): string {
	if (typeof data === "string") return data.slice(0, 120);
	if (isRecord(data)) {
		for (const value of Object.values(data)) {
			if (typeof value === "string" && value.trim()) return value.slice(0, 120);
		}
	}
	try {
		const serialized = JSON.stringify(data) ?? "";
		return serialized.slice(0, 120);
	} catch {
		return "";
	}
}
