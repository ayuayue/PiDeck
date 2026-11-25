import { Folder, MessageSquare } from "lucide-react";
import type { Project, SessionRecord } from "../../../../shared/types";
import type { MorphingSearchItem } from "../motion/morphing-search";
import { isLocalProject } from "../../../../shared/projectLocation";
import { displayProjectDirectoryName, isChatProject } from "../../rendererUtils";
import { sessionSearchItemFields, type SessionContentSearchHitView } from "../../utils/sessionContentSearchHits";
import { sessionDisplayName } from "../../utils/sessionDisplayName";
import { pinyinKeys } from "../../utils/pinyinSearch";

/**
 * 命令面板（Ctrl+F）的检索项：扁平化所有项目 + 会话。
 *
 * 从 SidebarContent 抽出来（该文件行数已贴上限），也顺手把「点开一条结果会发生什么」
 * 变成可测的输入输出：项目项只选中 + 展开目录行；会话项打开会话，**正文命中时先挂
 * pendingMessageJump**（#610）——否则搜到正文里的词也只能落到会话顶部。
 *
 * 图标与展示名在这里定（与侧栏树同口径：目录名 / 会话展示名 / chat 项目用 Chat）。
 */
export function buildSidebarSearchItems(input: {
	projects: readonly Project[];
	sessionsByProject: Readonly<Record<string, readonly SessionRecord[] | undefined>>;
	/** 会话 id → 首个正文命中（结构见 utils/sessionContentSearchHits）。 */
	contentHits: Map<string, SessionContentSearchHitView>;
	onSelectProject: (project: Project) => void;
	/** 打开会话；给了 jumpMessageId 时调用方负责先挂跳转再打开。 */
	onOpenSession: (projectId: string, sessionId: string, jumpMessageId?: string) => void;
}): MorphingSearchItem[] {
	const items: MorphingSearchItem[] = [];
	for (const project of input.projects) {
		const projectTitle = displayProjectDirectoryName(project);
		// 远端项目没有本机 path：描述用远端根路径，避免空串让结果看起来没有位置。
		const projectPath = isLocalProject(project) ? project.path : project.locator.remotePath;
		items.push({
			id: `project:${project.id}`,
			title: projectTitle,
			description: projectPath,
			pinyin: pinyinKeys(projectTitle),
			icon: isChatProject(project) ? MessageSquare : Folder,
			onSelect: () => input.onSelectProject(project),
		});
		for (const session of input.sessionsByProject[project.id] ?? []) {
			const sessionTitle = sessionDisplayName(session.title, session.forked) ?? session.title;
			const fields = sessionSearchItemFields(session.preview, input.contentHits.get(session.id));
			items.push({
				id: `session:${session.id}`,
				title: sessionTitle,
				description: fields.description,
				// 正文片段要参与匹配：标题不含查询词时，命中会话仍然得留在面板里。
				keywords: fields.keywords,
				context: { label: projectTitle, title: projectPath },
				pinyin: pinyinKeys(sessionTitle),
				icon: MessageSquare,
				onSelect: () => input.onOpenSession(project.id, session.id, fields.jumpMessageId),
			});
		}
	}
	return items;
}
