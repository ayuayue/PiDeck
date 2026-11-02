/**
 * 远端项目文件名搜索的纯状态机（渲染层，F2）。
 *
 * 为什么单独成模块：搜索的核心规则是「代次 + 三种终态」，与 React 无关，必须能离开组件单测——
 * 尤其是**迟到结果作废**这条（切项目、发起新搜索之后，旧请求的结果绝不能覆盖新查询）。
 *
 * 代次复用的就是 `remoteRequestGate`：与远端目录读取同一个闸门语义，不另立一套。
 * `settle` 在代次不是当前代次时返回 false 并**不动任何状态**，因此「旧结果盖新查询」在结构上
 * 就不可能发生，而不是靠调用方自觉。
 *
 * IPC 返回也是外部数据：渲染层不假设主进程一定给了正确形状，`readSearchResponse` 逐字段收窄，
 * 读不懂就当作「请求失败」，绝不把畸形对象渲染出去。
 */

import { createRequestGate } from "./remoteRequestGate";

/** 渲染层能安全使用的匹配项：`path` 已证明可拆段（相对 POSIX、无 `..`/空段/控制字节）。 */
export type RemoteSearchEntryView = {
	path: string;
	name: string;
	kind: "file" | "directory" | "other";
	bytes?: number;
};

/** 一次搜索的终态：成功（可能被截断）、失败（稳定码）、IPC reject（连失败形状都没拿到）。 */
export type RemoteSearchOutcome = { kind: "ok"; entries: RemoteSearchEntryView[]; scanned: number; truncated: boolean } | { kind: "failed"; code: string } | { kind: "rejected" };

/** idle=没搜过；searching=在途；empty=成功且无匹配；results=成功且有匹配；error=失败。 */
export type RemoteSearchPhase = "idle" | "searching" | "empty" | "results" | "error";

export type RemoteProjectSearchState = {
	phase: RemoteSearchPhase;
	/** 本代次的查询词（结果只属于它）。 */
	query: string;
	entries: RemoteSearchEntryView[];
	/** 如实来自主进程：true 时界面必须明说「结果已截断」，不得呈现成完整结果。 */
	truncated: boolean;
	scanned: number;
	/** 稳定错误码；IPC reject（没有码可报）时为 null。 */
	errorCode: string | null;
};

/** 一个码就是一个码，绝不是自由文本（与主进程同一判据）。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_PATH_LENGTH = 4096;
const DRIVE_PREFIX = /^[A-Za-z]:$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 拆段前的最后一道自检：只有合法的相对 POSIX 路径才允许进入视图状态。
 * 判据与主进程 reader 相同（那是**跨进程边界**的重复校验，不是第二套搜索实现）。
 */
