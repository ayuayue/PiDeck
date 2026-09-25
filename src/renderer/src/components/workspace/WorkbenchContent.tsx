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
	editorTabs: readonly EditorTabLike[];
	activeTab: EditorTabLike | null;
	onDirty: (id: string) => void;
	editorMode: WorkspaceContentOpenMode;
	onToggleEditorMode?: () => void;
	onCloseEditor: () => void;
	readContent: (path: string, maxBytes?: number, scope?: ProjectFileAccessScope) => Promise<string>;
	readOriginalContent: (path: string) => Promise<string>;
	saveContent: (path: string, content: string, scope?: ProjectFileAccessScope) => Promise<void>;
};

/**
 * 中间栏阅读面：Git Diff / 文件编辑共用 FileDiffViewer。
 *
 * 文件标签分别由标签模式顶栏与简洁模式右侧承载。已打开文件保持实例，切换仅隐藏，保留撤销历史。
 * 非当前文件关闭全局保存快捷键；关闭标签时才释放实例。
 * 不用 React.lazy：Vite/Electron 下动态 import 偶发
 * 「Failed to fetch dynamically imported module」，且 lazy 会缓存 rejected
 * promise，边界「重试」也无法恢复。打开文件是主路径，静态引入更稳。
 */
export function WorkbenchContent(props: WorkbenchContentProps) {
	return (
		<>
			{props.editorTabs.map((tab) => (
				<div key={tab.id} className={props.activeTab?.id === tab.id && !props.gitDiff ? "flex h-full min-h-0 flex-col" : "hidden"}>
					<FileDiffViewer
						active={props.activeTab?.id === tab.id && !props.gitDiff}
						onDirty={() => props.onDirty(tab.id)}
						displayMode={props.editorMode}
						filePath={tab.filePath}
						activeTabId={tab.id}
						fileAccessScope={tab.fileAccessScope}
						mode={tab.mode}
						onToggleMode={props.onToggleEditorMode}
						originalContent={tab.mode === "diff" ? tab.originalContent : undefined}
						initialLine={tab.initialLine}
						modifiedContent={tab.modifiedContent}
						onClose={props.onCloseEditor}
						readContent={props.readContent}
						readOriginalContent={props.readOriginalContent}
						saveContent={tab.allowSave ? props.saveContent : undefined}
						theme={props.theme}
						maxFileSizeMB={props.maxFileSizeMB}
						chromeTabsExternal
					/>
				</div>
			))}
			{props.gitDiff && (
				<FileDiffViewer
					key="git-diff"
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
					chromeTabsExternal
				/>
			)}
		</>
	);
}
