import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { FAVORITE_ENTRY_LIMIT, FAVORITE_META_MAX_CHARS, FAVORITE_SESSION_TITLE_MAX_CHARS, FAVORITE_TEXT_MAX_CHARS, type FavoriteEntry, type FavoriteKind, type FavoriteRole } from "../../shared/types";
import type { NormalizedFavoriteInput } from "./favoriteInput";

/**
 * 收藏的唯一状态源：<userData>/favorites.json（路径由装配层注入，便于测试）。
 *
 * 与 AgentProfileStore 同一套骨架（串行写队列 + 读盘归一化），差异是它只承载「快照」：
 * - 收藏的是正文快照而不是消息引用，会话删除/消息编辑都不影响已收藏内容；
 * - 数组顺序就是用户看到的顺序（也是拖拽排序持久化的权威顺序）：新增前插，读盘保留文件里的条目顺序；
 * - 读盘归一化丢弃坏条目、钳正文长度并裁到 FAVORITE_ENTRY_LIMIT；
 * - 坏文件（截断 / 手改坏）退化成空列表并立即写回，不让收藏功能拖垮启动。
 */
const STORE_VERSION = 1;

type PersistedFavoriteState = { version: number; entries: FavoriteEntry[] };

const FAVORITE_KINDS: readonly FavoriteKind[] = ["message", "selection"];
const FAVORITE_ROLES: readonly FavoriteRole[] = ["user", "assistant", "system"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMeta(value: unknown, maxChars: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, maxChars) : null;
}

function readKind(value: unknown): FavoriteKind | null {
	return typeof value === "string" && (FAVORITE_KINDS as readonly string[]).includes(value) ? (value as FavoriteKind) : null;
}

function readRole(value: unknown): FavoriteRole | null {
	return typeof value === "string" && (FAVORITE_ROLES as readonly string[]).includes(value) ? (value as FavoriteRole) : null;
}

function cloneEntry(entry: FavoriteEntry): FavoriteEntry {
	return { ...entry };
}

/** 单条读盘归一化：缺 id / 正文 / 合法 kind 的条目直接丢弃（宁可少一条，也不让坏数据进列表）。 */
function normalizeEntry(raw: unknown): FavoriteEntry | null {
	if (!isRecord(raw)) return null;
	const kind = readKind(raw.kind);
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Number.NaN;
	const text = typeof raw.text === "string" ? raw.text : "";
	if (!kind || !id || !text.trim() || Number.isNaN(createdAt)) return null;
	return {
		id,
		createdAt,
		kind,
		text: text.length > FAVORITE_TEXT_MAX_CHARS ? text.slice(0, FAVORITE_TEXT_MAX_CHARS) : text,
		role: readRole(raw.role),
		sessionId: readMeta(raw.sessionId, FAVORITE_META_MAX_CHARS),
		sessionTitle: readMeta(raw.sessionTitle, FAVORITE_SESSION_TITLE_MAX_CHARS),
		projectId: readMeta(raw.projectId, FAVORITE_META_MAX_CHARS),
		messageId: readMeta(raw.messageId, FAVORITE_META_MAX_CHARS),
		model: readMeta(raw.model, FAVORITE_META_MAX_CHARS),
		partial: raw.partial === true,
		truncated: raw.truncated === true || text.length > FAVORITE_TEXT_MAX_CHARS,
	};
}

/**
 * 整文件归一化：丢弃坏条目、去重 id（保留首次出现）、保留文件里的顺序、裁到上限。
 * 不按 createdAt 重排：数组顺序是用户拖拽出来的偏好，重排会把用户刚排好的顺序在重启后抹掉；
 * 旧版本写入的文件本来就是这个顺序（新增前插），所以迁移无需额外处理。
 * 返回 changed 供 load 决定是否写回。
 */
function normalizeState(raw: unknown): { state: PersistedFavoriteState; changed: boolean } {
	if (!isRecord(raw) || !Array.isArray(raw.entries)) return { state: { version: STORE_VERSION, entries: [] }, changed: true };
	const seen = new Set<string>();
	const entries: FavoriteEntry[] = [];
	for (const candidate of raw.entries) {
		const entry = normalizeEntry(candidate);
		if (!entry || seen.has(entry.id)) continue;
		seen.add(entry.id);
		entries.push(entry);
	}
	const trimmed = entries.slice(0, FAVORITE_ENTRY_LIMIT);
	const changed = trimmed.length !== raw.entries.length || raw.version !== STORE_VERSION;
	return { state: { version: STORE_VERSION, entries: trimmed }, changed };
}

