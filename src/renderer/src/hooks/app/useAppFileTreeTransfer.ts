import { t } from "../../i18n";
import type { FileTreeNode } from "../../../../shared/types";
import type { NoticeKind } from "../../utils/notice";
import type { PiDesktopApi } from "../../../../preload";

/** 文件树右键菜单：坐标 + 命中的节点（null = 关闭菜单）。 */
export type FileTreeMenuRequest = { x: number; y: number; node: FileTreeNode } | null;

export interface AppFileTreeTransferDeps {
	api: Pick<PiDesktopApi, "files">;
	refreshVisibleFiles: () => void | Promise<void>;
	showToast: (message: string, duration?: number, kind?: NoticeKind) => void;
	/** 打开/关闭右键菜单（由 App 持有菜单状态）。 */
	setFileMenu: (menu: FileTreeMenuRequest) => void;
	/** 右键菜单「粘贴」项显隐依据：剪贴板里是否有可粘贴的文件路径。 */
	setHasClipboardFiles: (value: boolean) => void;
}

export interface AppFileTreeTransfer {
	setFileMenu: (menu: FileTreeMenuRequest) => void;
	onDropFiles: (targetDir: string, files: FileList) => void;
	onPasteFiles: (targetDir: string) => void;
	onMoveFiles: (sourcePaths: string[], targetDir: string) => void;
}

/**
 * 文件树传输域（OS 拖入 / 剪贴板粘贴 / 树内拖拽移动）与右键菜单的剪贴板探测。
 *
 * 三个入口的差别只在源路径怎么来（DataTransfer / 剪贴板 / 拖拽选中项），
 * 落地动作与失败提示同源，避免各入口文案与刷新时机各自漂移。
 */
export function useAppFileTreeTransfer(deps: AppFileTreeTransferDeps): AppFileTreeTransfer {
	const { api, refreshVisibleFiles, showToast, setFileMenu, setHasClipboardFiles } = deps;

	const requestFileMenu = (menu: FileTreeMenuRequest) => {
		setFileMenu(menu);
		if (!menu) return;
		try {
			setHasClipboardFiles(api.files.getClipboardPaths().length > 0);
		} catch {
			setHasClipboardFiles(false);
		}
	};

	const copyInto = (paths: string[], targetDir: string, failureMessage: (error: unknown) => string) => {
		void api.files
			.copy(paths, targetDir)
			.then(() => {
				void refreshVisibleFiles();
				showToast(t("app.fileCopyDone", { count: paths.length }), 2000);
			})
			.catch((error) => {
				showToast(failureMessage(error), 4000);
			});
	};

	return {
		setFileMenu: requestFileMenu,
		onDropFiles: (targetDir, fileList) => {
			// 从 OS 拖入：解析本地路径后复制到目标目录（目录不支持跨源复制时跳过）
			const paths: string[] = [];
			for (let i = 0; i < fileList.length; i++) {
				const file = fileList.item(i);
				if (file) {
					const path = api.files.getPathForFile(file);
					if (path) paths.push(path);
				}
			}
			if (paths.length === 0) return;
			copyInto(paths, targetDir, (error) => (error instanceof Error ? error.message : String(error)));
		},
		onPasteFiles: (targetDir) => {
			// 粘贴：从系统剪贴板读取资源管理器复制的文件路径，复制到目标目录
			try {
				const paths = api.files.getClipboardPaths();
				if (paths.length > 0) copyInto(paths, targetDir, (error) => t("app.filePasteFailed", { error: error instanceof Error ? error.message : String(error) }));
			} catch {
				/* 剪贴板不可用 */
			}
		},
		onMoveFiles: (sourcePaths, targetDir) => {
			// 文件树内部拖拽移动：同设备 rename，跨设备 cp+rm
			void api.files
				.move(sourcePaths, targetDir)
				.then(() => {
					void refreshVisibleFiles();
					showToast(t("app.fileMoveDone", { count: sourcePaths.length }), 2000);
				})
				.catch((error) => {
					showToast(error instanceof Error ? error.message : String(error), 4000);
				});
		},
	};
}
