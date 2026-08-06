import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n";
import { ArrowLeft, Edit3, Maximize, Minimize2, SquareSplitHorizontal, X, Eye, FileCode } from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { MarkdownStream } from "../session/MarkdownStream";
import { defaultUrlTransform } from "../session/MarkdownLinkCore";
import { defaultRemarkPlugins, defaultRehypePlugins } from "streamdown";
import rehypeKatex from "rehype-katex";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { MergeDiffView } from "./MergeDiffView";

import { isBinaryExtension } from "../../utils/isTextFile";

type ViewMode = "view" | "diff";

export function FileDiffViewer(props: {
	filePath: string;
	mode?: ViewMode;
	/** 展示模式：弹框（modal）或侧栏（drawer） */
	displayMode?: "modal" | "drawer";
	/** 在弹框/侧栏之间切换 */
	onToggleMode?: () => void;
	/** 返回按钮回调（侧栏模式时提供，点击返回上一面板） */
	onBack?: () => void;
	onClose: () => void;
	/** 多 tab 支持：全部 tab 列表 */
	tabs?: { id: string; filePath: string; label?: string }[];
	/** 当前活跃 tab ID */
	activeTabId?: string | null;
	/** 切换到指定 tab */
	onSelectTab?: (id: string) => void;
	/** 关闭指定 tab */
	onCloseTab?: (id: string) => void;
	readContent: (path: string) => Promise<string>;
	/** 从会话消息 meta 中提取的工具执行前原始内容，优先于 Git HEAD。 */
	originalContent?: string;
	/** Session-recorded modified content, preferred over disk read for historical sessions. */
	modifiedContent?: string;
	/** 读取文件的 Git HEAD 原始内容，供差异模式左侧基准列使用。 */
	readOriginalContent?: (path: string) => Promise<string>;
	saveContent?: (path: string, content: string) => Promise<void>;
	/** HTML 文件点击预览时，切换到内置浏览器面板预览。 */
	onPreviewHtml?: (filePath: string) => void;
	theme?: "light" | "dark";
	/** 单个文件超过此大小（MB）时不加载编辑器。默认 5MB。 */
	maxFileSizeMB?: number;
}) {
	const maxFileSize = (props.maxFileSizeMB ?? 5) * 1024 * 1024;
	const [content, setContent] = useState("");
	// 差异模式左侧展示的原始内容：优先使用会话缓存（originalContent），
	// 没有则从 Git HEAD 读取。新增/未跟踪文件为空字符串。
	const [original, setOriginal] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [sideBySide, setSideBySide] = useState(props.displayMode !== "drawer");
	const [readOnly, setReadOnly] = useState(true);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [showHint, setShowHint] = useState(false);

	const isDiffMode = props.mode === "diff";
	const fileName = props.filePath.split(/[/\\]/).pop() ?? props.filePath;
	const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
	const isMarkdown = ext === "md" || ext === "mdx";
	const isHtml = ext === "html" || ext === "htm";
	// 只读视图下 markdown 文件默认启用预览；差异模式或编辑模式保持源码视图。
	const [preview, setPreview] = useState(isMarkdown && !isDiffMode && readOnly);

	useEffect(() => {
		// 每个 tab 都从只读模式开始，尤其不能把工作区文件的编辑状态带入历史提交 Diff。
		setReadOnly(true);
		setDirty(false);
		setShowHint(false);
		setPreview(isMarkdown && !isDiffMode);
	}, [isDiffMode, isMarkdown, props.activeTabId, props.filePath]);

	useEffect(() => {
		let cancelled = false;
		async function load() {
			setLoading(true);
			setError(null);
			setDirty(false);
			try {
				// 检查文件扩展名是否属于二进制/不可编辑类型
				if (isBinaryExtension(props.filePath)) {
					setError(t("editor.binaryFileNotSupported", { ext }));
					setLoading(false);
					return;
				}
				// 差异模式优先使用会话缓存原始内容（originalContent），
				// 没有时降级到 Git HEAD；两者都无则左侧显示空（新增文件）。
				// 修改后内容优先使用会话记录（modifiedContent），历史会话恢复时磁盘可能已变化。
				const contentPromise = props.modifiedContent !== undefined
					? Promise.resolve(props.modifiedContent)
					: props.readContent(props.filePath);
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
					setContent(result);
					setOriginal(originalResult);
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		void load();
		return () => { cancelled = true; };
	// readContent/readOriginalContent 是稳定的 API 回调（上层已 useCallback），
	// 不参与 effect deps，避免父组件因其他状态变化重渲染时反复加载文件导致编辑器重置到顶部。
	// 两侧缓存内容都需要监听：同一路径可在多个历史提交 Diff tab 之间切换。
	}, [props.filePath, props.originalContent, props.modifiedContent, isDiffMode]);

	const handleClose = useCallback(() => {
		props.onClose();
	}, [props.onClose]);

	// 从当前内容 state 取最新值（编辑器 onChange 已实时同步；CM6 无 Monaco 的实例取值路径）
	const getLatestContent = useCallback(() => content, [content]);

	const doSave = useCallback(async () => {
		if (!props.saveContent || !dirty) return;
		const latest = getLatestContent();
		setSaving(true);
		try {
			await props.saveContent(props.filePath, latest);
			setContent(latest);
			setDirty(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [dirty, getLatestContent, props.saveContent, props.filePath]);

	// Ctrl+S / Cmd+S 快捷键保存
	const handleKeyDown = useCallback((e: KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && e.key === "s") {
			e.preventDefault();
			void doSave();
		}
	}, [doSave]);

	useEffect(() => {
		if (!readOnly) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [readOnly, handleKeyDown]);

	// 进入编辑时显示快捷键提示，3 秒后自动消失
	useEffect(() => {
		if (showHint) {
			const timer = setTimeout(() => setShowHint(false), 3000);
			return () => clearTimeout(timer);
		}
	}, [showHint]);

	const handleEditToggle = useCallback(() => {
		setReadOnly(false);
		setShowHint(true);
	}, []);

	const handleExitEdit = useCallback(() => {
		setReadOnly(true);
	}, []);

	const handleEditorChange = useCallback((value: string) => {
		setContent(value);
		setDirty(true);
	}, []);

	const language = ext;

	const displayMode = props.displayMode ?? "drawer";
	const headerContent = (
		<>
			{props.tabs && props.tabs.length > 1 && (
				<div className="file-diff-tab-bar">
					{props.tabs.map((tab) => (
						<div
							key={tab.id}
							role="tab"
							aria-selected={tab.id === props.activeTabId}
							className={`file-diff-tab${tab.id === props.activeTabId ? " active" : ""}`}
							onClick={() => props.onSelectTab?.(tab.id)}
							onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onSelectTab?.(tab.id); } }}
							title={tab.label ?? tab.filePath}
							tabIndex={0}
						>
							<span>{tab.label ?? tab.filePath.split(/[/\\]/).pop()}</span>
							<button
								type="button"
								className="file-diff-tab-close"
								onClick={(e) => { e.stopPropagation(); props.onCloseTab?.(tab.id); }}
								aria-label={t("common.close")}
							>
								<X size={11} />
							</button>
						</div>
					))}
				</div>
			)}
			<div className="file-diff-header">
				{props.onBack && displayMode === "drawer" && (
					<Button
						variant="ghost"
						size="icon-sm"
						className="file-diff-close"
						onClick={props.onBack}
						title={t("common.back")}
						aria-label={t("common.back")}
					>
						<ArrowLeft size={18} />
					</Button>
				)}
				<span className="file-diff-title" title={props.filePath}>
					{fileName}
					{dirty && t("editor.unsavedMarker")}
					{showHint && <span className="file-diff-hint">{t("app.saveFileShortcut")}</span>}
				</span>
				<div className="file-diff-header-actions">
					{(isMarkdown || isHtml) && !isDiffMode && !loading && !error && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="file-diff-toggle-btn"
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
							className="file-diff-toggle-btn"
							title={sideBySide ? t("app.showSingle") : t("app.showSplit")}
							onClick={() => setSideBySide(!sideBySide)}
						>
							<SquareSplitHorizontal size={15} />
						</Button>
					)}
					{props.saveContent && readOnly && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="file-diff-toggle-btn"
							title={t("app.editFile")}
							onClick={handleEditToggle}
						>
							<Edit3 size={15} />
						</Button>
					)}
					{!readOnly && props.saveContent && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="file-diff-toggle-btn"
							title={t("app.exitEdit")}
							onClick={handleExitEdit}
						>
							<X size={15} />
						</Button>
					)}
					{props.onToggleMode && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="file-diff-toggle-btn"
							title={displayMode === "modal" ? t("app.minimizeToDrawer") : t("app.expandToModal")}
							onClick={props.onToggleMode}
						>
							{displayMode === "modal" ? <Minimize2 size={15} /> : <Maximize size={15} />}
						</Button>
					)}
					<Button variant="ghost" size="icon-sm" className="file-diff-close" onClick={handleClose} aria-label={t("common.close")}>
						<X size={18} />
					</Button>
				</div>
			</div>
			<div className="file-diff-body">
				{loading && <div className="file-diff-loading">{t("common.loading")}</div>}
				{error && <div className="file-diff-error">{error}</div>}
				{!loading && !error && (
					<>
						{/* Markdown 预览：仅 view 模式且 preview 启用（静态渲染，与会话正文同一 Streamdown 引擎） */}
						{!isDiffMode && preview && isMarkdown && (
							<div className="file-diff-preview">
								<MarkdownStream
									text={content}
									onOpenExternal={() => undefined}
									remarkPlugins={[defaultRemarkPlugins.gfm]}
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
									readOnly={readOnly}
									onChange={handleEditorChange}
								/>
							</div>
						)}
						{/* diff 模式：MergeView（分栏）/ unifiedMergeView（单栏），
							与 Editor 不同时渲染，key 切换强制重建避免状态串台 */}
						{isDiffMode && (
							<div style={{ height: "100%", flexDirection: "column" }}>
								<MergeDiffView
									key={sideBySide ? "split" : "unified"}
									original={original}
									modified={content}
									language={language}
									readOnly={readOnly}
									sideBySide={sideBySide}
									onChange={handleEditorChange}
								/>
							</div>
						)}
					</>
				)}
			</div>
		</>
	);

	if (displayMode === "modal") {
		return (
			<div className="modal-backdrop" onClick={readOnly ? handleClose : undefined}>
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
function HtmlPreview({ content }: { content: string }) {
	return (
		<iframe
			className="file-diff-preview"
			srcDoc={content}
			title={t("editor.htmlPreview")}
			sandbox="allow-scripts allow-forms"
			referrerPolicy="no-referrer"
			style={{ width: "100%", height: "100%", border: "none" }}
		/>
	);
}
