import type { ProjectFileAccessScope, ProjectFileTarget } from "../../../../shared/types";
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { t } from "../../i18n";
import { ArrowLeft, Maximize, Minimize2, RefreshCw, Rows2, SquareSplitHorizontal, X, Eye, FileCode, Loader2, TriangleAlert, WrapText } from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { cn } from "../../lib/utils";
import { MarkdownStream } from "../session/MarkdownStream";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { defaultUrlTransform } from "../session/MarkdownLinkCore";
import { UNTRUSTED_MARKDOWN_REHYPE_PLUGINS } from "../session/markdownSanitize";
import rehypeKatex from "rehype-katex";
import { remarkGfmNoSingleTilde } from "../../utils/markdownPlugins";
import { imageMimeOrBinary } from "../../utils/imageMime";
import { base64ToBytes } from "../../utils/base64Bytes";
import { getBinaryPreviewKind, getMediaMimeForPath } from "../../utils/binaryPreview";
import { BinaryFilePreview } from "./preview/BinaryFilePreview";
import CsvPreview from "./preview/CsvPreview";
import MediaPreview from "./preview/MediaPreview";
// CodeMirrorEditor 静态链上挂着整个 CodeMirror 6 全家桶（view/state/commands/
// autocomplete/search/lint/lang-json），经 WorkbenchContent 静态 import 进主 chunk，
// App 启动即解析。与 CodeDiffView 同款懒加载：首次打开编辑器才拉 chunk。
/** 预览面板自动换行的本机偏好键（值 "wrap" / "scroll"）。 */
const FILE_WORD_WRAP_KEY = "pideck.filePreview.wordWrap";

const CodeMirrorEditor = lazy(() => import("./CodeMirrorEditor").then((m) => ({ default: m.CodeMirrorEditor })));
// CodeDiffView 静态链上挂着 @pierre/diffs + shiki（WASM 重库），懒加载后这些模块
// 移出首屏初始 chunk（约 -500KB 解析量），仅在用户打开 diff 时才拉取。
const CodeDiffView = lazy(() => import("./CodeDiffView").then((m) => ({ default: m.CodeDiffView })));
import { formatFilePathRef } from "../session/composer/chips";
import { showNotice } from "../../utils/notice";

import { isBinaryExtension, isImageFile, isPdfFile } from "../../utils/isTextFile";
import { updateInstallPreflightTasksAtom } from "../../atoms/update-install-preflight";
import { encodeHtmlPreviewUrl } from "../../../../shared/htmlPreview";
import { fileLoadErrorMessage } from "./fileLoadErrorMessage";

