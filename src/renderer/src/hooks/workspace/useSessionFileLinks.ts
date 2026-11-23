import { useCallback } from "react";
import { t } from "../../i18n";
import { resolveFileLinkPath, isFilePathInsideRoot } from "../../utils/filePathLinks";
import { isRemoteProject } from "../../../../shared/projectLocation";
import { remoteProjectTarget } from "../../utils/remoteProjectPath";
import { publishRemoteFolderReveal } from "../../utils/remoteFolderReveal";
import { getRendererHomeDir } from "../../utils/rendererHomeDir";
import type { EditorTabOpenMode } from "../../utils/editorTabs";
import type { SessionFileOpenContext } from "../../components/session/SessionPaneServices";
import { useSessionFilePathOpener, type SessionFileOpenTarget } from "../useSessionFilePathOpener";
import { useExternalPathOpenGate } from "../useExternalPathOpenGate";
import type { ImageContent, Project, ProjectFileTarget } from "../../../../shared/types";
import type { AgentTab } from "../../../../shared/types";
import type { WorkspaceDrawerPanel } from "../useWorkspacePanels";

export interface SessionFileLinksDeps {
	activeAgent: AgentTab | undefined;
	activeProject: Project | undefined;
	/** 全部已打开项目：项目外链接若落在另一个项目内，按那个项目的写边界打开 */
	projects: readonly Project[];
	currentSessionId: string | undefined;
	activeProjectId: string | undefined;
	showToast: (message: string, duration?: number) => void;
	setPreviewImage: (image: ImageContent | null) => void;
	/** 中间栏阅读面入口：本机路径或远端项目 target（远端编辑不靠本机 fs） */
	viewFilePath: (path: SessionFileOpenTarget, openMode?: EditorTabOpenMode) => void;
	/** 抽屉面板域（useWorkspacePanels）的打开/关闭与状态 */
	workspace: {
		drawer: WorkspaceDrawerPanel | null;
		drawerCollapsed: boolean;
		openDrawer: (panel: WorkspaceDrawerPanel) => void;
		closeDrawer: () => void;
	};
	gitDrawerDiff: unknown;
	closeGitDiff: () => void;
	refreshVisibleFiles: (projectId?: string, silent?: boolean) => void | Promise<void>;
	restoreExpandedDirs: (projectId: string) => Promise<boolean>;
}

/**
 * 会话文件链接域：
 * 1) openSessionFilePath：已解析出绝对路径后的「按扩展名分级打开」（图片预览 / 目录进资源管理器 / 其余进编辑器）；
 * 2) requestExternalPathOpen：项目外路径按当次安全等级决定直开 / 二次确认 / 拒绝；
 * 3) handleOpenLinkedFile：会话内文件链接打开路由（项目内分级打开 / 项目外安全门）；
 * 4) handleToolDrawerAction：工具抽屉（files/git/browser）统一切换语义，浮动按钮与活动栏共用。
 */
