import { useCallback, useEffect, useRef, useState } from "react";
import { DiffEditor, Editor } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { t } from "../../i18n";
import { ArrowLeft, Edit3, Maximize, Minimize2, SquareSplitHorizontal, X, Eye, FileCode } from "lucide-react";
import { setupMonaco } from "../../utils/monacoSetup";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import { defaultUrlTransform } from "react-markdown";

const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
	"mp3", "wav", "ogg", "flac", "m4a",
	"mp4", "avi", "mkv", "mov", "webm",
	"zip", "tar", "gz", "bz2", "7z", "rar",
	"exe", "dll", "so", "dylib", "wasm",
	"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
	"ttf", "otf", "woff", "woff2", "eot",
	"o", "a", "lib", "obj", "class", "pyc", "pyo",
	"db", "sqlite", "sqlite3",
]);

let monacoSetupOnce = false;
function ensureMonaco() {
	if (monacoSetupOnce) return;
	monacoSetupOnce = true;
	setupMonaco();
}

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
	const [sideBySide, setSideBySide] = useState(true);
	const [readOnly, setReadOnly] = useState(true);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [showHint, setShowHint] = useState(false);

	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
	const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);

	const isDiffMode = props.mode === "diff";
	const fileName = props.filePath.split(/[/\\]/).pop() ?? props.filePath;
	const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
	const isMarkdown = ext === "md" || ext === "mdx";
	const isHtml = ext === "html" || ext === "htm";
	// 只读视图下 markdown/html 文件默认启用预览；差异模式或编辑模式保持源码视图。
	const [preview, setPreview] = useState((isMarkdown || isHtml) && !isDiffMode && readOnly);

	useEffect(() => {
		// 每个 tab 都从只读模式开始，尤其不能把工作区文件的编辑状态带入历史提交 Diff。
		setReadOnly(true);
		setDirty(false);
		setShowHint(false);
		// 文件类型切换时重置预览状态，防止跨文件残留导致内容区域空白
		const ext = (props.filePath.split(".").pop() ?? "").toLowerCase();
		const isMd = ext === "md" || ext === "mdx";
		const isHt = ext === "html" || ext === "htm";
		setPreview((isMd || isHt) && props.mode !== "diff");
	}, [props.activeTabId, props.filePath, props.mode]);

	useEffect(() => {
		ensureMonaco();

		let cancelled = false;
		async function load() {
			setLoading(true);
			setError(null);
			setDirty(false);
			try {
				// 检查文件扩展名是否属于二进制/不可编辑类型
				const ext = (props.filePath.split(".").pop() ?? "").toLowerCase();
				if (BINARY_EXTENSIONS.has(ext)) {
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
					// Diff 任一侧超过上限都不加载 Monaco；删除文件虽右侧为空，左侧仍可能很大。
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

	// 从编辑器当前实例获取最新内容，不依赖 state 以避免与 Monaco 实际内容不同步。
	const getLatestContent = useCallback(() => {
		return isDiffMode
			? diffEditorRef.current?.getModifiedEditor().getValue() ?? content
			: editorRef.current?.getValue() ?? content;
	}, [isDiffMode, content]);

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

	const handleEditorChange = useCallback((value: string | undefined) => {
		if (value !== undefined) {
			setContent(value);
			setDirty(true);
		}
	}, []);

	const handleEditorMount = useCallback((editor: Monaco.editor.IStandaloneCodeEditor) => {
		editorRef.current = editor;
	}, []);

	const handleDiffEditorMount = useCallback((editor: Monaco.editor.IStandaloneDiffEditor) => {
		diffEditorRef.current = editor;
		// 差异编辑器没有统一的 onChange；手动监听 modified 模型变化以跟踪未保存状态。
		const modified = editor.getModifiedEditor();
		modified.onDidChangeModelContent(() => {
			setContent(modified.getValue());
			setDirty(true);
		});
	}, []);

	// 组件卸载前先清理 Monaco 编辑器引用，避免异步清理造成 TextModel disposed 竞态。
	useEffect(() => {
		return () => {
			editorRef.current?.dispose();
			diffEditorRef.current?.dispose();
			editorRef.current = null;
			diffEditorRef.current = null;
		};
	}, []);

	const language = extToMonacoLanguage(ext);

	const editorOptions: Monaco.editor.IStandaloneEditorConstructionOptions = {
		readOnly,
		minimap: { enabled: false },
		scrollBeyondLastLine: false,
		lineNumbers: "on",
		folding: true,
		automaticLayout: true,
		// 编辑模式下启用语法补全和关键字提示
		quickSuggestions: true,
		suggestOnTriggerCharacters: true,
		tabCompletion: "on",
		wordBasedSuggestions: "currentDocument",
		parameterHints: { enabled: true },
		// 大文件优化：超长行截断 tokenize，防止渲染卡死
		maxTokenizationLineLength: 4000,
		largeFileOptimizations: true,
	};

	const diffOptions: Monaco.editor.IStandaloneDiffEditorConstructionOptions = {
		...editorOptions,
		readOnly,
		renderSideBySide: sideBySide,
		// 显示真实差异，包括行尾空格差异
		ignoreTrimWhitespace: false,
		// 大文件时折叠未变化区域，只显示有变动的代码段；最小上下文 3 行
		hideUnchangedRegions: {
			enabled: true,
			minimumLineCount: 3,
			contextLineCount: 3,
			revealLineCount: 5,
		},
		// 紧凑模式，差异视图两端对齐只显示有改动的行
		compactMode: true,
	};

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
					<button
						className="file-diff-close"
						onClick={props.onBack}
						title={t("common.back")}
						aria-label={t("common.back")}
					>
						<ArrowLeft size={18} />
					</button>
				)}
				<span className="file-diff-title" title={props.filePath}>
					{fileName}
					{dirty && " · 未保存"}
					{showHint && <span className="file-diff-hint">{t("app.saveFileShortcut")}</span>}
				</span>
				<div className="file-diff-header-actions">
					{(isMarkdown || isHtml) && !isDiffMode && !loading && !error && (
						<button
							className="file-diff-toggle-btn"
							title={preview ? t("editor.source") : t("editor.preview")}
							onClick={() => setPreview(!preview)}
						>
							{preview ? <FileCode size={15} /> : <Eye size={15} />}
						</button>
					)}
					{isDiffMode && !loading && !error && (
						<button
							className="file-diff-toggle-btn"
							title={sideBySide ? t("app.showSingle") : t("app.showSplit")}
							onClick={() => setSideBySide(!sideBySide)}
						>
							<SquareSplitHorizontal size={15} />
						</button>
					)}
					{props.saveContent && readOnly && (
						<button
							className="file-diff-toggle-btn"
							title={t("app.editFile")}
							onClick={handleEditToggle}
						>
							<Edit3 size={15} />
						</button>
					)}
					{!readOnly && props.saveContent && (
						<button
							className="file-diff-toggle-btn"
							title={t("app.exitEdit")}
							onClick={handleExitEdit}
						>
							<X size={15} />
						</button>
					)}
					{props.onToggleMode && (
						<button
							className="file-diff-toggle-btn"
							title={displayMode === "modal" ? t("app.minimizeToDrawer") : t("app.expandToModal")}
							onClick={props.onToggleMode}
						>
							{displayMode === "modal" ? <Minimize2 size={15} /> : <Maximize size={15} />}
						</button>
					)}
					<button className="file-diff-close" onClick={handleClose} aria-label={t("common.close")}>
						<X size={18} />
					</button>
				</div>
			</div>
			<div className="file-diff-body">
				{loading && <div className="file-diff-loading">{t("common.loading")}</div>}
				{error && <div className="file-diff-error">{error}</div>}
				{!loading && !error && (
					<>
						{/* Markdown 预览：仅 view 模式且 preview 启用 */}
						{!isDiffMode && preview && isMarkdown && (
							<div className="file-diff-preview">
								<ReactMarkdown
									remarkPlugins={[remarkGfm]}
									rehypePlugins={[rehypeKatex]}
									urlTransform={defaultUrlTransform}
								>
									{content}
								</ReactMarkdown>
							</div>
						)}
						{/* HTML 预览：仅 view 模式且 preview 启用 */}
						{!isDiffMode && preview && isHtml && (
							<HtmlPreview content={content} />
						)}
						{/* view 模式、非预览：常规 Editor */}
						{!isDiffMode && !preview && (
							<div style={{ height: "100%", flexDirection: "column" }}>
								<Editor
									value={content}
									language={language}
									theme={props.theme === "dark" ? "vs-dark" : "vs"}
									options={editorOptions}
									onMount={handleEditorMount}
									onChange={handleEditorChange}
								/>
							</div>
						)}
						{/* diff 模式：仅 DiffEditor（不与 Editor 同时渲染，避免 Monaco 模型销毁竞态） */}
						{isDiffMode && (
							<div style={{ height: "100%", flexDirection: "column" }}>
								<DiffEditor
									original={original}
									modified={content}
									language={language}
									theme={props.theme === "dark" ? "vs-dark" : "vs"}
									options={diffOptions}
									onMount={handleDiffEditorMount}
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

function extToMonacoLanguage(ext: string): string {
	const map: Record<string, string> = {
		ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
		json: "json", jsonc: "json", md: "markdown", mdx: "markdown", css: "css", scss: "scss", less: "less",
		html: "html", htm: "html", yaml: "yaml", yml: "yaml", xml: "xml", svg: "xml",
		sh: "shell", bash: "shell", zsh: "shell",
		py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", c: "c", "c++": "cpp", cpp: "cpp", h: "c", hpp: "cpp",
		sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf", toml: "toml", ini: "ini", cfg: "ini", env: "dotenv",
		dockerfile: "dockerfile", makefile: "makefile",
	};
	return map[ext] ?? "plaintext";
}

/**
 * HTML 预览组件：通过 sandboxed iframe 安全渲染 HTML。
 * 使用 srcdoc 避免 CSP frame-src 限制；不带 allow-scripts 确保内联脚本不执行。
 */
function HtmlPreview({ content }: { content: string }) {
	return (
		<iframe
			className="file-diff-preview"
			srcDoc={content}
			title="HTML preview"
			sandbox=""
			style={{
				width: "100%",
				height: "100%",
				border: "none",
				background: "white",
			}}
		/>
	);
}
