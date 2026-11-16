import type { FileTreeNode, LocalProject, SessionSummary } from "../../../shared/types";
import type { ReplyActionRule } from "../../../shared/types/replyActions";
import { t } from "../i18n";

/**
 * 预览/浏览器模式共享的夹具与占位函数：多域共用的项目/文件树与会话样本，
 * 以及订阅类槽位的通用 noop（调用返回退订函数）。
 */
const now = Date.now();

/** 快捷消息预览夹具：预览/截图需要一个非空弹框；真实数据在 userData/quick-messages.json。 */
const PREVIEW_QUICK_MESSAGES: readonly string[] = ["继续", "提交", "推送", "提交推送"];
const PREVIEW_REPLY_ACTIONS: readonly ReplyActionRule[] = [
	{ text: "继续", triggers: [{ kind: "onStop" }] },
	{ text: "提交", triggers: [{ kind: "onStop" }] },
	{ text: "重试", triggers: [{ kind: "onFailure" }] },
];

const projects: LocalProject[] = [
	{
		id: "builtin-chat",
		name: "Chat",
		path: "C:/Users/14012/AppData/Roaming/PiDeck/chat-workspace",
		lastOpenedAt: now,
		pinned: true,
		sortOrder: -1,
		kind: "chat",
	},
	{
		id: "preview-project",
		name: "preview-project",
		path: "C:/Users/14012/preview-project",
		lastOpenedAt: now,
		sortOrder: 0,
	},
];

const files: FileTreeNode[] = [
	{
		name: "src",
		path: "C:/Users/14012/preview-project/src",
		relativePath: "src",
		type: "directory",
		children: [
			{
				name: "App.tsx",
				path: "C:/Users/14012/preview-project/src/App.tsx",
				relativePath: "src/App.tsx",
				type: "file",
			},
		],
	},
	{
		name: "README.md",
		path: "C:/Users/14012/preview-project/README.md",
		relativePath: "README.md",
		type: "file",
	},
];

function findPreviewDirectory(nodes: FileTreeNode[], directory: string): FileTreeNode | undefined {
	for (const node of nodes) {
		if (node.type === "directory" && node.path === directory) return node;
		if (node.children) {
			const nested = findPreviewDirectory(node.children, directory);
			if (nested) return nested;
		}
	}
	return undefined;
}

function getSessions(): SessionSummary[] {
	return [
		{
			id: "s1",
			filePath: "preview.jsonl",
			projectPath: projects[0].path,
			name: t("preview.sessionName"),
			preview: t("preview.sessionPreview"),
			updatedAt: now,
			messageCount: 3,
		},
	];
}

// noop 是「订阅类槽位」的通用占位：调用它返回退订函数；never[] 入参使其可赋给任意回调签名
const noop = (() => () => undefined) as unknown as (...args: unknown[]) => () => void;

export { now, PREVIEW_QUICK_MESSAGES, PREVIEW_REPLY_ACTIONS, projects, files, findPreviewDirectory, getSessions, noop };
