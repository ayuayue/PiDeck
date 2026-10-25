import type { FileTreeNode } from "../../../shared/types";

/**
 * 判断目录节点是否「已加载」：主进程未递归时省略 children 字段，
 * 递归后一定带 children 数组（空目录是 []）。据此区分「未展开」与「已展开空目录」。
 */
function isLoadedDirectory(node: FileTreeNode): boolean {
	return node.type === "directory" && Array.isArray(node.children);
}

/**
 * 折叠「中间包」（IDEA Compact Middle Packages 的通用版）。
 *
 * 规则：一个目录若「恰好 1 个子目录、且没有任何文件」，就与子目录合并成
 * 点分节点（如 cn.redinfo.smarlink.modules.ops.service 一行展示），
 * 递归向上，直到链尾出现「多个子项」或「任意文件」才停止——那才是真实内容。
 *
 * 边界条件：
 * - 只折叠已加载的目录（children 为数组）；未加载目录保持原样，等加载后再折叠，
 *   避免把尚未展开的单子目录误并（其下可能其实有多个子项）。
 * - 合并节点沿用链尾目录的 path/relativePath/children/hasChildren：展开、点击、
 *   拖放仍作用于真实的叶子目录，点分 name 只是展示。
 * - 纯函数：不修改入参；由调用方（FilesPanel 的 useMemo）控制缓存与重算。
 */
export function compactMiddlePackages(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.map((node) => {
		if (node.type !== "directory") return node;
		// 先递归折叠子树，再判断自身是否可并入子目录（自底向上合并整条链）。
		const children = Array.isArray(node.children) ? compactMiddlePackages(node.children) : node.children;
		if (Array.isArray(children) && children.length === 1 && isLoadedDirectory(children[0])) {
			const child = children[0];
			return { ...child, name: `${node.name}.${child.name}` };
		}
		// children 未变化（未加载或已加载但无需折叠）时复用原引用，避免无谓重建。
		if (children === node.children) return node;
		return { ...node, children };
	});
}
