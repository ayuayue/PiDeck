/**
 * 会话 JSONL 的 entry 定位与目标解析（整读路径），以及定位/改写需要的内容原语。
 *
 * 职责边界：给定「用户界面认的那条消息」（`SessionEntryTarget`：entryId / legacy id / 文本），
 * 在该文件的**活动分支**上找出唯一对应的行；失效时给出稳定错误码（NOT_FOUND / AMBIGUOUS /
 * ROLE_INVALID）。这里只算「目标在哪、要写成什么」，不碰事务（锁 / 备份 / 原子写 / reload）
 * 也不碰 IO——那是宿主 SessionFileEditor 与 sessionFileStorage 的事。
 *
 * 搬迁自 SessionFileEditor.ts，函数体与注释一字未改。`SessionEntryTarget` 随本域一起搬出，
 * 宿主原样 re-export，公开 import 路径不变。
 */
import { createHash } from "node:crypto";
import type { SessionMessageImageTarget } from "../../../shared/types/session";
import { SessionFileEditorError } from "./sessionFileEditorError";
import { entryIdOf, type JsonlDocument, type JsonlEntry, messageOf, parentIdOf, textOf } from "./sessionFileJsonl";

export type SessionEntryTarget = {
	entryId?: string;
	legacyMessageId?: string;
	legacyAgentId?: string;
	role: "user" | "assistant";
	text: string;
	activeLeafId?: string;
};

export type LocatedEntry = {
	lineIndex: number;
	entry: JsonlEntry;
	entryId: string;
};

/**
 * 选出要删除的可见图块下标并校验（数量 + 哈希）。
 * 与 AgentMessageProjector 的可见投影一致：无有效 data 的 image 不占序号。
 * 返回 undefined = 校验失败，调用方按「图片已变化」报错（提示重新加载会话）。
 */
export function removableImageIndex(content: unknown, imageTarget: SessionMessageImageTarget | undefined): number | undefined {
	if (!Array.isArray(content) || !imageTarget || !Number.isSafeInteger(imageTarget.index) || imageTarget.index < 0) return undefined;
	const visible: Array<{ index: number; data: string }> = [];
	for (let index = 0; index < content.length; index += 1) {
		const block: unknown = content[index];
		if (!block || typeof block !== "object" || !("type" in block) || block.type !== "image") continue;
		const source = "source" in block && block.source && typeof block.source === "object" ? block.source : undefined;
		const data = "data" in block && typeof block.data === "string" ? block.data : source && "data" in source && typeof source.data === "string" ? source.data : "";
		if (data) visible.push({ index, data });
	}
	const selected = visible[imageTarget.index];
	if (!selected || imageTarget.expectedImageCount !== visible.length || !/^[a-f0-9]{64}$/.test(imageTarget.expectedHash) || createHash("sha256").update(selected.data).digest("hex") !== imageTarget.expectedHash) return undefined;
	return selected.index;
}

export function legacyEntryId(target: SessionEntryTarget): string | undefined {
	if (!target.legacyMessageId || !target.legacyAgentId) return undefined;
	const prefix = `${target.legacyAgentId}-history-`;
	return target.legacyMessageId.startsWith(prefix) ? target.legacyMessageId.slice(prefix.length) : undefined;
}

function validateLocatedRole(entry: JsonlEntry, target: SessionEntryTarget): void {
	const role = messageOf(entry)?.role;
	if (role !== target.role) {
		throw new SessionFileEditorError("SESSION_ENTRY_ROLE_INVALID", `Session entry role ${String(role)} cannot be used as ${target.role}`);
	}
}

/**
 * 计算「只改文本」的替换内容，保留图片 / 工具块等其他合法内容。
 *
 * 为什么不能直接把 newText 当 replacement.content：pi 的 `projectContextEntry`
 * 会用 replacement.content **整体**替换消息内容，|user 消息直接丢掉附件图片，
 * 块状内容也会被一个纯文本块顶掉。这里沿用旧 `setMessageText` 的语义（只改第一个
 * text 块、其余块原样保留），先算好完整 content 再交给 pi。
 *
 * 返回 `{ content, changed }`：changed 为 false 表示原文与新文本等价（图片但无文本块等），
 * 此时仍会写入替换记录，保持「用户确实编辑过」的事实。
 */
export function replaceTextInContent(content: unknown, text: string): unknown {
	if (typeof content === "string") return text;
	if (!Array.isArray(content)) return [{ type: "text", text }];
	const next: unknown[] = [];
	let replaced = false;
	for (const candidate of content) {
		const isText = Boolean(candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).type === "text");
		if (!isText) {
			next.push(candidate);
			continue;
		}
		if (replaced) continue;
		next.push({ ...(candidate as Record<string, unknown>), text });
		replaced = true;
	}
	if (!replaced) next.push({ type: "text", text });
	return next;
}

function locateById(document: JsonlDocument, entryId: string | undefined, target: SessionEntryTarget, activeIds: Set<string>): LocatedEntry | undefined {
	if (!entryId) return undefined;
	const lineIndex = document.entryLineById.get(entryId);
	if (lineIndex === undefined) return undefined;
	if (!activeIds.has(entryId)) {
		throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "The requested entry is not part of the active session branch");
	}
	const entry = document.lines[lineIndex].entry!;
	if (entry.type === "deleted") {
		throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "The requested entry has already been deleted");
	}
	validateLocatedRole(entry, target);
	return { lineIndex, entry, entryId };
}

