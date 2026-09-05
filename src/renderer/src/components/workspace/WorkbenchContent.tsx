import type { ProjectFileAccessScope, WorkspaceContentOpenMode } from "../../../../shared/types";
import { FileDiffViewer } from "../app/FileDiffViewer";

type EditorTabLike = {
	id: string;
	filePath: string;
	mode: "view" | "diff";
	originalContent: string;
	modifiedContent?: string;
	allowSave: boolean;
	label?: string;
	preserveDrawer?: boolean;
	/** 工具/消息文件入口的项目读取授权，随 tab 固化。 */
	fileAccessScope?: ProjectFileAccessScope;
	/** 打开文件后滚动定位的目标行（来自 `path:line` 链接）。 */
	initialLine?: number;
};

type GitDiffLike = {
	filePath: string;
	originalContent: string;
	modifiedContent: string;
	label: string;
};

export type WorkbenchContentProps = {
	theme: "dark" | "light";
	maxFileSizeMB: number;
	/** Git Diff 优先；无 Diff 时渲染编辑器 tab */
	gitDiff: GitDiffLike | null;
	gitDiffDisplayMode: WorkspaceContentOpenMode;
	onToggleGitDiffMode: () => void;
	onCloseGitDiff: () => void;
	activeTab: EditorTabLike | null;
	editorMode: WorkspaceContentOpenMode;
	onToggleEditorMode?: () => void;
	onCloseEditor: () => void;
	readContent: (
		path: string,
		maxBytes?: number,
		scope?: ProjectFileAccessScope,
	) => Promise<string>;
	readOriginalContent: (path: string) => Promise<string>;
	saveContent: (
		path: string,
		content: string,
		scope?: ProjectFileAccessScope,
	) => Promise<void>;
};

/**
 * 中间栏阅读面：Git Diff / 文件编辑共用 FileDiffViewer。
 *
 * Tab 名单已上收到 SessionTabsBar（与会话 Tab 同一条栏）；这里只渲染内容与顶栏动作。
 * 不用 React.lazy：Vite/Electron 下动态 import 偶发
 * 「Failed to fetch dynamically imported module」，且 lazy 会缓存 rejected
 * promise，边界「重试」也无法恢复。打开文件是主路径，静态引入更稳。
 */
export function WorkbenchContent(props: WorkbenchContentProps) {
	if (props.gitDiff) {
		return (
			<FileDiffViewer
				displayMode={props.gitDiffDisplayMode}
				filePath={props.gitDiff.filePath}
				mode="diff"
				onToggleMode={props.onToggleGitDiffMode}
				originalContent={props.gitDiff.originalContent}
				modifiedContent={props.gitDiff.modifiedContent}
				onClose={props.onCloseGitDiff}
				readContent={props.readContent}
				theme={props.theme}
				maxFileSizeMB={props.maxFileSizeMB}
				/* Tab 在总栏；内容区只留动作钮，避免第二套标题/绿条 */
				chromeTabsExternal
			/>
		);
	}

	if (!props.activeTab) return null;

	return (
		<FileDiffViewer
			displayMode={props.editorMode}
			filePath={props.activeTab.filePath}
			activeTabId={props.activeTab.id}
			fileAccessScope={props.activeTab.fileAccessScope}
			mode={props.activeTab.mode}
			onToggleMode={
				props.activeTab.preserveDrawer ? undefined : props.onToggleEditorMode
			}
			originalContent={
				props.activeTab.mode === "diff"
					? props.activeTab.originalContent
					: undefined
			}
			initialLine={props.activeTab.initialLine}
			modifiedContent={props.activeTab.modifiedContent}
			onClose={props.onCloseEditor}
			readContent={props.readContent}
			readOriginalContent={props.readOriginalContent}
			saveContent={
				props.activeTab.allowSave ? props.saveContent : undefined
			}
			theme={props.theme}
			maxFileSizeMB={props.maxFileSizeMB}
			chromeTabsExternal
		/>
	);
}
