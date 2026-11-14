/**
 * 从 AppUtils 拆出的「建议列表构造」域：`/` 命令、`@` 路径（一级树 + 模糊搜索）、`&` 会话。
 * 触发判断在 composerTrigger，命令可见性在 commandMenu。
 */

import type { FileTreeNode, PiCommand } from "../../../../../shared/types";
import { fileTreeNodeKey } from "../../../utils/fileTreeLazy";
import { formatFilePathRef } from "../../session/composer/chips";
import { localizedCommandDescription, mergeCommands } from "./commandMenu";
import { detectTrigger } from "./composerTrigger";

export type SuggestionItem = {
	key: string;
	label: string;
	description: string;
	value: string;
	/** 不可选中的分组头；目录本身可选，不再使用 disabled 表示目录 */
	disabled?: boolean;
	/** 树形缩进层级（0=根目录），仅在 @ 无关键词时使用 */
	treeDepth?: number;
	/** 目录引用：UI 显示文件夹图标，插入路径与文件相同 */
	isDirectory?: boolean;
	sessionMeta?: { sessionId: string; filePath: string; projectPath?: string };
};

function fuzzyScore(value: string, keyword: string) {
	if (!keyword) return 1;
	const text = value.toLowerCase();
	const query = keyword.toLowerCase();
	if (text.includes(query)) return 100 + query.length;
	let score = 0;
	let pos = 0;
	for (const ch of query) {
		const found = text.indexOf(ch, pos);
		if (found === -1) return 0;
		score += found === pos ? 8 : 2;
		pos = found + 1;
	}
	return score;
}

/** 目录引用在建议列表与插入文本中都用尾斜杠标记，避免 @src 被模型当成智能体。 */
function formatPathSuggestionLabel(node: FileTreeNode): string {
	return node.type === "directory" ? `@${node.name}/` : `@${node.name}`;
}

function formatPathSuggestionValue(node: FileTreeNode): string {
	return formatFilePathRef(node.relativePath, {
		isDirectory: node.type === "directory",
	});
}

/**
 * 建议列表的辅助描述：只显示父目录（根层用 .）。
 * 完整相对路径太长且文件名才是辨识关键——label 已展示文件名，
 * description 用父目录帮用户确认层级位置即可。
 */
function formatPathSuggestionDescription(relativePath: string): string {
	const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
	if (parts.length <= 1) return ".";
	return parts.slice(0, -1).join("/");
}

/**
 * 从扁平路径列表（文件 + 目录）重建一级树视图。
 * 目录与文件均可选，便于直接 @src 这类目录引用。
 */
function buildFileTreeItems(entries: FileTreeNode[]): SuggestionItem[] {
	interface PathNode {
		name: string;
		relativePath: string;
		children: Map<string, PathNode>;
		files: FileTreeNode[];
		dirNode?: FileTreeNode;
	}
	// 用 / 分隔符构建路径树；目录节点单独挂 dirNode，空目录也能出现。
	const root: PathNode = { name: "", relativePath: "", children: new Map(), files: [] };
	const ensureDir = (parent: PathNode, part: string): PathNode => {
		let child = parent.children.get(part);
		if (!child) {
			const relativePath = parent.relativePath ? `${parent.relativePath}/${part}` : part;
			child = { name: part, relativePath, children: new Map(), files: [] };
			parent.children.set(part, child);
		}
		return child;
	};
	for (const entry of entries) {
		const parts = entry.relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
		if (parts.length === 0) continue;
		if (entry.type === "directory") {
			let node = root;
			for (const part of parts) node = ensureDir(node, part);
			node.dirNode = entry;
			continue;
		}
		let node = root;
		for (const part of parts.slice(0, -1)) node = ensureDir(node, part);
		node.files.push(entry);
	}
	// 仅展平第一层（根目录文件 + 一级目录），避免大项目卡顿
	const result: SuggestionItem[] = [];
	function flatten(node: PathNode, depth: number, maxDepth: number) {
		const sortedDirs = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
		const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
		for (const dir of sortedDirs) {
			const dirPath = dir.dirNode?.relativePath ?? dir.relativePath;
			result.push({
				key: dir.dirNode?.path ?? `dir:${dirPath}`,
				label: `@${dir.name}/`,
				description: formatPathSuggestionDescription(dirPath),
				// 必须插入 @dir/：裸 @dir 无法过 chip 路径规则，也易被模型当成 mention
				value: formatFilePathRef(dirPath, { isDirectory: true }),
				treeDepth: depth,
				isDirectory: true,
			});
			if (depth < maxDepth) flatten(dir, depth + 1, maxDepth);
		}
		for (const file of sortedFiles) {
			result.push({
				key: fileTreeNodeKey(file),
				label: formatPathSuggestionLabel(file),
				description: formatPathSuggestionDescription(file.relativePath),
				value: formatPathSuggestionValue(file),
				treeDepth: depth,
				isDirectory: file.type === "directory",
			});
		}
	}
	flatten(root, 0, 0); // 只展开第一层
	return result;
}

