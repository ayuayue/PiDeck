import type { FileTreeNode } from "../../../shared/types";
import type { ProjectDirectoryEntry } from "../../../shared/types/projectFiles";

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
		...(entry.ignored === true ? { ignored: true } : {}),
		...(entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }),
		...(entry.ctimeMs === undefined ? {} : { ctimeMs: entry.ctimeMs }),
		...(entry.size === undefined ? {} : { size: entry.size }),
	};
}
