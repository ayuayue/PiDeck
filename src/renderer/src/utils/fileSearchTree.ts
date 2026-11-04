import type { FileSearchResult } from "../../../shared/types";

/**
 * 文件名搜索结果的树形归并。
 *
 * 搜索返回的是扁平命中列表（命中路径的前缀目录并不在结果里），直接平铺会把
 * `src/components/session/FileSearchResults.tsx` 这类长路径挤在同一列，用户看不出
 * 命中集中在哪个目录。这里按 relativePath 的前缀补出目录层，再交给渲染层按树展示。
 *
 * 目录命中（type === "directory"）不是文件，挂在自身路径对应的目录节点上（item），
 * 所以「搜到的目录」和「为了挂文件补出来的目录」在树里是同一行，不会重复出现。
 */

export type FileSearchTreeDir = {
	type: "directory";
	/** 相对项目根的目录路径（根为 ""），同时是展开态的稳定键 */
	key: string;
	/** 末级目录名（根为空串） */
	name: string;
	/** 目录本身命中了查询词；纯前缀目录没有 */
	item?: FileSearchResult;
	children: FileSearchTreeEntry[];
};

export type FileSearchTreeFile = {
	type: "file";
	key: string;
	item: FileSearchResult;
};

export type FileSearchTreeEntry = FileSearchTreeDir | FileSearchTreeFile;

/** 相对路径归一：主进程 searchNames 已把分隔符换成 /，这里防御远端/历史数据的反斜杠与首尾斜杠。 */
export function normalizeSearchRelativePath(relativePath: string): string {
	return relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** 目录永远排在文件前，同类型按名称排序（与文件树一致的阅读顺序）。 */
function sortEntries(entries: FileSearchTreeEntry[]): void {
	entries.sort((left, right) => {
		if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
		const leftName = left.type === "directory" ? left.name : left.item.name;
		const rightName = right.type === "directory" ? right.name : right.item.name;
		return leftName.localeCompare(rightName);
	});
	for (const entry of entries) {
		if (entry.type === "directory") sortEntries(entry.children);
	}
}

/** 扁平命中列表 → 树。返回的是根目录的子项（项目根本身不占一行）。 */
export function buildFileSearchTree(results: readonly FileSearchResult[]): FileSearchTreeEntry[] {
	const root: FileSearchTreeDir = { type: "directory", key: "", name: "", children: [] };
	const directories = new Map<string, FileSearchTreeDir>([["", root]]);

	// 逐段补出父目录：命中顺序是 BFS 的「先浅后深」，但父目录不一定命中，只能按路径补。
	const ensureDirectory = (path: string): FileSearchTreeDir => {
		const existing = directories.get(path);
		if (existing) return existing;
		const slash = path.lastIndexOf("/");
		const parent = ensureDirectory(slash < 0 ? "" : path.slice(0, slash));
		const directory: FileSearchTreeDir = { type: "directory", key: path, name: path.slice(slash + 1), children: [] };
		directories.set(path, directory);
		parent.children.push(directory);
		return directory;
	};

	for (const item of results) {
		const relativePath = normalizeSearchRelativePath(item.relativePath);
		if (item.type === "directory") {
			// 目录命中：挂在同路径节点上，与「被文件带出来的前缀目录」合并成一行
			ensureDirectory(relativePath).item = item;
			continue;
		}
		const slash = relativePath.lastIndexOf("/");
		const parent = ensureDirectory(slash < 0 ? "" : relativePath.slice(0, slash));
		parent.children.push({ type: "file", key: relativePath, item });
	}

	sortEntries(root.children);
	return root.children;
}

/** 目录节点下的命中文件数（含更深层），供折叠态显示「这个目录里还有多少命中」。 */
export function countSearchTreeFiles(entries: readonly FileSearchTreeEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		total += entry.type === "file" ? 1 : countSearchTreeFiles(entry.children);
	}
	return total;
}
