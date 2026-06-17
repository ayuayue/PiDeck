import { useCallback, useEffect, useRef, useState } from "react";
import { DiffEditor, Editor } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { t } from "../../i18n";
import { Columns3, Edit3, Maximize2, X } from "lucide-react";
import { setupMonaco } from "../../utils/monacoSetup";

const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
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
	onClose: () => void;
	readContent: (path: string) => Promise<string>;
	/** 从会话消息 meta 中提取的工具执行前原始内容，优先于 Git HEAD。 */
	originalContent?: string;
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
	const [loadedPath, setLoadedPath] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [showHint, setShowHint] = useState(false);

	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
	const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);

	const isDiffMode = props.mode === "diff";

	useEffect(() => {
		ensureMonaco();
		if (loadedPath === props.filePath) return;

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
				const originalPromise =
					isDiffMode && props.originalContent
						? Promise.resolve(props.originalContent)
						: isDiffMode && props.readOriginalContent
							? props.readOriginalContent(props.filePath).catch(() => "")
							: Promise.resolve("");
				const [result, originalResult] = await Promise.all([
					props.readContent(props.filePath),
					originalPromise,
				]);
				if (!cancelled) {
					// 文件内容超过上限时不加载编辑器，防止 Monaco 处理大文件卡死
					if (result.length > maxFileSize) {
						setError(
							t("editor.fileTooLarge", {
								size: (result.length / 1024 / 1024).toFixed(1),
								max: (maxFileSize / 1024 / 1024).toFixed(0),
							}),
						);
						setLoading(false);
						return;
					}
					setContent(result);
					setOriginal(originalResult);
					setLoadedPath(props.filePath);
					if (result === "" && !loading) {
						// 文件可能已被删除或为空
						setError(t("config.fileDeletedOrEmpty"));
					}
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		void load();
		return () => { cancelled = true; };
	}, [props.filePath, props.readContent, props.readOriginalContent, props.originalContent, isDiffMode, loadedPath]);

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

	const fileName = props.filePath.split(/[/\\]/).pop() ?? props.filePath;
	const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
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

	return (
		<div className="modal-backdrop" onClick={readOnly ? handleClose : undefined}>
			<div className="file-diff-modal" onClick={(e) => e.stopPropagation()}>
				<div className="file-diff-header">
					<span className="file-diff-title" title={props.filePath}>
						{fileName}
						{dirty && " · 未保存"}
						{showHint && <span className="file-diff-hint">{t("app.saveFileShortcut")}</span>}
					</span>
					<div className="file-diff-header-actions">
						{isDiffMode && !loading && !error && (
							<button
								className="file-diff-toggle-btn"
								title={sideBySide ? t("app.showSingle") : t("app.showSplit")}
								onClick={() => setSideBySide(!sideBySide)}
							>
								{sideBySide ? <Maximize2 size={15} /> : <Columns3 size={15} />}
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
							<div style={{ display: isDiffMode ? "none" : "flex", height: "100%", flexDirection: "column" }}>
								<Editor
									value={content}
									language={language}
									theme={props.theme === "dark" ? "vs-dark" : "vs"}
									options={editorOptions}
									onMount={handleEditorMount}
									onChange={handleEditorChange}
								/>
							</div>
							<div style={{ display: !isDiffMode ? "none" : "flex", height: "100%", flexDirection: "column" }}>
								<DiffEditor
									original={original}
									modified={content}
									language={language}
									theme={props.theme === "dark" ? "vs-dark" : "vs"}
									options={diffOptions}
									onMount={handleDiffEditorMount}
								/>
							</div>
						</>
					)}
				</div>
			</div>
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
