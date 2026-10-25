/**
 * checkpoint 路径过滤纯函数（只依赖 node 内置模块，可被 Node type stripping
 * 直接加载单测；移植自 pi-rewind core.ts，MIT）。
 *
 * 全部判断只依赖入参，不做任何项目内 import——刻意保持零依赖，
 * 让过滤规则（忽略目录、大文件/大目录阈值、路径归属）可以离开 git 单独测绿。
 */

import { join } from "node:path";

import { IGNORED_DIR_NAMES } from "./checkpointConstants.ts";

/** 路径任意段命中忽略目录名即忽略（跨平台匹配 / 与 \）。 */
export function shouldIgnoreForSnapshot(path: string): boolean {
	return path.split(/[/\\]/).some((c) => IGNORED_DIR_NAMES.has(c));
}

// 2027-02 移除 isLargeFile / isLargeDirectory（statSync/readdirSync 同步版）：
// 大小/大目录判定已由 captureStatusSnapshot 的异步 stat + detectLargeDirs（纯函数，
// 基于快照数据）承担，这两个同步版无人调用——留着只会被当成「可用的便捷判定」
// 复用回热路径（checkpoint 打点每 ≥8s 一次，同步 stat 在 WSL/UNC 下是主线程阻塞源）。

/** 统一 git 路径表示：反斜杠→正斜杠、去 ./ 前缀、去尾部斜杠。 */
export function normalizeGitPath(p: string): string {
	let n = p.replace(/\\/g, "/");
	if (n.startsWith("./")) n = n.slice(2);
	return n.replace(/\/$/, "");
}

/** path 是否位于 dir 之下（dir 为 "." 或空 = 根，恒真）。 */
export function isPathWithin(path: string, dir: string): boolean {
	if (!dir || dir === ".") return true;
	if (path === dir) return true;
	const prefix = dir.endsWith("/") ? dir : `${dir}/`;
	return path.startsWith(prefix);
}

/** path 是否位于任一目录之下（用于大目录保护集合判定）。 */
export function isPathWithinAny(path: string, dirs: ReadonlySet<string>): boolean {
	for (const d of dirs) if (isPathWithin(path, d)) return true;
	return false;
}

/**
 * 从「未跟踪文件 + 未跟踪目录」中找出文件数达到 threshold 的大目录。
 * 文件按「最具体（最深）的所在目录」分桶计数；不在任何未跟踪目录下的文件
 * 记到其父目录桶（根目录 "." 不计为大目录——根下文件多不代表该忽略）。
 */
export function detectLargeDirs(files: string[], dirs: string[], threshold: number): string[] {
	if (threshold <= 0 || files.length === 0) return [];
	const counts = new Map<string, number>();

	// 目录按深度降序排，保证 isPathWithin 命中时取到最深的那个。
	const sortedDirs = [...dirs].sort((a, b) => {
		const da = a.split("/").length;
		const db = b.split("/").length;
		return da !== db ? db - da : a.localeCompare(b);
	});

	for (const f of files) {
		let bucket: string | null = null;
		for (const d of sortedDirs) {
			if (isPathWithin(f, d)) {
				bucket = d;
				break;
			}
		}
		if (!bucket) {
			const parts = f.split("/");
			bucket = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
		}
		counts.set(bucket, (counts.get(bucket) || 0) + 1);
	}

	return [...counts.entries()]
		.filter(([k, v]) => v >= threshold && k !== ".")
		.sort((a, b) => b[1] - a[1])
		.map(([k]) => k);
}

/** 校验 checkpoint id 只含安全字符（与 shared/types/rewind.ts 的 isRewindCheckpointId 同规则）。 */
export const isSafeId = (id: string) => /^[\w-]+$/.test(id);

/** 字符串清洗为可用的 git ref 片段（非字母数字连字符替换为 _）。 */
export function sanitizeForRef(s: string): string {
	return s.replace(/[^a-zA-Z0-9-]/g, "_");
}

/** 找时间戳最接近 targetTs 的 checkpoint（同毫秒时稳定保持先到者）。 */
export function findClosestCheckpoint<T extends { timestamp: number }>(checkpoints: T[], targetTs: number): T | undefined {
	if (checkpoints.length === 0) return undefined;
	return checkpoints.reduce((best, cp) => {
		const bd = Math.abs(best.timestamp - targetTs);
		const cd = Math.abs(cp.timestamp - targetTs);
		// 优先选「targetTs 之后最近」而非「之前最近」，保证回退不跳到更早的点。
		if (cp.timestamp <= targetTs && best.timestamp > targetTs) return cp;
		if (best.timestamp <= targetTs && cp.timestamp > targetTs) return best;
		return cd < bd ? cp : best;
	});
}
