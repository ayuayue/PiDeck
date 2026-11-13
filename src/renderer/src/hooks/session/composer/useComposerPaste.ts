import { useCallback } from "react";
import type { SessionSummary } from "../../../../../shared/types";
import { PASTE_TO_FILE_MIN_CHARS } from "../../../rendererUtils";
import type { PastedTextFile } from "../../../atoms";
import type { ComposerChip } from "../../../components/session/composer/chips";
import { fileNodeDragPayloadToRef, readFileNodeDragPayload } from "../../../components/app/AppUtils";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { COMPOSER_IMAGE_MAX_BYTES, dataUrlToFile, getClipboardImageFiles, getDroppedImageFiles, imageMimeTypeFromPath, isImageFilePath } from "../../../utils/composerImages";
import { formatBytes } from "../../../../../shared/formatBytes";
import { showNotice } from "../../../utils/notice";

type ComposerLiveDraftRef = { current: { sessionId: string; value: string } };

/**
 * 粘贴 / 拖拽 / 附件栏域：剪贴板与拖入的路径、图片、大段文本如何进输入框，
 * 以及附件栏 chip 的增删。
 *
 * 优先级链（路径 → 位图 → 大段文本转文件）在 onPaste / pasteFromClipboard / onDrop
 * 之间共享同一条判定，拆散会让三种入口对同一份剪贴板给出不同结果，因此整块一起搬。
 */
export interface ComposerPasteOptions {
	composerProject: { path?: string } | undefined;
	pasteFiles: PastedTextFile[];
	setPasteFiles: (value: PastedTextFile[] | ((current: PastedTextFile[]) => PastedTextFile[])) => void;
	imageGenComposer: boolean;
	projectSessions: SessionSummary[];
	setSessionReference: (session: SessionSummary) => void;
	addImageFiles: (imageFiles: File[]) => Promise<void>;
	insertRefTexts: (refTexts: string[]) => void;
	insertFilePathRefs: (paths: string[]) => void;
	insertPlainTextAtCursor: (text: string) => void;
}