function isSafeRelativePath(value: string): boolean {
	if (value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
	if (CONTROL_CHARS.test(value) || value.includes("\\")) return false;
	if (value.startsWith("/")) return false;
	const segments = value.split("/");
	for (const segment of segments) {
		if (segment.length === 0 || segment === "." || segment === "..") return false;
	}
	const first = segments[0];
	return first === undefined || !DRIVE_PREFIX.test(first);
}

function isEntryName(value: string): boolean {
	return value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !CONTROL_CHARS.test(value);
}

/** 逐字段重建一条匹配项；多出来的字段一律丢弃（渲染层不需要，也不该带进来）。 */
function readSearchEntryView(value: unknown): RemoteSearchEntryView | undefined {
	if (!isRecord(value)) return undefined;
	const path = value.path;
	if (typeof path !== "string" || !isSafeRelativePath(path)) return undefined;
	const name = value.name;
	if (typeof name !== "string" || !isEntryName(name)) return undefined;
	if (path !== name && !path.endsWith("/" + name)) return undefined;
	const kind = value.kind;
	if (kind !== "file" && kind !== "directory" && kind !== "other") return undefined;
	const bytes = value.bytes;
	if (kind === "file") {
		if (!isCount(bytes)) return undefined;
		return { path, name, kind, bytes };
	}
	if (bytes !== undefined) return undefined;
	return { path, name, kind };
}

/**
 * 把 IPC 返回收窄成一次终态。任何读不懂的形状都是 `rejected`（请求失败），而不是「空结果」——
 * 把畸形响应当成「没有匹配」是这里最危险的一种谎。
 */
export function readSearchResponse(raw: unknown): RemoteSearchOutcome {
	if (!isRecord(raw)) return { kind: "rejected" };
	if (raw.ok === false) return typeof raw.code === "string" && STABLE_CODE.test(raw.code) ? { kind: "failed", code: raw.code } : { kind: "rejected" };
	if (raw.ok !== true) return { kind: "rejected" };
	if (typeof raw.truncated !== "boolean") return { kind: "rejected" };
	if (!isCount(raw.scanned)) return { kind: "rejected" };
	if (!Array.isArray(raw.entries)) return { kind: "rejected" };
	const entries: RemoteSearchEntryView[] = [];
	for (const value of raw.entries) {
		const entry = readSearchEntryView(value);
		if (entry === undefined) return { kind: "rejected" };
		entries.push(entry);
	}
	return { kind: "ok", entries, scanned: raw.scanned, truncated: raw.truncated };
}

/**
 * 服务层搜索结果 → 搜索状态机的终态。
 *
 * Phase B 起名字搜索只消费 `ProjectFileService.searchFiles`（类型已收窄），但仍在这一层重建
 * 视图对象：外部数据只在边界解析一次，缺字段/坏路径一律 `rejected`，绝不把畸形对象渲染出去。
 * 服务契约目前只携带 name/relativePath/type，因此这里不再有 bytes 与 "other" 分类（见交接 §8.8 的
 * S 契约扩展项）；truncated/scanned 原样保留，截断不能冒充完整结果。
 */
export function remoteSearchOutcomeFromService(result: { results: readonly { name: string; relativePath: string; type: "file" | "directory" }[]; entries?: readonly { path: string; name: string; kind: "file" | "directory" | "other"; bytes?: number }[]; truncated?: boolean; scanned?: number }): RemoteSearchOutcome {
	if (!Array.isArray(result.results)) return { kind: "rejected" };
	if (result.truncated !== undefined && typeof result.truncated !== "boolean") return { kind: "rejected" };
	if (result.scanned !== undefined && !isCount(result.scanned)) return { kind: "rejected" };
	const scanned = result.scanned ?? 0;
	const truncated = result.truncated === true;
	// 远端 provider 会附带原始 entries（other/bytes）；有就优先用它，避免把未跟随的链接/大小丢掉。
	if (result.entries !== undefined) {
		if (!Array.isArray(result.entries)) return { kind: "rejected" };
		const entries: RemoteSearchEntryView[] = [];
		for (const item of result.entries) {
			const view = readSearchEntryView(item);
			if (view === undefined) return { kind: "rejected" };
			entries.push(view);
		}
		return { kind: "ok", entries, scanned, truncated };
	}
	const entries: RemoteSearchEntryView[] = [];
	for (const item of result.results) {
		const path = item.relativePath;
		if (typeof path !== "string" || !isSafeRelativePath(path)) return { kind: "rejected" };
		const name = item.name;
		if (typeof name !== "string" || !isEntryName(name)) return { kind: "rejected" };
		if (path !== name && !path.endsWith("/" + name)) return { kind: "rejected" };
		if (item.type !== "file" && item.type !== "directory") return { kind: "rejected" };
		entries.push({ path, name, kind: item.type });
	}
	return { kind: "ok", entries, scanned, truncated };
}

function idleState(): RemoteProjectSearchState {
	return { phase: "idle", query: "", entries: [], truncated: false, scanned: 0, errorCode: null };
}

/** 落地一次成功/失败；三种终态的边界规则集中在这里（空 vs 被截断 vs 有结果）。 */
function settledState(query: string, outcome: RemoteSearchOutcome): RemoteProjectSearchState {
	if (outcome.kind === "failed") return { phase: "error", query, entries: [], truncated: false, scanned: 0, errorCode: outcome.code };
	if (outcome.kind === "rejected") return { phase: "error", query, entries: [], truncated: false, scanned: 0, errorCode: null };
	// 零匹配 + truncated 不是「没有匹配」：截断了就必须呈现成被截断的结果，绝不假装完整。
	const phase: RemoteSearchPhase = outcome.entries.length === 0 && !outcome.truncated ? "empty" : "results";
	return { phase, query, entries: outcome.entries, truncated: outcome.truncated, scanned: outcome.scanned, errorCode: null };
}

export type RemoteProjectSearchController = {
	/** 当前状态；**每次状态变化换成新对象**，可直接用于 React 的相等判断。 */
	getState(): RemoteProjectSearchState;
	/** 发起一次搜索：立即作废在途结果并进入 searching，返回本次代次。 */
	start(query: string): number;
	/** 落地一次结果；非当前代次返回 false 且不改动任何状态（迟到结果不得覆盖新查询）。 */
	settle(generation: number, outcome: RemoteSearchOutcome): boolean;
	/** 切项目/清空：作废在途结果并回到 idle。 */
	reset(): void;
};

export function createRemoteProjectSearchController(): RemoteProjectSearchController {
	const gate = createRequestGate();
	let state = idleState();
	return {
		getState: () => state,
		start(query) {
			const generation = gate.begin();
			state = { phase: "searching", query, entries: [], truncated: false, scanned: 0, errorCode: null };
			return generation;
		},
		settle(generation, outcome) {
			if (!gate.isCurrent(generation)) return false;
			state = settledState(state.query, outcome);
			return true;
		},
		reset() {
			gate.invalidate();
			state = idleState();
		},
	};
}