export class FavoritesStore {
	private state: PersistedFavoriteState = { version: STORE_VERSION, entries: [] };
	private saveQueue: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	async load(): Promise<FavoriteEntry[]> {
		let shouldRepair = false;
		try {
			const raw = await readFile(this.filePath, "utf8");
			const normalized = normalizeState(JSON.parse(raw) as unknown);
			this.state = normalized.state;
			shouldRepair = normalized.changed;
		} catch {
			// 文件缺失 / 被截断 / 手改坏：收藏是可选功能，解析失败按空列表重建，不阻断启动。
			this.state = { version: STORE_VERSION, entries: [] };
			shouldRepair = true;
		}
		if (shouldRepair) await this.persist();
		return this.list();
	}

	list(): FavoriteEntry[] {
		return this.state.entries.map(cloneEntry);
	}

	/** 新增一条收藏：正文超长时截断并标记 truncated（不拒绝，用户仍然收藏成功）。 */
	async add(input: NormalizedFavoriteInput, now = Date.now()): Promise<FavoriteEntry> {
		const truncated = input.text.length > FAVORITE_TEXT_MAX_CHARS;
		const entry: FavoriteEntry = {
			id: randomUUID(),
			createdAt: now,
			kind: input.kind,
			text: truncated ? input.text.slice(0, FAVORITE_TEXT_MAX_CHARS) : input.text,
			role: input.role,
			sessionId: input.sessionId,
			sessionTitle: input.sessionTitle,
			projectId: input.projectId,
			messageId: input.messageId,
			model: input.model,
			partial: input.partial,
			truncated,
		};
		await this.mutate(() => {
			// 新的在前；超出上限时丢最旧的一条（收藏列表按时间倒序，尾部就是最旧）。
			this.state.entries = [entry, ...this.state.entries].slice(0, FAVORITE_ENTRY_LIMIT);
		});
		return cloneEntry(entry);
	}

	async remove(id: string): Promise<boolean> {
		if (typeof id !== "string" || !id.trim()) return false;
		if (!this.state.entries.some((entry) => entry.id === id)) return false;
		await this.mutate(() => {
			this.state.entries = this.state.entries.filter((entry) => entry.id !== id);
		});
		return true;
	}

	/**
	 * 批量删除：命中的 id 一次过滤、一次落盘（逐条 remove 会写 N 次文件）。
	 * 未知 id 静默忽略——选区可能拿着稍早的快照；返回实际删除条数。
	 */
	async removeMany(ids: readonly string[]): Promise<number> {
		const wanted = new Set(ids.filter((id) => typeof id === "string" && id.trim()));
		if (wanted.size === 0) return 0;
		const kept = this.state.entries.filter((entry) => !wanted.has(entry.id));
		const removed = this.state.entries.length - kept.length;
		if (removed > 0) {
			await this.mutate(() => {
				this.state.entries = kept;
			});
		}
		return removed;
	}

	/**
	 * 保存用户拖拽出的顺序：ids 里命中的条目按首次出现的位置前置，未列出的（旧快照 /
	 * 拖拽期间新增）按当前顺序追加到尾，保证一次过期载荷不会让收藏从列表里消失。
	 * 顺序没变时不写盘（拖回原位只是视觉动作）。
	 */
	async reorder(ids: readonly string[]): Promise<FavoriteEntry[]> {
		const byId = new Map(this.state.entries.map((entry) => [entry.id, entry]));
		const next: FavoriteEntry[] = [];
		const seen = new Set<string>();
		for (const id of ids) {
			if (typeof id !== "string") continue;
			const entry = byId.get(id);
			if (!entry || seen.has(id)) continue;
			seen.add(id);
			next.push(entry);
		}
		for (const entry of this.state.entries) if (!seen.has(entry.id)) next.push(entry);
		const unchanged = next.length === this.state.entries.length && next.every((entry, index) => entry.id === this.state.entries[index].id);
		if (!unchanged) {
			await this.mutate(() => {
				this.state.entries = next;
			});
		}
		return this.list();
	}

	/** 串行写盘：先同步改内存再入队，await 的 Promise 覆盖「已落盘」，并发调用不会旧快照覆盖新快照。 */
	private async mutate(apply: () => void): Promise<void> {
		apply();
		const task = this.saveQueue.then(() => this.persist());
		this.saveQueue = task.catch(() => undefined);
		await task;
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const payload = JSON.stringify(this.state, null, 2);
		// tmp + rename：写一半崩溃时不会留下半截 JSON（读盘侧另有坏文件兜底）。
		const tmpPath = `${this.filePath}.tmp`;
		await writeFile(tmpPath, payload, "utf8");
		await rename(tmpPath, this.filePath);
	}
}
