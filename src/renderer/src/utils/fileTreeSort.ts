import type { FileTreeNode } from "../../../shared/types/session";
import type { TranslationKey } from "../i18n";

/**
 * 文件树排序维度。
 * - name：按名称（默认）
 * - mtime：按更新时间
 * - ctime：按创建时间
 * - size：按大小（目录恒 0，目录仍排前）
 */
export type FileSortMode = "name" | "mtime" | "ctime" | "size";
/** 排序方向：asc 升序（名称 A→Z / 时间旧→新 / 大小小→大），desc 倒序 */
export type FileSortDirection = "asc" | "desc";

/** 目录永远排在文件前；维度+方向只决定同类型内的次序。 */
function compareNodes(a: FileTreeNode, b: FileTreeNode, mode: FileSortMode, direction: FileSortDirection): number {
	if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
	let result: number;
	switch (mode) {
		case "mtime":
			result = (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
			break;
		case "ctime":
			result = (a.ctimeMs ?? 0) - (b.ctimeMs ?? 0);
			break;
		case "size":
			result = (a.size ?? 0) - (b.size ?? 0);
			break;
		case "name":
		default:
			result = a.name.localeCompare(b.name);
			break;
	}
	// 数值/时间类维度默认倒序更常用（最新的/最大的在前），故 desc 时取反；
	// 名称类 asc 即 A→Z。时间戳相等时回退名称比较保证稳定。
	if (result === 0) return a.name.localeCompare(b.name);
	return direction === "desc" ? -result : result;
}

/** 递归按维度+方向排序文件树（每层子节点独立排序，不改变树结构引用）。 */
export function sortFileNodes(nodes: FileTreeNode[], mode: FileSortMode, direction: FileSortDirection): FileTreeNode[] {
	return nodes.map((node) => (node.children && node.children.length > 0 ? { ...node, children: sortFileNodes(node.children, mode, direction) } : node)).sort((a, b) => compareNodes(a, b, mode, direction));
}

/** 各维度默认方向：名称升序；时间/大小倒序（最新/最大在前）。 */
export const FILE_SORT_DEFAULT_DIRECTION: Record<FileSortMode, FileSortDirection> = {
	name: "asc",
	mtime: "desc",
	ctime: "desc",
	size: "desc",
};

export const FILE_SORT_OPTIONS: readonly { value: FileSortMode; labelKey: TranslationKey }[] = [
	{ value: "name", labelKey: "drawer.fileSort.name" },
	{ value: "mtime", labelKey: "drawer.fileSort.mtime" },
	{ value: "ctime", labelKey: "drawer.fileSort.ctime" },
	{ value: "size", labelKey: "drawer.fileSort.size" },
];