export function useSessionFileLinks({ activeAgent, activeProject, projects, currentSessionId, activeProjectId, showToast, setPreviewImage, viewFilePath, workspace, gitDrawerDiff, closeGitDiff, refreshVisibleFiles, restoreExpandedDirs }: SessionFileLinksDeps) {
	const { requestExternalPathOpen, dialog: externalPathOpenDialog } = useExternalPathOpenGate();
	/**
	 * 远端目录链接的落点：本机没有那台机器上的文件管理器，只能定位到文件抽屉里的远端目录树。
	 * 抽屉跟随当前项目，所以目标可能是「另一个项目」的目录——请求带 projectId 留在 atom 里，
	 * 等那个项目的面板挂载时再消费，不在这里悄悄切项目。
	 */
	const openRemoteDirectory = useCallback(
		(target: ProjectFileTarget) => {
			// 抽屉已在文件面板时不重复切换：openDrawer 是「再点一次收起」语义。
			if (workspace.drawer !== "files" || workspace.drawerCollapsed) workspace.openDrawer("files");
			publishRemoteFolderReveal(target.projectId, target.relativePath);
		},
		[workspace.drawer, workspace.drawerCollapsed, workspace.openDrawer],
	);
	const openSessionFilePath = useSessionFilePathOpener({ onPreviewImage: setPreviewImage, viewFilePath, onOpenRemoteDirectory: openRemoteDirectory });

	// 会话内文件链接打开路由：项目内 → 直接按扩展名分级打开；项目外 → 交安全等级门。
	// 图片 → 弹窗预览（readBase64 → ImagePreviewModal）；markdown/html → 中间栏查看
	//（FileDiffViewer 对 .md 默认 preview、.html 用 HtmlPreview 内置渲染）；其他文件 → 编辑器打开。
	// line 为可选 `path:line` 位置标记：编辑器打开后滚动定位到该行。
	const handleOpenLinkedFile = useCallback(
		async (path: string, line?: number, context?: SessionFileOpenContext) => {
			// 有栏级上下文时绝不回退 App 当前焦点：分屏左栏的点击不能借用右栏 cwd/project。
			const baseDir = context ? context.baseDir : (activeAgent?.cwd ?? activeProject?.path);
			const projectRoot = context ? context.projectRoot : activeProject?.path;
			const projectId = context ? context.projectId : activeProject?.id;
			// 会话内入口必须携带稳定 projectId；缺失时不能降级成通用读取绕开主进程项目边界。
			if (context && !projectId) {
				showToast(t("app.fileLinkCannotResolve", { path }));
				return;
			}
			// 远端（SSH）项目在本机没有路径：会话里的绝对路径只能按项目根归一成项目内身份，
			// 否则下面的本机 stat 必然 ENOENT，远端主机上存在的文件被报成「路径不存在或已失效」。
			const paneProject = projectId ? projects.find((project) => project.id === projectId) : undefined;
			if (paneProject && isRemoteProject(paneProject)) {
				// 历史会话没有 runtime.cwd 时用远端项目根兜底：远端项目的根就是远端主机上的目录。
				const remoteBaseDir = baseDir ?? paneProject.locator.remotePath;
				const absolutePath = resolveFileLinkPath(path, remoteBaseDir, undefined, getRendererHomeDir());
				const target = absolutePath === null ? null : remoteProjectTarget(projects, absolutePath, projectId);
				if (absolutePath === null || target === null) {
					showToast(t("app.fileLinkCannotResolve", { path }));
					return;
				}
				// 成功路径不再带 scope：target 自带项目边界，提示文案用远端主机上的绝对路径。
				await openSessionFilePath(target, { line, displayPath: absolutePath });
				return;
			}
			// `~` 先按家目录展开（issue #426）：不展开的话 `~/x` 在有 projectRoot 的会话里
			// 会被一致地判成「项目外」，多一次无意义的安全确认且右键菜单拿不到真路径。
			const resolved = resolveFileLinkPath(path, baseDir, projectRoot, getRendererHomeDir());
			// 相对路径无基准目录、`..` 逃逸或绝对路径落在项目外都会返回 null。
			// 主进程读取时还会按 projectId 对真实路径做第二次边界校验。
			if (resolved) {
				await openSessionFilePath(resolved, { line, scope: projectId ? { projectId } : undefined });
				return;
			}
			// 项目外：先做一次不带项目边界的词法解析。解析不出来（缺基准目录/非法路径）说明真的无处可去，
			// 仍是原来的提示；解析出来就交给安全等级门——等级不限目录（默认）直接只读打开，
			// 敏感文件或限定目录的等级弹框二次确认，denyDirs 直接拒绝。
			// 只读 + 不带 scope：用户确认一次「看」不应变成可写任意路径。
			const externalPath = resolveFileLinkPath(path, baseDir, undefined, getRendererHomeDir());
			if (!externalPath) {
				showToast(t("app.fileLinkCannotResolve", { path }));
				return;
			}
			// 但落在「另一个已打开项目」里的文件不算任意路径：它本来就有主进程认可的写边界，
			// 按那个项目的 scope 打开（可编辑可保存），否则换个会话看同一份文件就只能只读，
			// 用户会以为「预览转编辑后不能保存」。
			const owningProject = projects.find((project) => project.path && isFilePathInsideRoot(externalPath, project.path));
			if (owningProject) {
				await openSessionFilePath(externalPath, { line, scope: { projectId: owningProject.id } });
				return;
			}
			await requestExternalPathOpen({
				path: externalPath,
				sessionId: context?.sessionId ?? currentSessionId,
				cwd: baseDir,
				projectRoot,
				proceed: () => void openSessionFilePath(externalPath, { line, readOnly: true }),
			});
		},
		[activeAgent?.cwd, activeProject?.id, activeProject?.path, projects, currentSessionId, openSessionFilePath, requestExternalPathOpen, showToast, t],
	);

	// 工具抽屉（files/git/browser）的统一切换语义：当前面板已展开 → 关闭；
	// 其余情况打开/切到目标面板。outline 浮动按钮与抽屉活动栏共用同一套语义，
	// 保证两个入口行为一致。注意必须放在 gitDrawerDiff 依赖之后。
	const handleToolDrawerAction = useCallback(
		(panel: WorkspaceDrawerPanel) => {
			if (workspace.drawer === panel && !workspace.drawerCollapsed) {
				if (panel === "git" && gitDrawerDiff) {
					closeGitDiff();
					return;
				}
				workspace.closeDrawer();
			} else if (panel === "files" && activeProjectId) {
				// 打开文件抽屉时先做一次「展开目录自愈」：若树里存在已展开但 children
				// 缺失、hasChildren 仍为 true 的目录（代次丢失/加载失败等历史残留），
				// 按需补拉消掉「加载中...」；返回 false 表示没有需要修复的目录，
				// 才走一次常规静默 refreshFiles。自愈本身不阻塞抽屉打开。
				void restoreExpandedDirs(activeProjectId).then((repaired) => {
					if (!repaired) void refreshVisibleFiles(activeProjectId, true);
				});
				workspace.openDrawer(panel);
			} else {
				workspace.openDrawer(panel);
			}
		},
		[workspace, gitDrawerDiff, closeGitDiff, activeProjectId, refreshVisibleFiles, restoreExpandedDirs],
	);

	return { openSessionFilePath, requestExternalPathOpen, externalPathOpenDialog, handleOpenLinkedFile, handleToolDrawerAction };
}
