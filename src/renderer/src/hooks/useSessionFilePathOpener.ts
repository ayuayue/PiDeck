import { useCallback } from "react";
import type { ImageContent, ProjectFileAccessScope, ProjectFileTarget } from "../../../shared/types";
import type { EditorTabOpenMode } from "../utils/editorTabs";
import { desktopApi as api } from "../desktopApi";
import { t } from "../i18n";
import { COMPOSER_IMAGE_MAX_BYTES, imageMimeTypeFromPath } from "../utils/composerImages";
import { showNotice } from "../utils/notice";

/** 图片后缀：走弹窗预览，不进文本编辑器（编辑器读二进制会显示乱码）。 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);

/** 会话内文件身份：本机是绝对路径，远端（SSH）项目只能是 `{ projectId, relativePath }`。 */
export type SessionFileOpenTarget = string | ProjectFileTarget;

export type SessionFilePathOpenOptions = {
	/** `path:line` 位置标记：编辑器打开后滚动定位到该行（1 起） */
	line?: number;
	/** 提示文案里展示的位置：远端 target 没有本机绝对路径，由调用方带上远端主机上的路径 */
	displayPath?: string;
	/** 项目文件读取授权；项目外路径（用户已确认）不带 scope */
	scope?: ProjectFileAccessScope;
	/** 只读打开：项目外文件确认后按只读查看，编辑器不提供保存与自动保存 */
	readOnly?: boolean;
};

/**
 * 会话内文件路径 → 打开方式的统一路由（左键点击文件链接、确认项目外路径后共用）。
 *
 * stat 分流：不存在 → 友好提示；目录 → 资源管理器；图片 → 弹窗预览；
 * 其余 → 中间栏编辑器（.md/.html 由 FileDiffViewer 自己决定渲染方式）。
 *
 * 「路径 → 打开方式」是业务路由，放这里才能不依赖 App 大组件的闭包状态。
 *
 * 入参是本机绝对路径或远端项目的 `ProjectFileTarget`：远端项目没有本机路径，
 * stat / 预览 / 编辑器全部按 target 走（主进程按 projectId 路由到远端 helper）。
 */
export function useSessionFilePathOpener(props: {
	onPreviewImage: (image: ImageContent | null) => void;
	viewFilePath: (path: SessionFileOpenTarget, openMode?: EditorTabOpenMode, initialLine?: number, fileAccessScope?: ProjectFileAccessScope, readOnly?: boolean) => void;
	/** 远端目录的落点：本机没有那台机器上的文件管理器，只能交给宿主（文件抽屉定位） */
	onOpenRemoteDirectory: (target: ProjectFileTarget) => void;
}) {
	const { onPreviewImage, viewFilePath, onOpenRemoteDirectory } = props;
	return useCallback(
		async (path: SessionFileOpenTarget, options: SessionFilePathOpenOptions = {}) => {
			// target 身份自带项目边界，再带 scope 会被主进程判成 INVALID_PROJECT_FILE_ACCESS_SCOPE。
			const scope = typeof path === "string" ? options.scope : undefined;
			// 远端 target 没有本机绝对路径：提示文案、扩展名判定与图片类型都退回项目内相对路径。
			const localPath = typeof path === "string" ? path : path.relativePath;
			const displayPath = options.displayPath ?? localPath;
			// 点击时 stat 一次定路由：渲染期 verdict 只回答「存在与否」，区分不了目录，
			// 目录链接进编辑器 readContent 会抛 EISDIR（"illegal operation on a directory"）。
			// 不存在（校验后被移动/删除，或 verdict 未返回时点击）→ 提示，不把 ENOENT 甩给用户。
			let stat = { exists: false, isDirectory: false };
			try {
				stat = await api.files.stat(path, scope);
			} catch {
				// stat 通道异常按不存在处理，走统一提示
			}
			if (!stat.exists) {
				showNotice(t("app.fileLinkNotFound", { path: displayPath }));
				return;
			}
			if (stat.isDirectory) {
				// 远端目录：`files:open` 对远端 target 必然 UNSUPPORTED_CAPABILITY（那是本机 shell 打开），
				// 交给宿主定位到文件抽屉的远端目录树，而不是把错误码甩给用户。
				if (typeof path !== "string") {
					onOpenRemoteDirectory(path);
					return;
				}
				void api.files.open(path, scope).catch((error) =>
					showNotice(
						t("app.openFileFailed", {
							error: error instanceof Error ? error.message : String(error),
						}),
					),
				);
				return;
			}
			const ext = localPath.split(".").pop()?.toLowerCase() ?? "";
			if (IMAGE_EXTENSIONS.has(ext)) {
				// readBase64 返回原始 base64，不是 data URL；直接构造 ImageContent 供预览弹层使用。
				// 传 COMPOSER_IMAGE_MAX_BYTES：预览也是完整读入内存，超限在主进程 stat 层拦截
				// （与粘贴附件同一条防线），避免超大图片直接压垮两侧内存。
				void api.files
					.readBase64(path, COMPOSER_IMAGE_MAX_BYTES, scope)
					.then((data) => {
						if (!data) throw new Error("FILE_NOT_FOUND");
						onPreviewImage({ type: "image", mimeType: imageMimeTypeFromPath(localPath), data });
					})
					.catch((error) =>
						showNotice(
							t("app.openFileFailed", {
								error: error instanceof Error ? error.message : String(error),
							}),
						),
					);
				return;
			}
			viewFilePath(path, undefined, options.line, scope, options.readOnly === true);
		},
		[onOpenRemoteDirectory, onPreviewImage, viewFilePath],
	);
}
