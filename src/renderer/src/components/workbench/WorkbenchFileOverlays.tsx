import { Suspense, lazy, type ComponentProps } from "react";
import type { Project, ProjectFileTarget } from "../../../../shared/types";
import { desktopApi as api } from "../../desktopApi";
import type { useProjectFileTreeController } from "../../hooks/files/useProjectFileTreeController";
import type { useOverlayActions } from "../../hooks/useOverlayActions";
import type { useRename } from "../../hooks/useRename";
import { t } from "../../i18n";
import type { NoticeKind } from "../../utils/notice";
import { fileNodeDragPayloadToRef } from "../app/AppUtils";
import { FileContextMenu } from "../app/AppParts";
import { RenameModals } from "../RenameModals";
import { fileTreeNodeDisplayPath } from "../../utils/fileTreeLazy";

// ProjectResourcesModal 仅在打开资源弹层时加载
const ProjectResourcesModal = lazy(() => import("../app/ProjectResourcesModal").then((m) => ({ default: m.ProjectResourcesModal })));

type FileContextMenuMenu = ComponentProps<typeof FileContextMenu>["menu"];

/** 文件树右键「新建文件/文件夹」的目标：目录=自身、文件=父目录（与「粘贴」同源）。 */
type CreatingFileState = { target: string | ProjectFileTarget; kind: "file" | "directory" };
/** 文件树右键「重命名」的目标：远端项目带 ProjectFileTarget，本地项目只有 path。 */
type RenamingFileState = { path: string; target?: ProjectFileTarget; name: string };

export interface WorkbenchFileOverlaysProps {
	/** 文件右键菜单：坐标 + 命中的文件树节点，以及决定是否显示「粘贴」的剪贴板门控。 */
	menu: {
		fileMenu: FileContextMenuMenu | null;
		hasClipboardFiles: boolean;
	};
	/** 新建/重命名弹窗状态：三者都由文件树右键注入，弹窗自身只做受控输入。 */
	editing: {
		creatingFile: CreatingFileState | null;
		creatingFileInput: string;
		renamingFile: RenamingFileState | null;
		renamingFileInput: string;
		rename: ReturnType<typeof useRename>;
	};
	/** 项目资源弹窗（.pi 资源预览）：App 侧选中的项目，空表示不挂载。 */
	resources: {
		projectResourcesProject: Project | null;
	};
	/** 事件入口：右键菜单的关闭/落到弹窗的状态写入，以及写入成功后的文件树刷新与提示。 */
	events: {
		setFileMenu: (menu: FileContextMenuMenu | null) => void;
		setCreatingFile: (state: CreatingFileState | null) => void;
		setCreatingFileInput: (value: string) => void;
		setRenamingFile: (state: RenamingFileState | null) => void;
		setRenamingFileInput: (value: string) => void;
		setProjectResourcesProject: (project: Project | null) => void;
		refreshVisibleFiles: ReturnType<typeof useProjectFileTreeController>["refreshVisibleFiles"];
		showToast: (message: string, duration?: number, kind?: NoticeKind) => void;
		overlays: ReturnType<typeof useOverlayActions>;
	};
}

/**
 * 工作台文件域浮层装配层：文件右键菜单 + 项目资源弹窗 + 新建/重命名弹窗。
 *
 * 只搬结构不持状态：菜单坐标、弹窗开关与输入值都归 App，这里按 menu / editing / resources /
 * events 四组接 props；条件渲染顺序（菜单 → 资源 → 重命名）与被搬走的内联版本一致。
 */
