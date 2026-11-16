/**
 * 归档/删除父会话时，磁盘侧还要单独处理的子树文件（#539）。
 *
 * 两种子会话布局：
 *   1. 嵌套目录 `parent.jsonl` + `parent/child.jsonl` —— `SessionScanner.archive/delete`
 *      会把整个 `<stem>/` 目录一起搬走，不用管；
 *   2. **平铺**（`@tintinweb/pi-subagents` 形态）：`parent.jsonl` 与 `child.jsonl` 同目录，
 *      靠会话头里的 `parentSession` 指回父文件。扫描器只认 `<stem>/`，这类子文件的
 *      catalog 条目会被 `removeWithDescendants` 摘掉、文件却留在活动扫描目录里，
 *      下次扫描就变成失去父节点的孤儿行。
 *
 * 这里补的是第 2 种：判定复用 catalog 的子树规则（`listSubtreeEntries`），只把
 * 「任何子树成员的 sibling 目录都覆盖不到」的那几个文件挑出来逐个交代给调用方。
 */
import { canonicalizeSessionPath, sessionSiblingDirPrefix } from "../../shared/sessionIdentity";
import type { SessionEnvironment } from "../../shared/types";

/** 只依赖 catalog 的读端口，便于单测直接给假条目。 */
export type SessionSubtreeCatalogPort = {
	listSubtreeEntries(id: string): ReadonlyArray<{ id: string }>;
	getLocalFilePath(id: string): string | undefined;
};

export type ScatteredSubtreeFile = { sessionId: string; filePath: string };

/**
 * 父会话磁盘操作覆盖不到的子树文件（平铺子代理、跨目录 parentSession 链接等）。
 *
 * 跳过规则：
 * - 父会话自身；
 * - 落在任一子树成员的 sibling 目录 `<stem>/` 里的文件——那个目录会跟着它的 owner 一起被搬走/删除，
 *   同一棵子树里“先处理 owner、再处理它下面的文件”会变成第二次 rename 失败（ENOENT）；
 * - 没有本机文件路径的条目（DSH/远端记录/草稿）；
 * - 同一个文件路径出现两次（归并条目可能指向同一文件）。
 */
export function scatteredSubtreeFiles(input: { catalog: SessionSubtreeCatalogPort; sessionId: string; parentFilePath: string; environment: SessionEnvironment }): ScatteredSubtreeFile[] {
	const canonical = (filePath: string) => canonicalizeSessionPath(filePath, input.environment);

	const candidates: ScatteredSubtreeFile[] = [];
	const seenPaths = new Set<string>([canonical(input.parentFilePath)]);
	for (const entry of input.catalog.listSubtreeEntries(input.sessionId)) {
		if (entry.id === input.sessionId) continue;
		// `getLocalFilePath` 对 ssh locator 会抛（远端记录没有本机文件）：那不是本函数的职责，
		// 跳过即可——抛出去会把一次正常的归档/删除变成「操作失败」。
		let filePath: string | undefined;
		try {
			filePath = input.catalog.getLocalFilePath(entry.id);
		} catch {
			continue;
		}
		if (!filePath) continue;
		const canonicalPath = canonical(filePath);
		if (seenPaths.has(canonicalPath)) continue;
		seenPaths.add(canonicalPath);
		candidates.push({ sessionId: entry.id, filePath });
	}

	// 父会话与每个候选自己的 sibling 目录都算「已被覆盖」：那些文件会跟着自己的 owner
	// 一起被搬走/删除，再单独处理一次只会拿到 ENOENT（而且顺序不可控）。
	const coveredPrefixes = [input.parentFilePath, ...candidates.map((candidate) => candidate.filePath)].map((filePath) => sessionSiblingDirPrefix(filePath, input.environment)).filter((prefix): prefix is string => prefix !== undefined);
	return candidates.filter((candidate) => !coveredPrefixes.some((prefix) => canonical(candidate.filePath).startsWith(prefix)));
}

/**
 * 把散落的子树文件逐个交给 `run`（归档 → `scanner.archive`，删除 → `scanner.delete`）。
 *
 * 失败只收集不抛出：调用方此刻已经把父会话搬走/删掉了，这时候报错会让用户看到
 * 「操作失败」而 catalog 又没更新，比留下一个文件更难收拾。返回失败路径供调用方记日志
 * ——与既有的 sibling 目录清理同一取舍（见 `SessionScanner.delete` 的注释）。
 */
export async function runForScatteredSubtreeFiles(input: { catalog: SessionSubtreeCatalogPort; sessionId: string; parentFilePath: string; environment: SessionEnvironment; run: (filePath: string) => Promise<unknown> }): Promise<string[]> {
	const failures: string[] = [];
	for (const candidate of scatteredSubtreeFiles(input)) {
		try {
			await input.run(candidate.filePath);
		} catch {
			failures.push(candidate.filePath);
		}
	}
	return failures;
}
