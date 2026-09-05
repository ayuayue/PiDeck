import type { ProjectFileAccessScope } from "../../../shared/types";
import { desktopApi } from "../desktopApi";

/**
 * 文件路径存在性判定 store：按需批量 stat 校验的进程内缓存。
 *
 * 设计约束（对应 VS Code filePathLinkifier 的共享 stat cache 思路）：
 * - 键是「projectId + 绝对路径」；同一路径在不同项目授权域中不能复用判定；
 * - 相对路径必须由调用方经 resolveFileLinkPath 解析后再请求；
 * - 三态语义：true/false = 已校验；undefined = 未知。校验失败/IPC 异常不写缓存，
 *   未知时 UI 维持链接形态，避免把有效文件误降级成纯文本。
 */

const CACHE_LIMIT = 1024;
const BATCH_MAX = 96;
const FLUSH_DELAY_MS = 250;

type Listener = () => void;
type PendingBucket = {
	scope?: ProjectFileAccessScope;
	paths: string[];
};

const verdictCache = new Map<string, boolean>();
const listeners = new Set<Listener>();
const pendingByScope = new Map<string, PendingBucket>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function scopeKey(scope?: ProjectFileAccessScope): string {
	return scope?.projectId ?? "";
}

function verdictKey(absPath: string, scope?: ProjectFileAccessScope): string {
	return `${scopeKey(scope)}\u0000${absPath}`;
}

function notifyListeners(): void {
	for (const listener of [...listeners]) listener();
}

function trimCache(): void {
	// Map 保持插入序：超限时逐出最早写入的键。长会话的路径量有限，
	// 粗粒度逐出足够；精确 LRU 需要每次 get 重排，收益不成比例。
	while (verdictCache.size > CACHE_LIMIT) {
		const oldest = verdictCache.keys().next().value;
		if (oldest === undefined) break;
		verdictCache.delete(oldest);
	}
}

/** 读取判定结果：true/false = 已校验；undefined = 未校验（含校验失败）。 */
export function getFilePathVerdict(
	absPath: string,
	scope?: ProjectFileAccessScope,
): boolean | undefined {
	return verdictCache.get(verdictKey(absPath, scope));
}

export function subscribeFilePathVerdicts(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function armFlushTimer(): void {
	if (flushTimer === null) {
		flushTimer = setTimeout(() => {
			flushTimer = null;
			void flushVerdictBatch();
		}, FLUSH_DELAY_MS);
	}
}

/**
 * 批量请求存在性校验：按项目授权域分桶，250ms 去抖后逐桶发 IPC。
 * 同一 IPC 只能携带一个 projectId，不能把两个分屏项目的路径混在一批里。
 */
export function requestFilePathVerdicts(
	paths: string[],
	scope?: ProjectFileAccessScope,
): void {
	const key = scopeKey(scope);
	const bucket = pendingByScope.get(key) ?? { scope, paths: [] };
	let added = false;
	for (const raw of paths) {
		if (!raw || verdictCache.has(verdictKey(raw, scope))) continue;
		if (bucket.paths.includes(raw)) continue;
		bucket.paths.push(raw);
		added = true;
	}
	if (!added) return;
	pendingByScope.set(key, bucket);
	armFlushTimer();
}

async function flushVerdictBatch(): Promise<void> {
	if (flushing) return;
	const next = pendingByScope.entries().next().value;
	if (!next) return;
	const [key, bucket] = next;
	const batch = [...new Set(bucket.paths)].slice(0, BATCH_MAX);
	const selected = new Set(batch);
	const remaining = bucket.paths.filter((path) => !selected.has(path));
	if (remaining.length > 0) pendingByScope.set(key, { ...bucket, paths: remaining });
	else pendingByScope.delete(key);
	if (batch.length === 0) return;

	flushing = true;
	try {
		// 主进程保证返回与入参等长的 boolean[]；防御性兜底把缺失位当未知处理。
		const results = await desktopApi.files.pathsExist(batch, bucket.scope);
		batch.forEach((path, index) => {
			const exists = Array.isArray(results) ? results[index] : undefined;
			if (typeof exists === "boolean") {
				verdictCache.set(verdictKey(path, bucket.scope), exists);
			}
		});
	} catch {
		// 校验通道不可用（预览模式/窗口关停中）：不留缓存，UI 维持链接形态。
	} finally {
		trimCache();
		flushing = false;
		notifyListeners();
		// 批量请求期间又来了新路径，或当前桶超过单批上限：继续调度直到清空。
		if (pendingByScope.size > 0) armFlushTimer();
	}
}
