/**
 * 从 AppUtils 拆出的「路径与匹配」域：~ 前缀友好路径、关键词匹配、文件树展平。
 */

import type { FileTreeNode } from "../../../../../shared/types";

/* ── 路径与匹配 ── */

export function matches(value: string, keyword: string) {
	return !keyword.trim() || value.toLowerCase().includes(keyword.trim().toLowerCase());
}

function getHomePathPrefix() {
	const match = location.href.match(/file:\/\/\/([A-Za-z]:\/Users\/[^/]+)/i);
	return match?.[1] ?? "C:/Users/14012";
}

export function displayPath(path?: string) {
	if (!path) return "";
	const home = getHomePathPrefix();
	const normalized = path.replace(/\\/g, "/");
	const friendly = home && normalized.toLowerCase().startsWith(home.toLowerCase()) ? `~${normalized.slice(home.length)}` : normalized;
	return friendly.length > 36 ? `...${friendly.slice(-35)}` : friendly;
}

/**
 * 将文件树展平为文件 + 目录列表。
 * 目录节点一并保留，供 @ 引用搜索与 chip 白名单使用（空目录也能被引用）。
 */
export function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.flatMap((node) => (node.type === "file" ? [node] : [node, ...flattenFiles(node.children ?? [])]));
}
