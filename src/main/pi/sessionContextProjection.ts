/**
 * 会话上下文投影（纯函数，无 fs / electron 依赖）。
 *
 * 与 pi `dist/core/session-manager.js` 的 `buildSessionProjection` 语义对齐：
 * 1. 沿 leaf 的 parentId 链得到活动分支（`buildSessionPath`）；
 * 2. 分支上有 compaction 时，只保留最新一条 compaction + 它之后的保留区间
 *    （`firstKeptEntryId` 起算，跳过 message.role === "system" 的历史），
 *    更早的条目已被摘要替代（`buildContextEntries`）；
 * 3. 在有效条目上收集 `context_edit`（同一 targetId 后者覆盖前者）并应用：
 *    `replacement === null` 表示该条不再进入模型上下文；否则按消息角色替换内容
 *    （assistant / toolResult 的字符串内容会被包装成 text block，与 pi 一致）。
 *
 * 为什么 PiDeck 需要自己的实现：pi 的这份投影只在 pi 进程内可用，而 PiDeck 需要
 * 在「不启动 pi」的情况下展示历史（离线 Viewer / Web / 历史页）。两者必须是同一套
 * 语义，否则同一会话在桌面时间线与模型实际看到的内容会漂移。
 *
 * 它只回答「模型当前能看到什么」，不回答「文件里曾经有什么」：
 * 原始条目一律保留（`context_edit` 是追加记录，不改写目标行）。
 */

/** JSONL 条目：只声明本模块消费的字段，其余原样透传。 */
export type SessionEntryLike = {
	id?: unknown;
	parentId?: unknown;
	type?: unknown;
	message?: unknown;
	targetId?: unknown;
	replacement?: unknown;
	firstKeptEntryId?: unknown;
	summary?: unknown;
	timestamp?: unknown;
};

export type ContextEditReplacement =
	/** 不再把目标条目送入模型上下文（`replacement: null`）。 */
	| { kind: "excluded" }
	/** 用给定内容替换目标条目的内容。 */
	| { kind: "replaced"; content: unknown }
	/**
	 * 形态不合 pi 写入端约定（畸形 / 手工编辑 / 未来格式）：按「无有效编辑」处理。
	 * 宁可显示原文，也不凭空把消息移出上下文 —— 排除是不可见的信息丢失。
	 */
	| { kind: "invalid" };

/** 活动分支上某个最终生效的编辑。 */
export type EffectiveContextEdit = {
	/** 产生这条编辑的 `context_edit` 条目 id（排查用）。 */
	editEntryId: string;
	targetId: string;
	replacement: ContextEditReplacement;
};

/** 目标条目在模型上下文中的最终形态。 */
export type ProjectedSessionEntry = {
	entry: SessionEntryLike;
	/** 原始条目 id；无 id 的条目（异常数据）为空串。 */
	entryId: string;
	/** 该条目是否已被移出模型上下文（`replacement: null`）。 */
	excluded: boolean;
	/** 生效的编辑；无编辑为 undefined。 */
	edit?: EffectiveContextEdit;
	/**
	 * 投影后送入模型上下文的消息；`excluded` 为 true 或该条目不贡献上下文时为 `[]`。
	 * 仍是原始 message 对象（未被改写），调用方按需读取。
	 */
	messages: unknown[];
};

