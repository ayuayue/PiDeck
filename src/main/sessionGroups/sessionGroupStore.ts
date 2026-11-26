/**
 * 会话分组的唯一状态源：<userData>/session-groups.json（路径由装配层注入，便于测试）。
 *
 * 与 FavoritesStore 同一套骨架（串行写队列 + tmp/rename 原子写 + 读盘归一化），差异：
 * - 数据形状与内置宿主插件 session-groups v2 的存储同构（groups 数组顺序即显示顺序）；
 * - 启动时从插件私有 storage（host-plugin-storage/session-groups.json）做一次性迁移：
 *   迁移只尝试一次并记 migratedAt，之后插件 v3 一律经宿主 sessionGroups.* API 读写本文件，
 *   插件旧 storage 不再读也不删（回退旧版插件不丢分组）。
 * - 坏文件按空列表重建，不阻断启动；会话引用不校验存在性（失效引用由渲染层按 catalog 过滤）。
 */
import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { SESSION_GROUP_COLORS, SESSION_GROUP_COUNT_LIMIT, SESSION_GROUP_DIRS_MAX_KEYS, SESSION_GROUP_META_MAX_CHARS, SESSION_GROUP_NAME_MAX_CHARS, SESSION_GROUP_SESSION_LIMIT, type SaveSessionGroupInput, type SessionGroup, type SessionGroupColor } from "../../shared/types";
import { readRepairableJsonFile } from "../persistence/durableJsonStore";

const STORE_VERSION = 1;

type PersistedSessionGroupState = { version: number; migratedAt: number | null; groups: SessionGroup[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionGroupColor(value: unknown): value is SessionGroupColor {
	return typeof value === "string" && (SESSION_GROUP_COLORS as readonly string[]).includes(value);
}

/** 字符串列表归一化：非字符串项丢弃、裁长度、去重、限量。 */
function normalizeStringList(value: unknown, maxChars: number, maxKeys: number): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const list: string[] = [];
	for (const candidate of value) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		list.push(trimmed.slice(0, maxChars));
		if (list.length >= maxKeys) break;
	}
	return list;
}

/** 单组读盘归一化：缺 id/name 或形状坏的组丢弃（宁可少一组，不让坏数据进列表）。 */
function normalizeGroup(raw: unknown, fallbackColor: SessionGroupColor): SessionGroup | null {
	if (!isRecord(raw)) return null;
	const id = typeof raw.id === "string" ? raw.id.trim().slice(0, SESSION_GROUP_META_MAX_CHARS) : "";
	const name = typeof raw.name === "string" ? raw.name.trim().slice(0, SESSION_GROUP_NAME_MAX_CHARS) : "";
	if (!id || !name) return null;
	const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
	return {
		id,
		name,
		color: isSessionGroupColor(raw.color) ? raw.color : fallbackColor,
		createdAt,
		sessionIds: normalizeStringList(raw.sessionIds, SESSION_GROUP_META_MAX_CHARS, SESSION_GROUP_SESSION_LIMIT),
		dirs: normalizeStringList(raw.dirs, SESSION_GROUP_META_MAX_CHARS, SESSION_GROUP_DIRS_MAX_KEYS),
	};
}

function normalizeState(raw: unknown): { state: PersistedSessionGroupState; changed: boolean } {
	const empty: PersistedSessionGroupState = { version: STORE_VERSION, migratedAt: null, groups: [] };
	if (!isRecord(raw) || !Array.isArray(raw.groups)) return { state: empty, changed: true };
	const seen = new Set<string>();
	const groups: SessionGroup[] = [];
	for (const candidate of raw.groups) {
		const group = normalizeGroup(candidate, SESSION_GROUP_COLORS[groups.length % SESSION_GROUP_COLORS.length]);
		if (!group || seen.has(group.id)) continue;
		seen.add(group.id);
		groups.push(group);
	}
	const trimmed = groups.slice(0, SESSION_GROUP_COUNT_LIMIT);
	const migratedAt = typeof raw.migratedAt === "number" && Number.isFinite(raw.migratedAt) ? raw.migratedAt : null;
	const changed = trimmed.length !== raw.groups.length || raw.version !== STORE_VERSION || migratedAt === null;
	return { state: { version: STORE_VERSION, migratedAt, groups: trimmed }, changed };
}

/* ---------- 插件 storage 迁移（只读插件私有文件，不写它） ---------- */

/** 插件 v2 分片：ws.g.<id> = { chunked: n } 时，真实 id 列表拆在 ws.g.<id>.<n> 里。 */
function readPluginGroupIds(store: Record<string, unknown>, groupId: string): string[] {
	const direct = store["ws.g." + groupId];
	if (isRecord(direct) && Array.isArray(direct.ids)) {
		return direct.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
	}
	if (isRecord(direct) && typeof direct.chunked === "number" && Number.isInteger(direct.chunked) && direct.chunked > 0) {
		const ids: string[] = [];
		for (let index = 0; index < direct.chunked; index += 1) {
			const part = store["ws.g." + groupId + "." + index];
			if (isRecord(part) && Array.isArray(part.ids)) for (const id of part.ids) if (typeof id === "string" && id.trim()) ids.push(id);
		}
		return ids;
	}
	return [];
}