function activeBranchIds(document: JsonlDocument, activeLeafId?: string): Set<string> {
	let leafId = activeLeafId;
	if (leafId && !document.entryLineById.has(leafId)) {
		throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "The active session branch is no longer present in the file");
	}
	if (!leafId) {
		for (let index = document.lines.length - 1; index >= 0; index -= 1) {
			const entry = document.lines[index].entry;
			if (!entry || entry.type === "deleted") continue;
			const candidate = entryIdOf(entry);
			if (candidate) {
				leafId = candidate;
				break;
			}
		}
	}
	if (!leafId) return new Set();

	const result = new Set<string>();
	let current: string | null | undefined = leafId;
	while (current && !result.has(current)) {
		result.add(current);
		const lineIndex = document.entryLineById.get(current);
		if (lineIndex === undefined) break;
		current = parentIdOf(document.lines[lineIndex].entry!);
	}
	return result;
}

/**
 * 分支上每个条目最终生效的替换文本（同一 targetId 后者覆盖前者）。
 * 仅用于「按文本定位」的回退比较：编辑后的条目在文件里仍是原文，
 * 但界面上显示的是改写后的文本，用原文比较会找不到刚编辑过的那条。
 * 返回 Map<targetId, string | null>：null 表示已被移出上下文。
 */
function effectiveContextEditTexts(document: JsonlDocument): Map<string, string | null> {
	const texts = new Map<string, string | null>();
	for (const line of document.lines) {
		const entry = line.entry;
		if (!entry || entry.type !== "context_edit") continue;
		const targetId = typeof entry.targetId === "string" ? entry.targetId : undefined;
		if (!targetId) continue;
		const replacement = entry.replacement;
		if (replacement === null) {
			texts.set(targetId, null);
			continue;
		}
		if (replacement && typeof replacement === "object" && !Array.isArray(replacement)) {
			const content = (replacement as Record<string, unknown>).content;
			if (typeof content === "string") texts.set(targetId, content);
			else if (Array.isArray(content)) texts.set(targetId, textOf(content));
		}
	}
	return texts;
}

export function locateEntry(document: JsonlDocument, target: SessionEntryTarget): LocatedEntry {
	const branchIds = activeBranchIds(document, target.activeLeafId);
	const exact = locateById(document, target.entryId, target, branchIds);
	if (exact) return exact;
	const legacy = locateById(document, legacyEntryId(target), target, branchIds);
	if (legacy) return legacy;

	// 文本回退要同时认「原文」与「有效文本（改写后）」：一次编辑后界面上显示的是
	// 改写内容，用户再编辑一次时带的就是改写文本，而文件里仍是原文。
	const effectiveTexts = effectiveContextEditTexts(document);
	const candidates: LocatedEntry[] = [];
	for (const entryId of branchIds) {
		const lineIndex = document.entryLineById.get(entryId);
		if (lineIndex === undefined) continue;
		const entry = document.lines[lineIndex].entry!;
		const message = messageOf(entry);
		if (message?.role !== target.role) continue;
		const rawText = textOf(message.content);
		const overridden = effectiveTexts.get(entryId);
		const effective = overridden === undefined ? rawText : (overridden ?? "");
		if (rawText !== target.text && effective !== target.text) continue;
		candidates.push({ lineIndex, entry, entryId });
	}

	if (candidates.length === 1) return candidates[0];
	if (candidates.length > 1) {
		throw new SessionFileEditorError("SESSION_ENTRY_AMBIGUOUS", "More than one entry matches the requested message on the active branch", { details: { matches: candidates.length } });
	}
	throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "Message was not found on the active session branch");
}

export function descendantEntryIds(document: JsonlDocument, rootEntryId: string): Set<string> {
	const descendants = new Set<string>([rootEntryId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const line of document.lines) {
			const entry = line.entry;
			if (!entry || entry.type === "deleted") continue;
			const entryId = entryIdOf(entry);
			const parentId = parentIdOf(entry);
			if (!entryId || !parentId || !descendants.has(parentId) || descendants.has(entryId)) continue;
			descendants.add(entryId);
			changed = true;
		}
	}
	return descendants;
}

/**
 * 删除/重发截断写入的墓碑。必须保留 id + parentId：
 * pi SessionManager._buildIndex 把文件里最后一条带 id 的记录当成 leaf，
 * 再沿 parentId 回溯活动分支。旧墓碑只有 originalEntryId，leaf 会落在
 * 这条「无 id、无父节点」的记录上，get_messages 整页变空。
 */
export function tombstone(entryId: string, now: number, parentId?: string | null, reason?: string): JsonlEntry {
	return {
		type: "deleted",
		id: entryId,
		originalEntryId: entryId,
		parentId: parentId ?? null,
		ts: now,
		...(reason ? { reason } : {}),
	};
}

/** 从索引（parentId 映射）展开后代集合；与整读路径 descendantEntryIds 同语义（跳过墓碑）。 */
export function descendantsFromParentMap(parentById: ReadonlyMap<string, string | null>, rootId: string, deletedIds: ReadonlySet<string>): Set<string> {
	const children = new Map<string, string[]>();
	for (const [entryId, parentId] of parentById) {
		if (!parentId) continue;
		const siblings = children.get(parentId) ?? [];
		siblings.push(entryId);
		children.set(parentId, siblings);
	}
	const result = new Set<string>([rootId]);
	const stack = [rootId];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const child of children.get(current) ?? []) {
			if (result.has(child) || deletedIds.has(child)) continue;
			result.add(child);
			stack.push(child);
		}
	}
	return result;
}