export type SessionProjection = {
	/** pi 眼中的活动分支（leaf → root 展开为 root → leaf）。 */
	path: SessionEntryLike[];
	/** 经过压缩裁剪后的有效条目（模型实际会读的那一段）。 */
	contextEntries: SessionEntryLike[];
	/** 有效条目 → 投影结果，顺序与 contextEntries 一致。 */
	projectedEntries: ProjectedSessionEntry[];
	/** 最终送入模型上下文的消息（顺序拼接）。 */
	messages: unknown[];
	/** 本分支上最终生效的编辑，按 targetId 去重。 */
	edits: Map<string, EffectiveContextEdit>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function entryIdOf(entry: SessionEntryLike): string {
	return typeof entry.id === "string" ? entry.id : "";
}

function parentIdOf(entry: SessionEntryLike): string {
	return typeof entry.parentId === "string" ? entry.parentId : "";
}

function messageRoleOf(entry: SessionEntryLike): string | undefined {
	return isRecord(entry.message) && typeof entry.message.role === "string" ? entry.message.role : undefined;
}

/**
 * 沿 parentId 从 leaf 回溯到 root，返回 root → leaf 顺序。
 * 重复 id（环）或父链断裂时提前停止，不抛错 —— 损坏的会话文件不应让历史读不出来。
 */
export function buildSessionPath(entries: readonly SessionEntryLike[], leafId: string | undefined, byId?: ReadonlyMap<string, SessionEntryLike>): SessionEntryLike[] {
	const index = byId ?? buildEntryIndex(entries);
	const path: SessionEntryLike[] = [];
	const seen = new Set<string>();
	let current = leafId ? index.get(leafId) : undefined;
	while (current) {
		const id = entryIdOf(current);
		if (!id || seen.has(id)) break;
		seen.add(id);
		path.push(current);
		current = parentIdOf(current) ? index.get(parentIdOf(current)) : undefined;
	}
	path.reverse();
	return path;
}

/** id → 条目；无 id 的条目跳过（无法参与父链）。 */
export function buildEntryIndex(entries: readonly SessionEntryLike[]): Map<string, SessionEntryLike> {
	const index = new Map<string, SessionEntryLike>();
	for (const entry of entries) {
		const id = entryIdOf(entry);
		if (id && !index.has(id)) index.set(id, entry);
	}
	return index;
}

/**
 * 压缩感知的有效条目序列，对齐 pi `buildContextEntries`：
 * 取路径上**最后**一条 compaction，输出 [compaction, 保留区间…, compaction 之后全部]。
 * 保留区间 = compaction 之前、从 `firstKeptEntryId` 开始（含）的条目，且跳过
 * `message.role === "system"` 的历史条目（pi 用它们承载提示词/工具清单变更）。
 * 找不到锚点/无 compaction 时按原路径返回，绝不丢条目。
 */
export function buildContextEntries(path: readonly SessionEntryLike[]): SessionEntryLike[] {
	let compaction: SessionEntryLike | undefined;
	for (const entry of path) {
		if (entry.type === "compaction") compaction = entry;
	}
	if (!compaction) return [...path];
	const compactionIndex = path.findIndex((entry) => entry === compaction);
	if (compactionIndex < 0) return [...path];

	const firstKeptEntryId = typeof compaction.firstKeptEntryId === "string" ? compaction.firstKeptEntryId : undefined;
	const contextEntries: SessionEntryLike[] = [compaction];
	let foundFirstKept = false;
	for (let index = 0; index < compactionIndex; index += 1) {
		const entry = path[index];
		if (firstKeptEntryId && entryIdOf(entry) === firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept && !(entry.type === "message" && messageRoleOf(entry) === "system")) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...path.slice(compactionIndex + 1));
	return contextEntries;
}

/** 收集有效条目上最终生效的编辑：同一 targetId 后者覆盖前者（对齐 pi 的 Map.set）。 */
export function collectEffectiveEdits(contextEntries: readonly SessionEntryLike[]): Map<string, EffectiveContextEdit> {
	const edits = new Map<string, EffectiveContextEdit>();
	for (const entry of contextEntries) {
		if (entry.type !== "context_edit") continue;
		const targetId = typeof entry.targetId === "string" ? entry.targetId : "";
		if (!targetId) continue;
		edits.set(targetId, {
			editEntryId: entryIdOf(entry),
			targetId,
			replacement: parseReplacement(entry.replacement),
		});
	}
	return edits;
}

/**
 * 解析 replacement。pi 的写入端只产出两种形态：null（排除）或含 content 的对象
 * （content 为字符串或内容块数组）。其余形态返回 invalid，由调用方当作「无编辑」。
 */
export function parseReplacement(value: unknown): ContextEditReplacement {
	if (value === null) return { kind: "excluded" };
	if (!isRecord(value) || !("content" in value)) return { kind: "invalid" };
	const content = value.content;
	if (typeof content === "string" || Array.isArray(content)) return { kind: "replaced", content };
	return { kind: "invalid" };
}

/** 该类型的条目是否会贡献模型上下文（对齐 pi `sessionEntryToContextMessages`）。 */
function contributesContext(entry: SessionEntryLike): boolean {
	if (entry.type === "message") return true;
	if (entry.type === "custom_message") return true;
	if (entry.type === "branch_summary") return typeof entry.summary === "string" && entry.summary.length > 0;
	if (entry.type === "compaction") return true;
	return false;
}

/**
 * 应用一条编辑到该条目投影出的消息上，对齐 pi `projectContextEntry`：
 * - 排除 → 无消息；
 * - 替换 → 按角色改写 content：user / custom 直接用 replacement.content；
 *   assistant / toolResult 在被替换为字符串时包成 `[{type:"text", text}]`；
 * - 不贡献上下文的条目（如 label / model_change / 非布尔 summary）不受编辑影响。
 */
function projectEntryMessages(entry: SessionEntryLike, edit?: EffectiveContextEdit): unknown[] {
	if (!contributesContext(entry)) return [];
	// invalid 编辑不生效（见 parseReplacement 注释）。
	if (!edit || edit.replacement.kind === "invalid") return entry.type === "message" ? [entry.message] : [];
	const replacement = edit.replacement;
	if (replacement.kind === "excluded") return [];
	const role = messageRoleOf(entry) ?? (entry.type === "custom_message" ? "custom" : undefined);
	if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "custom") {
		return entry.type === "message" ? [entry.message] : [];
	}
	// assistant / toolResult 被替换为字符串时包成 text block（与 pi 的归一化一致），
	// 否则直接用 replacement.content（字符串或其内容块数组）。
	const content = (role === "assistant" || role === "toolResult") && typeof replacement.content === "string" ? [{ type: "text", text: replacement.content }] : replacement.content;
	if (!isRecord(entry.message)) {
		// custom_message 的正文在条目顶层，替换后按消息形态返回，保持与 pi 一致的可见性。
		return [{ role: "custom", content, timestamp: entry.timestamp }];
	}
	return [{ ...entry.message, content }];
}

