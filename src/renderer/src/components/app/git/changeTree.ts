import type { GitResource, GitResourceGroups } from "../../../../../shared/types";

/**
 * Git 变更列表的树形建模（纯函数，无 React 依赖，便于单测）。
 *
 * 背景：变更列表只有扁平资源数组（`GitResource[]`，含绝对路径），但右抽屉需要一层
 * 可折叠的目录树。本模块把扁平数组折成嵌套行，供 GitPanel / GitResourceTree 渲染：
 * - 目录优先于文件排序（VS Code 语义）；
 * - 单子目录且无文件时向上合并成 `a.b.c` 一行（同 fileTreeCompact 的紧凑中包思路），
 *   避免 `src/main/pi/...` 这类链把列表挤成竖条；
 * - 目录行的 resources 是整个子树的资源，「暂存目录 / 回滚目录 / 计数」因此对整棵子树生效。
 */

/**
 * 项目根下的相对路径（统一 POSIX 分隔符）；不在根内时原样返回。
 * 多仓 / 项目目录外的路径没有共同前缀，保持原样由上层按段拆分。
 */
export function toRelativeChangePath(path: string, projectRoot?: string): string {
	const normalizedPath = path.replace(/[\\]+/g, "/");
	if (!projectRoot) return normalizedPath;
	const normalizedRoot = projectRoot.replace(/[\\]+/g, "/").replace(/\/+$/, "");
	if (normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath.slice(normalizedRoot.length + 1);
	if (normalizedPath === normalizedRoot) return "";
	return normalizedPath;
}

/**
 * 「未暂存的更改」组要渲染的资源：只取工作区侧的 workingTree + untracked。
 *
 * git status --porcelain 对「暂存后又继续改」的文件会同时给出 index 与 workingTree 两条资源，
 * 两者语义不同（index = HEAD↔暂存区，workingTree = 暂存区↔工作区），Changes 组只能渲染后者。
 * 把 index 资源也并进来会让已暂存文件在「未暂存的更改」里多留一行（issue #391），点它还按
 * workingTree 组取 diff，主进程在该组查不到资源 → 直接报「无法读取该工作区文件的差异内容」。
 * 因此这里不做按路径去重：workingTree 与 untracked 天然互斥。
 */
export function collectUnstagedResources(groups: Pick<GitResourceGroups, "workingTree" | "untracked">): GitResource[] {
	return [...groups.workingTree, ...groups.untracked];
}

/** 相对路径的目录部分；根级文件返回 ""（与扁平视图的根分组键一致）。 */
export function changeDirOf(relativePath: string): string {
	const parts = relativePath.split("/");
	return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

export type ChangeTreeDirRow = {
	kind: "dir";
	/** 目录相对项目根的路径；折叠状态与目录级操作都以它为键 */
	path: string;
	/** 展示名：紧凑链合并成 `a.b.c`，其余为末段目录名 */
	label: string;
	depth: number;
	/** 整棵子树的资源（暂存/回滚目录作用于这些路径） */
	resources: GitResource[];
};

export type ChangeTreeFileRow = {
	kind: "file";
	resource: GitResource;
	depth: number;
};

export type ChangeTreeRow = ChangeTreeDirRow | ChangeTreeFileRow;

/** 变更列表视图模式：tree = 嵌套目录树（默认展示）；flat = 按目录一级分组 */
export type GitChangeViewMode = "flat" | "tree";

type TreeNode = {
	children: Map<string, TreeNode>;
	/** 直属当前目录的文件（保持入参顺序：git status 已按路径排序） */
	files: GitResource[];
};

function emptyNode(): TreeNode {
	return { children: new Map(), files: [] };
}

/** 收集节点及其全部子目录下的文件 */
function collectSubtreeFiles(node: TreeNode, out: GitResource[] = []): GitResource[] {
	out.push(...node.files);
	for (const child of node.children.values()) collectSubtreeFiles(child, out);
	return out;
}

/** 把扁平资源折成目录树（逐段建立中间目录，即使中间目录没有直属文件） */
function buildTree(resources: GitResource[], projectRoot?: string): TreeNode {
	const root = emptyNode();
	for (const resource of resources) {
		const parts = toRelativeChangePath(resource.path, projectRoot).split("/");
		let node = root;
		for (const segment of parts.slice(0, -1)) {
			if (!segment) continue;
			const existing = node.children.get(segment);
			if (existing) {
				node = existing;
				continue;
			}
			const created = emptyNode();
			node.children.set(segment, created);
			node = created;
		}
		node.files.push(resource);
	}
	return root;
}

/**
 * 折叠「中间包」：恰好 1 个子目录且无直属文件的目录并入子目录，展示名以 `.` 连接。
 * 返回链尾节点与合并后的展示名；调用方用链尾路径做折叠键（中间层不会成为可点击行）。
 */
function compactChain(name: string, node: TreeNode): { label: string; segments: string[]; node: TreeNode } {
	// 同时保留真实目录段：目录名里可能含 `.`，不能用展示名反推路径
	const segments = [name];
	let current = node;
	while (current.files.length === 0 && current.children.size === 1) {
		const [childName, childNode] = [...current.children.entries()][0];
		segments.push(childName);
		current = childNode;
	}
	return { label: segments.join("."), segments, node: current };
}

/**
 * 把扁平变更资源折成树形行序列（目录行 + 文件行，前序遍历）。
 * `collapsedDirs` 命中的目录只输出目录行、不输出子树（折叠语义在这里生效，渲染层无需感知层级）。
 */
export function buildChangeTreeRows(resources: GitResource[], projectRoot?: string, collapsedDirs?: ReadonlySet<string>): ChangeTreeRow[] {
	const rows: ChangeTreeRow[] = [];

	const walk = (node: TreeNode, dirPath: string, depth: number): void => {
		// 目录优先、同级按名称排序：与文件抽屉的树一致
		const dirNames = [...node.children.keys()].sort((a, b) => a.localeCompare(b));
		for (const name of dirNames) {
			const { label, segments, node: leaf } = compactChain(name, node.children.get(name)!);
			const fullPath = [dirPath, ...segments].filter(Boolean).join("/");
			rows.push({ kind: "dir", path: fullPath, label, depth, resources: collectSubtreeFiles(leaf) });
			if (collapsedDirs?.has(fullPath)) continue;
			walk(leaf, fullPath, depth + 1);
		}
		for (const file of node.files) rows.push({ kind: "file", resource: file, depth });
	};

	walk(buildTree(resources, projectRoot), "", 0);
	return rows;
}

/** 树形视图里全部可折叠目录路径（用于「收起/展开全部」的状态判定与批量操作）。 */
export function collectChangeTreeDirPaths(resources: GitResource[], projectRoot?: string): string[] {
	return buildChangeTreeRows(resources, projectRoot)
		.filter((row): row is ChangeTreeDirRow => row.kind === "dir")
		.map((row) => row.path);
}
