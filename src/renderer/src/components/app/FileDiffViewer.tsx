import type { ProjectFileAccessScope } from "../../../../shared/types";
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { t } from "../../i18n";
import { ArrowLeft, Maximize, Minimize2, Rows2, SquareSplitHorizontal, X, Eye, FileCode } from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { cn } from "../../lib/utils";
import { MarkdownStream } from "../session/MarkdownStream";
import { defaultUrlTransform } from "../session/MarkdownLinkCore";
import { defaultRehypePlugins } from "streamdown";
import rehypeKatex from "rehype-katex";
import { remarkGfmNoSingleTilde } from "../../utils/markdownPlugins";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
// CodeDiffView 静态链上挂着 @pierre/diffs + shiki（WASM 重库），懒加载后这些模块
// 移出首屏初始 chunk（约 -500KB 解析量），仅在用户打开 diff 时才拉取。
const CodeDiffView = lazy(() =>
	import("./CodeDiffView").then((m) => ({ default: m.CodeDiffView })),
);
import { formatFilePathRef } from "../session/composer/chips";

import { isBinaryExtension, isImageFile, isPdfFile } from "../../utils/isTextFile";
import { updateInstallPreflightTasksAtom } from "../../atoms/update-install-preflight";

type ViewMode = "view" | "diff";

/** 把主进程的大文件错误码还原为用户可读文案，其它错误保留原始诊断。 */
function fileLoadErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const match = /FILE_TOO_LARGE:(\d+):(\d+)/.exec(raw);
	if (!match) return raw;
	const size = Number(match[1]);
	const limit = Number(match[2]);
	return t("editor.fileTooLarge", {
		size: (size / 1024 / 1024).toFixed(1),
		max: (limit / 1024 / 1024).toFixed(0),
	});
}