/**
 * 构造完整投影。`leafId` 缺省时取最后一个可入索引的条目（与 pi 的 leaf 语义一致：
 * 最后一条带 id 的条目）。
 */
export function buildSessionProjection(entries: readonly SessionEntryLike[], leafId?: string): SessionProjection {
	const byId = buildEntryIndex(entries);
	const resolvedLeafId = leafId ?? findLastEntryId(entries);
	const path = buildSessionPath(entries, resolvedLeafId, byId);
	const contextEntries = buildContextEntries(path);
	const edits = collectEffectiveEdits(contextEntries);
	const projectedEntries: ProjectedSessionEntry[] = contextEntries.map((entry) => {
		const id = entryIdOf(entry);
		const edit = id ? edits.get(id) : undefined;
		return {
			entry,
			entryId: id,
			excluded: edit?.replacement.kind === "excluded",
			...(edit && edit.replacement.kind !== "invalid" ? { edit } : {}),
			messages: projectEntryMessages(entry, edit),
		};
	});
	return {
		path,
		contextEntries,
		projectedEntries,
		messages: projectedEntries.flatMap((projected) => projected.messages),
		edits,
	};
}

function findLastEntryId(entries: readonly SessionEntryLike[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const id = entryIdOf(entries[index]);
		if (id) return id;
	}
	return undefined;
}

/** 把 JSONL 原文解析成条目数组；坏行跳过（与 pi 的「解析不做类型白名单」一致）。 */
export function parseSessionEntries(lines: readonly string[]): SessionEntryLike[] {
	const entries: SessionEntryLike[] = [];
	for (const rawLine of lines) {
		const line = rawLine?.trim();
		if (!line) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) entries.push(parsed as SessionEntryLike);
		} catch {
			// 跳过坏行：单行损坏不应让整段历史不可读
		}
	}
	return entries;
}