export function useComposerPaste(options: ComposerPasteOptions) {
	const { composerProject, pasteFiles, setPasteFiles, imageGenComposer, projectSessions, setSessionReference, addImageFiles, insertRefTexts, insertFilePathRefs, insertPlainTextAtCursor } = options;

	/**
	 * 大段粘贴文本 → 落盘 userData/paste-files + 附件栏 chip。
	 * 触发条件：粘贴纯文本达到 PASTE_TO_FILE_MIN_CHARS（复制长日志/代码/文章是主要场景）。
	 * 新写入一律落应用数据目录（与日志同属），发送时折叠原样文本内联；
	 * projectPath 仍会传给主进程做已登记项目校验，但不再决定落盘目录。
	 * 写盘失败（权限/路径异常）回退原样插入，保证粘贴内容不丢。
	 */
	const pasteTextToFile = useCallback(
		async (text: string) => {
			try {
				const result = await desktopApi.pasteFiles.write({
					// 项目根经 projectId 反查项目清单（不依赖可能缺失的 record.projectPath）；
					// 非空时主进程只做已登记项目校验，新写入一律落 userData/paste-files/。
					projectPath: composerProject?.path ?? "",
					content: text,
				});
				setPasteFiles((current) => [
					...current,
					{
						id: crypto.randomUUID(),
						path: result.path,
						fileName: result.fileName,
						bytes: result.bytes,
						inProject: result.inProject,
					},
				]);
				showNotice(t("app.pasteConvertedToFile", { name: result.fileName, size: formatBytes(result.bytes) }), 4000);
			} catch {
				showNotice(t("app.pasteConvertFailed"), 3000);
				insertPlainTextAtCursor(text);
			}
		},
		[composerProject?.path, insertPlainTextAtCursor, setPasteFiles],
	);

	/** 从 File 列表解析本地路径（Electron 32+ 必须走 webUtils，不能用已移除的 File.path） */
	const resolveLocalPathsFromFiles = useCallback((files: File[]) => {
		const getPath = desktopApi.files.getPathForFile;
		if (!getPath) return [];
		const paths: string[] = [];
		for (const file of files) {
			try {
				const path = getPath(file);
				if (path) paths.push(path);
			} catch {
				// 非本地文件或路径不可用时跳过
			}
		}
		return paths;
	}, []);

	/**
	 * 剪贴板里的图片文件 → 附加为图片预览（对齐微信/QQ 粘贴习惯）。
	 * 经 files.readBase64 读原文件（比剪贴板位图缩略图清晰），构造 File 走统一附件流程；
	 * 任一文件读取失败或超出合成器大小上限（主进程 stat 预检拦截）时：
	 * 先兜底剪贴板位图——截图工具/网页复制常同时写路径+位图，而路径文件可能已被删除
	 * 或过大，位图仍在（否则粘贴会退化成无用的 @path 引用）；实在没有位图才整体回退
	 * @path 引用，保证「复制图片」粘贴始终有可用结果。
	 */
	const pasteClipboardImages = useCallback(
		async (paths: string[], dataTransfer: DataTransfer | null) => {
			try {
				const files: File[] = [];
				for (const path of paths) {
					const dataUrl = await desktopApi.files.readBase64(path, COMPOSER_IMAGE_MAX_BYTES);
					if (!dataUrl) throw new Error(`Cannot read image: ${path}`);
					const fileName = path.split(/[\\/]/).pop() || path;
					files.push(dataUrlToFile(dataUrl, imageMimeTypeFromPath(path), fileName));
				}
				await addImageFiles(files);
			} catch {
				// 位图兜底：事件粘贴优先取 clipboardData 的 image 项；右键粘贴无事件，走 Electron 剪贴板位图
				const imageFiles = dataTransfer ? getClipboardImageFiles(dataTransfer) : [];
				if (imageFiles.length) {
					await addImageFiles(imageFiles);
					return;
				}
				const imageDataUrl = desktopApi.clipboard.readImage();
				if (imageDataUrl) {
					await addImageFiles([dataUrlToFile(imageDataUrl, "image/png", "clipboard-image.png")]);
					return;
				}
				insertFilePathRefs(paths);
			}
		},
		[addImageFiles, insertFilePathRefs],
	);

	/**
	 * 右键「粘贴」（无 ClipboardEvent）：从 Electron 剪贴板同步读取。
	 * 优先级同 onPaste：文件路径 → 位图 → 大段文本转文件；纯文本返回 false，交给编辑器本地插入。
	 */
	const pasteFromClipboard = useCallback(async (): Promise<boolean> => {
		const clipboardPaths = desktopApi.files.getClipboardPaths?.() ?? [];
		if (clipboardPaths.length > 0) {
			if (clipboardPaths.every(isImageFilePath)) {
				await pasteClipboardImages(clipboardPaths, null);
			} else {
				insertFilePathRefs(clipboardPaths);
			}
			return true;
		}
		const imageDataUrl = desktopApi.clipboard.readImage();
		if (imageDataUrl) {
			await addImageFiles([dataUrlToFile(imageDataUrl, "image/png", "clipboard-image.png")]);
			return true;
		}
		// 大段文本（右键粘贴菜单无 ClipboardEvent）：同样转文件，避免塞进 ProseMirror 变卡
		const text = desktopApi.clipboard.readText();
		if (text.length >= PASTE_TO_FILE_MIN_CHARS) {
			void pasteTextToFile(text);
			return true;
		}
		return false;
	}, [addImageFiles, insertFilePathRefs, pasteClipboardImages, pasteTextToFile]);

	/**
	 * 粘贴：系统文件路径以 @path 引用插入，位图/截图附加为图片。
	 * 未处理时不 preventDefault，交给 RichInput 做纯文本粘贴。
	 * preventDefault 必须在任何 await 之前同步调用，否则浏览器会先插入默认内容。
	 *
	 * 顺序说明：资源管理器复制图片文件时，剪贴板常同时带路径 + 缩略图；
	 * 路径为受支持图片时优先附加预览，否则仍按路径引用处理，避免被误当成截图。
	 */
	const onPaste = useCallback(
		(event: React.ClipboardEvent<HTMLDivElement>) => {
			// 1) 资源管理器复制/剪切的文件：浏览器 ClipboardEvent 通常没有 kind=file，
			//    需通过 preload 同步读取 Electron clipboard（FileNameW / CF_HDROP 等）
			const clipboardPaths = desktopApi.files.getClipboardPaths?.() ?? [];
			if (clipboardPaths.length > 0) {
				event.preventDefault();
				// 复制的全是受支持图片 → 附加预览；混合/其他文件 → 维持 @path 引用
				if (clipboardPaths.every(isImageFilePath)) {
					void pasteClipboardImages(clipboardPaths, event.clipboardData);
				} else {
					insertFilePathRefs(clipboardPaths);
				}
				return;
			}

			// 2) 兜底：剪贴板里若有 File 对象（部分场景），用 webUtils 解析路径
			const fileItems = Array.from(event.clipboardData.items).filter((item) => item.kind === "file");
			if (fileItems.length > 0) {
				const files = fileItems.map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
				const paths = resolveLocalPathsFromFiles(files);
				if (paths.length > 0) {
					event.preventDefault();
					// 与第 1 步同规则：全是图片 → 附加预览（失败位图兜底），混合 → @path
					if (paths.every(isImageFilePath)) {
						void pasteClipboardImages(paths, event.clipboardData);
					} else {
						insertFilePathRefs(paths);
					}
					return;
				}
			}

			// 3) 剪贴板位图（截图/微信QQ/网页复制图片）：必须优先于纯文本——
			//    这类复制常同时写位图 + text 槽（微信写图片缓存路径、网页写图片 URL），
			//    位图才是用户要的内容；文件路径场景已在前两步处理，这里只剩纯位图。
			const imageFiles = getClipboardImageFiles(event.clipboardData);
			if (imageFiles.length) {
				event.preventDefault();
				void addImageFiles(imageFiles);
				return;
			}
			// 4) 大段纯文本粘贴（复制日志/代码/长文是主要来源）：直接插入 ProseMirror
			//    会随文本量级变卡（文档模型 + 逐键建议扫描），改为落盘成文件并在附件栏
			//    显示文件 chip（与图片粘贴同款形态），发送时自动折叠 @引用/原样文本。
			const plainText = event.clipboardData.getData("text/plain");
			if (plainText.length >= PASTE_TO_FILE_MIN_CHARS) {
				event.preventDefault();
				void pasteTextToFile(plainText);
				return;
			}
			// 5) 其余纯文本一律交给编辑器原样插入：不做自动路径识别——
			//    粘贴 /foo/bar、//注释 这类文本时，若自动补 @ 并转成引用 chip，
			//    文本变成原子节点无法再编辑移动光标（用户反馈的痛点）；
			//    需要引用文件时走资源管理器复制文件（步骤 1/2）或手动输入 @ 触发补全。
		},
		[addImageFiles, insertFilePathRefs, pasteClipboardImages, pasteTextToFile, resolveLocalPathsFromFiles],
	);

	/**
	 * 本地图片路径 → 附件栏参考图（生图选图与生图模式拖入共用）。
	 * 逐张提示：一张读失败不应把同批其它图一起丢掉。
	 */
	const addReferenceImagePaths = useCallback(
		async (paths: string[]) => {
			const imagePaths = paths.filter(isImageFilePath);
			// 选择器/拖入都可能带非图片：提示一次即可，不往 prompt 里塞无效的 @path。
			if (imagePaths.length === 0) {
				showNotice(t("app.imageUnsupported"), 3000);
				return;
			}
			const files: File[] = [];
			for (const path of imagePaths) {
				try {
					const dataUrl = await desktopApi.files.readBase64(path, COMPOSER_IMAGE_MAX_BYTES);
					// 主进程对 ENOENT 返回空串（与粘贴同一读取口）：文件被移走时按读取失败提示。
					if (!dataUrl) throw new Error("image-read-failed");
					files.push(dataUrlToFile(dataUrl, imageMimeTypeFromPath(path), path.split(/[\\/]/).pop() || path));
				} catch (error) {
					showNotice(/FILE_TOO_LARGE/.test(String(error)) ? t("app.imageTooLarge") : t("app.imageReadFailed"), 3000);
				}
			}
			if (files.length > 0) await addImageFiles(files);
		},
		[addImageFiles],
	);

	/**
	 * 拖拽：
	 * 1) 文件树节点（含目录）→ 按节点信息生成 @ 引用；
	 * 2) OS 本地文件/目录 → 以 @path 引用插入（含图片文件，不上传内容）；
	 * 3) 仅当无法解析本地路径且类型为 image/* 时，才退回附加图片（极少见）。
	 */
	const onDrop = useCallback(
		(event: React.DragEvent<HTMLDivElement>) => {
			event.preventDefault();
			const nodePayload = readFileNodeDragPayload(event.dataTransfer);
			if (nodePayload) {
				insertRefTexts([fileNodeDragPayloadToRef(nodePayload)]);
				return;
			}
			const files = Array.from(event.dataTransfer.files);
			if (files.length === 0) return;
			const paths = resolveLocalPathsFromFiles(files);
			if (paths.length > 0) {
				// 生图模式：附件是参考图，@path 不会被解析成图片——与粘贴/选图同一条附件流程。
				if (imageGenComposer) {
					void addReferenceImagePaths(paths);
					return;
				}
				insertFilePathRefs(paths);
				return;
			}
			void addImageFiles(getDroppedImageFiles(event.dataTransfer));
		},
		[addImageFiles, addReferenceImagePaths, imageGenComposer, insertFilePathRefs, insertRefTexts, resolveLocalPathsFromFiles],
	);

	/** 「加入对话引用」按钮：系统选择器选中的文件/目录以 @path 插入 */
	const attachFile = useCallback(async () => {
		try {
			const paths = await desktopApi.dialog.pickFiles({ title: t("menu.attachFile") });
			insertFilePathRefs(paths);
		} catch {
			// 用户取消或出错时不作处理
		}
	}, [insertFilePathRefs]);

	/**
	 * 生图模式的「上传参考图」：系统选择器选中的图片走与粘贴/拖入同一条附件流程。
	 * 生图 prompt 里的 @path 引用没有任何意义（主进程不会把它们解成参考图），所以不能复用 attachFile。
	 */
	const attachReferenceImages = useCallback(async () => {
		let paths: string[];
		try {
			paths = await desktopApi.dialog.pickFiles({ title: t("app.composerAddReferenceImage") });
		} catch {
			return;
		}
		// 取消（空列表）不提示；选择器没有扩展名过滤，选错文件才给一次明确原因。
		if (paths.length === 0) return;
		await addReferenceImagePaths(paths);
	}, [addReferenceImagePaths]);

	/** 移除粘贴文件 chip：同步删除落盘文件（粘贴产物，不留孤儿文件）。 */
	const removePasteFile = useCallback(
		(index: number) => {
			const target = pasteFiles[index];
			setPasteFiles((current) => current.filter((_, item) => item !== index));
			if (target) void desktopApi.pasteFiles.delete(target.path).catch(() => undefined);
		},
		[pasteFiles, setPasteFiles],
	);

	/** 清空全部粘贴文件 chip（附件栏「清空」按钮）：逐个删除落盘文件。 */
	const clearPasteFiles = useCallback(() => {
		for (const file of pasteFiles) {
			void desktopApi.pasteFiles.delete(file.path).catch(() => undefined);
		}
		setPasteFiles([]);
	}, [pasteFiles, setPasteFiles]);

	const onChipClick = useCallback(
		(chip: ComposerChip) => {
			// 文件引用点击不再打开文件/分屏（用户要求阻止点击打开事件）：
			// 引用 chip 只是一段文本标记，打开文件走时间线链接或文件树等显式入口。
			if (chip.kind === "session") {
				const selected = projectSessions.find((session) => (session.name ?? session.filePath) === chip.label);
				if (selected) setSessionReference(selected);
			}
		},
		[projectSessions],
	);

	return { pasteFromClipboard, onPaste, onDrop, attachFile, attachReferenceImages, removePasteFile, clearPasteFiles, onChipClick };
}
