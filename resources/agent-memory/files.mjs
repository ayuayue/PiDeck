/**
 * Markdown 真值的读写层。
 *
 * 三条约束：
 *  1. **原子替换**：先写同目录临时文件再 `rename`，避免进程崩在写到一半时留下半份记忆。
 *     跨进程并发（宿主进程 + 本 MCP 服务器 + 用户编辑器）时，原子替换保证读者永远
 *     看到「旧的完整版」或「新的完整版」，最坏情况是后写者覆盖先写者——这是我们要的语义，
 *     记忆是增量追加的，覆盖只会丢最近一条，不会产生损坏文件。
 *  2. **写入后裁剪**：预算在写这一层强制执行，调用方不需要自己算。
 *  3. **目录按需创建**：首次写入时创建 `projects/<id>/`，但只在真正落盘时才建，
 *     避免「读一下」就在用户磁盘上留下空目录。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { dedupeEntries, parseEntries, renderEntries, trimEntries } from "./format.mjs";
import { FILE_BUDGETS, resolveMemoryRoot, targetFilePath } from "./paths.mjs";

/** 读文件；文件不存在等价于「还没有记忆」。 */
export function readRaw(filePath) {
	try {
		return readFileSync(filePath, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
		throw error;
	}
}

/** 读某个 target 的条目数组。 */
export function readEntries(root, target, projectId) {
	return parseEntries(readRaw(targetFilePath(root, target, projectId)));
}

/** 原子写：同目录临时文件 + rename；失败时清理临时文件。 */
export function writeAtomic(filePath, content) {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, content, "utf8");
		renameSync(temporary, filePath);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/**
 * 对某个 target 做一次「读 → 改 → 写」。
 * @param {string} root 记忆根目录
 * @param {"memory"|"user"|"standing"|"failure"} target
 * @param {string} projectId 项目作用域 id；空串表示全局
 * @param {(entries: string[]) => { entries: string[], result: any }} mutator
 * @returns {{ changed: boolean, result: any, dropped: number, count: number }}
 */
export function mutateEntries(root, target, projectId, mutator) {
	const filePath = targetFilePath(root, target, projectId);
	const before = dedupeEntries(parseEntries(readRaw(filePath)));
	const { entries: next, result } = mutator(before.slice());
	const trimmed = trimEntries(dedupeEntries(next), FILE_BUDGETS[target]);
	const rendered = renderEntries(trimmed.entries);
	if (rendered !== renderEntries(before)) writeAtomic(filePath, rendered);
	return { changed: rendered !== renderEntries(before), result, dropped: trimmed.dropped, count: trimmed.entries.length };
}

/** 便捷包装：让 mutator 只关心「要追加什么」。 */
export function appendEntry(root, target, projectId, entry) {
	return mutateEntries(root, target, projectId, (entries) => {
		entries.push(entry);
		return { entries, result: { added: true } };
	});
}

/** 读全部 target（注入路径用）：返回 `{ memory, user, standing, failure }` 原始条目数组。 */
export function readAllEntries(projectId, root = resolveMemoryRoot()) {
	return {
		standing: readEntries(root, "standing", ""),
		user: readEntries(root, "user", ""),
		memory: readEntries(root, "memory", ""),
		failure: readEntries(root, "failure", ""),
		projectMemory: projectId ? readEntries(root, "memory", projectId) : [],
		projectFailure: projectId ? readEntries(root, "failure", projectId) : [],
	};
}
