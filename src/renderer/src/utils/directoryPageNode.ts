import type { FileTreeNode } from "../../../shared/types";
import type { ProjectDirectoryEntry } from "../../../shared/types/projectFiles";

/**
 * 文件树的 `ignored` 修饰（本机与远端共用**这一处**转发）。
 *
 * 为什么抽出来：本机树（`directoryPageNode`）与远端树（`useRemoteFileTree.entryToNode`）各自映射条目，
 * 任何一处漏掉这个 spread，「ignored 行置灰」就会半边生效——这正是并行 e2e 抓到的缺口。
 * 只转发确定命中的 `true`；缺失/false 都保持字段缺失（未知 ≠ 未忽略）。
 */
export function fileTreeIgnoredField(entry: ProjectDirectoryEntry): { ignored?: boolean } {
	return entry.ignored === true ? { ignored: true } : {};
}

/**
 * 公共目录页条目 → 文件树节点（本机与远端共用这一份映射）。
 *
 * 只做投影，不做判断：`path`/排序元数据按原样保留（本机条目有，远端条目没有），
 * `ignored` 只在 backend **确定**判定过的情况下转发——字段缺失表示“没判定（未知）”，
 * 不允许补成 `false` 冒充“查过了”。
 */
export function directoryPageNode(entry: ProjectDirectoryEntry): FileTreeNode {
	const name = entry.relativePath.slice(entry.relativePath.lastIndexOf("/") + 1);
	const path = entry.path ?? entry.relativePath;
	const isDirectory = entry.type === "directory";
	return {
		name,
		path,
		displayPath: path,
		relativePath: entry.relativePath,
		target: entry.target,
		type: entry.type,
		...(isDirectory ? { hasChildren: entry.hasChildren !== false } : {}),
		// 只转发确定的修饰；没判定就保持缺失。
		...fileTreeIgnoredField(entry),
		...(entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }),
		...(entry.ctimeMs === undefined ? {} : { ctimeMs: entry.ctimeMs }),
		...(entry.size === undefined ? {} : { size: entry.size }),
	};
}