/** 内容指纹（与主进程 localTextRevision 同一算法）：保存时带上它做乐观锁。 */
async function contentRevision(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return "sha256:" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type ViewMode = "view" | "diff";

// md 预览的插件列表必须提为模块级常量：内联数组/箭头函数在 FileDiffViewer 每次
// 重新渲染时生成新引用，MarkdownStream 的 memo（浅比较）随即失效 → 整篇重新
// 走 marked+shiki 解析（分屏下与会话流式渲染抢主线程，2027-02 卡顿实测根因之一）。
const FILE_PREVIEW_REMARK_PLUGINS = [remarkGfmNoSingleTilde];
// 文件预览同样渲染不可信内容（模型写的 .md 就可能是当前打开的文件）：复用统一净化序列，KaTeX 产物在 sanitize 之后生成
const FILE_PREVIEW_REHYPE_PLUGINS = [...UNTRUSTED_MARKDOWN_REHYPE_PLUGINS, rehypeKatex];
const noopOpenExternal = (): void => undefined;

export function FileDiffViewer(props: {
	active?: boolean;
	onDirty?: () => void;
	/** dirty 态变化上报（Wave 5 关闭保护）：hook 侧维护「哪些 tab 有未保存改动」集合，
	 *  关闭路径据此弹确认。只在 true↔false 翻转时调用，不随每次击键触发。 */
	onDirtyChange?: (dirty: boolean) => void;
	filePath: string;
	fileTarget?: ProjectFileTarget;
	mode?: ViewMode;
	/** 展示模式：drawer=窄抽屉；split/maximize=中间栏宿主；modal=遗留全屏弹层 */
	displayMode?: "modal" | "drawer" | "split" | "maximize";
	/** 在分屏 / 占满中间栏之间切换（中间栏宿主）；遗留 drawer↔modal 也走此回调 */
	onToggleMode?: () => void;
	/** 返回按钮回调（侧栏模式时提供，点击返回上一面板） */
	onBack?: () => void;
	onClose: () => void;
	/** 多 tab 支持：全部 tab 列表（≥1 时顶栏始终展示，与 VS Code 一致） */
	tabs?: { id: string; filePath: string; label?: string; preview?: boolean }[];
	/** 当前活跃 tab ID */
	activeTabId?: string | null;
	/** 切换到指定 tab */
	onSelectTab?: (id: string) => void;
	/** 关闭指定 tab */
	onCloseTab?: (id: string) => void;
	/** 双击预览 Tab → 常驻 */
	onPromotePreviewTab?: (id: string) => void;
	readContent: (path: string | ProjectFileTarget, maxBytes?: number, scope?: ProjectFileAccessScope) => Promise<string>;
	/** 项目文件读取授权；存在时 read/stat/base64 都由主进程限制到该项目根。 */
	fileAccessScope?: ProjectFileAccessScope;
	/** 从会话消息 meta 中提取的工具执行前原始内容，优先于 Git HEAD。 */
	originalContent?: string;
	/** Session-recorded modified content, preferred over disk read for historical sessions. */
	modifiedContent?: string;
	/** 读取文件的 Git HEAD 原始内容，供差异模式左侧基准列使用。 */
	readOriginalContent?: (target?: ProjectFileTarget) => Promise<string>;
	saveContent?: (path: string | ProjectFileTarget, content: string, scope?: ProjectFileAccessScope, expectedRevision?: string) => Promise<void>;
	/**
	 * 只读 tab 的显式解锁：点击头部「转为可编辑」并二次确认后调用，宿主把该 tab
	 * 的 allowSave 翻成 true，之后才挂自动保存与 Ctrl+S。
	 */
	onRequestEditable?: () => void;
	/** HTML 文件点击预览时，切换到内置浏览器面板预览。 */
	onPreviewHtml?: (filePath: string) => void;
	theme?: "light" | "dark";
	/** 单个文件超过此大小（MB）时不加载编辑器。默认 5MB。 */
	maxFileSizeMB?: number;
	/** 打开文件后滚动定位的目标行（1 起，来自 `path:line` 链接位置标记）。 */
	initialLine?: number;
	/**
	 * Tab 已上收到 SessionTabsBar 时为 true：不再渲染内容区内嵌 Tab 栏/重复文件名，
	 * 只保留右侧动作钮（预览/分屏/关闭）。
	 */
	chromeTabsExternal?: boolean;
}) {
	const maxFileSize = (props.maxFileSizeMB ?? 5) * 1024 * 1024;
	const updateInstallPreflightId = useId();
	const setUpdateInstallPreflightTasks = useSetAtom(updateInstallPreflightTasksAtom);
	const [content, setContent] = useState("");
	// 差异模式左侧展示的原始内容：优先使用会话缓存（originalContent），
	// 没有则从 Git HEAD 读取。新增/未跟踪文件为空字符串。
	const [original, setOriginal] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [sideBySide, setSideBySide] = useState(props.displayMode !== "drawer");
	// 自动换行偏好（Discussions #423）：只影响本机的预览观感，属渲染层偏好，
	// 存 localStorage 而不是 settings.json——升级不该改变任何人的默认排版，
	// 也不需要为此扩设置 schema 与 IPC。null = 没点过开关，按各视图原有默认。
	const [wordWrapPref, setWordWrapPref] = useState<boolean | null>(() => {
		try {
			const stored = window.localStorage.getItem(FILE_WORD_WRAP_KEY);
			return stored === "wrap" ? true : stored === "scroll" ? false : null;
		} catch {
			return null;
		}
	});
	// 「转为可编辑」二次确认：解锁后本 tab 就能自动保存/Ctrl+S，所以把后果（直接写这个路径）先摆给用户。
	const [unlockConfirmOpen, setUnlockConfirmOpen] = useState(false);
	// 重新加载（重读磁盘）：内容只在打开/切 Tab 时读一次，AI 或外部工具改完磁盘后
	// 面板仍是旧快照。自增这个序号触发加载 effect 重跑，等价于「关掉重开」。
	const [reloadNonce, setReloadNonce] = useState(0);
	const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
	// diff 模式为只读对比视图（第三方渲染库），无需编辑态切换
	const [dirty, setDirty] = useState(false);
	// dirty 镜像上报（Wave 5）：只在翻转时通知宿主，避免每击键回调。
	const dirtyRef = useRef(false);
	const reportDirty = (next: boolean) => {
		if (dirtyRef.current === next) return;
		dirtyRef.current = next;
		props.onDirtyChange?.(next);
	};
	const [saving, setSaving] = useState(false);
	// 保存失败横幅（Wave 5）：与加载 error 分开——加载失败占满正文，保存失败只是
	// 编辑器顶部的 alert 横幅 + 重试钮（内容还在编辑器里，不抢布局）。
	const [saveError, setSaveError] = useState<string | null>(null);
	// 二进制预览（图片/PDF）的 Blob URL：切换文件/卸载时 revoke，防止内存泄漏
	const [mediaUrl, setMediaUrl] = useState<string | null>(null);
	const mediaUrlRef = useRef<string | null>(null);
	// 编辑器的 input 事件先于 React render；debounce timer 不能捕获旧 render 的 content。
	// 这个 ref 是编辑内容的实时镜像，保存时始终从它读取最新文本。
	const contentRef = useRef(content);
	// 换行形式只在载入时确定，保存单行内容不能重建编辑器并清空撤销历史。
	const lineSeparatorRef = useRef<"\n" | "\r\n">("\n");

	const isDiffMode = props.mode === "diff";
	// 没点过开关时沿用各视图原有观感：源码/单文件换行、diff 横向滚动。
	const wordWrap = wordWrapPref ?? !isDiffMode;
	const toggleWordWrap = () => {
		const next = !wordWrap;
		setWordWrapPref(next);
		try {
			window.localStorage.setItem(FILE_WORD_WRAP_KEY, next ? "wrap" : "scroll");
		} catch {
			// 隐私模式/配额满：开关本次会话内仍生效，只是不记住
		}
	};
	const fileAccessPath = props.fileTarget ?? props.filePath;
	// 只读查看：项目外文件经安全门打开时没有 saveContent（allowSave=false），编辑器只展示不可输入。
	const readOnlyView = !isDiffMode && !props.saveContent;
	const fileName = props.filePath.split(/[/\\]/).pop() ?? props.filePath;
	const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
	const isMarkdown = ext === "md" || ext === "mdx";
	const isHtml = ext === "html" || ext === "htm";
	// SVG 是文本（可编辑），预览时用内容渲染为 data URL 图片（CSP img-src 已允许 data:）
	const isSvg = ext === "svg";
	// CSV/TSV 是文本（可编辑），但预览默认走表格：打开 csv 的人要看内容，不是看逗号。
	const isCsv = ext === "csv" || ext === "tsv";
	// 图片/PDF 走内置预览（view 模式）：二进制内容不可文本读取，跳过编辑器直接渲染。
	const isImage = isImageFile(props.filePath);
	const isPdf = isPdfFile(props.filePath);
	// Office/压缩包/音视频同样不可文本编辑：音视频与图片/PDF 一样读成 Blob URL，
	// Office/zip 交给 BinaryFilePreview 自己读盘（按类型懒加载解析库，不进首屏 chunk）。
	const binaryPreviewKind = isDiffMode ? null : getBinaryPreviewKind(props.filePath);
	// 音视频走 Blob URL（CSP media-src 已允许），Office/zip 交给 BinaryFilePreview 自己读盘。
	const officePreviewKind = binaryPreviewKind === "docx" || binaryPreviewKind === "spreadsheet" || binaryPreviewKind === "archive" ? binaryPreviewKind : null;
	const isAudio = binaryPreviewKind === "audio";
	const isVideo = binaryPreviewKind === "video";
	// 默认预览模式：markdown/html/svg/csv 打开直接渲染预览（干净阅读），
	// 点「源码」切换按钮才进入源码模式；源码模式即编辑模式，不再需要独立的编辑按钮。
	const defaultPreview = !isDiffMode && (isMarkdown || isHtml || isSvg || isCsv);
	const [preview, setPreview] = useState(defaultPreview);
	// 有专属预览时正文不再挂编辑器：图片/PDF/音视频/Office/压缩包读出来是空串，
	// csv 切到表格后也不需要把原始文本垫在下面（空编辑器还会和预览抢高度）。
	const dedicatedPreview = !isDiffMode && (isImage || isPdf || isAudio || isVideo || officePreviewKind !== null || (isCsv && preview));

	useEffect(() => {
		// 每个 tab 重置编辑状态：view 可编辑（源码即编辑），diff 只读对比无编辑态。
		setDirty(false);
		reportDirty(false);
		setPreview(defaultPreview);
		// 清掉上一个文件的 Blob URL（媒体预览随 tab 切换失效）
		revokeMediaUrl();
		setMediaUrl(null);
	}, [isDiffMode, props.activeTabId, props.filePath, props.fileTarget?.projectId, props.fileTarget?.relativePath]);

	useEffect(() => {
		let cancelled = false;
		// 每次重载（含大小上限变化）都失效旧 timer；读取失败时绝不能把旧缓冲写回。
		saveGenerationRef.current += 1;
		savePendingRef.current = null;
		saveReadyRef.current = false;
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		setSaving(false);
		async function load() {
			setLoading(true);
			setError(null);
			try {
				// 图片/PDF：仅 view 模式读取二进制转 Blob URL 预览（不文本读取）；
				// diff 模式无法展示二进制差异，维持「不支持编辑」提示。
				if (isBinaryExtension(props.filePath)) {
					if (!isDiffMode && (isImageFile(props.filePath) || isPdfFile(props.filePath) || isAudio || isVideo)) {
						await loadMediaPreview();
						return;
					}
					// Office/zip：父层只决定该不该展示，读盘与加载/错误态由 BinaryFilePreview 负责，
					// 避免同一份二进制在父子两层各读一次。
					if (officePreviewKind) {
						setLoading(false);
						return;
					}
					setError(t("editor.binaryFileNotSupported", { ext }));
					setLoading(false);
					return;
				}
				// 差异模式优先使用会话缓存原始内容（originalContent），
				// 没有时降级到 Git HEAD；两者都无则左侧显示空（新增文件）。
				// 修改后内容优先使用会话记录（modifiedContent），历史会话恢复时磁盘可能已变化。
				const contentPromise = props.modifiedContent !== undefined ? Promise.resolve(props.modifiedContent) : props.readContent(fileAccessPath, maxFileSize, props.fileAccessScope);
				const originalPromise = isDiffMode && props.originalContent !== undefined ? Promise.resolve(props.originalContent) : isDiffMode && props.readOriginalContent ? props.readOriginalContent(props.fileTarget).catch(() => "") : Promise.resolve("");
				const [result, originalResult] = await Promise.all([contentPromise, originalPromise]);
				if (!cancelled) {
					const largestContentSize = Math.max(result.length, originalResult.length);
					// Diff 任一侧超过上限都不加载编辑器；删除文件虽右侧为空，左侧仍可能很大。
					if (largestContentSize > maxFileSize) {
						setError(
							t("editor.fileTooLarge", {
								size: (largestContentSize / 1024 / 1024).toFixed(1),
								max: (maxFileSize / 1024 / 1024).toFixed(0),
							}),
						);
						setLoading(false);
						return;
					}
					contentRef.current = result;
					lineSeparatorRef.current = result.includes("\r\n") ? "\r\n" : "\n";
					setContent(result);
					// 自动保存基准快照：加载完成即视为「已落盘」状态，避免打开后无改动就触发写盘
					lastSavedRef.current = result;
					void contentRevision(result).then((revision) => {
						if (!cancelled) baselineRevisionRef.current = revision;
					});
					setOriginal(originalResult);
					// 空内容二次校验（仅绝对路径 + 查看/编辑模式）：主进程 readContent 对
					// ENOENT 返回 ""（为「新建文件」流程保留的语义），死链直接渲染就是
					// 一片空白。但 AI 回复链接打开的路径必须给明确反馈——已解析成绝对路径
					// 仍读到空串，大概率是模型给的路径本就不存在；再确认一次并展示错误态。
					let missing = false;
					if (result === "" && !isDiffMode && (props.fileTarget || /^([A-Za-z]:[\\/]|\/)/.test(props.filePath))) {
						try {
							const [exists] = await window.piDesktop.files.pathsExist([fileAccessPath], props.fileAccessScope);
							if (!exists && !cancelled) {
								missing = true;
								setError(t("editor.fileNotFound", { path: props.fileTarget?.relativePath ?? props.filePath }));
							}
						} catch {
							// 校验通道不可用（预览模式）：维持原状不额外报错。
						}
					}
					if (!cancelled && !missing) {
						saveReadyRef.current = true;
						setDirty(false);
						reportDirty(false);
					}
				}
			} catch (e) {
				if (!cancelled) setError(fileLoadErrorMessage(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		// 二进制预览加载：主进程读 base64 → Blob URL。
		// 为什么不用 file:// 直链：dev 模式页面走 http:// 加载，Chromium webSecurity
		// 会以 "Not allowed to load local resource" 拦截 file:// 子资源；
		// blob: 与 CSP（img-src/frame-src 均允许 blob:）匹配且 dev/prod 行为一致。
		async function loadMediaPreview() {
			const readBinary = window.piDesktop?.files?.readBase64;
			if (!readBinary) {
				if (!cancelled) setError(t("editor.binaryFileNotSupported", { ext }));
				return;
			}
			try {
				const base64 = await readBinary(fileAccessPath, undefined, props.fileAccessScope);
				// 读取完成后重新读取闭包里的取消标记；传入 boolean 会冻结为调用时的 false，
				// 旧 tab 的结果就可能 revoke 并覆盖新 tab 刚创建的 Blob URL。
				if (cancelled || !base64) {
					if (!cancelled) setError(t("editor.binaryFileNotSupported", { ext }));
					return;
				}
				// 传**路径**：映射按扩展名查表，传裸扩展名（"png"）会查不到而永远退化成 octet-stream。
				const mime = isPdf ? "application/pdf" : (getMediaMimeForPath(props.filePath) ?? imageMimeOrBinary(props.filePath));
				const bytes = base64ToBytes(base64);
				revokeMediaUrl();
				const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
				mediaUrlRef.current = url;
				setMediaUrl(url);
			} catch (e) {
				// 主进程的 FILE_TOO_LARGE 结构化前缀经 fileLoadErrorMessage 转 i18n 文案；
				// 直接展示 e.message 会把 FILE_TOO_LARGE:size:max 裸码给用户。
				if (!cancelled) setError(fileLoadErrorMessage(e));
			}
		}
		void load();
		return () => {
			cancelled = true;
			saveReadyRef.current = false;
		};
		// readContent/readOriginalContent 是稳定的 API 回调（上层已 useCallback），
		// 不参与 effect deps，避免父组件因其他状态变化重渲染时反复加载文件导致编辑器重置到顶部。
		// 两侧缓存内容都需要监听：同一路径可在多个历史提交 Diff tab 之间切换。
	}, [props.filePath, props.fileTarget?.projectId, props.fileTarget?.relativePath, props.activeTabId, props.originalContent, props.modifiedContent, props.fileAccessScope?.projectId, isDiffMode, maxFileSize, reloadNonce]);

	const handleClose = useCallback(() => {
		props.onClose();
	}, [props.onClose]);

	// 释放媒体预览 Blob URL（组件内声明：依赖 mediaUrlRef）
	function revokeMediaUrl() {
		if (mediaUrlRef.current) {
			URL.revokeObjectURL(mediaUrlRef.current);
			mediaUrlRef.current = null;
		}
	}

	// 自动保存：编辑停止 500ms 后静默落盘（仅 allowSave 的文件），Ctrl+S 立即保存并取消挂起的自动保存。
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 最近一次落盘内容快照：内容未变时跳过保存，避免重复写盘
	const lastSavedRef = useRef("");
	// 落盘基准指纹（sha256）：保存时带上它，盘上已被外部改过就拒绝，而不是静默覆盖。
	const baselineRevisionRef = useRef<string | undefined>(undefined);
	// FileDiffViewer 在切换 Tab 时复用实例；用代数阻止旧文件的异步保存结果污染新 Tab。
	const saveGenerationRef = useRef(0);
	const saveReadyRef = useRef(false);
	const savePendingRef = useRef<Promise<boolean> | null>(null);

	const saveNow = useCallback((): Promise<boolean> => {
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		const saveContent = props.saveContent;
		if (isDiffMode || !saveContent) return Promise.resolve(true);
		if (!saveReadyRef.current) return Promise.resolve(!dirtyRef.current);
		if (savePendingRef.current) return savePendingRef.current;
		const saveGeneration = saveGenerationRef.current;
		const savePath = fileAccessPath;
		// 所有调用等待同一个串行任务；期间继续输入时保存最新文本，安装前置检查也必须等它落盘。
		const save = async (): Promise<boolean> => {
			setSaving(true);
			try {
				while (saveGeneration === saveGenerationRef.current) {
					const latest = contentRef.current;
					if (latest === lastSavedRef.current) {
						setDirty(false);
						reportDirty(false);
						setSaveError(null);
						return true;
					}
					await saveContent(savePath, latest, props.fileAccessScope, baselineRevisionRef.current);
					if (saveGeneration !== saveGenerationRef.current) return false;
					baselineRevisionRef.current = await contentRevision(latest);
					lastSavedRef.current = latest;
				}
				return false;
			} catch (e) {
				// 失败不清 dirty/缓冲；旧文件请求不能污染新 Tab。
				const conflict = e instanceof Error && e.message.includes("PROJECT_FILE_CHANGED");
				if (saveGeneration === saveGenerationRef.current) setSaveError(conflict ? t("editor.fileChangedOnDisk") : fileLoadErrorMessage(e));
				return false;
			} finally {
				if (saveGeneration === saveGenerationRef.current) setSaving(false);
			}
		};
		const pending = save().finally(() => {
			if (savePendingRef.current === pending) savePendingRef.current = null;
		});
		savePendingRef.current = pending;
		return pending;
	}, [isDiffMode, props.saveContent, props.filePath, props.fileTarget?.projectId, props.fileTarget?.relativePath, props.fileAccessScope?.projectId]);

	// 更新安装会直接终止 Electron；把活跃文本编辑器的防抖保存提升为可等待的前置任务。
	useEffect(() => {
		if (isDiffMode || !props.saveContent) return;
		setUpdateInstallPreflightTasks((current) => {
			const next = new Map(current);
			next.set(updateInstallPreflightId, saveNow);
			return next;
		});
		return () => {
			setUpdateInstallPreflightTasks((current) => {
				if (!current.has(updateInstallPreflightId)) return current;
				const next = new Map(current);
				next.delete(updateInstallPreflightId);
				return next;
			});
		};
	}, [isDiffMode, props.saveContent, saveNow, setUpdateInstallPreflightTasks, updateInstallPreflightId]);

	const scheduleAutoSave = useCallback(() => {
		if (!props.saveContent || !saveReadyRef.current) return;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		const generation = saveGenerationRef.current;
		saveTimerRef.current = setTimeout(() => {
			saveTimerRef.current = null;
			if (generation === saveGenerationRef.current) void saveNow();
		}, 500);
	}, [props.saveContent, saveNow]);

	// Ctrl+S / Cmd+S：立即保存（取消挂起的自动保存，避免重复写盘）。
	// 仅 view 模式生效：diff 是只读对比，不存在保存。
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				// 只读文件的 Ctrl+S 必须给个回话：否则用户只会看到按键毫无反应。
				if (readOnlyView) {
					showNotice(t("editor.readOnlyHint"));
					return;
				}
				void saveNow();
			}
		},
		[readOnlyView, saveNow],
	);

	useEffect(() => {
		if (!isDiffMode && props.active !== false) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [isDiffMode, props.active, handleKeyDown]);

	// 卸载时取消挂起的自动保存 timer + 释放媒体 Blob URL（生命周期配对）
	useEffect(() => {
		return () => {
			if (saveTimerRef.current) {
				clearTimeout(saveTimerRef.current);
				saveTimerRef.current = null;
			}
			revokeMediaUrl();
		};
	}, []);

	const handleEditorChange = useCallback(
		(value: string) => {
			if (!saveReadyRef.current || readOnlyView) return;
			// 先写 ref 再触发 React 更新，保证 debounce timer 不会保存上一个 render 的值。
			contentRef.current = value;
			setContent(value);
			setDirty(true);
			reportDirty(true);
			props.onDirty?.();
			scheduleAutoSave();
		},
		[scheduleAutoSave, props.onDirty, readOnlyView],
	);

	// 编辑器选中文本 → 右键「引用选中内容」：以 pi 的 read 语法 @path:start-end 派发到输入框。
	// 与文件树右键 onAttach 共用同一追加语义（composer-attach-refs 由 App 监听后插入 draft）。
	const handleAttachSelection = useCallback(
		(startLine: number, endLine: number) => {
			const range = startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
			const ref = `${formatFilePathRef(props.filePath)}:${range}`;
			window.dispatchEvent(new CustomEvent("composer-attach-refs", { detail: { refs: [ref] } }));
		},
		[props.filePath],
	);

	const language = ext;

	const displayMode = props.displayMode ?? "drawer";
	const isWorkbenchPane = displayMode === "split" || displayMode === "maximize";
	const showInlineTabs = !props.chromeTabsExternal && Boolean(props.tabs && props.tabs.length > 0);
	const headerContent = (
		<>
			{showInlineTabs && props.tabs && (
				<div className="file-diff-tab-bar" role="tablist">
					{props.tabs.map((tab) => {
						const tabLabel = tab.label ?? tab.filePath.split(/[/\\]/).pop() ?? tab.filePath;
						const showDirty = tab.id === props.activeTabId && dirty ? t("editor.unsavedMarker") : "";
						return (
							<div
								key={tab.id}
								role="tab"
								aria-selected={tab.id === props.activeTabId}
								className={cn("file-diff-tab", tab.id === props.activeTabId && "active", tab.preview && "italic text-muted-foreground")}
								onClick={() => props.onSelectTab?.(tab.id)}
								onDoubleClick={() => props.onPromotePreviewTab?.(tab.id)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										props.onSelectTab?.(tab.id);
									}
								}}
								title={tab.label ?? tab.filePath}
								tabIndex={0}
							>
								<span>
									{tabLabel}
									{showDirty}
								</span>
								<button
									type="button"
									className="file-diff-tab-close"
									onClick={(e) => {
										e.stopPropagation();
										props.onCloseTab?.(tab.id);
									}}
									aria-label={t("common.close")}
								>
									<X size={11} />
								</button>
							</div>
						);
					})}
				</div>
			)}
			<div className="file-diff-header">
				{props.onBack && displayMode === "drawer" && (
					<Button variant="ghost" size="icon-sm" onClick={props.onBack} title={t("common.back")} aria-label={t("common.back")}>
						<ArrowLeft size={18} />
					</Button>
				)}
				{/* Tab 栏负责切换；操作区同时显示当前文件名，避免用户只看到一排无语义的动作钮。 */}
				<span className="file-diff-title min-w-0 flex-1 truncate" title={props.filePath}>
					{fileName}
					{dirty && t("editor.unsavedMarker")}
				</span>
				{/* 只读查看（项目外文件确认后打开）必须显式标出来：编辑器可选中/复制但不可输入，
				    否则用户会在这里打了半天字才发现既没有自动保存、Ctrl+S 也没有任何反应。 */}
				{readOnlyView && (
					<span className="shrink-0 rounded border border-border-subtle px-1.5 py-0.5 text-caption text-muted-foreground" title={t("editor.readOnlyHint")}>
						{t("editor.readOnlyBadge")}
					</span>
				)}
				{readOnlyView && props.onRequestEditable && (
					<Button variant="ghost" size="xs" className="shrink-0" title={t("editor.unlockEditHint")} onClick={() => setUnlockConfirmOpen(true)}>
						{t("editor.unlockEdit")}
					</Button>
				)}
				<div className="file-diff-header-actions">
					{/* 重新加载：只读看盘上最新内容（AI / 外部编辑器改了文件后刷新）。
					   有未保存改动时先确认——重读会把编辑器里的内容换掉。 */}
					{!isDiffMode && (
						<Button
							variant="ghost"
							size="icon-sm"
							title={t("editor.reloadHint")}
							aria-label={t("editor.reload")}
							disabled={loading}
							onClick={() => {
								if (dirty) setReloadConfirmOpen(true);
								else setReloadNonce((current) => current + 1);
							}}
						>
							<RefreshCw size={15} className={loading ? "animate-pideck-spin" : undefined} />
						</Button>
					)}
					{(isMarkdown || isHtml || isSvg || isCsv) && !isDiffMode && !loading && !error && (
						<Button
							variant="ghost"
							size="icon-sm"
							title={preview ? t("editor.source") : t("editor.preview")}
							onClick={() => {
								if (isHtml && props.onPreviewHtml) {
									props.onPreviewHtml(props.filePath);
								} else {
									setPreview(!preview);
								}
							}}
						>
							{preview ? <FileCode size={15} /> : <Eye size={15} />}
						</Button>
					)}
					{!loading && !error && !dedicatedPreview && (
						<Button variant="ghost" size="icon-sm" title={wordWrap ? t("editor.wordWrapOff") : t("editor.wordWrapOn")} aria-label={t("editor.wordWrap")} aria-pressed={wordWrap} className={cn(wordWrap && "text-foreground")} onClick={toggleWordWrap}>
							<WrapText size={15} />
						</Button>
					)}
					{isDiffMode && !loading && !error && displayMode !== "drawer" && (
						<Button variant="ghost" size="icon-sm" title={sideBySide ? t("app.showSingle") : t("app.showSplit")} onClick={() => setSideBySide(!sideBySide)}>
							{/* 图标随模式变化：分栏时显示「单栏」图标（点击合并），单栏时显示「分栏」图标（点击分栏），
							   与 title 的目标状态一致，两种模式按钮一眼可辨 */}
							{sideBySide ? <Rows2 size={15} /> : <SquareSplitHorizontal size={15} />}
						</Button>
					)}
					{/* 编辑/退出编辑按钮已移除：diff 为只读对比（第三方渲染库），
					   view 模式源码即编辑（切到源码即可改），均无需独立的编辑按钮。 */}
					{props.onToggleMode && (
						<Button variant="ghost" size="icon-sm" title={isWorkbenchPane ? (displayMode === "maximize" ? t("app.restoreSplit") : t("app.maximizeInWorkbench")) : displayMode === "modal" ? t("app.minimizeToDrawer") : t("app.expandToModal")} onClick={props.onToggleMode}>
							{(isWorkbenchPane ? displayMode === "maximize" : displayMode === "modal") ? <Minimize2 size={15} /> : <Maximize size={15} />}
						</Button>
					)}
					{/* 关闭按钮：无论 Tab 是否上收总栏都保留，保证 DIFF/文件预览右上角
					   始终有关闭入口（Tab 栏小叉在窄栏下不易点中）。 */}
					<Button variant="ghost" size="icon-sm" onClick={handleClose} aria-label={t("common.close")} title={t("common.close")}>
						<X size={15} />
					</Button>
				</div>
			</div>
			{reloadConfirmOpen && (
				<ConfirmDialog
					title={t("editor.reloadDirtyTitle")}
					message={t("editor.reloadDirtyBody", { file: fileName })}
					confirmLabel={t("editor.reloadDirtyConfirm")}
					onCancel={() => setReloadConfirmOpen(false)}
					onConfirm={() => {
						setReloadConfirmOpen(false);
						setReloadNonce((current) => current + 1);
					}}
				/>
			)}
			{readOnlyView && unlockConfirmOpen && props.onRequestEditable && (
				<ConfirmDialog
					title={t("editor.unlockEditTitle")}
					message={t("editor.unlockEditBody", { path: props.filePath })}
					confirmLabel={t("editor.unlockEditConfirm")}
					onCancel={() => setUnlockConfirmOpen(false)}
					onConfirm={() => {
						setUnlockConfirmOpen(false);
						props.onRequestEditable?.();
					}}
				/>
			)}
			{saveError && (
				<div role="alert" className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-caption text-destructive">
					<TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate" title={saveError}>
						{t("editor.saveFailedBanner", { error: saveError })}
					</span>
					<Button variant="ghost" size="sm" className="h-6 shrink-0 rounded-md px-2 text-caption" onClick={() => void saveNow()}>
						{t("common.retry")}
					</Button>
				</div>
			)}
			<div className="file-diff-body">
				{/* 加载态补 spinner，与 Git 树 ResourceRow 的 Loader2 动效同语言；外层 .file-diff-loading 是 grid 居中，内层用 inline-flex 排图标+文案 */}
				{loading && (
					<div className="file-diff-loading">
						<span className="inline-flex items-center gap-2">
							<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
							{t("common.loading")}
						</span>
					</div>
				)}
				{error && <div className="file-diff-error">{error}</div>}
				{!loading && !error && (
					<>
						{/* 图片预览：Blob URL（base64 经主进程读取，dev/prod 一致） */}
						{!isDiffMode && isImage && mediaUrl && (
							<div className="file-diff-media-preview">
								<img src={mediaUrl} alt={fileName} />
							</div>
						)}
						{/* PDF 预览：Blob URL + Chromium 内置 PDF viewer */}
						{!isDiffMode && isPdf && mediaUrl && <iframe className="file-diff-pdf-preview" src={mediaUrl} title={t("editor.pdfPreview")} referrerPolicy="no-referrer" />}
						{/* 音视频：与图片/PDF 同一条 Blob URL 链路（CSP media-src 已允许 blob:）；
						   视频由 MediaPreview 负责「元素收缩到画面尺寸 + 常显播放按钮」 */}
						{!isDiffMode && isAudio && mediaUrl && (
							<div className="flex h-full w-full items-center justify-center p-6">
								<audio controls src={mediaUrl} className="w-full max-w-xl" onError={() => setError(t("editor.mediaUnsupported"))} />
							</div>
						)}
						{!isDiffMode && isVideo && mediaUrl && <MediaPreview url={mediaUrl} fileName={fileName} onError={() => setError(t("editor.mediaUnsupported"))} />}
						{/* CSV/TSV：解析成二维表格（引号感知，行/列上限内截断） */}
						{!isDiffMode && preview && isCsv && <CsvPreview key={`${props.filePath}:${reloadNonce}`} content={content} />}
						{/* Office/压缩包：自带读盘 + lazy 解析器，父层不再读第二遍 */}
						{!isDiffMode && officePreviewKind && <BinaryFilePreview key={`${props.filePath}:${reloadNonce}`} kind={officePreviewKind} filePath={fileAccessPath} fileAccessScope={props.fileAccessScope} />}
						{/* SVG 预览：文本内容直接编码为 data URL（无 Blob 生命周期管理） */}
						{!isDiffMode && preview && isSvg && (
							<div className="file-diff-media-preview">
								<img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`} alt={fileName} />
							</div>
						)}
						{/* Markdown 预览：仅 view 模式且 preview 启用（静态渲染，与会话正文同一 Streamdown 引擎）。
						   排版复用会话正文的 .markdown-body 体系，预览专属增量（阅读宽度/任务列表/kbd 等）
						   由 markdown-preview-chrome utility 提供（tailwind.css @utility，不再自建 parallel 样式）。 */}
						{!isDiffMode && preview && isMarkdown && (
							// scroll-ok: text —— 单一文本块（pre / markdown 正文），没有行列表可切，虚拟化无从下手。
							<div className="markdown-body markdown-preview-chrome h-full overflow-y-auto px-6 py-6 text-body text-text-primary font-sans">
								<MarkdownStream text={content} onOpenExternal={noopOpenExternal} remarkPlugins={FILE_PREVIEW_REMARK_PLUGINS} rehypePlugins={FILE_PREVIEW_REHYPE_PLUGINS} urlTransform={defaultUrlTransform} />
							</div>
						)}
						{!isDiffMode && preview && isHtml && <HtmlPreview content={content} />}
						{/* view 模式、非预览：常规编辑器（CodeMirror 6）；有专属预览的二进制/表格文件不挂编辑器 */}
						{!isDiffMode && !preview && !dedicatedPreview && (
							<div style={{ height: "100%", flexDirection: "column" }}>
								{/* lazy 边界：首次打开编辑器才拉取 CodeMirror chunk，期间轻量占位 */}
								<Suspense
									fallback={
										<div
											style={{
												height: "100%",
												display: "grid",
												placeItems: "center",
											}}
											className="flex items-center justify-center gap-2 text-caption text-foreground/50"
										>
											<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
											{t("common.loading")}
										</div>
									}
								>
									<CodeMirrorEditor value={content} lineSeparator={lineSeparatorRef.current} language={language} readOnly={readOnlyView} initialLine={props.initialLine} wordWrap={wordWrap} onChange={handleEditorChange} onAttachSelection={handleAttachSelection} />
								</Suspense>
							</div>
						)}
						{/* diff 模式：只读差异对比（分栏 / 单栏由 sideBySide 切换），
						   与编辑器不同时渲染，key 切换强制重建避免状态串台 */}
						{isDiffMode && (
							<div style={{ height: "100%", flexDirection: "column" }}>
								{/* lazy 边界：首次进入 diff 需要拉取 @pierre/diffs + shiki chunk，期间显示轻量占位 */}
								<Suspense
									fallback={
										<div
											style={{
												height: "100%",
												display: "grid",
												placeItems: "center",
											}}
											className="flex items-center justify-center gap-2 text-caption text-foreground/50"
										>
											<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
											{t("common.loading")}
										</div>
									}
								>
									<CodeDiffView key={sideBySide ? "split" : "unified"} oldContent={original} newContent={content} filePath={props.filePath} viewMode={sideBySide ? "split" : "unified"} theme={props.theme} wordWrap={wordWrap} />
								</Suspense>
							</div>
						)}
					</>
				)}
			</div>
		</>
	);

	if (displayMode === "modal") {
		return (
			<div className="modal-backdrop" onClick={isDiffMode ? handleClose : undefined}>
				<div className="file-diff-modal" onClick={(e) => e.stopPropagation()}>
					{headerContent}
				</div>
			</div>
		);
	}

	return <div className="file-diff-viewer">{headerContent}</div>;
}

/**
 * HTML previews intentionally use an opaque-origin iframe. This restores the
 * dev preview interaction without giving project HTML the renderer's origin,
 * Electron bridge, popups, or file-system navigation privileges.
 */

function HtmlPreview({ content }: { content: string }) {
	// 走 pideck-html: 协议而非 srcDoc：srcdoc 会继承主窗口 CSP，把文件里的内联脚本整段拦掉（#377）。
	// 协议文档的 CSP 由主进程响应头下发，与主窗口策略解耦，内联 <script> 才能正常执行。
	const src = useMemo(() => encodeHtmlPreviewUrl(content), [content]);
	// 超大文件不为跑脚本把整份内容塞进 URL：退回 srcDoc，至少能看到静态内容
	const source = src ? { src } : { srcDoc: content };
	return <iframe className="h-full w-full border-0 bg-[var(--color-bg-panel)]" {...source} title={t("editor.htmlPreview")} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", border: "none" }} />;
}