/** `/` 菜单里置顶的命令名（只影响排序；当前为空，保留原语义）。 */
const PINNED_COMMAND_NAMES = new Set<string>();

export function buildSuggestionItems(prompt: string, cursor: number, commands: PiCommand[], files: FileTreeNode[], sessions?: { id: string; filePath: string; projectPath?: string; name?: string; preview: string; updatedAt: number }[]): SuggestionItem[] {
	const allCommands = mergeCommands(commands);
	// 与 onChange 同一套白名单：& 只有仍是已知会话名前缀时才开建议
	const sessionRefs = sessions ? new Set(sessions.map((session) => session.name ?? session.filePath)) : undefined;
	const trigger = detectTrigger(prompt, cursor, sessionRefs);
	if (!trigger) return [];
	const keyword = trigger.query.toLowerCase();
	if (trigger.char === "/") {
		return allCommands
			.map((command, index) => ({ command, index }))
			.filter(({ command }) => command.name.toLowerCase().includes(keyword))
			.sort((a, b) => {
				const aPinned = PINNED_COMMAND_NAMES.has(a.command.name);
				const bPinned = PINNED_COMMAND_NAMES.has(b.command.name);
				if (aPinned !== bPinned) return aPinned ? -1 : 1;
				return a.index - b.index;
			})
			.map(({ command }) => ({
				key: command.name,
				label: `/${command.name}`,
				description: localizedCommandDescription(command),
				value: `/${command.name}`,
			}));
	}
	if (trigger.char === "@") {
		if (!keyword) {
			// 无关键词：展示一级目录/文件；目录可直接选中引用
			return buildFileTreeItems(files);
		}
		// 有关键词：文件与目录一起模糊搜索；同名时目录略优先，方便找文件夹
		return files
			.map((file) => ({
				file,
				score: fuzzyScore(file.relativePath, keyword) + fuzzyScore(file.name, keyword) * 2 + (file.type === "directory" ? 4 : 0),
			}))
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 15)
			.map((item) => ({
				key: fileTreeNodeKey(item.file),
				label: formatPathSuggestionLabel(item.file),
				description: formatPathSuggestionDescription(item.file.relativePath),
				// 相对路径含空格时同样加引号；目录追加 / 以通过 chip 规则并语义化为路径。
				value: formatPathSuggestionValue(item.file),
				isDirectory: item.file.type === "directory",
			}));
	}
	if (trigger.char === "&") {
		const list = sessions ?? [];
		return list
			.map((s) => ({ session: s, score: fuzzyScore(s.name ?? s.filePath, keyword) + fuzzyScore(s.preview ?? "", keyword) }))
			.filter((item) => item.score > 0 || !keyword)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8)
			.map((item) => ({
				// key 用会话 id：DSH 会话没有文件路径，用 filePath 会与其它会话撞 key
				key: item.session.id,
				label: item.session.name ?? item.session.filePath,
				description: item.session.preview,
				value: `&${item.session.name ?? item.session.filePath}`,
				sessionMeta: { sessionId: item.session.id, filePath: item.session.filePath, projectPath: item.session.projectPath },
			}));
	}
	return [];
}