/** 从插件私有 storage 提取分组；文件缺失/损坏返回 null（调用方记 migratedAt 后不再重试）。 */
export function readSessionGroupsFromPluginStorage(raw: unknown): SessionGroup[] | null {
	if (!isRecord(raw)) return null;
	const meta = raw["ws.meta"];
	if (!isRecord(meta) || !Array.isArray(meta.groups)) return null;
	const groups: SessionGroup[] = [];
	for (const candidate of meta.groups) {
		const group = normalizeGroup(candidate, SESSION_GROUP_COLORS[groups.length % SESSION_GROUP_COLORS.length]);
		if (!group) continue;
		group.sessionIds = normalizeStringList(readPluginGroupIds(raw, group.id), SESSION_GROUP_META_MAX_CHARS, SESSION_GROUP_SESSION_LIMIT);
		groups.push(group);
	}
	return groups.slice(0, SESSION_GROUP_COUNT_LIMIT);
}

export class SessionGroupStore {
	private state: PersistedSessionGroupState = { version: STORE_VERSION, migratedAt: null, groups: [] };
	private saveQueue: Promise<void> = Promise.resolve();
	private listeners = new Set<() => void>();

	/** 数据变化通知（IPC handler 与 broker 写入后都会触发）：桌面帧据此刷新侧栏分组树。 */
	onChanged(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	constructor(
		private readonly filePath: string,
		/** 插件私有 storage 文件路径（<userData>/host-plugin-storage/session-groups.json）；缺省不迁移。 */
		private readonly pluginStoragePath?: string,
	) {}

	async load(): Promise<void> {
		const { state, changed } = normalizeState(await readRepairableJsonFile(this.filePath));
		if (state.migratedAt === null) {
			if (this.pluginStoragePath && state.groups.length === 0) {
				const legacy = await readRepairableJsonFile(this.pluginStoragePath);
				state.groups = readSessionGroupsFromPluginStorage(legacy) ?? [];
			}
			state.migratedAt = Date.now();
		}
		this.state = state;
		if (changed) await this.persist();
	}

	list(): SessionGroup[] {
		return this.state.groups.map((group) => ({ ...group, sessionIds: [...group.sessionIds], dirs: [...group.dirs] }));
	}

	/** 新建（无 id 时生成）或整体替换一个分组：id 已知按位替换（保持显示顺序），未知 = 追加。 */
	async save(input: SaveSessionGroupInput): Promise<SessionGroup[]> {
		const id = typeof input.id === "string" && input.id.trim() ? input.id.trim().slice(0, SESSION_GROUP_META_MAX_CHARS) : randomUUID();
		const name = (typeof input.name === "string" ? input.name.trim() : "").slice(0, SESSION_GROUP_NAME_MAX_CHARS);
		if (!name) throw new Error("invalid-session-group");
		const group: SessionGroup = {
			id,
			name,
			color: isSessionGroupColor(input.color) ? input.color : SESSION_GROUP_COLORS[0],
			createdAt: typeof input.createdAt === "number" && Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
			sessionIds: normalizeStringList(input.sessionIds, SESSION_GROUP_META_MAX_CHARS, SESSION_GROUP_SESSION_LIMIT),
			dirs: normalizeStringList(input.dirs, SESSION_GROUP_META_MAX_CHARS, SESSION_GROUP_DIRS_MAX_KEYS),
		};
		await this.mutate(() => {
			if (this.state.groups.length >= SESSION_GROUP_COUNT_LIMIT && !this.state.groups.some((existing) => existing.id === id)) throw new Error("session-groups-full");
			const index = this.state.groups.findIndex((existing) => existing.id === id);
			if (index >= 0) this.state.groups[index] = group;
			else this.state.groups.push(group);
		});
		return this.list();
	}

	async delete(id: string): Promise<boolean> {
		if (!this.state.groups.some((group) => group.id === id)) return false;
		await this.mutate(() => {
			this.state.groups = this.state.groups.filter((group) => group.id !== id);
		});
		return true;
	}

	/** 保存显示顺序：ids 命中的按首次出现位置前置，未列出的按当前顺序追加（与 FavoritesStore.reorder 同策略）。 */
	async reorder(ids: readonly string[]): Promise<SessionGroup[]> {
		const byId = new Map(this.state.groups.map((group) => [group.id, group]));
		const next: SessionGroup[] = [];
		const seen = new Set<string>();
		for (const id of ids) {
			const group = byId.get(id);
			if (!group || seen.has(id)) continue;
			seen.add(id);
			next.push(group);
		}
		for (const group of this.state.groups) if (!seen.has(group.id)) next.push(group);
		const unchanged = next.length === this.state.groups.length && next.every((group, index) => group.id === this.state.groups[index].id);
		if (!unchanged) {
			await this.mutate(() => {
				this.state.groups = next;
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
		for (const listener of this.listeners) listener();
	}

	private async persist(): Promise<void> {
		const payload = JSON.stringify(this.state, null, 2);
		const tmpPath = this.filePath + ".tmp";
		await writeFile(tmpPath, payload, "utf8");
		await rename(tmpPath, this.filePath);
	}
}