export function FileDiffViewer(props: {
	filePath: string;
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
	readContent: (
		path: string,
		maxBytes?: number,
		scope?: ProjectFileAccessScope,
	) => Promise<string>;
	/** 项目文件读取授权；存在时 read/stat/base64 都由主进程限制到该项目根。 */
	fileAccessScope?: ProjectFileAccessScope;
	/** 从会话消息 meta 中提取的工具执行前原始内容，优先于 Git HEAD。 */
	originalContent?: string;
	/** Session-recorded modified content, preferred over disk read for historical sessions. */
	modifiedContent?: string;
	/** 读取文件的 Git HEAD 原始内容，供差异模式左侧基准列使用。 */
	readOriginalContent?: (path: string) => Promise<string>;
	saveContent?: (
		path: string,
		content: string,
		scope?: ProjectFileAccessScope,
	) => Promise<void>;
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
	// diff 模式为只读对比视图（第三方渲染库），无需编辑态切换
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	// 二进制预览（图片/PDF）的 Blob URL：切换文件/卸载时 revoke，防止内存泄漏
	const [mediaUrl, setMediaUrl] = useState<string | null>(null);
	const mediaUrlRef = useRef<string | null>(null);
	// 编辑器的 input 事件先于 React render；debounce timer 不能捕获旧 render 的 content。
	// 这个 ref 是编辑内容的实时镜像，保存时始终从它读取最新文本。
	const contentRef = useRef(content);

	const isDiffMode = props.mode === "diff";
	const fileName = props.filePath.split(/[/\\]/).pop() ?? props.filePath;
	const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
	const isMarkdown = ext === "md" || ext === "mdx";
	const isHtml = ext === "html" || ext === "htm";
	// SVG 是文本（可编辑），预览时用内容渲染为 data URL 图片（CSP img-src 已允许 data:）
	const isSvg = ext === "svg";
	// 图片/PDF 走内置预览（view 模式）：二进制内容不可文本读取，跳过编辑器直接渲染。
	const isImage = isImageFile(props.filePath);
	const isPdf = isPdfFile(props.filePath);
	// 默认预览模式：markdown/html/svg 打开直接渲染预览（干净阅读），
	// 点「源码」切换按钮才进入源码模式；源码模式即编辑模式，不再需要独立的编辑按钮。
	const defaultPreview = !isDiffMode && (isMarkdown || isHtml || isSvg);
	const [preview, setPreview] = useState(defaultPreview);

	useEffect(() => {
		// 每个 tab 重置编辑状态：view 可编辑（源码即编辑），diff 只读对比无编辑态。
		setDirty(false);
		setPreview(defaultPreview);
		// 清掉上一个文件的 Blob URL（媒体预览随 tab 切换失效）
		revokeMediaUrl();
		setMediaUrl(null);
	}, [isDiffMode, props.activeTabId, props.filePath]);

	useEffect(() => {
		let cancelled = false;
		async function load() {
			setLoading(true);
			setError(null);
			setDirty(false);
			try {
				// 图片/PDF：仅 view 模式读取二进制转 Blob URL 预览（不文本读取）；
				// diff 模式无法展示二进制差异，维持「不支持编辑」提示。
				if (isBinaryExtension(props.filePath)) {
					if (!isDiffMode && (isImageFile(props.filePath) || isPdfFile(props.filePath))) {
						await loadMediaPreview();
						return;
					}
					setError(t("editor.binaryFileNotSupported", { ext }));
					setLoading(false);
					return;
				}
				// 差异模式优先使用会话缓存原始内容（originalContent），
				// 没有时降级到 Git HEAD；两者都无则左侧显示空（新增文件）。
				// 修改后内容优先使用会话记录（modifiedContent），历史会话恢复时磁盘可能已变化。
				const contentPromise = props.modifiedContent !== undefined
					? Promise.resolve(props.modifiedContent)
					: props.readContent(props.filePath, maxFileSize, props.fileAccessScope);
				const originalPromise =
					isDiffMode && props.originalContent !== undefined
						? Promise.resolve(props.originalContent)
						: isDiffMode && props.readOriginalContent
							? props.readOriginalContent(props.filePath).catch(() => "")
							: Promise.resolve("");
				const [result, originalResult] = await Promise.all([
					contentPromise,
					originalPromise,
				]);
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
					setContent(result);
					// 自动保存基准快照：加载完成即视为「已落盘」状态，避免打开后无改动就触发写盘
					lastSavedRef.current = result;
					setOriginal(originalResult);
					// 空内容二次校验（仅绝对路径 + 查看/编辑模式）：主进程 readContent 对
					// ENOENT 返回 ""（为「新建文件」流程保留的语义），死链直接渲染就是
					// 一片空白。但 AI 回复链接打开的路径必须给明确反馈——已解析成绝对路径
					// 仍读到空串，大概率是模型给的路径本就不存在；再确认一次并展示错误态。
					if (
						result === "" &&
						!isDiffMode &&
						/^([A-Za-z]:[\\/]|\/)/.test(props.filePath)
					) {
						try {
							const [exists] = await window.piDesktop.files.pathsExist(
								[props.filePath],
								props.fileAccessScope,
							);
							if (!exists && !cancelled) {
								setError(t("editor.fileNotFound", { path: props.filePath }));
							}
						} catch {
							// 校验通道不可用（预览模式）：维持原状不额外报错。
						}
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
				const base64 = await readBinary(
					props.filePath,
					undefined,
					props.fileAccessScope,
				);
				// 读取完成后重新读取闭包里的取消标记；传入 boolean 会冻结为调用时的 false，
				// 旧 tab 的结果就可能 revoke 并覆盖新 tab 刚创建的 Blob URL。
				if (cancelled || !base64) {
					if (!cancelled) setError(t("editor.binaryFileNotSupported", { ext }));
					return;
				}
				const mime = isPdf ? "application/pdf" : mimeFromImageExt(ext);
				const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
				revokeMediaUrl();
				const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
				mediaUrlRef.current = url;
				setMediaUrl(url);
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			}
		}
		void load();
		return () => { cancelled = true; };
	// readContent/readOriginalContent 是稳定的 API 回调（上层已 useCallback），
	// 不参与 effect deps，避免父组件因其他状态变化重渲染时反复加载文件导致编辑器重置到顶部。
	// 两侧缓存内容都需要监听：同一路径可在多个历史提交 Diff tab 之间切换。
	}, [props.filePath, props.activeTabId, props.originalContent, props.modifiedContent, props.fileAccessScope?.projectId, isDiffMode, maxFileSize]);

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

	// 从实时内容镜像取值，而不是从 state 闭包取值：debounce timer/快捷键回调
	// 可能仍属于上一次 render，但 input 事件已经把最新文本写入 ref。
	const getLatestContent = useCallback(() => contentRef.current, []);

	// 自动保存：编辑停止 500ms 后静默落盘（仅 allowSave 的文件），Ctrl+S 立即保存并取消挂起的自动保存。
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 最近一次落盘内容快照：内容未变时跳过保存，避免重复写盘
	const lastSavedRef = useRef("");
	// FileDiffViewer 在切换 Tab 时复用实例；用代数阻止旧文件的异步保存结果污染新 Tab。
	const saveGenerationRef = useRef(0);

	// 切换文件/Tab 或外部缓存内容时，取消旧文件的 debounce 保存并令进行中的保存失效。
	// 否则旧 timer 可能在新文件已挂载后调用旧 render 的 saveNow，覆盖新文件状态。
	useEffect(() => {
		saveGenerationRef.current += 1;
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		contentRef.current = "";
		lastSavedRef.current = "";
		setSaving(false);
	}, [props.activeTabId, props.filePath, props.originalContent, props.modifiedContent, props.fileAccessScope?.projectId, isDiffMode]);

	const saveNow = useCallback(async (): Promise<boolean> => {
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		if (isDiffMode || !props.saveContent) return true;
		const latest = getLatestContent();
		if (latest === lastSavedRef.current) return true;
		const saveGeneration = saveGenerationRef.current;
		const savePath = props.filePath;
		setSaving(true);
		try {
			await props.saveContent(savePath, latest, props.fileAccessScope);
			// Tab 已切换时，旧请求即使完成也不能改动新 Tab 的 dirty/content 状态。
			if (saveGeneration !== saveGenerationRef.current) return true;
			lastSavedRef.current = latest;
			// 保存期间用户可能继续输入；只有没有更新过才可以清除 dirty，
			// 绝不能把保存开始时的快照重新 set 回编辑器。
			if (contentRef.current === latest) {
				setDirty(false);
			}
			return true;
		} catch (e) {
			if (saveGeneration === saveGenerationRef.current) {
				// 保存失败保留 dirty，用户可继续编辑后由下一次自动保存/Ctrl+S 重试
				setError(e instanceof Error ? e.message : String(e));
			}
			return false;
		} finally {
			if (saveGeneration === saveGenerationRef.current) setSaving(false);
		}
	}, [getLatestContent, isDiffMode, props.saveContent, props.filePath, props.fileAccessScope?.projectId]);

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
		if (!props.saveContent) return;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			saveTimerRef.current = null;
			void saveNow();
		}, 500);
	}, [props.saveContent, saveNow]);

	// Ctrl+S / Cmd+S：立即保存（取消挂起的自动保存，避免重复写盘）。
	// 仅 view 模式生效：diff 是只读对比，不存在保存。
	const handleKeyDown = useCallback((e: KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && e.key === "s") {
			e.preventDefault();
			void saveNow();
		}
	}, [saveNow]);

	useEffect(() => {
		if (!isDiffMode) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [isDiffMode, handleKeyDown]);

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

	const handleEditorChange = useCallback((value: string) => {
		// 先写 ref 再触发 React 更新，保证 debounce timer 不会保存上一个 render 的值。
		contentRef.current = value;
		setContent(value);
		setDirty(true);
		scheduleAutoSave();
	}, [scheduleAutoSave]);

	// 编辑器选中文本 → 右键「引用选中内容」：以 pi 的 read 语法 @path:start-end 派发到输入框。
	// 与文件树右键 onAttach 共用同一追加语义（composer-attach-refs 由 App 监听后插入 draft）。
	const handleAttachSelection = useCallback((startLine: number, endLine: number) => {
		const range = startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
		const ref = `${formatFilePathRef(props.filePath)}:${range}`;
		window.dispatchEvent(new CustomEvent("composer-attach-refs", { detail: { refs: [ref] } }));
	}, [props.filePath]);

	const language = ext;

	const displayMode = props.displayMode ?? "drawer";
	const isWorkbenchPane = displayMode === "split" || displayMode === "maximize";
	const showInlineTabs =
		!props.chromeTabsExternal && Boolean(props.tabs && props.tabs.length > 0);
	const headerContent = (
		<>
			{showInlineTabs && props.tabs && (
				<div className="file-diff-tab-bar" role="tablist">
					{props.tabs.map((tab) => {
						const tabLabel =
							tab.label ?? tab.filePath.split(/[/\\]/).pop() ?? tab.filePath;
						const showDirty =
							tab.id === props.activeTabId && dirty
								? t("editor.unsavedMarker")
								: "";
						return (
							<div
								key={tab.id}
								role="tab"
								aria-selected={tab.id === props.activeTabId}
								className={cn(
									"file-diff-tab",
									tab.id === props.activeTabId && "active",
									tab.preview && "italic text-muted-foreground",
								)}
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
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={props.onBack}
						title={t("common.back")}
						aria-label={t("common.back")}
					>
						<ArrowLeft size={18} />
					</Button>
				)}
				{/* Tab 栏负责切换；操作区同时显示当前文件名，避免用户只看到一排无语义的动作钮。 */}
				<span className="file-diff-title min-w-0 flex-1 truncate" title={props.filePath}>
					{fileName}
					{dirty && t("editor.unsavedMarker")}
				</span>
				<div className="file-diff-header-actions">
					{(isMarkdown || isHtml || isSvg) && !isDiffMode && !loading && !error && (
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
					{isDiffMode && !loading && !error && displayMode !== "drawer" && (
						<Button
							variant="ghost"
							size="icon-sm"
							title={sideBySide ? t("app.showSingle") : t("app.showSplit")}
							onClick={() => setSideBySide(!sideBySide)}
						>
							{/* 图标随模式变化：分栏时显示「单栏」图标（点击合并），单栏时显示「分栏」图标（点击分栏），
							   与 title 的目标状态一致，两种模式按钮一眼可辨 */}
							{sideBySide ? <Rows2 size={15} /> : <SquareSplitHorizontal size={15} />}
						</Button>
					)}
					{/* 编辑/退出编辑按钮已移除：diff 为只读对比（第三方渲染库），
					   view 模式源码即编辑（切到源码即可改），均无需独立的编辑按钮。 */}
					{props.onToggleMode && (
						<Button
							variant="ghost"
							size="icon-sm"
							title={
								isWorkbenchPane
									? displayMode === "maximize"
										? t("app.restoreSplit")
										: t("app.maximizeInWorkbench")
									: displayMode === "modal"
										? t("app.minimizeToDrawer")
										: t("app.expandToModal")
							}
							onClick={props.onToggleMode}
						>
							{(isWorkbenchPane ? displayMode === "maximize" : displayMode === "modal")
								? <Minimize2 size={15} />
								: <Maximize size={15} />}
						</Button>
					)}
					{/* 关闭按钮：无论 Tab 是否上收总栏都保留，保证 DIFF/文件预览右上角
					   始终有关闭入口（Tab 栏小叉在窄栏下不易点中）。 */}
					<Button
						variant="ghost"
							size="icon-sm"
							onClick={handleClose}
						aria-label={t("common.close")}
						title={t("common.close")}
					>
						<X size={15} />
					</Button>
				</div>
			</div>
			<div className="file-diff-body">
				{loading && <div className="file-diff-loading">{t("common.loading")}</div>}
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
						{!isDiffMode && isPdf && mediaUrl && (
							<iframe
								className="file-diff-pdf-preview"
								src={mediaUrl}
								title={t("editor.pdfPreview")}
								referrerPolicy="no-referrer"
							/>
						)}
						{/* SVG 预览：文本内容直接编码为 data URL（无 Blob 生命周期管理） */}
						{!isDiffMode && preview && isSvg && (
							<div className="file-diff-media-preview">
								<img
									src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`}
									alt={fileName}
								/>
							</div>
						)}
						{/* Markdown 预览：仅 view 模式且 preview 启用（静态渲染，与会话正文同一 Streamdown 引擎）。
						   排版复用会话正文的 .markdown-body 体系，预览专属增量（阅读宽度/任务列表/kbd 等）
						   由 markdown-preview-chrome utility 提供（tailwind.css @utility，不再自建 parallel 样式）。 */}
						{!isDiffMode && preview && isMarkdown && (
							<div className="markdown-body markdown-preview-chrome h-full overflow-y-auto px-6 py-6 text-body text-text-primary font-sans">
								<MarkdownStream
									text={content}
									onOpenExternal={() => undefined}
									remarkPlugins={[remarkGfmNoSingleTilde]}
									rehypePlugins={[defaultRehypePlugins.raw, rehypeKatex]}
									urlTransform={defaultUrlTransform}
								/>
							</div>
						)}
						{!isDiffMode && preview && isHtml && (
							<HtmlPreview content={content} />
						)}
						{/* view 模式、非预览：常规编辑器（CodeMirror 6） */}
						{!isDiffMode && !preview && (
							<div style={{ height: "100%", flexDirection: "column" }}>
								<CodeMirrorEditor
									value={content}
									language={language}
									readOnly={false}
									initialLine={props.initialLine}
									onChange={handleEditorChange}
									onAttachSelection={handleAttachSelection}
								/>
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
											className="text-caption text-foreground/50"
										>
											{t("common.loading")}
										</div>
									}
								>
									<CodeDiffView
										key={sideBySide ? "split" : "unified"}
										oldContent={original}
										newContent={content}
										filePath={props.filePath}
										viewMode={sideBySide ? "split" : "unified"}
										theme={props.theme}
									/>
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

	return (
		<div className="file-diff-viewer">
			{headerContent}
		</div>
	);
}

/**
 * HTML previews intentionally use an opaque-origin iframe. This restores the
 * dev preview interaction without giving project HTML the renderer's origin,
 * Electron bridge, popups, or file-system navigation privileges.
 */
/** 图片扩展名 → MIME（Blob 类型；Chromium 按内容解码，类型仅作提示） */
function mimeFromImageExt(ext: string): string {
	const map: Record<string, string> = {
		png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
		webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
	};
	return map[ext] ?? "application/octet-stream";
}

function HtmlPreview({ content }: { content: string }) {
	return (
		<iframe
			className="h-full w-full border-0 bg-[var(--color-bg-panel)]"
			srcDoc={content}
			title={t("editor.htmlPreview")}
			sandbox="allow-scripts allow-forms"
			referrerPolicy="no-referrer"
			style={{ width: "100%", height: "100%", border: "none" }}
		/>
	);
}
