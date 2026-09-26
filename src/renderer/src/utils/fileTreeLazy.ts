import type { ProjectFileTarget } from "../../../shared/types/project";
import type { FileTreeNode } from "../../../shared/types";

export type FileTreeListTarget = ProjectFileTarget | string;

/**
 * 按相对路径查找目录节点（含尚未展开的，children 可为 undefined）。
 * 供 composer @ 引用懒加载使用：查询前缀命中的目录才按需拉取子项；
 * 只沿已加载的 children 下钻——父目录未展开时深层目录本就不在树里。
 */
export function findDirectoryNodeByRelativePath(nodes: FileTreeNode[], relativePath: string): FileTreeNode | undefined {
	for (const node of nodes) {
		if (node.type === "directory" && node.relativePath === relativePath) {
			return node;
		}
		if (node.children && node.children.length > 0) {
			const nested = findDirectoryNodeByRelativePath(node.children, relativePath);
			if (nested) return nested;
		}
	}
	return undefined;
}

/**
 * 解析 @ 查询需要下钻的目标目录节点。
 * 规则：
 * - 查询含 /（如 @src/components/fo）：取最后一个 / 之前的目录（src/components）；
 * - 查询不含 / 但整段恰好是某个目录名（如 @src）：直接命中该目录，提前拉子项；
 * - 目标目录本身未加载（整段粘贴，如 @src/deep/nope/I）：沿相对路径找
 *   「已加载前缀的下一级」，即第一个尚未加载子项的目录；该目录加载完、merge
 *   后 files 变化驱动 effect 重评，链条自动向前推进，直到命中最终目录。
 * 找不到可下钻目录返回 undefined（不发起请求，等用户继续输入）。
 */
export function resolveAtDrillDirectory(query: string, files: FileTreeNode[]): FileTreeNode | undefined {
	const slash = query.lastIndexOf("/");
	const dirRel = slash > 0 ? query.slice(0, slash) : query;
	if (!dirRel) return undefined;
	const exact = findDirectoryNodeByRelativePath(files, dirRel);
	if (exact) return exact;
	if (slash > 0) {
		// 目标目录未出现在已加载树中：沿路径逐段推进
		const segments = dirRel.split("/");
		let node: FileTreeNode | undefined;
		for (let i = 0; i < segments.length; i++) {
			const seg = findDirectoryNodeByRelativePath(files, segments.slice(0, i + 1).join("/"));
			if (!seg) return node; // 该级还没出现在已加载树里：加载它
			if (!Array.isArray(seg.children)) return seg; // 已加载但子项未拉：下钻这个
			node = seg; // 子项已拉：继续找更深一层
		}
		return node; // 全链已加载：调用方的 Array.isArray 门会短路
	}
	return undefined;
}

/**
 * 无 / 的纯文件名搜索（如 @index）是否需要触发一次整树后台加载。
 * 目录浏览有下钻锚点，按需拉一层即可；按名搜索没有锚点，只能搜到已加载树，
 * 而默认树只有根层——所以要搜到深层文件必须一次性拉全树（仅当查询已有
 * 一定长度、看起来是真实搜索意图；绝对路径引用（盘符开头）不触发）。
 */
export function shouldLoadFullTreeForAtSearch(query: string): boolean {
	if (query.length < 2) return false;
	if (query.includes("/") || query.includes("\\")) return false;
	// 盘符绝对路径（@C:\… / @C:/…）是按地址引用，不是搜索，无需整树
	if (/^[a-zA-Z]:/.test(query)) return false;
	return true;
}

export function fileTreeNodeKey(node: FileTreeNode): string {
	if (node.path) return node.path;
	if (node.target) return `project:${node.target.projectId}\u0000${node.target.relativePath}`;
	return node.displayPath ?? node.relativePath;
}

export function fileTreeNodeDisplayPath(node: FileTreeNode): string {
	return node.displayPath ?? node.path ?? node.relativePath;
}

export function findDirectoryNodeByPath(nodes: FileTreeNode[], directoryPath: string): FileTreeNode | undefined {
	for (const node of nodes) {
		if (node.type === "directory" && fileTreeNodeKey(node) === directoryPath) return node;
		if (node.children?.length) {
			const nested = findDirectoryNodeByPath(node.children, directoryPath);
			if (nested) return nested;
		}
	}
	return undefined;
}