export function WorkbenchFileOverlays({ menu, editing, resources, events }: WorkbenchFileOverlaysProps) {
	const { fileMenu, hasClipboardFiles } = menu;
	const { creatingFile, creatingFileInput, renamingFile, renamingFileInput, rename } = editing;
	const { projectResourcesProject } = resources;
	const { setFileMenu, setCreatingFile, setCreatingFileInput, setRenamingFile, setRenamingFileInput, setProjectResourcesProject, refreshVisibleFiles, showToast, overlays } = events;

	return (
		<>
			{fileMenu && (
				<FileContextMenu
					menu={fileMenu}
					hasClipboardFiles={hasClipboardFiles}
					onPaste={(targetDir) => {
						// 右键菜单「粘贴文件到此处」：读剪贴板路径复制到目标目录
						try {
							const paths = api.files.getClipboardPaths();
							if (paths.length > 0) {
								void api.files
									.copy(paths, targetDir)
									.then(() => {
										void refreshVisibleFiles();
										showToast(t("app.fileCopyDone", { count: paths.length }), 2000);
									})
									.catch((error) => {
										showToast(t("app.filePasteFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
									});
							}
						} catch {
							/* 剪贴板不可用 */
						}
						setFileMenu(null);
					}}
					onClose={() => setFileMenu(null)}
					onOpen={() => {
						const target = fileMenu.node.target ?? fileMenu.node.path;
						if (target) {
							void api.files.open(target).catch((error) => {
								showToast(t("app.openFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
							});
						}
						setFileMenu(null);
					}}
					onReveal={() => {
						const target = fileMenu.node.target ?? fileMenu.node.path;
						if (target) {
							void api.files.showInFolder(target).catch((error) => {
								showToast(t("app.openFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
							});
						}
						setFileMenu(null);
					}}
					onAttach={() => {
						// 与文件树拖拽共用同一引用格式：目录补尾斜杠（@dir/），含空格路径自动加引号。
						// 走 composer-attach-refs 事件插入，避免这里再维护一份 @path 拼接逻辑
						// （裸 @dir 过不了 chip 路径规则，模型也容易当成 mention）。
						window.dispatchEvent(
							new CustomEvent("composer-attach-refs", {
								detail: {
									refs: [
										fileNodeDragPayloadToRef({
											path: fileTreeNodeDisplayPath(fileMenu.node),
											relativePath: fileMenu.node.relativePath,
											type: fileMenu.node.type,
										}),
									],
								},
							}),
						);
						setFileMenu(null);
					}}
					onCopyPath={() => {
						void navigator.clipboard.writeText(fileTreeNodeDisplayPath(fileMenu.node));
						setFileMenu(null);
						showToast(t("app.pathCopied"), 1200);
					}}
					onRename={() => {
						const node = fileMenu.node;
						if (node.target || node.path) {
							setRenamingFile({ path: fileTreeNodeDisplayPath(node), target: node.target, name: node.name });
							setRenamingFileInput(node.name);
						}
						setFileMenu(null);
					}}
					onCreate={(target, kind) => {
						setCreatingFile({ target, kind });
						setCreatingFileInput("");
						setFileMenu(null);
					}}
					onDelete={() => {
						const node = fileMenu.node;
						const target = node.target ?? node.path;
						setFileMenu(null);
						if (!target) return;
						overlays.showConfirm({
							title: node.type === "directory" ? t("drawer.deleteFolderTitle") : t("drawer.deleteFileTitle"),
							message: node.type === "directory" ? t("drawer.deleteFolderConfirm", { name: node.name }) : t("drawer.deleteFileConfirm", { name: node.name }),
							danger: true,
							confirmLabel: t("common.delete"),
							onConfirm: async () => {
								overlays.clearConfirm();
								try {
									// 公共写面返回 Op：失败必须显式抛出，才能沿用下面的错误提示；
									// unknown 也走同一条提示（不自动重放）。
									const deleted = await api.files.delete(target, true);
									if (!deleted.ok) throw new Error(deleted.code);
									void refreshVisibleFiles();
									showToast(t("app.fileDeleted"), 2000);
								} catch (error) {
									// 回收站不可用、权限不足或文件已被外部移走时，必须把主进程错误呈现给用户；
									// 仅写控制台会让确认框关闭后看起来像“点击无效”。
									showToast(
										t("app.fileDeleteFailed", {
											error: String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, ""),
										}),
										5000,
										"error",
									);
								}
							},
						});
					}}
				/>
			)}

			{projectResourcesProject && (
				<Suspense fallback={null}>
					<ProjectResourcesModal project={projectResourcesProject} onClose={() => setProjectResourcesProject(null)} />
				</Suspense>
			)}
			<RenameModals
				rename={rename.renameModalsProps.rename}
				fileCreate={
					creatingFile
						? {
								targetLabel: typeof creatingFile.target === "string" ? creatingFile.target : creatingFile.target.relativePath || "/",
								kind: creatingFile.kind,
								inputValue: creatingFileInput,
								onInputChange: setCreatingFileInput,
								onClose: () => setCreatingFile(null),
								onConfirm: (name) => {
									void api.files
										.create(creatingFile.target, name, creatingFile.kind)
										.then(() => {
											// 静默刷新：下面已经有了针对本次操作的具体提示，别再叠一层「已刷新」
											void refreshVisibleFiles(undefined, true);
											setCreatingFile(null);
											showToast(t(creatingFile.kind === "directory" ? "app.folderCreated" : "app.fileCreated"), 2000);
										})
										.catch((error) => {
											setCreatingFile(null);
											showToast(t("app.fileCreateFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
										});
								},
							}
						: undefined
				}
				fileRename={
					renamingFile
						? {
								path: renamingFile.path,
								name: renamingFile.name,
								inputValue: renamingFileInput,
								onInputChange: setRenamingFileInput,
								onClose: () => setRenamingFile(null),
								onConfirm: (path, newName) => {
									void api.files
										.rename(renamingFile.target ?? path, newName)
										.then(() => {
											void refreshVisibleFiles();
											setRenamingFile(null);
											showToast(t("app.fileRenamed"), 2000);
										})
										.catch((err) => console.error("[File] rename failed:", err));
								},
							}
						: undefined
				}
			/>
		</>
	);
}
