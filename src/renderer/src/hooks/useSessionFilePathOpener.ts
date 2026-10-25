import { useCallback } from "react";
import type { ImageContent, ProjectFileAccessScope } from "../../../shared/types";
import type { EditorTabOpenMode } from "../utils/editorTabs";
import { desktopApi as api } from "../desktopApi";
import { t } from "../i18n";
import { COMPOSER_IMAGE_MAX_BYTES, imageMimeTypeFromPath } from "../utils/composerImages";
import { showNotice } from "../utils/notice";

/** 图片后缀：走弹窗预览，不进文本编辑器（编辑器读二进制会显示乱码）。 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);

export type SessionFilePathOpenOptions = {
	/** `path:line` 位置标记：编辑器打开后滚动定位到该行（1 起） */
	line?: number;
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
 * 从 App.tsx 抽出的原因：App 只该负责边界解析（resolveFileLinkPath）与安全策略，
 * 「路径 → 打开方式」是业务路由，放这里才能不依赖 App 大组件的闭包状态。
 */
export function useSessionFilePathOpener(props: { onPreviewImage: (image: ImageContent | null) => void; viewFilePath: (path: string, openMode?: EditorTabOpenMode, initialLine?: number, fileAccessScope?: ProjectFileAccessScope, readOnly?: boolean) => void }) {
	const { onPreviewImage, viewFilePath } = props;
	return useCallback(
		async (path: string, options: SessionFilePathOpenOptions = {}) => {
			// 点击时 stat 一次定路由：渲染期 verdict 只回答「存在与否」，区分不了目录，
			// 目录链接进编辑器 readContent 会抛 EISDIR（"illegal operation on a directory"）。
			// 不存在（校验后被移动/删除，或 verdict 未返回时点击）→ 提示，不把 ENOENT 甩给用户。
			let stat = { exists: false, isDirectory: false };
			try {
				stat = await api.files.stat(path, options.scope);
			} catch {
				// stat 通道异常按不存在处理，走统一提示
			}
			if (!stat.exists) {
				showNotice(t("app.fileLinkNotFound", { path }));
				return;
			}
			if (stat.isDirectory) {
				void api.files.open(path, options.scope).catch((error) =>
					showNotice(
						t("app.openFileFailed", {
							error: error instanceof Error ? error.message : String(error),
						}),
					),
				);
				return;
			}
			const ext = path.split(".").pop()?.toLowerCase() ?? "";
			if (IMAGE_EXTENSIONS.has(ext)) {
				// readBase64 返回原始 base64，不是 data URL；直接构造 ImageContent 供预览弹层使用。
				// 传 COMPOSER_IMAGE_MAX_BYTES：预览也是完整读入内存，超限在主进程 stat 层拦截
				// （与粘贴附件同一条防线），避免超大图片直接压垮两侧内存。
				void api.files
					.readBase64(path, COMPOSER_IMAGE_MAX_BYTES, options.scope)
					.then((data) => {
						if (!data) throw new Error("FILE_NOT_FOUND");
						onPreviewImage({ type: "image", mimeType: imageMimeTypeFromPath(path), data });
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
			viewFilePath(path, undefined, options.line, options.scope, options.readOnly === true);
		},
		[onPreviewImage, viewFilePath],
	);
}