/** 目录是否已经拉过子项（有 children 数组即视为已加载，含空目录）。 */
export function findLoadedDirectory(nodes: FileTreeNode[], directoryPath: string): FileTreeNode | undefined {
	for (const node of nodes) {
		if (node.type === "directory" && fileTreeNodeKey(node) === directoryPath) {
			return Array.isArray(node.children) ? node : undefined;
		}
		if (node.children?.length) {
			const nested = findLoadedDirectory(node.children, directoryPath);
			if (nested) return nested;
		}
	}
	return undefined;
}

/**
 * 把某个目录标记为「加载失败」：hasChildren 置 false。
 *
 * 为什么需要：展开目录的 children 拉取失败（目录被删、权限、超过
 * FILE_TREE_MAX_DIRECTORY_ENTRIES 上限等）时，树里该节点仍是
 * 「无 children 且 hasChildren=true」，FileNode 会永久显示「加载中...」占位
 * 覆盖文件名。置 false 后占位消失（hasChildren !== false 条件不再成立），
 * 用户重新点开目录时 toggleDirectory 走 findLoadedDirectory 未命中，会再次
 * 发起拉取——相当于一次自然的重试入口，不会永久卡死。
 */
export function markFileTreeLoadFailed(nodes: FileTreeNode[], directoryPath: string): FileTreeNode[] {
	// 快速路径：本层不含目标时返回原数组引用，避免无谓重建导致
	// FilesPanel 的 useMemo / FileNode 全量重渲染（与 compactMiddlePackages 同约定）。
	let touched = false;
	const marked = nodes.map((node) => {
		if (node.type === "directory" && fileTreeNodeKey(node) === directoryPath) {
			touched = true;
			return { ...node, hasChildren: false };
		}
		if (node.children?.length) {
			const nextChildren = markFileTreeLoadFailed(node.children, directoryPath);
			if (nextChildren !== node.children) {
				touched = true;
				return { ...node, children: nextChildren };
			}
		}
		return node;
	});
	return touched ? marked : nodes;
}

export function mergeFileTreeChildren(nodes: FileTreeNode[], directoryPath: string, children: FileTreeNode[]): FileTreeNode[] {
	return nodes.map((node) => {
		if (node.type === "directory" && fileTreeNodeKey(node) === directoryPath) {
			return {
				...node,
				children,
				hasChildren: children.length > 0,
			};
		}
		if (node.children && node.children.length > 0) {
			return {
				...node,
				children: mergeFileTreeChildren(node.children, directoryPath, children),
			};
		}
		return node;
	});
}

/**
 * 按路径从短到长补齐已展开目录，保证父目录先于子目录写入。
 * 单个目录失败（已删/无权限）跳过，不阻断整棵树。
 */
export async function hydrateExpandedFileTree(listDirectory: (directory: FileTreeListTarget) => Promise<FileTreeNode[]>, tree: FileTreeNode[], expandedDirs: Iterable<string>): Promise<FileTreeNode[]> {
	const dirs = [...expandedDirs].sort((left, right) => left.length - right.length);
	let next = tree;
	for (const directory of dirs) {
		try {
			const target = findDirectoryNodeByPath(next, directory)?.target ?? directory;
			const children = await listDirectory(target);
			next = mergeFileTreeChildren(next, directory, children);
		} catch {
			// 持久化里的展开路径可能已不存在；忽略后展开态仍保留，下次刷新自然消失。
		}
	}
	return next;
}

/** 切项目或新请求发出后，旧 files:list 不得再写入当前抽屉（#159）。 */
export function shouldApplyFileTreeResult(requestedProjectId: string, currentProjectId: string | undefined, requestGeneration: number, currentGeneration: number): boolean {
	return requestedProjectId === currentProjectId && requestGeneration === currentGeneration;
}

/**
 * 拉浅层根再补齐已展开目录；中途项目切走或请求被取代时返回 null，
 * 避免慢扫描结果盖住当前项目的文件树。
 */
export async function loadProjectFileTree(listRoot: () => Promise<FileTreeNode[]>, expandedDirs: Iterable<string>, isCurrent: () => boolean, listDirectory: (directory: FileTreeListTarget) => Promise<FileTreeNode[]> = listRoot): Promise<FileTreeNode[] | null> {
	const tree = await listRoot();
	if (!isCurrent()) return null;
	const next = await hydrateExpandedFileTree(listDirectory, tree, expandedDirs);
	if (!isCurrent()) return null;
	return next;
}
