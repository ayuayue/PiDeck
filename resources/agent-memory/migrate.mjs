/**
 * 项目键算法变更后的一次性目录迁移。
 *
 * 键从「短路径直接用 slug」换成「slug + 路径哈希」后，老用户的 `projects/<旧键>/`
 * 会和新键失联——记忆还在磁盘上，但会话再也读不到（看起来就是「我的项目记忆没了」）。
 * 这里把旧目录改名到新键：
 * - **幂等**：新键目录已存在就跳过（不合并、不覆盖：两边都有时宁可不迁移，也不冒丢条目的险）；
 * - **尽力而为**：单个目录改名失败（权限、并发）只记录，不阻断会话启动；
 * - 只在**已知 cwd** 上做：键是单向派生，无法从目录名反推原路径。
 */

import { renameSync, statSync } from "node:fs";
import path from "node:path";

import { legacyProjectKeyFromPath, projectKeyFromPath } from "./paths.mjs";

function isDirectory(target) {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/**
 * @param {string} root 记忆根目录
 * @param {string[]} cwds 需要迁移的项目路径（当前会话 cwd + 宿主已知的项目路径）
 * @returns {{ moved: {from: string, to: string}[], skipped: {from: string, to: string, reason: string}[] }}
 */
export function migrateLegacyProjectDirs(root, cwds) {
	const moved = [];
	const skipped = [];
	if (typeof root !== "string" || root.length === 0) return { moved, skipped };
	for (const cwd of Array.isArray(cwds) ? cwds : []) {
		const next = projectKeyFromPath(cwd);
		const legacy = legacyProjectKeyFromPath(cwd);
		if (!next || !legacy || next === legacy) continue;
		const from = path.join(root, "projects", legacy);
		const to = path.join(root, "projects", next);
		if (!isDirectory(from)) continue;
		if (isDirectory(to)) {
			skipped.push({ from: legacy, to: next, reason: "target-exists" });
			continue;
		}
		try {
			renameSync(from, to);
			moved.push({ from: legacy, to: next });
		} catch (error) {
			skipped.push({ from: legacy, to: next, reason: error && typeof error === "object" && "code" in error ? String(error.code) : "rename-failed" });
		}
	}
	return { moved, skipped };
}
