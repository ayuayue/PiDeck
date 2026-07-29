import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * 桌面端 RPC 启动时已知不兼容 / 可能导致整应用异常的扩展。
 * CodeIsland 面向终端 pi + macOS 浮动窗；在 Electron 子进程树下
 * 曾出现「启动 Agent 后 PiDeck 整应用退出」。无法改第三方扩展时，
 * 由 PiDeck 在 RPC 生命周期内临时停放（rename）该文件，进程退出后还原。
 *
 * 注意：不要用 --no-extensions 白名单方案——会误伤 npm packages 扩展。
 */
export const DESKTOP_BLOCKED_EXTENSION_PATTERNS: RegExp[] = [
	/^codeisland(\.ts|\.js)?$/i,
	/codeisland/i,
];

/** 停放后缀：不以 .ts/.js 结尾，pi 自动发现不会加载 */
export const DESKTOP_PARK_SUFFIX = ".pideck-disabled";

export type ExtensionFilterResult = {
	/** 被识别为应隔离的扩展 basename（停放前的名字） */
	blocked: string[];
	/** 可安全保留的扩展绝对路径（仅用于诊断/列举，不再用于 -e 白名单） */
	safePaths: string[];
};

/** 判断扩展 basename 是否应在桌面 RPC 中隔离。 */
export function isDesktopBlockedExtension(name: string): boolean {
	const base = basename(name).trim();
	if (!base || base.startsWith(".")) return false;
	// 已停放文件不再二次匹配
	if (base.endsWith(DESKTOP_PARK_SUFFIX)) return false;
	return DESKTOP_BLOCKED_EXTENSION_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * 扫描扩展目录，拆分被拦截与可安全加载的条目。
 * 单文件 .ts/.js 与含 index.ts/js 的目录都会识别。
 */
export function scanExtensionDir(extensionsDir: string): ExtensionFilterResult {
	const blocked: string[] = [];
	const safePaths: string[] = [];

	if (!extensionsDir || !existsSync(extensionsDir)) {
		return { blocked, safePaths };
	}

	let entries: string[];
	try {
		entries = readdirSync(extensionsDir);
	} catch {
		return { blocked, safePaths };
	}

	for (const entry of entries) {
		if (!entry || entry.startsWith(".") || entry === "node_modules" || entry.endsWith(".d.ts")) {
			continue;
		}
		// 已停放的扩展：记入 blocked（还原用），不进 safePaths
		if (entry.endsWith(DESKTOP_PARK_SUFFIX)) {
			const original = entry.slice(0, -DESKTOP_PARK_SUFFIX.length);
			if (original) blocked.push(original);
			continue;
		}

		const fullPath = join(extensionsDir, entry);
		let isFile = false;
		let isDir = false;
		try {
			const st = statSync(fullPath);
			isFile = st.isFile();
			isDir = st.isDirectory();
		} catch {
			continue;
		}

		if (isFile) {
			if (!entry.endsWith(".ts") && !entry.endsWith(".js")) continue;
			if (isDesktopBlockedExtension(entry)) {
				blocked.push(entry);
			} else {
				safePaths.push(fullPath);
			}
			continue;
		}

		if (isDir) {
			const indexTs = join(fullPath, "index.ts");
			const indexJs = join(fullPath, "index.js");
			if (!existsSync(indexTs) && !existsSync(indexJs)) continue;
			if (isDesktopBlockedExtension(entry)) {
				blocked.push(entry);
			} else {
				safePaths.push(fullPath);
			}
		}
	}

	return { blocked, safePaths };
}

/** 合并多目录扫描结果（用户级 + 项目级）。 */
export function mergeExtensionFilters(
	...results: ExtensionFilterResult[]
): ExtensionFilterResult {
	const blockedSet = new Set<string>();
	const pathSet = new Set<string>();
	for (const result of results) {
		for (const name of result.blocked) blockedSet.add(name);
		for (const path of result.safePaths) pathSet.add(path);
	}
	return {
		blocked: [...blockedSet],
		safePaths: [...pathSet],
	};
}

export type ParkedExtension = {
	/** 扩展所在目录 */
	dir: string;
	/** 原始 basename（如 codeisland.ts） */
	name: string;
	/** 停放后的完整路径 */
	parkedPath: string;
	/** 原始完整路径 */
	originalPath: string;
};

/**
 * 引用计数：多个 Agent 并发时只 park 一次，全部退出后再 unpark。
 * key = `${dir}::${name}`
 */
const parkRefCount = new Map<string, number>();

function parkKey(dir: string, name: string): string {
	return `${dir}::${name}`;
}

/**
 * 将目录中匹配的危险扩展临时改名，使 pi 自动发现跳过它们。
 * npm packages / 其它本地扩展不受影响。
 * @returns 本次新停放或已在停放中的条目（用于诊断文案）
 */
export function parkBlockedExtensionsInDir(extensionsDir: string): ParkedExtension[] {
	const result: ParkedExtension[] = [];
	if (!extensionsDir || !existsSync(extensionsDir)) return result;

	let entries: string[];
	try {
		entries = readdirSync(extensionsDir);
	} catch {
		return result;
	}

	for (const entry of entries) {
		if (!entry || entry.startsWith(".") || entry === "node_modules") continue;

		// 已经是停放态：只抬引用计数
		if (entry.endsWith(DESKTOP_PARK_SUFFIX)) {
			const original = entry.slice(0, -DESKTOP_PARK_SUFFIX.length);
			if (!original || !isDesktopBlockedExtension(original)) continue;
			const key = parkKey(extensionsDir, original);
			parkRefCount.set(key, (parkRefCount.get(key) ?? 0) + 1);
			result.push({
				dir: extensionsDir,
				name: original,
				parkedPath: join(extensionsDir, entry),
				originalPath: join(extensionsDir, original),
			});
			continue;
		}

		const fullPath = join(extensionsDir, entry);
		let isFile = false;
		let isDir = false;
		try {
			const st = statSync(fullPath);
			isFile = st.isFile();
			isDir = st.isDirectory();
		} catch {
			continue;
		}

		const looksLikeExt =
			(isFile && (entry.endsWith(".ts") || entry.endsWith(".js"))) ||
			(isDir &&
				(existsSync(join(fullPath, "index.ts")) || existsSync(join(fullPath, "index.js"))));
		if (!looksLikeExt) continue;
		if (!isDesktopBlockedExtension(entry)) continue;

		const parkedPath = fullPath + DESKTOP_PARK_SUFFIX;
		const key = parkKey(extensionsDir, entry);
		// 目标已存在（上次异常退出残留）：视为已停放
		if (existsSync(parkedPath) && !existsSync(fullPath)) {
			parkRefCount.set(key, (parkRefCount.get(key) ?? 0) + 1);
			result.push({
				dir: extensionsDir,
				name: entry,
				parkedPath,
				originalPath: fullPath,
			});
			continue;
		}

		try {
			if (existsSync(fullPath)) {
				// 若停放名已存在，先去掉残留再 rename，避免 EEXIST
				if (existsSync(parkedPath)) {
					try {
						renameSync(parkedPath, fullPath + `.pideck-bak-${Date.now()}`);
					} catch {
						/* 尽力清理 */
					}
				}
				renameSync(fullPath, parkedPath);
			}
			parkRefCount.set(key, (parkRefCount.get(key) ?? 0) + 1);
			result.push({
				dir: extensionsDir,
				name: entry,
				parkedPath,
				originalPath: fullPath,
			});
		} catch (error) {
			console.error(
				"[piExtensionFilter] Failed to park extension:",
				entry,
				error instanceof Error ? error.message : error,
			);
		}
	}

	return result;
}

/**
 * 释放一次停放引用；引用归零时把文件名还原，供 CLI / 其它工具继续使用。
 */
export function unparkBlockedExtensions(parked: ParkedExtension[]): void {
	for (const item of parked) {
		const key = parkKey(item.dir, item.name);
		const current = parkRefCount.get(key) ?? 0;
		const next = Math.max(0, current - 1);
		if (next > 0) {
			parkRefCount.set(key, next);
			continue;
		}
		parkRefCount.delete(key);

		try {
			if (existsSync(item.parkedPath) && !existsSync(item.originalPath)) {
				renameSync(item.parkedPath, item.originalPath);
			}
		} catch (error) {
			console.error(
				"[piExtensionFilter] Failed to unpark extension:",
				item.name,
				error instanceof Error ? error.message : error,
			);
		}
	}
}

/**
 * 应用启动时清理异常退出留下的停放文件，避免扩展永久消失。
 * 不依赖引用计数（进程重启后计数已空）。
 */
export function restoreAllParkedExtensions(extensionsDirs: string[]): string[] {
	const restored: string[] = [];
	for (const dir of extensionsDirs) {
		if (!dir || !existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(DESKTOP_PARK_SUFFIX)) continue;
			const original = entry.slice(0, -DESKTOP_PARK_SUFFIX.length);
			if (!original) continue;
			const parkedPath = join(dir, entry);
			const originalPath = join(dir, original);
			try {
				if (!existsSync(originalPath)) {
					renameSync(parkedPath, originalPath);
					restored.push(original);
				}
			} catch (error) {
				console.error(
					"[piExtensionFilter] Failed to restore parked extension on startup:",
					entry,
					error instanceof Error ? error.message : error,
				);
			}
		}
	}
	parkRefCount.clear();
	return restored;
}

/**
 * @deprecated 保留空实现以免旧调用方编译失败；不再使用 --no-extensions 白名单。
 */
export function buildBlockedExtensionCliArgs(
	_filter: ExtensionFilterResult,
	_options?: { alreadyNoExtensions?: boolean },
): string[] {
	return [];
}
