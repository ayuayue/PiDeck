import {
	isValidElement,
	memo,
	useEffect,
	useId,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { toPng } from "html-to-image";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

// Mermaid 库体积数 MB，仅在真正出现 mermaid 代码块时才动态加载，
// 避免随渲染进程常驻、放大内存占用并在流式期间抢占主线程。
let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
function loadMermaid() {
	if (!mermaidModulePromise) mermaidModulePromise = import("mermaid");
	return mermaidModulePromise;
}
import {
	AlertTriangle,
	Check,
	ChevronDown,
	ChevronRight,
	GitBranch,
	Brain,
	FileText,
	Folder,
	Globe2,
	MessageCircle,
	Network,
	Pencil,
	PawPrint,
	Pin,
	Plus,
	RefreshCw,
	Search,
	Settings2,
	Terminal,
	UploadCloud,
	Wrench,
	X,
	Star,
} from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui/Button";
import { CloseIconButton, IconButton } from "../ui/IconButton";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import type {
	AgentRuntimeState,
	AgentTab,
	AppInfo,
	AppSettings,
	ComposerAgentMode,
	AvailableModel,
	ChatMessage,
	CodexImportReport,
	CodexSessionSummary,
	ClaudeImportReport,
	ClaudeSessionSummary,
	OpenCodeImportReport,
	OpenCodeSessionSummary,
	FileTreeNode,
	GitBranchInfo,
	ImageContent,
	PetManifest,
	PiCliUpdateResult,
	PiCommand,
	PiInstallStatus,
	PiUpdateCheckResult,
	Project,
	SessionSummary,
} from "../../../../shared/types";
import { parseRichInputChips, type RichInputChip } from "./RichInput";
/** 复用 petdex 标准网格规格，在主设置面板里为宠物选择器渲染单格动画预览 */
import { GRID_COLS, CELL_W, CELL_H, MODE_ROW, MODE_FRAMES } from "../../pet/PetSpriteSheet";

export type DrawerPanel = "files" | "sessions";

export type SessionModifiedFile = {
	path: string;
	toolName: string;
	status: string;
	changedLines?: number;
	/** 工具执行前的文件原始内容，用于历史会话恢复时展示差异对比。 */
	originalContent?: string;
	/** 工具写入/编辑后的新文件内容，优先于从磁盘实时读取（历史会话恢复时磁盘可能已变化或文件已删除）。 */
	content?: string;
};

type DiffFileHandler = (path: string, originalContent?: string, content?: string) => void;

function countToolContentLines(value: unknown) {
	if (typeof value !== "string" || !value) return 0;
	return value.split(/\r\n|\r|\n/).length;
}

const FILE_PATH_KEYS = [
	"filePath",
	"file_path",
	"path",
	"targetPath",
	"target_path",
	"outputPath",
	"output_path",
	"file",
	"fileName",
	"filename",
] as const;

function getPathField(input: unknown) {
	if (!input) return undefined;
	// meta.args 可能被 AgentManager 序列化为 JSON 字符串（safeJson），需反解再查找路径字段。
	if (typeof input === "string" && input.trim()) {
		try { input = JSON.parse(input); } catch { return undefined; }
	}
	if (typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	for (const key of FILE_PATH_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function collectPathFields(input: unknown) {
	const paths = new Set<string>();
	const primary = getPathField(input);
	if (primary) paths.add(primary);
	const record = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
	const nestedLists = [record?.edits, record?.files, record?.paths, record?.items];
	for (const list of nestedLists) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (typeof item === "string" && item.trim()) paths.add(item);
			const nestedPath = getPathField(item);
			if (nestedPath) paths.add(nestedPath);
		}
	}
	return [...paths];
}

function editChangedLineCount(edit: any) {
	const oldLines = countToolContentLines(edit?.oldText ?? edit?.old_text);
	const newLines = countToolContentLines(edit?.newText ?? edit?.new_text);
	return Math.max(oldLines, newLines);
}

function getToolChangedLineCountForPath(toolName: string, args: any, path: string) {
	// meta.args 可能被 AgentManager 序列化为 JSON 字符串
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return 0; }
	}
	// 会话卡片只基于当前轮工具参数估算触达行数，不读取 Git 工作区，
	// 避免提交后工作区清空导致历史会话修改摘要消失。
	if (/edit|patch/i.test(toolName)) {
		const edits = Array.isArray(args?.edits) ? args.edits : undefined;
		if (edits) {
			const pathScopedEdits = edits.filter((edit: any) => {
				const editPath = getPathField(edit);
				return !editPath || editPath === path;
			});
			return pathScopedEdits.reduce(
				(total: number, edit: any) => total + editChangedLineCount(edit),
				0,
			);
		}
		return Math.max(
			countToolContentLines(args?.oldText ?? args?.old_text),
			countToolContentLines(args?.newText ?? args?.new_text),
		);
	}
	if (/write|create/i.test(toolName)) {
		return countToolContentLines(args?.content ?? args?.text ?? args?.data ?? args?.body);
	}
	return 0;
}

function isFileMutationTool(toolName: string) {
	return /write|edit|create|patch/i.test(toolName);
}

function mergeModifiedFiles(
	base: SessionModifiedFile[] | undefined,
	fallback: SessionModifiedFile[],
) {
	const byPath = new Map<string, SessionModifiedFile>();
	for (const file of fallback) byPath.set(file.path, file);
	// 固化摘要通常包含运行结束时的准确累计结果；放到后面覆盖兜底结果。
	for (const file of base ?? []) byPath.set(file.path, file);
	return Array.from(byPath.values());
}

function collectModifiedFilesFromToolMessages(messages: ChatMessage[]) {
	const byPath = new Map<string, SessionModifiedFile>();
	for (const message of messages) {
		// meta 不可用时降级到 message.toolName（部分会话 JSONL 行不携带 meta）
		const toolName = (message.meta?.toolName ?? (message as any).toolName) as string | undefined;
		if (typeof toolName !== "string" || !isFileMutationTool(toolName)) continue;
		const args = message.meta?.args;
		// 优先从 args 提取路径；arg 不可用时降级到 details._piDeckFilePath（pi-deck-file-capture 扩展记录）
		const filePaths = args ? collectPathFields(args) : [];
		if (filePaths.length === 0) {
			const detailsPath = (message as any).details?._piDeckFilePath as string | undefined;
			if (detailsPath) filePaths.push(detailsPath);
		}
		for (const filePath of filePaths) {
			const previous = byPath.get(filePath);
			if (previous) byPath.delete(filePath);
			byPath.set(filePath, {
				path: filePath,
				toolName,
				status: String(message.meta?.status ?? "done"),
				changedLines:
					(previous?.changedLines ?? 0) +
					getToolChangedLineCountForPath(toolName, args, filePath),
				originalContent:
					previous?.originalContent ??
					(message.meta?.originalContent as string | undefined) ??
					"",
			});
		}
	}
	return Array.from(byPath.values());
}

export function EnvironmentDialog(props: {
	status: PiInstallStatus | null;
	checking: boolean;
	onClose: () => void;
	onRecheck: () => void;
	onOpenInstallDocs: () => void;
	/** 用户手动输入的 pi 路径 */
	customPath: string;
	/** 正在校验自定义路径 */
	customPathValidating: boolean;
	/** 自定义路径校验结果 */
	customPathResult: PiInstallStatus | null;
	onCustomPathChange: (path: string) => void;
	onValidateCustomPath: () => void;
}) {
	const installed = props.status?.installed || props.customPathResult?.installed;
	const searchedDirs = props.status?.searchedDirs.slice(0, 16) ?? [];
	const errorText = props.status?.error ?? props.customPathResult?.error;
	const steps = [
		t("environment.stepCli"),
		t("environment.stepPath"),
		t("environment.stepPermission"),
		t("environment.stepDone"),
	];
	const activeStep = props.checking ? 0 : installed ? 3 : 1;

	// Windows 统一使用 CMD 查找 .cmd/.exe shim，不再引导用户使用 PowerShell 的 .ps1 入口。
	const refCmd = 'where pi';

	return (
		<div className="modal-backdrop environment-backdrop">
			<section className="environment-modal">
				<div className="modal-header">
					<strong>{t("environment.title")}</strong>
					<CloseIconButton
						label={t("common.close")}
						onClick={props.onClose}
					/>
				</div>

				<div className="environment-body">
					<div className="env-stepper" aria-label={t("environment.title")}>
						{steps.map((step, index) => (
							<div
								key={step}
								className={`env-step ${index < activeStep ? "done" : ""} ${index === activeStep ? "active" : ""}`}
							>
								<span>{index < activeStep ? "✓" : index + 1}</span>
								<b>{step}</b>
							</div>
						))}
					</div>

					{props.checking && (
						<div className="env-card env-loading-card">
							<div className="loader" />
							<span>{t("environment.checking")}</span>
						</div>
					)}

					{!props.checking && installed && (
						<div className="env-card env-success-card">
							<div className="env-success-icon">✓</div>
							<div className="env-success-info">
								<strong>{t("environment.passed")}</strong>
								<span>
									{t("environment.path")}：{(props.customPathResult || props.status)?.command}
								</span>
								{(props.customPathResult || props.status)?.version && (
									<span>
										{t("environment.version")}：{(props.customPathResult || props.status)!.version}
									</span>
								)}
								<small>{t("environment.autoClose")}</small>
							</div>
						</div>
					)}

					{!props.checking && !installed && (
						<>
							{/* 状态说明卡片 */}
							<div className="env-card env-status-card">
								<strong>{t("environment.notFoundTitle")}</strong>
								<small>{t("environment.notFoundDesc")}</small>
							</div>

							{/* 自动检测错误信息（如有） */}
							{errorText && (
								<div className="env-card env-error-card">
									<strong>{t("environment.errorDetails")}</strong>
									<pre className="env-error-pre">{errorText}</pre>
								</div>
							)}

							{/* 安装指引卡片 */}
							<div className="env-card env-guide-card">
								<strong>{t("environment.installTitle")}</strong>
								<small>{t("environment.installDesc")}</small>
								<button
									className="env-card-btn"
									onClick={props.onOpenInstallDocs}
								>
									{t("environment.openInstallDocs")}
								</button>
							</div>

							{/* 手动输入 pi 路径卡片 */}
							<div className="env-card env-custom-card">
								<strong>{t("environment.customPathTitle")}</strong>
								<small>{t("environment.customPathDesc")}</small>
								<div className="ref-commands">
									<div className="ref-command-item">
										<span className="ref-label">{t("environment.commandLabel")}</span>
										<code>{refCmd}</code>
									</div>

								</div>
								<div className="custom-path-input-row">
									<input
										type="text"
										placeholder="D:\\mise-data\\installs\\node\\24 13 0\\pi.cmd"
										value={props.customPath}
										onChange={(e) =>
											props.onCustomPathChange(e.target.value)
										}
										disabled={props.customPathValidating}
									/>
									<button
										className="env-card-btn primary"
										onClick={props.onValidateCustomPath}
										disabled={
											!props.customPath.trim() ||
											props.customPathValidating
										}
									>
										{props.customPathValidating
											? t("environment.validatingPath")
											: t("environment.validatePath")}
									</button>
								</div>
								{props.customPathResult && (
									<div
										className={`custom-path-result ${props.customPathResult.installed ? "success" : "error"}`}
									>
										{props.customPathResult.installed
											? `✓ ${t("environment.validatePassed", { value: props.customPathResult.version ?? "pi" })}`
											: `✗ ${t("environment.validateFailed", { value: props.customPathResult.error ?? t("environment.unableToRun") })}`}
									</div>
								)}
							</div>

							{/* 检测路径卡片 */}
							{searchedDirs.length > 0 && (
								<div className="env-card env-dirs-card">
									<strong>{t("environment.searchedDirs")}</strong>
									<small>{t("environment.searchedDirsDesc")}</small>
									<ul className="env-dirs-list">
										{searchedDirs.map((dir) => (
											<li key={dir}>{dir}</li>
										))}
									</ul>
								</div>
							)}
						</>
					)}
				</div>

				<div className="environment-footer">
					<button
						onClick={props.onRecheck}
						disabled={props.checking || props.customPathValidating}
					>
						{t("environment.recheck")}
					</button>
				</div>
			</section>
		</div>
	);
}

export function SessionStatus(props: {
	state?: AgentRuntimeState;
	duration?: number;
}) {
	if (!props.state) return null;
	return (
		<div className="session-status">
			<span className="model-chip">
				{props.state.provider ? `${props.state.provider}/` : ""}{props.state.modelName ?? props.state.modelId ?? "model"}
			</span>
			<span className="think-chip">{t("app.think")}: {props.state.thinkingLevel ?? "-"}</span>
			{props.state.contextPercent != null && (
				<span className="ctx-chip">
					{t("app.ctx")}:{" "}
					{props.state.contextPercent?.toFixed?.(1) ??
						props.state.contextPercent}
					% / {formatCompact(props.state.contextWindow)}
				</span>
			)}
			{props.state.inputTokens != null && (
				<span className="token-chip token-input">
					↑ {formatCompact(props.state.inputTokens)}
				</span>
			)}
			{props.state.outputTokens != null && (
				<span className="token-chip token-output">
					↓ {formatCompact(props.state.outputTokens)}
				</span>
			)}
			{props.state.cacheHitPercent != null && (
				<span className="cache-chip">
					{t("app.cacheHit")}: {props.state.cacheHitPercent?.toFixed?.(0) ?? props.state.cacheHitPercent}%
				</span>
			)}
			{props.state.cacheTotal != null && (
				<span className="cache-chip cache-total">{t("app.cache")}: {formatCompact(props.state.cacheTotal)}</span>
			)}
		</div>
	);
}

export function ComposerToolbar(props: {
	state?: AgentRuntimeState;
	compacting: boolean;
	disabled?: boolean;
	onCycleModel: () => void;
	onPickModel: () => void;
	onPickThinking: () => void;
	onCompact: () => void;
	/** 当前发送模式，用于按钮文字和轻高亮 */
	composerAgentMode?: ComposerAgentMode;
	onOpenComposerModePicker?: () => void;
	/** 取消计划模式：直接切回普通发送模式，不经过模式选择器 */
	onCancelPlan?: () => void;
	/** 在思考按钮后插入的额外指示器（如飞书链接状态） */
	feishuIndicator?: ReactNode;

}) {
	const ctxPercent = props.state?.contextPercent;
	const showCompact = ctxPercent != null && ctxPercent > 30;
	// 根据当前 thinkingLevel 查找对应的多语言标签
	const currentThinkingLevel = props.state?.thinkingLevel;
	const thinkingLevelLabel = currentThinkingLevel
		? THINKING_LEVELS.find((level) => level.value === currentThinkingLevel)?.labelKey
		: undefined;
	const thinkingDisplay = thinkingLevelLabel ? t(thinkingLevelLabel) : "-";

	// mode 选择器：和模型/思考面板保持一致，默认普通。
	const activeMode = props.composerAgentMode ?? "normal";
	const activeModeLabel = activeMode === "plan" ? t("app.composerModePlan") : t("app.composerModeNormal");

	return (
		<div className="composer-toolbar">
			{props.onOpenComposerModePicker && (
				<button
					className={activeMode === "plan" ? "composer-mode-active" : ""}
					disabled={props.disabled}
					onClick={props.onOpenComposerModePicker}
					title={t("app.composerModeTitle")}
				>
					{activeModeLabel}
				</button>
			)}
			{activeMode === "plan" && props.onCancelPlan && (
				<button
					className="composer-mode-cancel"
					disabled={props.disabled}
					onClick={props.onCancelPlan}
					title={t("app.composerModeCancelPlan")}
				>
					<X size={14} strokeWidth={2.5} aria-hidden="true" />
					{t("app.composerModeCancelPlan")}
				</button>
			)}
			<button onClick={props.onPickModel} disabled={props.disabled}>
				{t("app.model")}: {props.state?.provider ? `${props.state.provider}/` : ""}{props.state?.modelName ?? "-"}
			</button>
			<button onClick={props.onCycleModel} disabled={props.disabled}>
				{t("app.cycleModel")}
			</button>
			<button onClick={props.onPickThinking} disabled={props.disabled}>
				{t("app.think")}: {thinkingDisplay}
			</button>
			{props.feishuIndicator}

			{showCompact && (
				<button
					className={
						props.state?.isCompacting || props.compacting ? "compacting" : ""
					}
					disabled={
						props.state?.isCompacting ||
						props.compacting ||
						!!props.state?.isStreaming
					}
					title={t("app.contextCompactTitle", {
						percent: ctxPercent.toFixed(1),
					})}
					onClick={props.onCompact}
				>
					{props.state?.isCompacting || props.compacting
						? t("app.compacting")
						: `${t("app.compact")} ${ctxPercent.toFixed(0)}%`}
				</button>
			)}
		</div>
	);
}

export function ModelPicker(props: {
	models: AvailableModel[];
	current?: { provider?: string; modelId?: string; modelName?: string };
	onClose: () => void;
	onPick: (model: AvailableModel) => void;
	/** 收藏的模型 ID 列表（格式：provider/modelId），收藏的模型独立置顶显示但仍保留在原供应商分组 */
	favoriteModels: string[];
	/** 切换收藏状态 */
	onToggleFavorite: (provider: string, modelId: string) => void;
}) {
	const [modelPickerSearch, setModelPickerSearch] = useState("");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
	const normalizedSearch = modelPickerSearch.trim().toLowerCase();
	const currentModelKey = props.current?.provider && props.current?.modelId
		? `${props.current.provider}/${props.current.modelId}`
		: undefined;
	const favoritesSet = new Set(props.favoriteModels ?? []);

	// 搜索同时覆盖模型展示名、模型 id 和 provider,避免用户只记得任一字段时找不到模型。
	const filteredModels = normalizedSearch
		? props.models.filter((model) =>
				[
					model.name,
					model.id,
					model.provider,
					`${model.provider}/${model.id}`,
				]
					.filter(Boolean)
					.some((value) =>
						String(value).toLowerCase().includes(normalizedSearch),
					),
			)
		: props.models;

	// 收藏列表（从全部模型中提取，不移除原供应商分组下的显示）
	const favorites: AvailableModel[] = filteredModels.filter((model) =>
		favoritesSet.has(`${model.provider}/${model.id}`),
	);
	favorites.sort((a, b) => {
		const ap = a.provider ?? '';
		const bp = b.provider ?? '';
		if (ap !== bp) return ap.localeCompare(bp);
		return (a.name ?? a.id).localeCompare(b.name ?? b.id);
	});

	// 全量模型按供应商分组（收藏模型也保留在原分组）
	const groupedModels = filteredModels.reduce<Record<string, AvailableModel[]>>((groups, model) => {
		const provider = model.provider || 'other';
		if (!groups[provider]) {
			groups[provider] = [];
		}
		groups[provider].push(model);
		return groups;
	}, {});
	// 每个分组按展示名排序
	for (const provider of Object.keys(groupedModels)) {
		groupedModels[provider].sort((a, b) =>
			(a.name ?? a.id).localeCompare(b.name ?? b.id),
		);
	}

	// 供应商排序：常见的放前面
	const providerOrder = ['anthropic', 'openai', 'google', 'deepseek', 'other'];
	const sortedProviders = Object.keys(groupedModels).sort((a, b) => {
		const aIndex = providerOrder.indexOf(a);
		const bIndex = providerOrder.indexOf(b);
		if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
		if (aIndex !== -1) return -1;
		if (bIndex !== -1) return 1;
		return a.localeCompare(b);
	});

	const renderModelRow = (model: AvailableModel) => {
		const modelKey = `${model.provider}/${model.id}`;
		const selected = modelKey === currentModelKey;
		const favorited = favoritesSet.has(modelKey);
		return (
			<button
				key={modelKey}
				className={`picker-palette-item${selected ? " selected" : ""}`}
				onClick={() => props.onPick(model)}
			>
				{/* 收藏/取消收藏按钮：填充星为收藏，空心为未收藏 */}
				<span
					className={`model-favorite-star${favorited ? ' favorited' : ''}`}
					title={favorited ? t("app.modelUnfavorite") : t("app.modelFavorite")}
					onClick={(e) => {
						e.stopPropagation();
						props.onToggleFavorite(model.provider, model.id);
					}}
				>
					<Star size={14} strokeWidth={1.8} fill={favorited ? 'currentColor' : 'none'} />
				</span>
				<span className="picker-palette-label">{model.name ?? model.id}</span>
				<span className="picker-palette-desc">
					{model.provider}/{model.id}
				</span>
				{selected && <span className="picker-palette-check">✓</span>}
			</button>
		);
	};

	return (
		<div className="picker-backdrop" onClick={props.onClose}>
			<div
				className="picker-palette model-picker"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="picker-palette-header">
					<span>{t("app.modelPickerTitle")}</span>
					<IconButton
						className="picker-palette-close"
						label={t("common.close")}
						onClick={props.onClose}
					>
						<X size={16} strokeWidth={2.2} aria-hidden="true" />
					</IconButton>
				</div>
				<div className="picker-palette-search">
					<input
						autoFocus
						value={modelPickerSearch}
						onChange={(event) => setModelPickerSearch(event.target.value)}
						placeholder={t("app.modelPickerSearch")}
					/>
				</div>
				<div className="picker-palette-list">
					{/* 收藏分区：置于最顶部，可折叠 */}
					{favorites.length > 0 && (
						<div className="model-group model-favorites-group">
							<div
								className={`model-group-header${collapsedGroups.has('__favorites__') ? ' collapsed' : ''}`}
								onClick={() => {
									setCollapsedGroups(prev => {
										const next = new Set(prev);
										if (next.has('__favorites__')) next.delete('__favorites__');
										else next.add('__favorites__');
										return next;
									});
								}}
							>
								<span className={`model-favorites-arrow${collapsedGroups.has('__favorites__') ? ' collapsed' : ''}`}>
									<Star size={14} strokeWidth={1.8} fill='currentColor' />
								</span>
								{t("app.modelFavorites")}
								<span className="model-group-count">{favorites.length}</span>
							</div>
							{!collapsedGroups.has('__favorites__') && favorites.map(renderModelRow)}
						</div>
					)}
					{/* 其余模型按供应商分组 */}
					{sortedProviders.map((provider) => (
						<div key={provider} className="model-group">
							<div
								className={`model-group-header${collapsedGroups.has(provider) ? ' collapsed' : ''}`}
								onClick={() => {
									setCollapsedGroups(prev => {
										const next = new Set(prev);
										if (next.has(provider)) next.delete(provider);
										else next.add(provider);
										return next;
									});
								}}
							>
								{provider}
								<span className="model-group-count">{groupedModels[provider].length}</span>
							</div>
							{!collapsedGroups.has(provider) && groupedModels[provider].map(renderModelRow)}
						</div>
					))}
					{favorites.length === 0 && sortedProviders.length === 0 && (
						<div className="picker-palette-empty">{t("app.modelPickerEmpty")}</div>
					)}
				</div>
			</div>
		</div>
	);
}

const THINKING_LEVELS = [
	{ value: "off", labelKey: "thinking.levelLabel.off", descriptionKey: "thinking.level.off" },
	// minimal 是 pi/Codex reasoning 的最轻量档位,放在 Off 与 Low 之间便于按强度递增选择。
	{ value: "minimal", labelKey: "thinking.levelLabel.minimal", descriptionKey: "thinking.level.minimal" },
	{ value: "low", labelKey: "thinking.levelLabel.low", descriptionKey: "thinking.level.low" },
	{ value: "medium", labelKey: "thinking.levelLabel.medium", descriptionKey: "thinking.level.medium" },
	{ value: "high", labelKey: "thinking.levelLabel.high", descriptionKey: "thinking.level.high" },
	// xhigh 只在部分模型上可用;选择后以前端收到的 runtime state 为准,必要时提示用户已被回退。
	{ value: "xhigh", labelKey: "thinking.levelLabel.xhigh", descriptionKey: "thinking.level.xhigh" },
] satisfies Array<{ value: string; labelKey: TranslationKey; descriptionKey: TranslationKey }>;

export function ComposerModePicker(props: {
	currentMode: ComposerAgentMode;
	onClose: () => void;
	onPick: (mode: ComposerAgentMode) => void;
}) {
	const items = [
		{
			value: "normal" as const,
			labelKey: "app.composerModeNormal" as const,
			descriptionKey: "app.composerModeNormalDesc" as const,
		},
		{
			value: "plan" as const,
			labelKey: "app.composerModePlan" as const,
			descriptionKey: "app.composerModePlanDesc" as const,
		},
	];

	return (
		<div className="picker-backdrop" onClick={props.onClose}>
			<div
				className="picker-palette composer-mode-picker"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="picker-palette-header">
					<div className="thinking-picker-header-content">
						<span>{t("app.composerModeTitle")}</span>
					</div>
					<IconButton
						className="picker-palette-close"
						label={t("common.close")}
						onClick={props.onClose}
					>
						<X size={16} strokeWidth={2.2} aria-hidden="true" />
					</IconButton>
				</div>
				<div className="picker-palette-list">
					{items.map((item) => {
						const selected = item.value === props.currentMode;
						return (
							<button
								key={item.value}
								className={`picker-palette-item${selected ? " selected" : ""}`}
								onClick={() => props.onPick(item.value)}
							>
								<span className="picker-palette-label">{t(item.labelKey)}</span>
								<span className="picker-palette-desc">{t(item.descriptionKey)}</span>
								{selected && <span className="picker-palette-check">✓</span>}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}

export function ThinkingPicker(props: {
	current?: string;
	onClose: () => void;
	onPick: (level: string) => void;
}) {
	return (
		<div className="picker-backdrop" onClick={props.onClose}>
			<div
				className="picker-palette thinking-picker"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="picker-palette-header">
					<div className="thinking-picker-header-content">
						<span>{t("app.thinkingPickerTitle")}</span>
						<small className="thinking-picker-hint">
							{t("app.thinkingPickerHint")}
						</small>
					</div>
					<IconButton
						className="picker-palette-close"
						label={t("common.close")}
						onClick={props.onClose}
					>
						<X size={16} strokeWidth={2.2} aria-hidden="true" />
					</IconButton>
				</div>
				<div className="picker-palette-list">
					{THINKING_LEVELS.map((level) => {
						const selected = level.value === props.current;
						return (
							<button
								key={level.value}
								className={`picker-palette-item${selected ? " selected" : ""}`}
								onClick={() => props.onPick(level.value)}
							>
								<span className="picker-palette-label">{t(level.labelKey)}</span>
								<span className="picker-palette-desc">{t(level.descriptionKey)}</span>
								{selected && <span className="picker-palette-check">✓</span>}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}

function formatCompact(value?: number | null) {
	if (value == null) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}

export function BranchSelector(props: {
	gitInfo: GitBranchInfo;
	switchingBranch?: string | null;
	onSwitch: (branch: string) => void;
	onCreateBranch: (branchName: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [creatingBranch, setCreatingBranch] = useState(false);
	const [newBranchName, setNewBranchName] = useState("");
	const ref = useRef<HTMLDivElement>(null);

	// 点击外部区域自动关闭下拉
	useEffect(() => {
		if (!open) return;
		const handler = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) {
				setOpen(false);
				setCreatingBranch(false);
				setNewBranchName("");
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	const current = props.gitInfo.current ?? "";
	const branches = props.gitInfo.branches;

	// 无分支信息时不渲染
	if (!current && branches.length === 0) return null;

	const handleCreateBranch = () => {
		const trimmed = newBranchName.trim();
		if (!trimmed) return;
		props.onCreateBranch(trimmed);
		setOpen(false);
		setCreatingBranch(false);
		setNewBranchName("");
	};

	return (
		<div className="branch-select" ref={ref}>
			<button
				className="branch-trigger"
				disabled={Boolean(props.switchingBranch)}
				onClick={() => setOpen((v) => !v)}
				title={t("app.branchCurrent", {
					branch: current,
					count: branches.length,
				})}
			>
				<span className="branch-icon">
					<GitBranch size={14} />
				</span>
				<span className="branch-label" title={current}>
					{current || "detached"}
				</span>
				<span className="branch-badge">{branches.length}</span>
				<span className={`branch-chevron${open ? " open" : ""}`}>
					<ChevronDown size={12} />
				</span>
			</button>
			{open && (
				<div className="branch-dropdown">
					{branches.length <= 1 && (
						<div className="branch-empty-hint">{t("app.branchOnlyOne")}</div>
					)}
					{branches.map((branch) => {
						const switching = props.switchingBranch === branch;
						return (
						<button
							key={branch}
							className={branch === current ? "active" : ""}
							disabled={Boolean(props.switchingBranch)}
							onClick={() => {
								if (branch !== current) props.onSwitch(branch);
								setOpen(false);
							}}
						>
							<span className="branch-item-icon">
								{branch === current ? (
									<Check size={14} className="branch-check" />
								) : (
									<GitBranch size={14} />
								)}
							</span>
							<span className="branch-item-label" title={branch}>
								{switching ? t("app.branchSwitching") : branch}
							</span>
						</button>
					);
					})}
					{creatingBranch ? (
						<div className="branch-create-form">
							<input
								type="text"
								placeholder={t("app.branchNewPlaceholder")}
								value={newBranchName}
								onChange={(e) => setNewBranchName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleCreateBranch();
									if (e.key === "Escape") {
										setCreatingBranch(false);
										setNewBranchName("");
									}
								}}
								autoFocus
							/>
							<button
								className="branch-create-confirm"
								disabled={!newBranchName.trim()}
								onClick={handleCreateBranch}
							>
								<Check size={14} />
							</button>
						</div>
					) : (
						<button
							className="branch-create-trigger"
							onClick={() => setCreatingBranch(true)}
						>
							<Plus size={14} />
							<span>{t("app.branchCreate")}</span>
						</button>
					)}
				</div>
			)}
		</div>
	);
}

export function LogoMark() {
	return (
		<div className="logo-mark" aria-label={t("app.logoLabel")}>
			<svg viewBox="140 140 520 520" width="22" height="22" aria-hidden="true">
				<path
					fill="#fff"
					fillRule="evenodd"
					d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
				/>
				<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
			</svg>
		</div>
	);
}

export function ProjectAvatar(props: { name: string; kind?: "chat" | "project" }) {
	return (
		<div
			className={`conversation-avatar project-avatar${props.kind === "chat" ? " chat-avatar" : ""}`}
			title={t("app.projectAvatarTitle", { name: props.name })}
		>
			{props.kind === "chat" ? (
				<MessageCircle size={16} strokeWidth={1.9} />
			) : (
				<Folder size={16} strokeWidth={1.8} />
			)}
		</div>
	);
}

export function AgentAvatar(props: { status: string }) {
	return (
		<div className={`conversation-avatar agent-avatar ${props.status}`}>
			<svg viewBox="140 140 520 520" width="28" height="28" aria-hidden="true">
				<path
					fill="#fff"
					fillRule="evenodd"
					d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
				/>
				<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
			</svg>
		</div>
	);
}

export function matches(value: string, keyword: string) {
	return (
		!keyword.trim() ||
		value.toLowerCase().includes(keyword.trim().toLowerCase())
	);
}

export function displayPath(path?: string) {
	if (!path) return "";
	const home = getHomePathPrefix();
	const normalized = path.replace(/\\/g, "/");
	const friendly =
		home && normalized.toLowerCase().startsWith(home.toLowerCase())
			? `~${normalized.slice(home.length)}`
			: normalized;
	return friendly.length > 36 ? `...${friendly.slice(-35)}` : friendly;
}

function getHomePathPrefix() {
	// 浏览器侧无法直接读取 OS home;从常见 Windows 用户路径中提取到 /Users/name,其他路径保持原样。
	const match = location.href.match(/file:\/\/\/([A-Za-z]:\/Users\/[^/]+)/i);
	return match?.[1] ?? "C:/Users/14012";
}

export function EmptyState(props: { hasProject: boolean; onCreate: () => void }) {
	return (
		<div className="empty-state">
			<div className="empty-logo">
				<svg
					viewBox="140 140 520 520"
					width="40"
					height="40"
					aria-hidden="true"
				>
					<path
						fill="#fff"
						fillRule="evenodd"
						d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
					/>
					<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
				</svg>
			</div>
			<h2>{t("app.startAgent")}</h2>
			<p>{t("app.emptyGuide")}</p>
			{props.hasProject ? (
				<button onClick={props.onCreate}>{t("app.createAgent")}</button>
			) : (
				<p className="empty-hint">{t("app.emptyNoProject")}</p>
			)}
		</div>
	);
}

export type ToolGroupItem = {
	kind: "tool-group";
	id: string;
	messages: ChatMessage[];
};

export type MessageItem = { kind: "message"; message: ChatMessage };

export type ThinkingGroupItem = {
	kind: "thinking-group";
	id: string;
	messages: ChatMessage[];
	text: string;
	startedAt: number;
	endedAt: number;
};

export type AgentRunItem = {
	kind: "agent-run";
	id: string;
	items: Array<MessageItem | ToolGroupItem | ThinkingGroupItem>;
	startedAt: number;
	endedAt: number;
};

export type RenderMessage = MessageItem | ToolGroupItem | ThinkingGroupItem | AgentRunItem;

async function copyElementAsPng(element: HTMLElement) {
	// 截图复制依赖浏览器 ClipboardItem PNG 支持；失败时由调用方提示/回退，不影响文本复制。
	const dataUrl = await toPng(element, {
		cacheBust: true,
		pixelRatio: Math.min(2, window.devicePixelRatio || 1),
		backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || undefined,
		filter: (node) =>
			!(node instanceof HTMLElement) ||
			(!node.classList.contains("turn-row-actions") &&
				!node.classList.contains("user-turn-actions") &&
				!node.classList.contains("copy-menu-popover")),
	});
	const blob = await (await fetch(dataUrl)).blob();
	await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

function CopyMenu(props: {
	text: string;
	markdown: string;
	targetRef: React.RefObject<HTMLElement | null>;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const closeTimerRef = useRef<number | null>(null);
	const clearCloseTimer = () => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	};
	const scheduleClose = () => {
		// 操作栏由 hover/focus 控制显隐；离开后主动收起菜单，避免下次 hover 时复用旧 open 状态。
		clearCloseTimer();
		closeTimerRef.current = window.setTimeout(() => {
			setOpen(false);
			closeTimerRef.current = null;
		}, 180);
	};
	useEffect(() => clearCloseTimer, []);
	const copy = async (kind: "text" | "markdown" | "image") => {
		try {
			if (kind === "text") await navigator.clipboard.writeText(props.text);
			if (kind === "markdown") await navigator.clipboard.writeText(props.markdown);
			if (kind === "image" && props.targetRef.current) await copyElementAsPng(props.targetRef.current);
			setCopied(kind);
			setOpen(false);
			window.setTimeout(() => setCopied(null), 1800);
		} catch {
			setCopied(null);
		}
	};
	const toggleOpen = () => {
		clearCloseTimer();
		const rect = triggerRef.current?.getBoundingClientRect();
		if (rect) {
			setMenuStyle({
				position: "fixed",
				top: rect.bottom + 4,
				left: Math.min(window.innerWidth - 156, Math.max(8, rect.right - 148)),
			});
		}
		setOpen((value) => !value);
	};
	return (
		<div
			className={`copy-menu ${props.className ?? ""}`}
			onPointerEnter={clearCloseTimer}
			onPointerLeave={scheduleClose}
		>
			<button
				ref={triggerRef}
				className="copy-menu-trigger"
				type="button"
				onClick={toggleOpen}
				aria-expanded={open}
			>
				{copied ? `${t("common.copy")} ✓` : t("common.copy")}
			</button>
			{open && (
				<div className="copy-menu-popover" style={menuStyle}>
					<button type="button" onClick={() => void copy("text")}>{t("copy.asText")}</button>
					<button type="button" onClick={() => void copy("markdown")}>{t("copy.asMarkdown")}</button>
					<button type="button" onClick={() => void copy("image")}>{t("copy.asImage")}</button>
				</div>
			)}
		</div>
	);
}

export function groupToolMessages(messages: ChatMessage[]): RenderMessage[] {
	const result: RenderMessage[] = [];
	let currentTools: ChatMessage[] = [];
	let currentThinking: ChatMessage[] = [];
	let currentRun: Array<MessageItem | ToolGroupItem | ThinkingGroupItem> = [];
	let runStartedAt = 0;
	let runEndedAt = 0;

	function isThinkingOnly(message: ChatMessage) {
		return (
			message.role === "assistant" &&
			Boolean(message.thinking?.trim()) &&
			!stripThinkingTags(stripAnsi(message.text)).trim()
		);
	}

	function flushThinking() {
		if (currentThinking.length === 0) return;
		const previous = currentRun[currentRun.length - 1];
		const nextGroup: ThinkingGroupItem = {
			kind: "thinking-group",
			id: currentThinking.map((message) => message.id).join("|"),
			messages: currentThinking,
			text: currentThinking
				.map((message) => stripAnsi(message.thinking ?? ""))
				.filter(Boolean)
				.join("\n\n"),
			startedAt: currentThinking[0]?.timestamp ?? runStartedAt,
			endedAt:
				currentThinking[currentThinking.length - 1]?.timestamp ?? runEndedAt,
		};
		if (previous?.kind === "thinking-group") {
			// 历史会话可能把多段纯 thinking 拆成多条 assistant 消息；如果展示层上已经相邻，
			// 继续合并成一个折叠块，避免一轮回答里出现一串重复“思考过程”卡片。
			previous.id = `${previous.id}|${nextGroup.id}`;
			previous.messages = [...previous.messages, ...nextGroup.messages];
			previous.text = [previous.text, nextGroup.text].filter(Boolean).join("\n\n");
			previous.endedAt = nextGroup.endedAt;
		} else {
			currentRun.push(nextGroup);
		}
		runEndedAt = nextGroup.endedAt;
		currentThinking = [];
	}

	function flushTools() {
		if (currentTools.length === 0) return;
		flushThinking();
		// 同一轮问答里的连续 tool 消息聚合显示,减少工具调用刷屏;详情仍保留在每条 tool 的 meta 里可展开查看。
		const group: ToolGroupItem = {
			kind: "tool-group",
			id: currentTools.map((message) => message.id).join("|"),
			messages: currentTools,
		};
		currentRun.push(group);
		runEndedAt = currentTools[currentTools.length - 1]?.timestamp ?? runEndedAt;
		currentTools = [];
	}

	function flushRun() {
		flushTools();
		flushThinking();
		if (currentRun.length === 0) return;

		// 合并连续的 assistant 文本消息，避免同一轮回答被拆成多个气泡
		const merged: Array<MessageItem | ToolGroupItem | ThinkingGroupItem> = [];
		for (const item of currentRun) {
			const prev = merged[merged.length - 1];
			if (
				item.kind === "message" &&
				item.message.role === "assistant" &&
				prev?.kind === "message" &&
				prev.message.role === "assistant"
			) {
				prev.message = {
					...prev.message,
					text: prev.message.text + "\n\n" + item.message.text,
					thinking: (prev.message.thinking || "") + (item.message.thinking ? "\n\n" + item.message.thinking : ""),
					id: prev.message.id + "|" + item.message.id,
				};
			} else {
				merged.push(item);
			}
		}

		result.push({
			kind: "agent-run",
			id: merged
				.map((item) => (item.kind === "message" ? item.message.id : item.id))
				.join("|"),
			items: merged,
			startedAt: runStartedAt,
			endedAt: runEndedAt || runStartedAt,
		});
		currentRun = [];
		runStartedAt = 0;
		runEndedAt = 0;
	}

	function appendRunMessage(message: ChatMessage) {
		flushThinking();
		flushTools();
		if (currentRun.length === 0) runStartedAt = message.timestamp;
		runEndedAt = message.timestamp;
		currentRun.push({ kind: "message", message });
	}

	for (const message of messages) {
		if (isThinkingOnly(message)) {
			flushTools();
			if (currentRun.length === 0 && currentThinking.length === 0) {
				runStartedAt = message.timestamp;
			}
			currentThinking.push(message);
			runEndedAt = message.timestamp;
		} else if (message.role === "assistant") {
			appendRunMessage(message);
		} else if (message.role === "tool") {
			flushThinking();
			if (currentRun.length === 0) runStartedAt = message.timestamp;
			currentTools.push(message);
		} else {
			flushRun();
			result.push({ kind: "message", message });
		}
	}
	flushRun();
	return result;
}

// ============================================================
// 会话时间线渲染组件（借鉴 opencode 扁平 timeline 风格重写）
// 设计要点：
// - 助手内容去掉气泡，改为左对齐扁平排版，用左侧竖线聚合一轮对话
// - 工具调用做成独立可折叠卡片，trigger 行 + 展开内容，内联在 timeline 里
// - 用户消息保留右对齐气泡，但收窄并去掉头像，操作栏 hover 显隐
// - 思考过程做成轻量折叠卡片，不再占用大块气泡空间
// ============================================================

/** 按工具名选择语义图标：read→文件、edit→铅笔、bash→终端、grep→搜索等，未匹配回退扳手。 */
function toolIcon(toolName: string): ReactNode {
	const key = toolName.toLowerCase();
	if (key.includes("read") || key.includes("view")) return <FileText size={14} />;
	if (key.includes("write") || key.includes("edit") || key.includes("apply_patch") || key.includes("patch"))
		return <Pencil size={14} />;
	if (key.includes("bash") || key.includes("shell") || key.includes("terminal")) return <Terminal size={14} />;
	if (key.includes("grep") || key.includes("search")) return <Search size={14} />;
	if (key.includes("glob") || key.includes("list") || key.includes("ls")) return <Folder size={14} />;
	if (key.includes("task") || key.includes("subagent") || key.includes("agent")) return <Network size={14} />;
	if (key.includes("web") || key.includes("fetch")) return <Globe2 size={14} />;
	if (key.includes("todo")) return <Check size={14} />;
	return <Wrench size={14} />;
}

function parseToolArgs(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		let parsed = JSON.parse(value) as unknown;
		// 兼容已二次 JSON.stringify 的异常数据（meta 中存储的 args 字符串被 safeJson 再包一层）
		if (typeof parsed === "string" && parsed.trim()) {
			try {
				parsed = JSON.parse(parsed) as unknown;
			} catch {
				return undefined;
			}
		}
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

/** 从工具消息 meta 中提取副标题（文件路径或命令），让 trigger 行能体现工具作用对象。
 *  pi 的工具参数可能是对象，也可能已被主进程截断/序列化为 JSON 字符串；两种格式都要兼容，否则 bash 命令摘要会丢失。 */
function getToolSubtitle(message: ChatMessage): string {
	const meta = message.meta;
	if (!meta) return "";
	// 优先从 args 取参数（pi 工具事件的标准结构）
	const args = parseToolArgs(meta.args);
	if (args) {
		for (const key of [
			// 文件操作类
			"filePath", "file_path", "path", "file",
			// bash/shell 命令
			"command",
			// 搜索/查询类（grep、web_search 等）
			"pattern", "query", "queries",
			// 网络获取类（fetch_content 等）
			"url", "urls",
		]) {
			const v = args[key];
			if (typeof v === "string" && v) return v;
			// queries 和 urls 是数组，取第一条
			if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
		}
	}
	// 兼容历史平铺写法
	const path = meta.path;
	if (typeof path === "string" && path) return path;
	const command = meta.command;
	if (typeof command === "string" && command) return command;
	const file = meta.file;
	if (typeof file === "string" && file) return file;
	return "";
}

/**
 * 识别模型主动触发的 skill：pi 系统提示会指示 LLM 用 read 工具读取 SKILL.md 来加载 skill，
 * 所以 toolName==="read" 且 path 以 SKILL.md 结尾时，视为 skill 调用，返回 skill 名（父目录名）。
 * 这是模型侧的 skill 触发，与用户侧 /skill:name 展开成 <skill> 块不同。
 */
function getReadSkillName(message: ChatMessage): string | undefined {
	const meta = message.meta;
	if (!meta) return;
	const toolName = typeof meta.toolName === "string" ? meta.toolName : "";
	if (toolName.toLowerCase() !== "read") return;
	const args = meta.args as Record<string, unknown> | undefined;
	if (!args || typeof args !== "object") return;
	const rawPath = String(args.path ?? args.filePath ?? args.file_path ?? "");
	if (!rawPath) return;
	// 取最后一段文件名与父目录名，跨平台分隔符兼容
	const segs = rawPath.split(/[\\/]/).filter(Boolean);
	const fileName = segs[segs.length - 1] ?? "";
	if (fileName.toUpperCase() !== "SKILL.MD") return;
	return segs[segs.length - 2] ?? fileName;
}

/** 计算工具的语气色：running 黄、error 红、非零退出 warning、其余 ok。 */
function getToolTone(message: ChatMessage): "running" | "error" | "warning" | "ok" {
	const status = getToolStatus(message);
	const exitCode = getToolExitCode(message);
	if (status === "running") return "running";
	if (status === "error" || message.meta?.isError === true) return "error";
	if (typeof exitCode === "number" && exitCode !== 0) return "warning";
	return "ok";
}

/** pi 内置工具名集合，用于与 MCP / 扩展工具区分。 */
const BUILT_IN_TOOLS = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);

/**
 * 扩展工具中带下划线的名称，会被 MCP-direct 正则误匹配为形如 {server}_{tool}。
 * 在此登记后 getToolKind 将其归为 "extension" 而非 "mcp-direct"。
 */
const NON_MCP_TOOLS = new Set(["ask_question"]);

/**
 * 识别工具来源类型：
 * - mcp-proxy：toolName 为 mcp（pi-mcp-adapter 代理模式，LLM 通过单一 mcp 工具调用具体 server/tool）
 * - mcp-direct：toolName 形如 {server}_{tool} 且非内置/非扩展工具（directTools 模式，server 名去掉 -mcp 后缀）
 * - builtin：pi 内置工具（bash/edit/find/grep/ls/read/write）
 * - extension：扩展工具或自定义命名的其他工具
 */
function getToolKind(toolName: string): "mcp-proxy" | "mcp-direct" | "builtin" | "extension" {
	const key = toolName.toLowerCase();
	if (key === "mcp") return "mcp-proxy";
	if (BUILT_IN_TOOLS.has(key)) return "builtin";
	// directTools 模式：server_tool，server 名通常含字母/连字符，tool 名也是标识符
	if (/^[a-z][a-z0-9-]*_[a-z][a-z0-9_-]*$/i.test(toolName)) {
		// 已知扩展工具名含下划线但不是 MCP 直连 → 归为 extension
		if (NON_MCP_TOOLS.has(key)) return "extension";
		return "mcp-direct";
	}
	return "extension";
}

/** 从 MCP direct 工具名中拆出 server 名（chrome_devtools_navigate → chrome）。 */
function getMcpServerName(toolName: string): string {
	const idx = toolName.indexOf("_");
	return idx > 0 ? toolName.slice(0, idx) : toolName;
}

/** 给工具返回展示标签：MCP 代理/直连/内置/扩展，用于 ToolCard trigger 的 kind 徽标。 */
function getToolKindLabel(toolName: string): string {
	const kind = getToolKind(toolName);
	if (kind === "mcp-proxy") return "MCP";
	if (kind === "mcp-direct") return `MCP·${getMcpServerName(toolName)}`;
	return "";
}

/** 单个工具调用卡片：trigger 行（图标+工具名+副标题+状态+耗时）+ 展开后详情。 */
export const ToolCard = memo(function ToolCard(props: {
	message: ChatMessage;
	defaultOpen?: boolean;
}) {
	const [expanded, setExpanded] = useState(props.defaultOpen ?? false);
	const status = getToolStatus(props.message);
	const toolName = getToolName(props.message);
	const detailText = getToolDetailText(props.message);
	const tone = getToolTone(props.message);
	const subtitle = getToolSubtitle(props.message);
	const kindLabel = getToolKindLabel(toolName);
	const durationMs =
		typeof props.message.meta?.durationMs === "number"
			? props.message.meta.durationMs
			: undefined;
	const showDuration = status !== "running" && durationMs !== undefined;
	// 模型用 read 工具读取 SKILL.md 来加载 skill：识别后以 skill 徽标样式渲染
	const skillName = getReadSkillName(props.message);
	const isSkillRead = Boolean(skillName);
	// 历史会话中从 ask_question 工具结果反推的提问卡片数据
	const askCard = props.message.meta?._askCard as
		| { question?: string; type?: string; answered?: boolean; answer?: unknown; answerLabel?: string; options?: string[] }
		| undefined;
	const isAskCard = Boolean(askCard?.question);
	const statusLabel =
		status === "running"
			? t("tool.statusRunning")
			: status === "error"
				? t("tool.statusError")
				: t("tool.statusDone");
	const [copied, setCopied] = useState(false);
	const handleCopy = () => {
		navigator.clipboard.writeText(detailText);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};
	return (
		<section
			className={`tool-card tone-${tone}${isSkillRead ? " tool-card--skill" : ""}${isAskCard ? " tool-card--ask" : ""}`}
			data-status={status}
			data-tool-kind={isSkillRead ? "skill" : getToolKind(toolName)}
			data-message-id={props.message.id}
		>
			<button
				className="tool-card-trigger"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
			>
				<span className="tool-card-icon">
					{isSkillRead ? <Brain size={14} /> : isAskCard ? <MessageCircle size={14} /> : toolIcon(toolName)}
				</span>
				<span className="tool-card-name">
					{isSkillRead ? `skill:${skillName}` : isAskCard ? t("ask.toolName") : toolName}
				</span>
				{!isSkillRead && kindLabel && (
					<span className="tool-card-kind">{kindLabel}</span>
				)}
				<span className="tool-card-status">
					{status === "running" && <span className="tool-card-spinner" aria-hidden="true" />}
					{askCard?.answered ? t("ask.answered") : (statusLabel)}
				</span>
				{showDuration && (
					<span className="tool-card-duration" title={t("tool.durationTitle")}>
						{formatDuration(durationMs)}
					</span>
				)}
				{isAskCard && askCard?.question ? (
					<span className="tool-card-subtitle" title={askCard.question}>
						{askCard.question}
					</span>
				) : subtitle ? (
					<span className="tool-card-subtitle" title={subtitle}>
						{subtitle}
					</span>
				) : null}
				<ChevronDown
					size={14}
					className={`tool-card-chevron${expanded ? " open" : ""}`}
				/>
			</button>
			{expanded && (
				<div className="tool-card-content">
					{isAskCard && askCard ? (
						<div className="ask-question-card-tool-inner">
							<div className="ask-question-card-title"><MessageCircle size={13} />{askCard.question}</div>
							{askCard.options && askCard.options.length > 0 && (
								<div className="ask-question-card-options-list">
									{askCard.options.map((opt, i) => {
										const optLabel = typeof opt === "string" ? opt : (opt as any).label ?? String((opt as any).value ?? "");
										const optValue = typeof opt === "string" ? opt : String((opt as any).value ?? optLabel);
										const desc = typeof opt === "object" ? (opt as any).description : undefined;
										const isSelected = askCard.answered && (optLabel === askCard.answerLabel || optValue === askCard.answer);
										return (
											<div key={i} className={`ask-question-card-option-item${isSelected ? " selected" : ""}`}>
												<span className="ask-question-card-option-selector">{isSelected ? "✓" : ""}</span>
												<div className="ask-question-card-option-text">
													<span className="ask-question-card-option-label">{optLabel}</span>
													{desc && <span className="ask-question-card-option-desc">{desc}</span>}
												</div>
											</div>
										);
									})}
								</div>
							)}
							{askCard.answered && (!askCard.options || askCard.options.length === 0) ? (
								<div className="ask-question-card-answered">
									<Check size={14} className="ask-question-card-answered-ok" />
									<span className="ask-question-card-answer-text">
										{askCard.answerLabel ?? (
											typeof askCard.answer === "string" ? askCard.answer :
											typeof askCard.answer === "boolean" ? (askCard.answer ? t("common.true") : t("common.false")) :
											t("ask.answered")
										)}
									</span>
								</div>
							) : askCard.answered ? (
								<div className="ask-question-card-answered">
									<Check size={14} className="ask-question-card-answered-ok" />
									<span className="ask-question-card-answer-text">
										{askCard.answerLabel ?? (
											typeof askCard.answer === "string" ? askCard.answer :
											typeof askCard.answer === "boolean" ? (askCard.answer ? t("common.true") : t("common.false")) :
											t("ask.answered")
										)}
									</span>
								</div>
							) : (
								<div className="ask-question-card-answered" style={{ color: "var(--color-text-tertiary)" }}>
									{t("ask.unanswered")}
								</div>
							)}
						</div>
					) : (
						<pre className="tool-card-detail">{detailText}</pre>
					)}
					<button
						className="tool-card-copy"
						onClick={handleCopy}
						title={t("tool.copyDetail")}
					>
						{copied ? `${t("common.copy")} ✓` : t("common.copy")}
					</button>
				</div>
			)}
		</section>
	);
});

/** 工具组直接平铺为工具列表；每个 ToolCard 自己默认折叠，避免外层再占一行。 */
export const ToolGroupCard = memo(function ToolGroupCard(props: {
	group: ToolGroupItem;
}) {
	return (
		<section className="tool-group-card flat" data-message-id={props.group.id}>
			<div className="tool-group-card-list">
				{props.group.messages.map((message) => (
					<ToolCard key={message.id} message={message} />
				))}
			</div>
		</section>
	);
});

function getDiagnosticTone(message: ChatMessage): "error" | "warning" | "success" | "info" {
	if (message.role === "error") return "error";
	const status = String(message.meta?.status ?? "");
	if (status === "error") return "error";
	if (status === "running") return "warning";
	if (status === "success") return "success";
	return "info";
}

/** 压缩事件卡片：在时间线上标记会话被压缩过，展示摘要和节约的 token 数。 */
export const CompactionCard = memo(function CompactionCard(props: {
	message: ChatMessage;
}) {
	const summary = props.message.text;
	const tokensBefore = (props.message.meta as any)?.tokensBefore;
	const time = formatTime(props.message.timestamp);
	return (
		<article
			className="compaction-card"
			data-message-id={props.message.id}
		>
			<span className="compaction-card-icon" aria-hidden="true">🔁</span>
			<div className="compaction-card-body">
				<span className="compaction-card-summary">{stripAnsi(summary)}</span>
				{typeof tokensBefore === "number" && (
					<span className="compaction-card-tokens">
						~{Math.round(tokensBefore / 1000)}k tokens before
					</span>
				)}
				<time className="compaction-card-time">{time}</time>
			</div>
		</article>
	);
});

/** 错误/RPC/系统诊断消息使用独立卡片，避免和普通 AI 正文混在一起难以扫读。 */
export const DiagnosticMessageCard = memo(function DiagnosticMessageCard(props: {
	message: ChatMessage;
}) {
	const tone = getDiagnosticTone(props.message);
	const title = props.message.role === "error"
		? t("diagnostic.errorTitle")
		: t("diagnostic.systemTitle");
	return (
		<article
			className={`diagnostic-card tone-${tone}`}
			data-message-id={props.message.id}
			data-role={props.message.role}
		>
			<div className="diagnostic-card-header">
				<AlertTriangle size={14} aria-hidden="true" />
				<span>{title}</span>
				<time>{formatTime(props.message.timestamp)}</time>
			</div>
			<pre className="diagnostic-card-body">{stripAnsi(props.message.text)}</pre>
		</article>
	);
});

/**
 * 内联提问卡片：渲染 Extension UI 请求（select/confirm/input/editor）作为 system 消息。
 * 用于实时会话中模型通过 ask_question 扩展向用户发起交互。
 */
export const AskQuestionCard = memo(function AskQuestionCard(props: {
	message: ChatMessage;
	onRespond?: (response: { value?: string | boolean; cancelled?: boolean; confirmed?: boolean }) => void;
}) {
	const meta = props.message.meta as Record<string, unknown> | undefined;
	const uiRequest = meta?.uiRequest as Record<string, unknown> | undefined;
	const status = String(meta?.status ?? "pending");
	const response = meta?.response as Record<string, unknown> | undefined;
	const answered = status === "answered" && response && !response.cancelled;
	const cancelled = status === "cancelled" || status === "error";

	const [inputValue, setInputValue] = useState("");
	const [cancelling, setCancelling] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// 编辑器输入 ref
	const editorRef = useRef<HTMLTextAreaElement>(null);

	// 当 prefill 变化时同步到 inputValue
	useEffect(() => {
		if (uiRequest?.prefill) setInputValue(String(uiRequest.prefill));
	}, [uiRequest?.prefill]);

	const handleSelect = (value: string) => {
		props.onRespond?.({ value });
	};

	const handleConfirm = (value: boolean) => {
		props.onRespond?.({ confirmed: value });
	};

	const handleInputSubmit = () => {
		if (inputValue.trim()) {
			props.onRespond?.({ value: inputValue });
		}
	};

	const handleCancel = () => {
		setCancelling(true);
		props.onRespond?.({ cancelled: true });
	};

	// 已回答/取消的卡片：信息已在 ToolCard 的 _askCard 中展示，此处不再重复渲染
	if (answered || cancelled) {
		return null;
	}

	// pending 卡片：显示交互界面
	const cancellingLabel = t("ask.cancelling");
	const method = String(uiRequest?.method ?? "input");
	const title = String(uiRequest?.title ?? "");
	const placeholder = String(uiRequest?.placeholder ?? "");
	const options = uiRequest?.options as string[] | undefined;

	return (
		<article className="ask-question-card pending" data-message-id={props.message.id}>
			<div className="ask-question-card-header">
				<MessageCircle size={14} />
				<span className="ask-question-card-title">{title || t("ask.defaultTitle")}</span>
				<span className="ask-question-card-status">{cancelling ? t("ask.cancelling") : t("ask.waiting")}</span>
			</div>
			<div className="ask-question-card-body">
				{method === "select" && options && options.length > 0 && (
					<div className="ask-question-card-options">
						{options.map((opt, i) => (
							<button
								key={i}
								className="ask-question-card-option"
								onClick={() => handleSelect(opt)}
								disabled={cancelling}
							>
								{opt}
							</button>
						))}
					</div>
				)}
				{method === "confirm" && (
					<div className="ask-question-card-options ask-question-card-options-confirm">
						<button
							className="ask-question-card-option ask-question-card-option-yes"
							onClick={() => handleConfirm(true)}
							disabled={cancelling}
						>
							{t("common.true")}
						</button>
						<button
							className="ask-question-card-option ask-question-card-option-no"
							onClick={() => handleConfirm(false)}
							disabled={cancelling}
						>
							{t("common.false")}
						</button>
					</div>
				)}
				{method === "input" && (
					<div className="ask-question-card-input-row">
						<textarea
							ref={inputRef}
							className="ask-question-card-input"
							placeholder={placeholder || t("ask.inputPlaceholder")}
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									handleInputSubmit();
								}
							}}
							disabled={cancelling}
						/>
						<button
							className="ask-question-card-submit"
							onClick={handleInputSubmit}
							disabled={!inputValue.trim() || cancelling}
						>
							<Check size={14} />
						</button>
						<button
							className="ask-question-card-cancel"
							onClick={handleCancel}
							disabled={cancelling}
						>
							{cancelling ? cancellingLabel : t("common.cancel")}
						</button>
					</div>
				)}
				{method === "editor" && (
					<div className="ask-question-card-editor-area">
						<textarea
							ref={editorRef}
							className="ask-question-card-editor"
							placeholder={placeholder || t("ask.editorPlaceholder")}
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							disabled={cancelling}
						/>
						<div className="ask-question-card-editor-actions">
							<button
								className="ask-question-card-submit"
								onClick={handleInputSubmit}
								disabled={!inputValue.trim() || cancelling}
							>
								{t("ask.submit")}
							</button>
							<button
								className="ask-question-card-cancel"
								onClick={handleCancel}
								disabled={cancelling}
							>
								{cancelling ? cancellingLabel : t("common.cancel")}
							</button>
						</div>
					</div>
				)}
			</div>
		</article>
	);
});

/** 思考过程折叠卡片：默认收起，展开后显示完整推理文本（超长时提供截断展开）。 */
export const ThinkingBlock = memo(function ThinkingBlock(props: {
	text: string;
	endedAt?: number;
	showThinking?: boolean;
}) {
	// 默认展开，方便用户看到推理过程；可手动折叠
	const [expanded, setExpanded] = useState(true);
	if (!props.showThinking || !props.text.trim()) return null;
	const previewLen = 220;
	const needsTruncate = props.text.length > previewLen;
	const previewText =
		expanded || !needsTruncate
			? props.text
			: `${props.text.slice(0, previewLen)}...`;
	return (
		<section className="thinking-card">
			<button
				className="thinking-card-trigger"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
			>
				<Brain size={14} />
				<span>{t("thinking.title")}</span>
				{!expanded && props.text && (
					<span className="thinking-card-subtitle" title={props.text}>
						{props.text.slice(0, 80)}{props.text.length > 80 ? "..." : ""}
					</span>
				)}
				{props.endedAt ? <small>{formatTime(props.endedAt)}</small> : null}
				<em>{expanded ? t("common.collapse") : t("common.expand")}</em>
				<ChevronDown
					size={14}
					className={`thinking-card-chevron${expanded ? " open" : ""}`}
				/>
			</button>
			{expanded && <div className="thinking-card-content">{previewText}</div>}
		</section>
	);
});



/**
 * 流式等待指示器（三点脉动动画 + 状态文案）。
 *
 * 状态优先级：
 *  1. 工具执行中 → "正在执行 {tool}"（琥珀色）
 *  2. 思考中（有可见思考文本）→ "思考中"（默认强调色）
 *  3. 等待中 → 只显示 "..."（更低透明度）
 *
 * 当模型正在输出可见文本（responding）时，由外层 App.tsx
 * 的 isAwaitingAssistant 控制直接不渲染此组件，无需在此处理。
 */
export function ThinkingIndicator(props: {
	thinking?: string;
	showThinking?: boolean;
	isExecutingTool?: boolean;
	executingToolName?: string;
}) {
	const { isExecutingTool, executingToolName, thinking, showThinking } = props;

	let kind: "executing" | "thinking" | "waiting";
	let label: string;

	if (isExecutingTool) {
		// 工具执行中：琥珀色变体，优先显示具体工具名
		kind = "executing";
		label = executingToolName
			? t("thinking.executing", { tool: executingToolName })
			: t("thinking.executingFallback");
	} else if (showThinking && thinking && thinking.length > 0) {
		// 思考中：有可见思考文本
		kind = "thinking";
		label = t("thinking.streaming");
	} else {
		// 通用等待：无具体状态
		kind = "waiting";
		label = "...";
	}

	return (
		<div className="thinking-indicator" data-kind={kind}>
			<span className="thinking-indicator-dots" aria-hidden="true">
				<span />
				<span />
				<span />
			</span>
			{kind !== "waiting" && (
				<span className="thinking-indicator-label">{label}</span>
			)}
		</div>
	);
}

/** 宠物选择预览：给定宠物清单项，用 <canvas> 解码其 spritesheet 并循环播放
 *  对应 mode 行（默认 idle）的网格帧，让用户在选择宠物时即时看到动画效果，
 *  不必切换真实宠物窗。失败时降级为空占位，不阻塞设置面板。 */
function PetChooserPreview(props: {
	pet?: PetManifest;
	mode?: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const rafRef = useRef<number | null>(null);

	useEffect(() => {
		const pet = props.pet;
		const canvas = canvasRef.current;
		if (!pet || !pet.spritesheetUrl || !canvas) {
			const ctx = canvas!.getContext("2d");
			ctx?.clearRect(0, 0, canvas!.width, canvas!.height);
			return;
		}

		// 复用 petdex 标准网格规格（8 列 × 9 行，单格 192×208）
		const mode = props.mode && props.mode !== "__auto" ? props.mode : "idle";
		const row = MODE_ROW[mode] ?? 0;
		const frameCount = MODE_FRAMES[mode] ?? 6;
		const cols = GRID_COLS;
		const cellW = CELL_W;
		const cellH = CELL_H;

		// 解码 spritesheet；成功后用 rAF 按帧定时绘制单格，避免每帧重新解码。
		const img = new Image();
		img.src = pet.spritesheetUrl;
		let disposed = false;
		const start = () => {
			if (disposed) return;
			imgRef.current = img;
			let frame = 0;
			let last = performance.now();
			const FPS = 8;
			let acc = 0;
			const tick = (now: number) => {
				rafRef.current = requestAnimationFrame(tick);
				acc += now - last;
				last = now;
				if (acc < 1000 / FPS) return;
				acc = 0;
				if (frameCount <= 0) return;
				frame = (frame + 1) % frameCount;
				const ctx = canvas.getContext("2d");
				if (!ctx) return;
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				// 仅绘制当前帧对应的单格，按 canvas 尺寸等比缩放，避免拉伸出框。
				ctx.drawImage(img, frame * cellW, row * cellH, cellW, cellH, 0, 0, canvas.width, canvas.height);
			};
			rafRef.current = requestAnimationFrame(tick);
		};
		img.decode().then(start).catch(() => undefined);

		return () => {
			disposed = true;
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
			imgRef.current = null;
		};
	}, [props.pet, props.mode]);

	return (
		<div className="pet-chooser-preview">
			<canvas ref={canvasRef} width={CELL_W} height={CELL_H} aria-hidden="true" />
		</div>
	);
}

/** 助手正文：扁平 markdown 渲染，无气泡包裹，全宽排版，支持内嵌图片。
 *  路径链接化用 remark 插件在 mdast 层处理（见底部 remarkLinkifyPaths），不再前置改写原始字符串。 */
/** 流式输出期间的轻量代码块：不加载 mermaid、不跑数学/语法高亮，只展示原始文本，
 *  避免未闭合的 ```mermaid 围栏触发 mermaid.initialize/render 挤占主线程。 */
function StreamingCodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
	const child = Array.isArray(props.children) ? props.children[0] : props.children;
	const codeProps = isValidElement(child)
		? (child.props as { className?: string; children?: ReactNode })
		: undefined;
	const text = extractText(codeProps?.children ?? props.children);
	return (
		<div className="code-block-wrap">
			<button className="code-copy" onClick={() => navigator.clipboard.writeText(text)}>
				{t("code.copy")}
			</button>
			<pre {...props}>{props.children}</pre>
		</div>
	);
}

export const AssistantText = memo(
	function AssistantText(props: {
		text: string;
		images?: ImageContent[];
		onPreviewImage: (image: ImageContent) => void;
		onOpenExternal: (url: string) => void;
		onOpenFile?: (path: string) => void;
		/** 当前消息是否正在流式追加。为 true 时走轻量渲染路径，跳过 KaTeX 数学解析与
		 *  mermaid 图渲染，避免每个 token 都对不断增长的全量正文调用重型插件导致主线程卡死。 */
		isStreaming?: boolean;
	}) {
		// 清理 ANSI 转义码与 <thinking> 标签，thinking 由调用方通过 ThinkingBlock 渲染
		const cleanText = stripThinkingTags(stripAnsi(props.text));
		// 流式期间用轻量管线（仅 GFM + 路径链接化），回答结束后切回含数学/图表的完整渲染。
		const streaming = Boolean(props.isStreaming);
		return (
			<div className="assistant-text markdown-body">
				{props.images && props.images.length > 0 && (
					<div className="message-images">
						{props.images.map((img, index) => (
							<img
								key={index}
								src={`data:${img.mimeType};base64,${img.data}`}
								alt={t("app.imageAlt", { index: index + 1 })}
								className="message-image"
								onClick={() => props.onPreviewImage(img)}
							/>
						))}
					</div>
				)}
				<ReactMarkdown
					remarkPlugins={
						streaming
							? [remarkGfm, remarkLinkifyPaths]
							: [remarkGfm, remarkMath, remarkLinkifyPaths]
					}
					rehypePlugins={streaming ? [] : [rehypeKatex]}
					urlTransform={markdownUrlTransform}
					components={{
						pre: streaming ? StreamingCodeBlock : CodeBlock,
						span: MathSpan,
						a: (linkProps) => (
							<MarkdownLink
								{...linkProps}
								onOpenExternal={props.onOpenExternal}
								onOpenFile={props.onOpenFile}
							/>
						),
					}}
				>
					{cleanText}
				</ReactMarkdown>
			</div>
		);
	},
	// 自定义比较：文本、流式标记、图片一致时跳过重渲染。回调函数（onPreviewImage/onOpenExternal/
	// onOpenFile）行为稳定（读 ref 或 setState），不参与比较，避免 App 每次渲染新建内联箭头
	// 函数导致 memo 失效——历史消息在流式期间因此不再重复解析 Markdown，从根上消除卡顿。
	(prev, next) =>
		prev.text === next.text &&
		prev.isStreaming === next.isStreaming &&
		prev.images === next.images,
);

/** 一轮 AI 回答的扁平容器：左侧竖线聚合，内含思考/工具/正文/文件摘要。
 *  替代旧的 AgentRun + ChatBubble 助手分支 + RunActivity 三层结构。 */
export const TurnRow = memo(function TurnRow(props: {
	run: AgentRunItem;
	onPreviewImage: (image: ImageContent) => void;
	showThinking?: boolean;
	isStreaming?: boolean;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
	onDiffFile?: DiffFileHandler;
	onResendUserMessage?: (message: ChatMessage) => void;
	onDeleteMessage?: (messageId: string) => void;
	onEditMessage?: (messageId: string, newText: string) => void;
	fileSummariesByMessage?: Record<string, SessionModifiedFile[]>;
}) {
	const { run } = props;
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const editAreaRef = useRef<HTMLDivElement | null>(null);
	// 激活编辑时自动滚动到编辑区（避免 textarea 超出可视区域）
	useEffect(() => {
		if (editing && editAreaRef.current) {
			editAreaRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, [editing]);
	const isComplete = run.endedAt > 0;
	const duration = isComplete && run.startedAt > 0 ? run.endedAt - run.startedAt : 0;
	const showDuration = isComplete && duration > 100;

	// 合并本轮所有 assistant 文本与思考（保持原 AgentRun 的合并语义：同一轮多段回答拼成一整篇）
	const assistantMessages = run.items.filter(
		(item): item is MessageItem =>
			item.kind === "message" && item.message.role === "assistant",
	);
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	const allImages: ImageContent[] = [];
	for (const item of assistantMessages) {
		const txt = stripThinkingTags(stripAnsi(item.message.text)).trim();
		if (txt) textParts.push(txt);
		if (item.message.thinking?.trim())
			thinkingParts.push(stripAnsi(item.message.thinking));
		if (item.message.images) allImages.push(...item.message.images);
	}
	const mergedText = textParts.join("\n\n");
	const mergedThinking = thinkingParts.join("\n\n");

	// 判断本轮是否有独立思考组（用于 inline thinking 是否展示的决策）
	const hasStandaloneThinking = run.items.some(
		(item): item is ThinkingGroupItem => item.kind === "thinking-group",
	);
	// 优先使用运行结束时固化到 assistant 消息的摘要；若本轮没有 assistant 文本或历史 id 对不上，
	// 则直接从本轮 tool 消息兜底提取，保证纯工具调用（如 write）也能在卡片里展示。
	const toolMessages = run.items.flatMap((item) =>
		item.kind === "tool-group" ? item.messages : [],
	);
	const fallbackFileSummary = collectModifiedFilesFromToolMessages(toolMessages);
	const fileSummary = mergeModifiedFiles(
		props.fileSummariesByMessage?.[assistantMessages[0]?.message.id],
		fallbackFileSummary,
	);

	const rowRef = useRef<HTMLElement | null>(null);
	const [collapsed, setCollapsed] = useState(false);

	// 本轮没有任何可渲染内容时不输出空容器
	const hasContent =
		mergedText ||
		mergedThinking ||
		run.items.some(item => item.kind === "thinking-group") ||
		run.items.some(item => item.kind === "tool-group") ||
		allImages.length > 0;
	if (!hasContent) return null;

	return (
		<article ref={rowRef} className={`turn-row${collapsed ? " collapsed" : ""}`} data-message-id={run.id}>
			<button
				className="turn-row-rail"
				type="button"
				onClick={() => setCollapsed((value) => !value)}
				aria-expanded={!collapsed}
				aria-label={collapsed ? t("common.expand") : t("common.collapse")}
				title={collapsed ? t("common.expand") : t("common.collapse")}
			/>
			<div className="turn-row-body">
				<div className="turn-row-meta">
					<span className="turn-row-agent">pi</span>
					<time>{formatTime(run.endedAt)}</time>
					{showDuration && (
						<span className="turn-row-duration">{formatDuration(duration)}</span>
					)}
				</div>
				{collapsed ? (
					<div className="turn-row-collapsed-summary" aria-hidden="true">
						{mergedText ? summarizeMessage(mergedText) : t("common.expand")}
					</div>
				) : (
					<>
						{/* 按时序渲染 thinking / tool 条目，assistant 正文已合并统一渲染在下文 */}
						{run.items.map((item) => {
							if (item.kind === "thinking-group") {
								if (!props.showThinking) return null;
								return (
									<ThinkingBlock
										key={item.id}
										text={item.text}
										endedAt={item.endedAt}
										showThinking={props.showThinking}
									/>
								);
							}
							if (item.kind === "tool-group") {
								return <ToolGroupCard key={item.id} group={item} />;
							}
							// assistant 消息已合并为 mergedText，在循环外统一渲染一次，避免重复
							return null;
						})}
						{/* 内联思考（来自 assistant 消息自身的 thinking 字段）：
						    仅当本轮无独立思考组时才展示，避免冗余 */}
						{props.showThinking && mergedThinking && !hasStandaloneThinking && (
							<ThinkingBlock
								text={mergedThinking}
								endedAt={run.endedAt}
								showThinking={props.showThinking}
							/>
						)}
						{/* 助手正文（已合并，只渲染一次） */}
						{mergedText && editing ? (
							<div className="turn-row-edit-area" ref={editAreaRef}>
								<div className="edit-area-indicator">{t("common.edit")}</div>
								<textarea
									className="turn-row-edit-textarea"
									value={editText}
									onChange={(e) => setEditText(e.target.value)}
									onKeyDown={(e) => {
										// Ctrl+Enter 保存，Escape 取消
										if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
											e.preventDefault();
											const targetId = assistantMessages.at(-1)?.message.id;
											if (targetId && props.onEditMessage) {
												props.onEditMessage(targetId, editText);
												setEditing(false);
											}
										}
										if (e.key === "Escape") {
											setEditing(false);
										}
									}}
									autoFocus
								/>
								<div className="turn-row-edit-actions">
									<button
										className="turn-row-edit-btn primary"
										onClick={() => {
											const targetId = assistantMessages.at(-1)?.message.id;
											if (targetId && props.onEditMessage) {
												props.onEditMessage(targetId, editText);
												setEditing(false);
											}
										}}
									>
										{t("common.save")}
									</button>
									<button
										className="turn-row-edit-btn"
										onClick={() => setEditing(false)}
									>
										{t("common.cancel")}
									</button>
								</div>
							</div>
						) : mergedText ? (
							<AssistantText
								text={mergedText}
								images={allImages}
								onPreviewImage={props.onPreviewImage}
								onOpenExternal={props.onOpenExternal}
								onOpenFile={props.onOpenFile}
								isStreaming={props.isStreaming ?? false}
							/>
						) : null}
						{/* 操作栏 */}
						{mergedText && !editing && (
							<div className="turn-row-actions">
								<CopyMenu text={mergedText} markdown={mergedText} targetRef={rowRef} />
								{!props.isStreaming && assistantMessages.at(-1)?.message.id && (
									<>
										<button
											className="turn-row-action-btn"
											onClick={() => {
												setEditText(mergedText);
												setEditing(true);
											}}
											title={t("common.edit")}
										>
											{t("common.edit")}
										</button>
										<button
											className="turn-row-action-btn"
											onClick={() => {
												const targetId = assistantMessages.at(-1)?.message.id;
												if (targetId && props.onDeleteMessage) {
													props.onDeleteMessage(targetId);
												}
											}}
											title={t("common.delete")}
										>
											{t("common.delete")}
										</button>
									</>
								)}
							</div>
						)}
						{/* 本轮修改文件摘要：放在工具和助手消息下方，即使本轮只有工具调用也展示 */}
						{fileSummary && fileSummary.length > 0 && (
							<SessionFileSummary
								files={fileSummary}
								onOpenFile={props.onOpenFile}
								onDiffFile={props.onDiffFile}
							/>
						)}
					</>
				)}
			</div>
		</article>
	);
});

/**
 * 从用户消息文本中提取 pi 展开后的 <skill name="..." location="...">...</skill> 块。
 * pi 在发送 /skill:name 时会把 skill 内容展开成该 XML 块注入用户消息，
 * 这里在展示层把它们识别出来，渲染成 skill 徽标，并把原始 XML 从正文里剥除。
 * 返回 { skills, text }：skills 为 skill 名列表，text 为移除 skill 块后的正文。
 */
function extractSkillBlocks(text: string): { skills: string[]; text: string } {
	const skills: string[] = [];
	// 非贪婪匹配 skill 块；name/location 属性顺序与引号样式兼容 pi 实际输出
	const re = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/gi;
	const cleaned = text.replace(re, (_m, name: string) => {
		if (name) skills.push(name);
		return "";
	});
	return { skills, text: cleaned.trim() };
}

/** 用户消息：右对齐气泡 + 附件 + hover 显隐操作栏（复制/编辑/删除/重发/修改输入框）。
 * 编辑分两种：原地编辑（修改 JSONL + 重载会话）和修改输入框（放回 composer 不自动发送）。 */
export const UserBubble = memo(function UserBubble(props: {
	message: ChatMessage;
	onPreviewImage: (image: ImageContent) => void;
	onOpenFile?: (path: string) => void;
	onResendUserMessage?: (message: ChatMessage) => void;
	onEditMessage?: (messageId: string, newText: string) => void;
	onDeleteMessage?: (messageId: string) => void;
	/** 是否为该 agent 消息列表中的最后一条用户消息，用于控制「重发」按钮的显隐 */
	isLastUserMessage?: boolean;
	validCommandNames?: Set<string>;
	validFilePaths?: Set<string>;
}) {
	const { message } = props;
	const rowRef = useRef<HTMLElement | null>(null);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const editAreaRef = useRef<HTMLDivElement | null>(null);
	// 激活编辑时自动滚动到编辑区
	useEffect(() => {
		if (editing && editAreaRef.current) {
			editAreaRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, [editing]);
	// 提取 pi 展开后的 <skill> 块：渲染为 skill 徽标，并从正文里剥除 XML
	const { skills, text: bodyText } = extractSkillBlocks(stripAnsi(message.text));
	const cleanText = bodyText;
	// 投递策略标签：steer(下次调用前插入) / followUp(停止后排队)
	const deliveryBehavior = message.meta?.streamingBehavior as
		| "steer"
		| "followUp"
		| undefined;
	const deliveryLabel =
		deliveryBehavior === "steer"
			? t("app.messageDeliverySteer")
			: deliveryBehavior === "followUp"
				? t("app.messageDeliveryFollowUp")
				: null;
	/** 原地编辑不影响输入框；先提交给确认弹窗。 */
	const handleSaveEdit = () => {
		if (props.onEditMessage && editText.trim()) {
			props.onEditMessage(message.id, editText);
			setEditing(false);
		}
	};
	/** 编辑后重发：放回 composer 输入框，由用户自行修改后发送。 */
	const handleEditAndResend = () => {
		document.querySelector<HTMLTextAreaElement>(".composer-box textarea")?.focus();
		window.dispatchEvent(
			new CustomEvent("user-message-edit", { detail: { text: message.text } }),
		);
	};
	return (
		<article ref={rowRef} className="user-turn" data-message-id={message.id}>
			{skills.length > 0 && (
				<div className="user-turn-skills">
					{skills.map((name) => (
						<span key={name} className="user-turn-skill-badge" title={`/${name}`}>
							<span className="user-turn-skill-icon">/</span>
							{name}
						</span>
					))}
				</div>
			)}
			{message.images && message.images.length > 0 && (
				<div className="user-turn-attachments">
					{message.images.map((img, index) => (
						<img
							key={index}
							src={`data:${img.mimeType};base64,${img.data}`}
							alt={t("app.imageAlt", { index: index + 1 })}
							className="user-turn-attachment"
							onClick={() => props.onPreviewImage(img)}
						/>
					))}
				</div>
			)}
			{cleanText && !editing && (
				<div className="user-turn-bubble">
					<div className="user-turn-text">
						{renderChipText(cleanText, props.onOpenFile, props.validCommandNames, props.validFilePaths)}
					</div>
				</div>
			)}
			{editing && (
				<div className="user-turn-edit-area" ref={editAreaRef}>
					<div className="edit-area-indicator">{t("common.edit")}</div>
					<textarea
						className="message-edit-textarea"
						value={editText}
						onChange={(e) => setEditText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								handleSaveEdit();
							}
							if (e.key === "Escape") setEditing(false);
						}}
						autoFocus
					/>
					<div className="message-edit-actions">
						<button className="message-edit-btn primary" onClick={handleSaveEdit}>
							{t("common.save")}
						</button>
						<button className="message-edit-btn" onClick={() => setEditing(false)}>
							{t("common.cancel")}
						</button>
					</div>
				</div>
			)}
			<div className="user-turn-meta">
				{deliveryLabel && (
					<span
						className={`user-turn-delivery${
							deliveryBehavior === "followUp" ? " follow-up" : " steer"
						}`}
						title={
							deliveryBehavior === "followUp"
								? t("app.messageDeliveryFollowUpTitle")
								: t("app.messageDeliverySteerTitle")
						}
					>
						{deliveryLabel}
					</span>
				)}
				<time>{formatTime(message.timestamp)}</time>
			</div>
			<div className="user-turn-actions">
				<CopyMenu text={cleanText} markdown={message.text} targetRef={rowRef} />
				{!editing && (
					<>
						<button className="user-turn-action-btn" onClick={() => {
							setEditText(cleanText);
							setEditing(true);
						}}>
							{t("common.edit")}
						</button>
						<button
							className="user-turn-action-btn"
							onClick={handleEditAndResend}
							title={t("app.editAndResendTitle")}
						>
							{t("app.editAndResend")}
						</button>
						<button
							className="user-turn-action-btn"
							onClick={() => props.onDeleteMessage?.(message.id)}
							title={t("common.delete")}
						>
							{t("common.delete")}
						</button>
						{props.isLastUserMessage && (
							<button
								className="user-turn-action-btn"
								onClick={() => props.onResendUserMessage?.(message)}
								title={t("app.resendTitle")}
							>
								{t("app.resend")}
							</button>
						)}
					</>
				)}
			</div>
		</article>
	);
});

/**
 * remark 插件：把助手正文里的裸文件路径转换成可点击的 file:// 链接。
 *
 * 以前用对原始 markdown 字符串做正则替换的 linkifyFilePaths，缺点是会把
 * ```代码块``` 里的路径字符串也改写掉（例如 AI 给出的 path: "D:\..." 示例
 * 被替换成 [D:\...](file://...) 破坏代码块），且 file:// 经 encodeURIComponent
 * 后反斜杠全被编码，链接既不可用又渲染异常。
 *
 * 改为在 mdast 层遍历，只处理 type === "text" 的叶子节点，天然跳过
 * code / inlineCode / link 内的文本，从根上消除双重处理与代码块破坏。
 * URL 用 file:// + encodeURIComponent 编码路径，MarkdownLink 里解码还原。
 */
const FILE_PATH_RE =
	/(?:[A-Z]:[\\/][^\s<>"'`|?*\n\[\]()]+|(?:\.\.?\/|\/)[^\s<>"'`|?*\n\[\]()]+|(?:[a-zA-Z_][a-zA-Z0-9_-]*[\\/])+[^\s<>"'`|?*\n\[\]()]+)\.[a-zA-Z0-9]+/g;

const remarkLinkifyPaths = () => {
	return (tree: any) => {
		// 遍历 mdast，仅替换 text 叶子节点；code/inlineCode/link 等节点不被处理。
		// 文本节点无 children，所以先用 __segs 标记待拆分节点，由父节点遍历时展开。
		const visit = (node: any) => {
			if (!node || typeof node !== "object") return;
			const type: string = node.type;
			if (type === "code" || type === "inlineCode" || type === "link") return;
			if (type === "text" && typeof node.value === "string") {
				const text: string = node.value;
				FILE_PATH_RE.lastIndex = 0;
				const segs: any[] = [];
				let last = 0;
				let m: RegExpExecArray | null;
				let touched = false;
				while ((m = FILE_PATH_RE.exec(text)) !== null) {
					const start = m.index;
					const end = start + m[0].length;
					if (start > last) segs.push({ type: "text", value: text.slice(last, start) });
					segs.push({
						type: "link",
						url: `file://${encodeURIComponent(m[0])}`,
						children: [{ type: "text", value: m[0] }],
					});
					last = end;
					touched = true;
				}
				if (touched) {
					if (last < text.length) segs.push({ type: "text", value: text.slice(last) });
					node.__segs = segs;
				}
				return;
			}
			const children: any[] | undefined = node.children;
			if (Array.isArray(children)) {
				const next: any[] = [];
				for (const child of children) {
					visit(child);
					if (child && (child as any).__segs) {
						const segs = (child as any).__segs;
						delete (child as any).__segs;
						next.push(...segs);
					} else {
						next.push(child);
					}
				}
				node.children = next;
			}
		};
		visit(tree);
	};
};

function getToolStatus(message: ChatMessage): "running" | "done" | "error" {
	const status = String(message.meta?.status ?? "done");
	if (status === "running" || status === "error") return status;
	return "done";
}

function getToolName(message: ChatMessage) {
	const name = message.meta?.toolName;
	if (typeof name === "string" && name.trim()) return name.trim();
	const text = stripAnsi(message.text).replace(/^[▶✓✗]\s*/u, "").trim();
	return text || "tool";
}

function getToolDetailText(message: ChatMessage) {
	if (typeof message.meta?.detailText === "string") {
		return stripAnsi(message.meta.detailText);
	}
	return stripAnsi(JSON.stringify(message.meta ?? {}, null, 2));
}

function getToolExitCode(message: ChatMessage) {
	const result = message.meta?.result;
	if (!result || typeof result !== "object") return undefined;
	const value = (result as { exitCode?: unknown }).exitCode;
	if (typeof value === "number") return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function ImagePreviewModal(props: {
	image: ImageContent;
	onClose: () => void;
}) {
	return (
		<div className="image-preview-modal" onClick={props.onClose}>
			<button
				className="image-preview-close"
				onClick={props.onClose}
				aria-label={t("app.imagePreviewClose")}
			>
				<X size={20} strokeWidth={2.4} />
			</button>
			<img
				src={`data:${props.image.mimeType};base64,${props.image.data}`}
				alt={t("app.imagePreviewAlt")}
				onClick={(event) => event.stopPropagation()}
			/>
		</div>
	);
}

// ANSI 转义码正则:匹配 \x1b[...m 等终端颜色/样式序列
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** 去除 pi 输出中的 ANSI 终端转义码,避免在 React UI 中显示原始 \e[38;5;109m 等文本 */
function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

/** 去除文本中的 <thinking> 标签 */
function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

/** 将消息文本中的 @path / /command 渲染为行内 chip（聊天区展示用，与输入框 chip 视觉一致）。
 * 可通过 onOpenFile 回调使 chip 可点击跳转。 */
function renderChipText(text: string, onOpenFile?: (path: string) => void, validCommandNames?: Set<string>, validFilePaths?: Set<string>): ReactNode[] {
	const chips = parseRichInputChips(text, validCommandNames, validFilePaths);
	if (chips.length === 0) return [text];
	const nodes: ReactNode[] = [];
	let cursor = 0;
	for (const chip of chips) {
		if (chip.start > cursor) {
			nodes.push(text.slice(cursor, chip.start));
		}
		const clickable = onOpenFile && chip.kind === "file";
		nodes.push(
			<span
				key={`chip-${chip.start}`}
				className={`input-chip input-chip--${chip.kind}${clickable ? " clickable" : ""}`}
				data-type={chip.kind}
				data-raw={chip.raw}
				title={chip.raw}
				onClick={clickable ? () => onOpenFile(chip.raw.slice(1)) : undefined}
			>
				<span className="input-chip__icon">
					{chip.kind === "file" ? "@" : "/"}
				</span>
				<span className="input-chip__label">{chip.label}</span>
			</span>,
		);
		cursor = chip.end;
	}
	if (cursor < text.length) {
		nodes.push(text.slice(cursor));
	}
	return nodes;
}

function MathSpan(props: React.HTMLAttributes<HTMLSpanElement>) {
	const { className, children, ...spanProps } = props;
	const ref = useRef<HTMLSpanElement | null>(null);
	const isDisplayMath = /\bkatex-display\b/.test(className ?? "");
	if (!isDisplayMath) return <span className={className} {...spanProps}>{children}</span>;
	const copyMath = () => {
		const annotation = ref.current?.querySelector('annotation[encoding="application/x-tex"]');
		const source = annotation?.textContent || extractText(children);
		void navigator.clipboard.writeText(`$$\n${source}\n$$`);
	};
	return (
		<span className="math-copy-wrap">
			<span ref={ref} className={className} {...spanProps}>{children}</span>
			<button className="math-copy-btn" type="button" onClick={copyMath}>{t("common.copy")}</button>
		</span>
	);
}

function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
	const child = Array.isArray(props.children) ? props.children[0] : props.children;
	const codeProps = isValidElement(child)
		? (child.props as { className?: string; children?: ReactNode })
		: undefined;
	const languageClass = codeProps?.className ?? "";
	const text = extractText(codeProps?.children ?? props.children);
	if (/\blanguage-mermaid\b/i.test(languageClass)) {
		return <MermaidDiagram chart={text} />;
	}
	return (
		<div className="code-block-wrap">
			<button
				className="code-copy"
				onClick={() => navigator.clipboard.writeText(text)}
			>
				{t("code.copy")}
			</button>
			<pre {...props}>{props.children}</pre>
		</div>
	);
}

function normalizeMermaidChart(chart: string) {
	// Mermaid flowchart 的方括号节点 label 未加引号时，`foo(bar)` 里的括号会被解析成形状语法。
	// 模型常输出 `A[api.call(arg)]` 这种写法，这里仅把含括号的普通方括号 label 自动转成 quoted label。
	return chart.replace(
		/(\b[A-Za-z][\w-]*\s*)\[([^\]\n"]*[()][^\]\n"]*)\]/g,
		(_match, prefix: string, label: string) =>
			`${prefix}["${label.replace(/"/g, "\\\"")}"]`,
	);
}

function MermaidDiagram(props: { chart: string }) {
	const reactId = useId();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [zoom, setZoom] = useState(1);

	useEffect(() => {
		let disposed = false;
		const chart = normalizeMermaidChart(props.chart);
		const renderId = `pi-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
		// Mermaid 图由模型输出生成，使用 strict 安全级别并禁用 startOnLoad，
		// 避免库扫描整个页面或执行不受控的链接/脚本行为。此处动态加载 mermaid，
		// 保证不按需出现的图表场景不占用渲染进程常驻内存。
		loadMermaid()
			.then((mod) => {
				const mermaid = mod.default;
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
				});
				return mermaid.render(renderId, chart);
			})
			.then(({ svg }) => {
				if (disposed || !containerRef.current) return;
				containerRef.current.innerHTML = svg;
				setError(null);
			})
			.catch((err: unknown) => {
				if (disposed) return;
				setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			disposed = true;
		};
	}, [props.chart, reactId]);

	return (
		<div className="mermaid-block">
			{error ? (
				<MermaidMarkdownFallback chart={props.chart} error={error} />
			) : (
				<>
					<div className="mermaid-toolbar" aria-label="Mermaid diagram controls">
						<button type="button" onClick={() => navigator.clipboard.writeText(`\`\`\`mermaid\n${props.chart}\n\`\`\``)}>{t("common.copy")}</button>
						<button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}>−</button>
						<span>{Math.round(zoom * 100)}%</span>
						<button type="button" onClick={() => setZoom((value) => Math.min(2.5, value + 0.1))}>＋</button>
						<button type="button" onClick={() => setZoom(1)}>100%</button>
					</div>
					<div className="mermaid-viewport">
						<div
							ref={containerRef}
							className="mermaid-diagram"
							style={{ transform: `scale(${zoom})`, "--mermaid-zoom": zoom } as CSSProperties}
						/>
					</div>
				</>
			)}
		</div>
	);
}

function MermaidMarkdownFallback(props: { chart: string; error: string }) {
	const markdown = `\`\`\`mermaid\n${props.chart}\n\`\`\``;
	return (
		<div className="code-block-wrap mermaid-fallback">
			<button
				className="code-copy"
				onClick={() => navigator.clipboard.writeText(markdown)}
			>
				{t("code.copy")}
			</button>
			<pre>{markdown}</pre>
			<small className="mermaid-error-message">Mermaid render failed: {props.error}</small>
		</div>
	);
}

/** Markdown 内的链接默认会在 Electron 窗口内导航,这里拦截点击统一用系统浏览器打开。
 * 支持文件路径链接（file:// 协议）点击打开文件。
 */
function markdownUrlTransform(url: string): string {
	// react-markdown 默认会清空 file:// 协议；这里只放行本地文件链接，普通外链仍使用默认安全过滤。
	return url.startsWith("file://") ? url : defaultUrlTransform(url);
}

function MarkdownLink(
	props: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
		onOpenExternal: (url: string) => void;
		onOpenFile?: (path: string) => void;
	},
) {
	const { onOpenExternal, onOpenFile, ...anchorProps } = props;
	const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		if (!props.href) return;
		
		// 处理文件路径链接（file:// 协议）
		if (props.href.startsWith('file://')) {
			const filePath = decodeURIComponent(props.href.slice(7));
			if (onOpenFile) {
				void onOpenFile(filePath);
			}
		} else {
			// 普通 URL 链接用系统浏览器打开
			void onOpenExternal(props.href);
		}
	};
	return <a {...anchorProps} onClick={handleClick} />;
}

function extractText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join("");
	if (isValidElement<{ children?: ReactNode }>(node))
		return extractText(node.props.children);
	return "";
}

/** 将毫秒数格式化为短可读形式,如 "3.2s" "1m23s" */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}.${Math.floor((ms % 1000) / 100)}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return remaining > 0 ? `${minutes}m${remaining}s` : `${minutes}m`;
}

function formatTime(timestamp: number) {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function buildOutline(messages: ChatMessage[]) {
	// 会话定位只展示用户提问，每条代表一轮完整对话（用户提问 + 紧随其后的 AI 回答）。
	// AI 回答不单独列出，避免列表冗长且与用户提问重复描述同一轮对话。
	return messages
		.filter((message) => message.role === "user")
		.map((message) => ({
			id: message.id,
			role: message.role,
			title: summarizeMessage(message.text),
			time: formatTime(message.timestamp),
		}))
		.filter((item) => item.title);
}

function summarizeMessage(text: string) {
	// 过滤 ANSI 转义码,避免 outline 标题显示乱码
	const cleaned = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	const firstLine =
		cleaned
			.replace(/```[\s\S]*?```/g, " ")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return firstLine.length > 48 ? `${firstLine.slice(0, 48)}...` : firstLine;
}

export function RpcLogModal(props: {
	logs: Array<{
		id: string;
		agentId: string;
		direction: string;
		summary: string;
		time: number;
		data?: unknown;
	}>;
	onClose: () => void;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [directionFilter, setDirectionFilter] = useState<"all" | "send" | "recv">("all");
	const [keyword, setKeyword] = useState("");
	const normalizedKeyword = keyword.trim().toLowerCase();
	const visibleLogs = props.logs
		.filter((log) => directionFilter === "all" || log.direction === directionFilter)
		.filter((log) => {
			if (!normalizedKeyword) return true;
			// 搜索同时覆盖摘要和完整 JSON,方便直接查 502、terminated、auto_retry 等排障关键词。
			return formatRpcLogForCopy(log).toLowerCase().includes(normalizedKeyword);
		})
		.slice(-2000);

	useEffect(() => {
		const el = panelRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [props.logs.length, visibleLogs.length]);

	const copyLogs = (logs: typeof visibleLogs) =>
		navigator.clipboard.writeText(logs.map(formatRpcLogForCopy).join("\n"));

	return (
		<div className="modal-backdrop" onClick={props.onClose}>
			<div className="rpc-log-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header rpc-log-header">
					<strong>
						{t("rpc.title", {
							visible: visibleLogs.length,
							total: props.logs.length,
						})}
					</strong>
					<div className="modal-header-actions rpc-log-header-actions">
						<button className="config-btn primary" onClick={() => copyLogs(props.logs)}>
							{t("common.copyAll")}
						</button>
						<button className="config-btn blue" onClick={() => copyLogs(visibleLogs)}>
							{t("common.copyVisible")}
						</button>
						<CloseIconButton
							label={t("common.close")}
							onClick={props.onClose}
						/>
					</div>
				</div>
				<div className="rpc-log-toolbar">
					<div className="rpc-log-filter-tabs">
						<button
							className={directionFilter === "all" ? "active" : ""}
							onClick={() => setDirectionFilter("all")}
						>
							{t("rpc.filterAll")}
						</button>
						<button
							className={directionFilter === "send" ? "active" : ""}
							onClick={() => setDirectionFilter("send")}
						>
							{t("rpc.filterSend")}
						</button>
						<button
							className={directionFilter === "recv" ? "active" : ""}
							onClick={() => setDirectionFilter("recv")}
						>
							{t("rpc.filterReceive")}
						</button>
					</div>
					<input
						value={keyword}
						onChange={(event) => setKeyword(event.target.value)}
						placeholder={t("rpc.searchPlaceholder")}
					/>
				</div>
				<div className="rpc-log-list" ref={panelRef}>
					{visibleLogs.map((log) => {
						const jsonText = JSON.stringify(log.data ?? {}, null, 2);
						return (
							<div key={log.id} className="rpc-log-entry-wrap">
								<div
									className={`rpc-log-entry ${log.direction === "send" ? "log-send" : "log-recv"}`}
									onClick={() =>
										setExpandedId(expandedId === log.id ? null : log.id)
									}
								>
									<time>
										{new Date(log.time).toLocaleTimeString(undefined, {
											hour: "2-digit",
											minute: "2-digit",
											second: "2-digit",
										})}
									</time>
									<span className="log-direction">
										{log.direction === "send" ? "→" : "←"}
									</span>
									<span className="log-summary">{log.summary}</span>
									<div className="rpc-log-entry-actions" onClick={(event) => event.stopPropagation()}>
										<button onClick={() => navigator.clipboard.writeText(formatRpcLogForCopy(log))}>
											{t("common.copy")}
										</button>
										<button onClick={() => navigator.clipboard.writeText(jsonText)}>
											{t("rpc.copyJson")}
										</button>
									</div>
								</div>
								{expandedId === log.id && log.data != null && (
									<pre className="rpc-log-detail">{jsonText}</pre>
								)}
							</div>
						);
					})}
					{visibleLogs.length === 0 && (
						<div className="rpc-log-empty">
							{t("rpc.empty")}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function formatRpcLogForCopy(log: {
	agentId: string;
	direction: string;
	summary: string;
	time: number;
	data?: unknown;
}) {
	return JSON.stringify({
		time: new Date(log.time).toISOString(),
		agentId: log.agentId,
		direction: log.direction,
		summary: log.summary,
		data: log.data,
	});
}

type EntryAction = {
	active?: boolean;
	label: string;
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
	icon: ReactNode;
};

export function ConversationOutline(props: {
	items: Array<{ id: string; role: string; title: string; time: string }>;
	onJump: (id: string) => void;
	extraAction?: EntryAction;
	terminalAction?: EntryAction;
	filesAction?: EntryAction;
	editorsAction?: EntryAction & { anchorRef?: React.RefObject<HTMLButtonElement | null> };
}) {
	const [expanded, setExpanded] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [top, setTop] = useState(() => getInitialOutlineTop());
	const dragRef = useRef<{ startY: number; startTop: number } | null>(null);
	const topRef = useRef(top);
	const visibleItems = expanded ? props.items : props.items.slice(-15);
	const hasMore = props.items.length > 15;

	useEffect(() => {
		topRef.current = top;
	}, [top]);

	useEffect(() => {
		if (!dragging) return;
		function onMove(event: PointerEvent) {
			const drag = dragRef.current;
			if (!drag) return;
			setTop(clampOutlineTop(drag.startTop + event.clientY - drag.startY));
		}
		function onUp() {
			setDragging(false);
			dragRef.current = null;
			localStorage.setItem(OUTLINE_TOP_STORAGE_KEY, String(topRef.current));
		}
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [dragging]);

	useEffect(() => {
		const onResize = () => setTop((value) => clampOutlineTop(value));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	function startDrag(event: ReactPointerEvent<HTMLElement>) {
		event.preventDefault();
		event.stopPropagation();
		dragRef.current = { startY: event.clientY, startTop: topRef.current };
		setDragging(true);
	}

	return (
		<div
			className={`outline-hover${dragging ? " dragging" : ""}`}
			style={{ "--outline-top": `${top}px` } as React.CSSProperties}
		>
			<div className="outline-zone">
				<button
					className={`outline-trigger${props.items.length > 0 ? "" : " is-disabled"}`}
					disabled={props.items.length === 0}
					title={t("outline.trigger", { count: props.items.length })}
					onPointerDown={props.items.length > 0 ? startDrag : undefined}
				>
					☰
				</button>
				{props.items.length > 0 && (
				<nav className="conversation-outline">
				<div className="outline-title">
					<span
						className="outline-drag-handle"
						title={t("outline.drag")}
						onPointerDown={startDrag}
					>
						⋮⋮
					</span>
					<span>{t("outline.title")}</span>
					<span className="outline-count">{props.items.length}</span>
				</div>
				<div className="outline-list">
					{hasMore && !expanded && (
						<button
							className="outline-expand"
							onClick={() => setExpanded(true)}
						>
							{t("outline.showAll", { count: props.items.length })}
						</button>
					)}
					{visibleItems.map((item) => (
						<button
							key={item.id}
							className={
								item.role === "user" ? "outline-user" : "outline-assistant"
							}
							onClick={() => props.onJump(item.id)}
						>
							<strong>{item.title}</strong>
							<span>{item.time}</span>
						</button>
					))}
				</div>
				</nav>
				)}
			</div>
			{props.extraAction && (
				<button
					type="button"
					className={`scratch-pad-entry${props.extraAction.active ? " active" : ""}`}
					title={props.extraAction.label}
					aria-label={props.extraAction.label}
					onClick={props.extraAction.onClick}
				>
					{props.extraAction.icon}
				</button>
			)}
			{props.terminalAction && (
				<button
					type="button"
					className={`terminal-entry${props.terminalAction.active ? " active" : ""}`}
					title={props.terminalAction.label}
					aria-label={props.terminalAction.label}
					onClick={props.terminalAction.onClick}
				>
					{props.terminalAction.icon}
				</button>
			)}
			{props.filesAction && (
				<button
					type="button"
					className={`files-entry${props.filesAction.active ? " active" : ""}`}
					title={props.filesAction.label}
					aria-label={props.filesAction.label}
					onClick={props.filesAction.onClick}
				>
					{props.filesAction.icon}
				</button>
			)}
			{props.editorsAction && (
				<button
					type="button"
					className={`editors-entry${props.editorsAction.active ? " active" : ""}`}
					title={props.editorsAction.label}
					aria-label={props.editorsAction.label}
					onClick={props.editorsAction.onClick}
				>
					{props.editorsAction.icon}
				</button>
			)}
		</div>
	);
}

const OUTLINE_TOP_STORAGE_KEY = "pi-desktop:outline-top";
function getInitialOutlineTop() {
	if (typeof window === "undefined") return 180;
	const saved = Number(localStorage.getItem(OUTLINE_TOP_STORAGE_KEY));
	if (Number.isFinite(saved) && saved > 0) return clampOutlineTop(saved);
	return clampOutlineTop(Math.round(window.innerHeight * 0.32));
}

function clampOutlineTop(value: number) {
	if (typeof window === "undefined") return value;
	return Math.min(window.innerHeight - 92, Math.max(76, value));
}

export function DrawerContent(props: {
	panel: DrawerPanel;
	project?: Project;
	files: FileTreeNode[];
	sessions: SessionSummary[];
	sessionsLoading?: boolean;
	/** Git 工作区中对比 HEAD 有变更的文件列表 */
	gitChangedFiles: { path: string; status: string }[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	pinned: boolean;
	onTogglePin: () => void;
	onCollapse: () => void;
	onClose: () => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshFiles: () => void;
	onRefreshSessions: () => void;
	onOpenSession: (session: SessionSummary) => void;
	onRenameSession: (filePath: string, newName: string) => void;
	onCopySession: (session: SessionSummary) => void | Promise<void>;
	onExportSession: (session: SessionSummary) => void | Promise<void>;
	onDeleteSession: (session: SessionSummary) => void | Promise<void>;
	onDiffFile?: DiffFileHandler;
	onOpenFile?: (path: string) => void;
	onViewFile?: (path: string) => void;
}) {
	const title =
		props.panel === "files"
			? t("drawer.files")
			: props.project
				? t("drawer.projectSessions", { name: props.project.name })
				: t("drawer.historyTitle");
	return (
		<>
			<div className="drawer-header">
				<strong>{title}</strong>
				<div className="drawer-header-actions">
					<button
						className={props.pinned ? "active" : ""}
						title={props.pinned ? t("drawer.unpin") : t("drawer.pin")}
						aria-label={props.pinned ? t("drawer.unpin") : t("drawer.pin")}
						onClick={props.onTogglePin}
					>
						<Pin size={15} />
					</button>
					<button
						disabled={props.pinned}
						title={props.pinned ? t("drawer.pinnedCannotCollapse") : t("drawer.collapsePanel")}
						aria-label={t("drawer.collapsePanel")}
						onClick={props.onCollapse}
					>
						<ChevronRight size={16} />
					</button>
					<button
						disabled={props.pinned}
						title={props.pinned ? t("drawer.pinnedCannotClose") : t("drawer.closePanel")}
						aria-label={t("drawer.closePanel")}
						onClick={props.onClose}
					>
						<X size={16} />
					</button>
				</div>
			</div>
			{props.panel === "files" && (
				<FilesPanel
					files={props.files}
					// 将 Git 变更文件列表转换为 SessionModifiedFile 格式传入 FilesPanel 展示
					modifiedFiles={props.gitChangedFiles.map((f) => ({
						path: f.path,
						toolName: "git",
						status: "done",
					}))}
					expandedDirs={props.expandedDirs}
					onToggleDirectory={props.onToggleDirectory}
					onFileContextMenu={props.onFileContextMenu}
					onRefreshFiles={props.onRefreshFiles}
					onDiffFile={props.onDiffFile}
					onOpenFile={props.onOpenFile}
					onViewFile={props.onViewFile}
				/>
			)}
			{props.panel === "sessions" && (
				<SessionsPanel
					sessions={props.sessions}
					onRefresh={props.onRefreshSessions}
					onOpen={props.onOpenSession}
					onRename={props.onRenameSession}
					onCopy={props.onCopySession}
					onExport={props.onExportSession}
					onDelete={props.onDeleteSession}
				/>
			)}
		</>
	);
}

const MODIFIED_FILES_PREVIEW_LIMIT = 5;

function FilesPanel(props: {
	files: FileTreeNode[];
	/** Git 工作区中对比 HEAD 有变更的文件；会话卡片的修改摘要不使用该数据源。 */
	modifiedFiles: SessionModifiedFile[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshFiles: () => void;
	onDiffFile?: DiffFileHandler;
	onOpenFile?: (path: string) => void;
	onViewFile?: (path: string) => void;
}) {
	const [modifiedFilesExpanded, setModifiedFilesExpanded] = useState(false);
	// 后端按修改时间升序传入；抽屉顶部优先展示最新文件，避免文件多时用户看不到刚改的内容。
	const latestModifiedFiles = [...props.modifiedFiles].reverse();
	const visibleModifiedFiles = modifiedFilesExpanded
		? latestModifiedFiles
		: latestModifiedFiles.slice(0, MODIFIED_FILES_PREVIEW_LIMIT);
	const hiddenModifiedFileCount = Math.max(
		0,
		latestModifiedFiles.length - visibleModifiedFiles.length,
	);

	return (
		<div className="files-panel">
			<div className="panel-action-row">
				<span>{t("drawer.fileItems", { count: props.files.length })}</span>
				<button onClick={props.onRefreshFiles}>{t("common.refresh")}</button>
			</div>
			{props.modifiedFiles.length > 0 && (
				<div className="modified-files-section">
					<div className="modified-files-header">
						<span>{t("drawer.gitChangedFiles")}</span>
						<small>{t("drawer.gitChangedFilesDesc")}</small>
					</div>
					{visibleModifiedFiles.map((file) => {
						const fileName = file.path.split(/[/\\]/).pop() ?? file.path;
						const isRunning = file.status === "running";
						// 构造最小的 FileTreeNode 以复用右键菜单,保持修改清单和文件树相同的打开/定位入口。
						const fakeNode: FileTreeNode = {
							name: fileName,
							path: file.path,
							relativePath: file.path,
							type: "file",
						};
						return (
							<div
								key={file.path}
								className={`modified-file-row${isRunning ? " running" : ""}`}
								title={file.path}
								onContextMenu={(e) => {
									e.preventDefault();
									props.onFileContextMenu(fakeNode, e.clientX, e.clientY);
								}}
								onClick={() => props.onDiffFile?.(file.path, file.originalContent, file.content)}
							>
								<span
									className={`modified-file-icon${isRunning ? "" : " done"}`}
								>
									{file.toolName === "git"
										? gitStatusIcon(file.status)
										: isRunning
											? "◌"
											: "✓"}
								</span>
								<span className="modified-file-name">{fileName}</span>
								{file.toolName === "git" && file.status !== "deleted" && (
									<span className="modified-file-lines">{file.status === "added" ? "新" : "改"}</span>
								)}
								{file.toolName !== "git" && Boolean(file.changedLines) && (
									<span className="modified-file-lines">
										{t("drawer.changedLines", {
											count: file.changedLines ?? 0,
										})}
									</span>
								)}
								<span className="modified-file-tool">{file.toolName}</span>
							</div>
						);
					})}
					{latestModifiedFiles.length > MODIFIED_FILES_PREVIEW_LIMIT && (
						<button
							className="modified-files-toggle"
							type="button"
							onClick={() => setModifiedFilesExpanded((current) => !current)}
						>
							{modifiedFilesExpanded
								? t("common.collapse")
								: t("drawer.moreFiles", { count: hiddenModifiedFileCount })}
						</button>
					)}
				</div>
			)}
			{props.files.map((node) => (
				<FileNode
					key={node.path}
					node={node}
					expandedDirs={props.expandedDirs}
					onToggleDirectory={props.onToggleDirectory}
					onFileContextMenu={props.onFileContextMenu}
					onOpenFile={props.onOpenFile}
					onViewFile={props.onViewFile}
					onDiffFile={props.onDiffFile}
				/>
			))}
		</div>
	);
}

export function SessionFileSummary(props: {
	files: SessionModifiedFile[];
	onOpenFile?: (path: string) => void;
	onDiffFile?: DiffFileHandler;
}) {
	const [expanded, setExpanded] = useState(false);
	const totalLines = props.files.reduce(
		(total, file) => total + (file.changedLines ?? 0),
		0,
	);
	const visibleFiles = expanded ? props.files : props.files.slice(0, 4);
	const hiddenCount = Math.max(0, props.files.length - visibleFiles.length);
	return (
		<section className="session-file-summary-list-card" aria-label={t("drawer.modifiedFilesAria")}>
			<div className="session-file-summary-title">
				<span>{t("drawer.modifiedFiles")}</span>
				<small title={t("drawer.changedLinesEstimate")}>
					{props.files.length} {t("app.files")}
					{totalLines > 0
						? ` · ${t("drawer.changedLinesShort", { count: totalLines })}`
						: ""}
				</small>
			</div>
			<ul className="session-file-summary-list">
				{visibleFiles.map((file) => {
					const fileName = file.path.split(/[/\\]/).pop() ?? file.path;
					return (
						<li key={file.path}>
							<button
								className="session-file-summary-row"
								type="button"
								title={file.path}
								onClick={() => props.onDiffFile?.(file.path, file.originalContent, file.content)}
							>
								<span className="session-file-summary-name">{fileName}</span>
								<span
									className="session-file-summary-lines"
									title={t("drawer.changedLinesEstimate")}
								>
									{file.changedLines
										? `~${t("drawer.changedLines", { count: file.changedLines })}`
										: t("drawer.changed")}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
			{props.files.length > 4 && (
				<button
					className="session-file-summary-toggle"
					type="button"
					onClick={() => setExpanded((current) => !current)}
				>
					{expanded ? t("common.collapse") : t("drawer.moreFiles", { count: hiddenCount })}
				</button>
			)}
		</section>
	);
}

function FileNode(props: {
	node: FileTreeNode;
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onOpenFile?: (path: string) => void;
	onViewFile?: (path: string) => void;
	onDiffFile?: (path: string) => void;
	depth?: number;
}) {
	const { node, expandedDirs, onToggleDirectory, depth = 0 } = props;
	const expanded = expandedDirs.has(node.path);
	// 每行保持同一个宽度，只通过 CSS 变量控制缩进；避免深层递归容器把最后一层可用宽度越压越窄。
	const rowStyle = { "--file-depth-offset": `${depth * 16}px` } as CSSProperties;
	const menu = (event: React.MouseEvent) => {
		event.preventDefault();
		props.onFileContextMenu(node, event.clientX, event.clientY);
	};
	if (node.type === "file")
		return (
			<div className="file-node" style={rowStyle}>
				<button
					className="file file-node-row"
					style={rowStyle}
					title={node.relativePath}
					onClick={() => props.onViewFile?.(node.path)}
					onContextMenu={menu}
				>
					<span className="file-node-icon">{fileIcon(node.name)}</span>
					<span className="file-node-name">{node.name}</span>
				</button>
			</div>
		);
	return (
		<div className="file-node" style={rowStyle}>
			<button
				className="directory file-node-row"
				style={rowStyle}
				onClick={() => onToggleDirectory(node.path)}
				onContextMenu={menu}
				title={node.relativePath}
			>
				<span className="file-node-icon">
					{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				</span>
				<span className="file-node-name">{node.name}</span>
			</button>
			{expanded && node.children && node.children.length > 0 && (
				<div className="file-children">
					{node.children.map((child) => (
						<FileNode
							key={child.path}
							node={child}
							expandedDirs={expandedDirs}
							onToggleDirectory={onToggleDirectory}
							onFileContextMenu={props.onFileContextMenu}
							onOpenFile={props.onOpenFile}
							onViewFile={props.onViewFile}
							onDiffFile={props.onDiffFile}
							depth={depth + 1}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function fileIcon(name: string) {
	if (/\.(ts|tsx|js|jsx)$/.test(name)) return "◇";
	if (/\.(md|mdx)$/.test(name)) return "M";
	if (/\.(json|yaml|yml)$/.test(name)) return "{}";
	return "·";
}

function gitStatusIcon(status: string): string {
	switch (status) {
		case "added":
			return "+";
		case "deleted":
			return "×";
		case "renamed":
			return "→";
		default:
			return "~";
	}
}

function SessionsPanel(props: {
	sessions: SessionSummary[];
	onRefresh: () => void;
	onOpen: (session: SessionSummary) => void;
	onRename: (filePath: string, newName: string) => void | Promise<void>;
	onCopy: (session: SessionSummary) => void | Promise<void>;
	onExport: (session: SessionSummary) => void | Promise<void>;
	onDelete: (session: SessionSummary) => void | Promise<void>;
}) {
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	const [sessionActionNotice, setSessionActionNotice] = useState<{
		filePath: string;
		text: string;
	} | null>(null);
	const [sessionActionLoading, setSessionActionLoading] = useState<{
		filePath: string;
		action: "copy" | "export" | "delete";
	} | null>(null);
	const [deleteConfirmSession, setDeleteConfirmSession] =
		useState<SessionSummary | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	function startRename(session: SessionSummary) {
		setRenamingPath(session.filePath);
		setEditValue(session.name || "");
		requestAnimationFrame(() => inputRef.current?.focus());
	}

	function confirmRename() {
		if (renamingPath && editValue.trim()) {
			void props.onRename(renamingPath, editValue.trim());
		}
		setRenamingPath(null);
		setEditValue("");
	}

	async function runSessionAction(
		session: SessionSummary,
		actionType: "copy" | "export" | "delete",
		action: () => void | Promise<void>,
		successText: string,
	) {
		setSessionActionLoading({ filePath: session.filePath, action: actionType });
		setSessionActionNotice({
			filePath: session.filePath,
			text:
				actionType === "copy"
					? t("drawer.sessionActionCopying")
					: actionType === "export"
						? t("drawer.sessionActionExporting")
						: t("drawer.sessionActionDeleting"),
		});
		try {
			await action();
			setSessionActionNotice({ filePath: session.filePath, text: successText });
			window.setTimeout(() => setSessionActionNotice(null), 1600);
		} catch (error) {
			setSessionActionNotice({
				filePath: session.filePath,
				text: error instanceof Error ? error.message : t("drawer.sessionActionFailed"),
			});
			window.setTimeout(() => setSessionActionNotice(null), 2400);
		} finally {
			setSessionActionLoading(null);
		}
	}

	return (
		<div className="sessions-panel">
			<div className="panel-action-row">
				<span>{t("drawer.sessionCount", { count: props.sessions.length })}</span>
				<button onClick={props.onRefresh}>{t("common.refresh")}</button>
			</div>
			{props.sessions.length === 0 && (
				<div className="sessions-empty">
					<strong>{t("drawer.sessionEmptyTitle")}</strong>
					<span>{t("drawer.sessionEmptyDesc")}</span>
				</div>
			)}
			{props.sessions.map((session) => (
				<div
					key={session.filePath}
					className="session-card"
				>
					{renamingPath === session.filePath ? (
						<div className="session-rename-row">
							<input
								ref={inputRef}
								value={editValue}
								onChange={(e) => setEditValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") confirmRename();
									if (e.key === "Escape") {
										setRenamingPath(null);
										setEditValue("");
									}
								}}
								autoFocus
							/>
							<button onClick={confirmRename}>{t("common.save")}</button>
							<button
								onClick={() => {
									setRenamingPath(null);
									setEditValue("");
								}}
							>
								{t("common.cancel")}
							</button>
						</div>
					) : (
						<div className="session-card-display">
							<button
								className="session-card-inner"
								onClick={() => props.onOpen(session)}
								title={session.filePath}
							>
								<div className="session-card-title">
									<strong>{session.name || t("common.untitled")}</strong>
									{session.source && session.source !== "pi" && (
										<span className={`session-source-badge ${session.source}`}>
											{t(`sessionSource.${session.source}` as any)}
										</span>
									)}
									<small>
										{new Date(session.updatedAt).toLocaleString()} ·{" "}
										{t("drawer.sessionMessages", {
											count: session.messageCount,
										})}
									</small>
								</div>
							</button>
							<div className="session-card-actions">
								<button
									className="session-rename-button"
									title={t("menu.copySession")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() =>
										void runSessionAction(
											session,
											"copy",
											() => props.onCopy(session),
											t("drawer.sessionCopied"),
										)
									}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "copy" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "copy"
											? t("menu.copying")
											: t("common.copy")}
									</span>
								</button>
								<button
									className="session-rename-button"
									title={t("menu.exportHtml")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() =>
										void runSessionAction(
											session,
											"export",
											() => props.onExport(session),
											t("drawer.sessionExported"),
										)
									}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "export" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "export"
											? t("menu.exporting")
											: t("common.export")}
									</span>
								</button>
								<button
									className="session-rename-button"
									title={t("common.rename")}
									onClick={() => startRename(session)}
								>
									<span>{t("common.rename")}</span>
								</button>
								<button
									className="session-rename-button danger"
									title={t("common.delete")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() => setDeleteConfirmSession(session)}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "delete" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "delete"
											? t("drawer.sessionActionDeleting")
											: t("common.delete")}
									</span>
								</button>
							</div>
							{sessionActionNotice?.filePath === session.filePath && (
								<div className="session-action-notice">{sessionActionNotice.text}</div>
							)}
						</div>
					)}
				</div>
			))}
			{deleteConfirmSession && (
				<div className="session-delete-confirm-backdrop" onClick={() => setDeleteConfirmSession(null)}>
					<section
						className="session-delete-confirm"
						onClick={(event) => event.stopPropagation()}
					>
						<strong>{t("drawer.sessionDeleteTitle")}</strong>
						<p>
							{t("drawer.sessionDeleteBody", {
								name: deleteConfirmSession.name || t("common.untitled"),
							})}
						</p>
						<div className="session-delete-confirm-actions">
							<button onClick={() => setDeleteConfirmSession(null)}>{t("common.cancel")}</button>
							<button
								className="danger"
								onClick={() => {
									const target = deleteConfirmSession;
									setDeleteConfirmSession(null);
									void runSessionAction(
										target,
										"delete",
										() => props.onDelete(target),
										t("drawer.sessionDeleted"),
									);
								}}
							>
								{t("common.delete")}
							</button>
						</div>
					</section>
				</div>
			)}
		</div>
	);
}

export function SessionHistoryModal(props: {
	project: Project;
	sessions: SessionSummary[];
	loading: boolean;
	onClose: () => void;
	onRefresh: () => void;
	onOpen: (session: SessionSummary) => void;
	onRename: (filePath: string, newName: string) => void | Promise<void>;
	onCopy: (session: SessionSummary) => void | Promise<void>;
	onExport: (session: SessionSummary) => void | Promise<void>;
	onDelete: (session: SessionSummary) => void | Promise<void>;
}) {
	return (
		<div className="picker-backdrop session-history-backdrop" onClick={props.onClose}>
			<section
				className="session-history-modal command-palette"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="command-palette-header session-history-header">
					<div>
						<strong>{t("drawer.historyTitle")}</strong>
						<span>{props.project.name}</span>
					</div>
					<IconButton
						className="command-palette-close"
						label={t("common.close")}
						onClick={props.onClose}
					>
						<X size={16} strokeWidth={2.2} aria-hidden="true" />
					</IconButton>
				</div>
				<div className="session-history-path" title={props.project.path}>
					{props.project.path}
				</div>
				<div className="session-history-body">
					{props.loading ? (
						<div className="session-history-loading">
							<div className="loader" />
							<span>{t("drawer.historyLoading")}</span>
						</div>
					) : (
						<SessionsPanel
							sessions={props.sessions}
							onRefresh={props.onRefresh}
							onOpen={props.onOpen}
							onRename={props.onRename}
							onCopy={props.onCopy}
							onExport={props.onExport}
							onDelete={props.onDelete}
						/>
					)}
				</div>
			</section>
		</div>
	);
}

export function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.flatMap((node) =>
		node.type === "file" ? [node] : flattenFiles(node.children ?? []),
	);
}

export type ComposerSuggestionResult = {
	text: string;
	cursor: number;
};

export type ComposerTrigger = {
	start: number;
	char: string;
	query: string;
};

/**
 * 在光标位置检测 @ / 触发器。
 *
 * 早期实现用「整段 prompt 最后一个空白分词」判定,完全忽略光标位置,
 * 导致光标停在文字中间时,末尾分词在光标之后,文件/skill 菜单无法弹出。
 * 这里改为以光标为锚:取光标前最后一个 @ 或 /,要求从该字符到光标之间
 * 连续无空白、无其它触发符,再要求触发符前一字符不是字母/数字(避免误判
 * email@host、路径 a/b、URL https://)。这样「写一段话@文件」「用/ppt」
 * 也能在文字中间唤出引用/命令菜单。
 */
export function detectTrigger(
	text: string,
	cursor: number,
): ComposerTrigger | null {
	if (cursor < 0 || cursor > text.length) cursor = text.length;
	const before = text.slice(0, cursor);
	const atIdx = before.lastIndexOf("@");
	const slashIdx = before.lastIndexOf("/");
	const start = Math.max(atIdx, slashIdx);
	if (start < 0) return null;
	const char = before[start];
	const segment = before.slice(start + 1);
	// 触发符到光标之间必须连续(无空白、无其它 @ /),否则不是同一个触发上下文。
	if (/[\s@/]/.test(segment)) return null;
	const prevChar = start > 0 ? before[start - 1] : "";
	if (prevChar) {
		// 允许字母/数字前置(中文写作不打空格的习惯同样适用于英文上下文)。
		// 仅 URL 协议(://)与路径分隔符(/usr/bin)不触发,
		// email@host 的 @ 虽然会触发但不影响体验(选了文件后自然替换掉)。
		if (/[:/]/.test(prevChar)) return null;
	}
	return { start, char, query: segment };
}

export function applySuggestion(
	current: string,
	cursor: number,
	value: string,
): ComposerSuggestionResult {
	const trigger = detectTrigger(current, cursor);
	if (!trigger) {
		const text = `${current}${value} `;
		return { text, cursor: text.length };
	}
	// 用选中项替换「触发符 .. 光标」这一段,保留光标之后的文本。
	const text = `${current.slice(0, trigger.start)}${value} ${current.slice(cursor)}`;
	return { text, cursor: trigger.start + value.length + 1 };
}

export function clearSuggestionTrigger(
	current: string,
	cursor: number,
): ComposerSuggestionResult {
	const trigger = detectTrigger(current, cursor);
	if (!trigger) return { text: current, cursor };
	const text = `${current.slice(0, trigger.start)}${current.slice(cursor)}`;
	return { text, cursor: trigger.start };
}

export type SuggestionItem = {
	key: string;
	label: string;
	description: string;
	value: string;
};

export function buildSuggestionItems(
	prompt: string,
	cursor: number,
	commands: PiCommand[],
	files: FileTreeNode[],
): SuggestionItem[] {
	const allCommands = mergeCommands(commands);
	const trigger = detectTrigger(prompt, cursor);
	if (!trigger) return [];
	const keyword = trigger.query.toLowerCase();
	if (trigger.char === "/") {
		return allCommands
			.map((command, index) => ({ command, index }))
			.filter(({ command }) => command.name.toLowerCase().includes(keyword))
			.sort((a, b) => {
				const aPinned = PINNED_COMMAND_NAMES.has(a.command.name);
				const bPinned = PINNED_COMMAND_NAMES.has(b.command.name);
				if (aPinned !== bPinned) return aPinned ? -1 : 1;
				return a.index - b.index;
			})
			.map(({ command }) => ({
				key: command.name,
				label: `/${command.name}`,
				description: command.description ?? "",
				value: `/${command.name}`,
			}));
	}
	if (trigger.char === "@") {
		return files
			.map((file) => ({
				file,
				score:
					fuzzyScore(file.relativePath, keyword) +
					fuzzyScore(file.name, keyword) * 2,
			}))
			.filter((item) => item.score > 0 || !keyword)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8)
			.map((item) => ({
				key: item.file.path,
				label: `@${item.file.name}`,
				description: item.file.relativePath,
				value: `@${item.file.relativePath}`,
			}));
	}
	return [];
}

export function mergeCommands(commands: PiCommand[]) {
	const visibleCommands = commands.filter(isVisibleDesktopCommand);
	const names = new Set(visibleCommands.map((command) => command.name));
	const extras = getBuiltinCommands().filter(
		(command) => !names.has(command.name) && isVisibleDesktopCommand(command),
	);
	return [...visibleCommands, ...extras];
}

const PINNED_COMMAND_NAMES = new Set<string>();
const HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES = new Set([
	"new",
	"model",
	"resume",
	"fork",
	"name",
	"session",
	"tree",
	"clone",
	"copy",
	"export",
	"share",
	"settings",
	"reload",
	"hotkeys",
	"login",
	"logout",
	// goal 模式暂不作为桌面端推荐命令展示,避免当前版本引导用户使用未稳定能力。
	"goal",
]);

function isBuiltinDesktopCommand(command: PiCommand) {
	// get_commands 可能返回 source 为空的 pi 内置命令;扩展/skill 命令通常带有自己的 source。
	// Desktop 只隐藏 CLI 内置命令,避免误伤用户自己安装的同名扩展能力。
	return command.source == null || command.source === "builtin";
}

function isVisibleDesktopCommand(command: PiCommand) {
	return !(
		isBuiltinDesktopCommand(command) &&
		HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES.has(command.name.toLowerCase())
	);
}

// pi 内置斜杠命令,get_commands 只返回扩展注册的命令,这些需要手动补充
// desktop 已有独立 UI 入口或在 desktop 中不适合执行的命令由 HIDDEN_DESKTOP_COMMAND_NAMES 统一过滤。
function getBuiltinCommands(): PiCommand[] {
	return [
	{
		name: "session",
		description: t("prompt.command.session.description"),
		source: "builtin",
	},
	{
		name: "tree",
		description: t("prompt.command.tree.description"),
		source: "builtin",
	},
	{ name: "clone", description: t("prompt.command.clone.description"), source: "builtin" },
	{
		name: "compact",
		description: t("prompt.command.compact.description"),
		source: "builtin",
	},
	{ name: "copy", description: t("prompt.command.copy.description"), source: "builtin" },
	{ name: "export", description: t("prompt.command.export.description"), source: "builtin" },
	{
		name: "share",
		description: t("prompt.command.share.description"),
		source: "builtin",
	},
	{ name: "settings", description: t("prompt.command.settings.description"), source: "builtin" },
	{ name: "reload", description: t("prompt.command.reload.description"), source: "builtin" },
	{ name: "hotkeys", description: t("prompt.command.hotkeys.description"), source: "builtin" },
	{
		name: "login",
		description: t("prompt.command.login.description"),
		source: "builtin",
	},
	{ name: "logout", description: t("prompt.command.logout.description"), source: "builtin" },
	];
}

export function PromptSuggestions(props: {
	prompt: string;
	items: SuggestionItem[];
	selectedIndex: number;
	onSelectedIndexChange: (index: number) => void;
	onClose: () => void;
	onPick: (value: string) => void;
	/** 菜单锚定位置（屏幕坐标），未传则使用默认居中定位 */
	anchorStyle?: React.CSSProperties;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	// 头部标题类型由选中项推导:光标相关触发后,第一个候选的 value 前缀即代表当前是命令还是文件。
	const isCommand = props.items[0]?.value.startsWith("/") ?? false;

	// 滚动到选中项
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const item = list.children[props.selectedIndex] as HTMLElement;
		if (item) {
			item.scrollIntoView({ block: "nearest" });
		}
	}, [props.selectedIndex]);

	if (props.items.length === 0) return null;

	// 阻止 mousedown 冒泡到 RichInput，避免点击面板时触发 blur 关闭面板，
	// 但保留各按钮的 onClick 正常工作。
	return (
		<div
			className="command-palette"
			style={props.anchorStyle}
			onMouseDown={(e) => e.preventDefault()}
		>
			<div className="command-palette-header">
				<span>{isCommand ? t("prompt.commands") : t("prompt.files")}</span>
				<IconButton
					className="command-palette-close"
					label={t("common.close")}
					onClick={props.onClose}
				>
					<X size={16} strokeWidth={2.2} aria-hidden="true" />
				</IconButton>
			</div>
			<div className="command-palette-list" ref={listRef}>
				{props.items.map((item, index) => (
					<button
						key={item.key}
						className={`command-palette-item${index === props.selectedIndex ? " selected" : ""}`}
						onMouseEnter={() => props.onSelectedIndexChange(index)}
						onClick={() => props.onPick(item.value)}
					>
						<span className="command-palette-label">{item.label}</span>
						<span className="command-palette-desc">{item.description}</span>
					</button>
				))}
			</div>
			<div className="command-palette-footer">
				<span>{t("prompt.selectHint")}</span>
				<span>{t("prompt.confirmHint")}</span>
				<span>{t("prompt.closeHint")}</span>
			</div>
		</div>
	);
}

export function ConfirmDialog(props: {
	title: string;
	message: string;
	onConfirm: () => void;
	onCancel: () => void;
	confirmLabel?: string;
	danger?: boolean;
}) {
	return (
		<div className="config-modal-overlay" onClick={props.onCancel}>
			<div className="config-modal-dialog" onClick={(e) => e.stopPropagation()}>
				<strong>{props.title}</strong>
				<p>{props.message}</p>
				<div className="config-modal-actions">
					<button className="config-btn" onClick={props.onCancel}>
						{t("common.cancel")}
					</button>
					<button
						className={`config-btn${props.danger ? " danger" : " primary"}`}
						onClick={props.onConfirm}
					>
						{props.confirmLabel ?? t("common.confirm")}
					</button>
				</div>
			</div>
		</div>
	);
}

export function FileContextMenu(props: {
	menu: { x: number; y: number; node: FileTreeNode };
	onClose: () => void;
	onOpen: () => void;
	onReveal: () => void;
	onAttach: () => void;
	onCopyPath: () => void;
	onDelete?: () => void;
	onRename?: () => void;
}) {
	const menuRef = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState({ x: props.menu.x, y: props.menu.y });
	const isFile = props.menu.node.type === "file";
	const isDir = props.menu.node.type === "directory";

	// 测量菜单实际高度，超底部时向上翻转，避免底部文件右键菜单被视口遮挡。
	// 翻转后至少保留 8px 上边距，使菜单始终可读。
	useEffect(() => {
		const el = menuRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const overflowY = rect.bottom - window.innerHeight;
		if (overflowY > 0) {
			setPos({ x: props.menu.x, y: Math.max(8, props.menu.y - rect.height) });
		}
	}, [props.menu.x, props.menu.y]);

	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				ref={menuRef}
				className="context-menu"
				style={{ left: pos.x, top: pos.y }}
				onClick={(event) => event.stopPropagation()}
			>
				<button disabled={!isFile} onClick={props.onAttach}>
					{t("menu.attachFile")}
				</button>
				<button disabled={!isFile} onClick={props.onOpen}>
					{t("menu.defaultOpen")}
				</button>
				<button onClick={props.onReveal}>{t("menu.revealFile")}</button>
				<button onClick={props.onCopyPath}>{t("menu.copyPath")}</button>
				{props.onRename && (
					<button onClick={props.onRename}>{t("common.rename")}</button>
				)}
				{props.onDelete && (
					<button className="danger" onClick={props.onDelete}>
						{t("common.delete")}
					</button>
				)}
			</div>
		</div>
	);
}

export function ProjectContextMenu(props: {
	menu: { x: number; y: number; project: Project };
	onClose: () => void;
	onRevealProject: () => void;
	onImportCodexSessions: () => void;
	onImportClaudeSessions: () => void;
	onImportOpenCodeSessions: () => void;
	onManageProjectResources: () => void;
	onFilterSessions: () => void;
	onRemoveProject: () => void;
}) {
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: props.menu.x, top: props.menu.y }}
				onClick={(event) => event.stopPropagation()}
			>
				<button onClick={props.onRevealProject}>{t("menu.revealProject")}</button>
				<button onClick={props.onImportCodexSessions}>
					{t("menu.importCodex")}
				</button>
				<button onClick={props.onImportClaudeSessions}>
					{t("menu.importClaude")}
				</button>
				<button onClick={props.onImportOpenCodeSessions}>
					{t("menu.importOpenCode")}
				</button>
				<hr className="context-separator" />
				<button onClick={props.onManageProjectResources}>{t("menu.projectResources")}</button>
				<hr className="context-separator" />
				<button onClick={props.onFilterSessions}>{t("menu.filterSessions")}</button>
				<hr className="context-separator" />
				<button onClick={props.onRemoveProject}>{t("menu.removeProject")}</button>
			</div>
		</div>
	);
}

export function AgentContextMenu(props: {
	menu: { x: number; y: number; agent: AgentTab };
	actionLoading?: "copy" | "export" | null;
	onClose: () => void;
	onRename: () => void;
	onExport: () => void;
	onCopySession: () => void;
	onToggleRpcLogging?: () => void;
	isRpcLogging?: boolean;
	onOpenLogFile?: () => void;
	onCloseAgent: () => void;
}) {
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: props.menu.x, top: props.menu.y }}
				onClick={(event) => event.stopPropagation()}
			>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onRename}>{t("common.rename")}</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onCopySession}>
					{props.actionLoading === "copy" && <span className="mini-loader" />}
					{props.actionLoading === "copy" ? t("menu.copying") : t("menu.copySession")}
				</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onExport}>
					{props.actionLoading === "export" && <span className="mini-loader" />}
					{props.actionLoading === "export" ? t("menu.exporting") : t("menu.exportHtml")}
				</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onToggleRpcLogging}>
					{props.isRpcLogging ? `✓ ${t("menu.rpcLoggingOn")}` : t("menu.rpcLogging")}
				</button>
				{props.isRpcLogging && (
					<button disabled={Boolean(props.actionLoading)} onClick={props.onOpenLogFile}>
						{t("menu.rpcLogFile")}
					</button>
				)}
				<button className="danger" onClick={props.onCloseAgent}>{t("menu.closeAgent")}</button>
			</div>
		</div>
	);
}

export function SessionContextMenu(props: {
	menu: { x: number; y: number; session: SessionSummary };
	actionLoading?: "copy" | "export" | null;
	onClose: () => void;
	onRename: () => void;
	onExport: () => void;
	onCopySession: () => void;
	onShowLogs?: () => void;
	onDeleteSession: () => void;
}) {
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: props.menu.x, top: props.menu.y }}
				onClick={(event) => event.stopPropagation()}
			>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onRename}>{t("common.rename")}</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onCopySession}>
					{props.actionLoading === "copy" && <span className="mini-loader" />}
					{props.actionLoading === "copy" ? t("menu.copying") : t("menu.copySession")}
				</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onExport}>
					{props.actionLoading === "export" && <span className="mini-loader" />}
					{props.actionLoading === "export" ? t("menu.exporting") : t("menu.exportHtml")}
				</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onShowLogs}>{t("menu.rpcLogs")}</button>
				<button
					className="danger"
					disabled={Boolean(props.actionLoading)}
					onClick={props.onDeleteSession}
				>
					{t("common.delete")}
				</button>
			</div>
		</div>
	);
}

function fuzzyScore(value: string, keyword: string) {
	if (!keyword) return 1;
	const text = value.toLowerCase();
	const query = keyword.toLowerCase();
	if (text.includes(query)) return 100 + query.length;
	let score = 0;
	let pos = 0;
	for (const ch of query) {
		const found = text.indexOf(ch, pos);
		if (found === -1) return 0;
		score += found === pos ? 8 : 2;
		pos = found + 1;
	}
	return score;
}

export function SettingsModal(props: {
	settings: AppSettings;
	notice: string;
	piStatus: PiInstallStatus | null;
	piChecking: boolean;
	piProxyChecking: boolean;
	piProxyNotice: string;
	piProxyNoticeTone: "info" | "success" | "error";
	webServiceChanging: boolean;
	appInfo: AppInfo;
	customPiPath: string;
	customPathValidating: boolean;
	customPathResult: PiInstallStatus | null;
	updateChecking: boolean;
	piUpdating: boolean;
	piUpdateChecking: boolean;
	piUpdateCheck: PiUpdateCheckResult | null;
	piUpdateResult: PiCliUpdateResult | null;
	onCustomPathChange: (path: string) => void;
	onValidateCustomPath: () => void;
	onClearCustomPath: () => void;
	onCheckPi: () => void;
	onTestPiProxy: () => void;
	onCheckUpdate: () => void;
	onCheckPiUpdate: () => void;
	onUpdatePi: () => void;
	onToggleDevTools: () => void;
	onRestartApp: () => void;
	onOpenWebService: (port: string) => void;
	onClose: () => void;
	onChange: (patch: Partial<AppSettings>) => void;
}) {
	const [activeTab, setActiveTab] = useState<SettingsTabId>("base");
	const [webPortDraft, setWebPortDraft] = useState(String(props.settings.webServicePort));
	const piPath = props.settings.customPiPath || props.piStatus?.command || "";
	useEffect(() => {
		setWebPortDraft(String(props.settings.webServicePort));
	}, [props.settings.webServicePort]);

	// 宠物包列表：异步加载内置 + petdex 社区包，供选择下拉使用
	const [petOptions, setPetOptions] = useState<{ value: string; label: string }[]>([]);
	// 完整宠物清单（含 spritesheetUrl / 描述），用于选择预览：仅靠 id 无法加载图，需清单里的 url。
	const [petList, setPetList] = useState<PetManifest[]>([]);
	useEffect(() => {
		window.piDesktop.pet
			.list()
			.then((pets) => { setPetList(pets); setPetOptions(pets.map((p) => ({ value: p.id, label: p.displayName }))); })
			.catch(() => undefined);
	}, []);
	// 宠物动画预览模式：下拉选中值需受控，避免选完弹回"自动"
	const [petPreviewMode, setPetPreviewMode] = useState("__auto");
	const applyWebPortDraft = () => {
		const port = Number(webPortDraft);
		if (Number.isInteger(port) && port >= 1 && port <= 65535 && port !== props.settings.webServicePort) {
			props.onChange({ webServicePort: port });
		} else {
			setWebPortDraft(String(props.settings.webServicePort));
		}
	};
	const tabs: Array<{
		id: SettingsTabId;
		label: string;
		description: string;
		icon: ReactNode;
	}> = [
		{
			id: "base",
			label: t("settings.tabs.base"),
			description: t("settings.tabs.baseDesc"),
			icon: <Settings2 size={16} />,
		},
		{
			id: "proxy",
			label: t("settings.tabs.proxy"),
			description: t("settings.tabs.proxyDesc"),
			icon: <Network size={16} />,
		},
		{
			id: "web",
			label: t("settings.tabs.web"),
			description: t("settings.tabs.webDesc"),
			icon: <Globe2 size={16} />,
		},
		{
			id: "dev",
			label: t("settings.tabs.dev"),
			description: t("settings.tabs.devDesc"),
			icon: <Wrench size={16} />,
		},
		{
			id: "pet",
			label: t("settings.tabs.pet"),
			description: t("settings.tabs.petDesc"),
			icon: <PawPrint size={16} />,
		},
	];
	const themeOptions = [
		{ value: "system", label: t("settings.themeSystem") },
		{ value: "light", label: t("settings.themeLight") },
		{ value: "dark", label: t("settings.themeDark") },
	];
	const lightBackgroundOptions = [
		{ value: "white", label: t("settings.lightBackgroundWhite") },
		{ value: "warm", label: t("settings.lightBackgroundWarm") },
		{ value: "paper", label: t("settings.lightBackgroundPaper") },
		{ value: "blue", label: t("settings.lightBackgroundBlue") },
		{ value: "green", label: t("settings.lightBackgroundGreen") },
	];
	const languageOptions = [
		{ value: "system", label: t("settings.languageSystem") },
		{ value: "zh-CN", label: t("settings.languageZh") },
		{ value: "en-US", label: t("settings.languageEn") },
		{ value: "pseudo", label: t("settings.languagePseudo") },
	];
	const sendShortcutOptions = [
		{ value: "enter-send", label: t("settings.sendShortcut.enter") },
		{ value: "ctrl-enter-send", label: t("settings.sendShortcut.ctrl") },
		{ value: "shift-enter-send", label: t("settings.sendShortcut.shift") },
	];
	const linkOpenModeOptions = [
		{ value: "external", label: t("settings.linkOpenMode.external") },
		{ value: "internal", label: t("settings.linkOpenMode.internal") },
	];
	const lightBackgroundDisabled = props.settings.theme === "dark";

	return (
		<div className="modal-backdrop">
			<div
				className="settings-modal"
			>
				<div className="modal-header">
					<strong>{t("settings.title")}</strong>
					<CloseIconButton
						label={t("common.close")}
						onClick={props.onClose}
					/>
				</div>
				<div className="settings-layout">
					<nav className="settings-tabs" aria-label={t("settings.title")}>
						{tabs.map((tab) => (
							<button
								key={tab.id}
								className={activeTab === tab.id ? "active" : ""}
								onClick={() => setActiveTab(tab.id)}
							>
								<span className="settings-tab-icon">{tab.icon}</span>
								<span>
									<strong>{tab.label}</strong>
									<small>{tab.description}</small>
								</span>
							</button>
						))}
					</nav>
					<div className="settings-panel">
						{activeTab === "base" && (
							<>
								<SettingsSection title={t("settings.interface")}>
									<SelectField
										className="setting-field"
										label={t("settings.theme")}
										value={props.settings.theme}
										options={themeOptions}
										onChange={(value) =>
											props.onChange({
												theme: value as AppSettings["theme"],
											})
										}
									/>
									<SelectField
										className="setting-field"
										label={t("settings.lightBackground")}
										description={
											lightBackgroundDisabled
												? t("settings.lightBackgroundDisabledDesc")
												: t("settings.lightBackgroundDesc")
										}
										disabled={lightBackgroundDisabled}
										value={props.settings.lightBackground}
										options={lightBackgroundOptions}
										onChange={(value) =>
											props.onChange({
												lightBackground: value as AppSettings["lightBackground"],
											})
										}
									/>
									<SelectField
										className="setting-field"
										label={t("settings.language")}
										value={props.settings.language}
										options={languageOptions}
										onChange={(value) =>
											props.onChange({
												language: value as AppSettings["language"],
											})
										}
									/>
									<SettingSwitch
										title={t("settings.nativeTitleBar")}
										checked={props.settings.useNativeTitleBar}
										onChange={(checked) =>
											props.onChange({ useNativeTitleBar: checked })
										}
									/>
									<SettingSwitch
										title={t("settings.nativeMenu")}
										checked={props.settings.showNativeMenu}
										onChange={(checked) =>
											props.onChange({ showNativeMenu: checked })
										}
									/>
								</SettingsSection>
								<SettingsSection title={t("settings.notificationSection")}>
									<SettingSwitch
										title={t("settings.closeToTray")}
										checked={props.settings.closeToTray}
										onChange={(checked) =>
											props.onChange({ closeToTray: checked })
										}
									/>
									<SettingSwitch
										title={t("settings.enableNotifications")}
										checked={props.settings.enableNotifications}
										onChange={(checked) =>
											props.onChange({ enableNotifications: checked })
										}
									/>
									<SettingSwitch
										title={t("settings.showThinking")}
										description={t("settings.showThinkingDesc")}
										checked={props.settings.showThinking}
										onChange={(checked) =>
											props.onChange({ showThinking: checked })
										}
									/>
									<SelectField
										className="setting-field"
										label={t("settings.inputShortcut")}
										value={props.settings.sendShortcut}
										options={sendShortcutOptions}
										onChange={(value) =>
											props.onChange({
												sendShortcut:
													value as AppSettings["sendShortcut"],
											})
										}
									/>
									<TextField
										className="setting-field"
										label={t("settings.rpcTimeout")}
										type="number"
										value={String(Math.round(props.settings.rpcTimeout / 1000))}
										description={t("settings.rpcTimeoutDesc")}
										onChange={(value) => {
											// 防止用户设置过小的超时导致 RPC 调用频繁超时，最低 600 秒
											const seconds = Math.max(600, parseInt(value) || 600);
											props.onChange({ rpcTimeout: seconds * 1000 });
										}}
									/>
									<SelectField
										className="setting-field"
										label={t("settings.linkOpenMode")}
										description={t("settings.linkOpenModeDesc")}
										value={props.settings.linkOpenMode}
										options={linkOpenModeOptions}
										onChange={(value) =>
											props.onChange({
												linkOpenMode: value as AppSettings["linkOpenMode"],
											})
										}
									/>
									<TextField
										className="setting-field"
										label={t("settings.maxEditorFileSize")}
										description={t("settings.maxEditorFileSizeDesc")}
										type="number"
										value={String(props.settings.maxEditorFileSizeMB)}
										onChange={(value) => {
											const mb = Math.max(1, parseInt(value) || 5);
											props.onChange({ maxEditorFileSizeMB: mb });
										}}
									/>
								</SettingsSection>
								<SettingsSection title={t("settings.privacy")}>
									<SettingSwitch
										title={t("settings.telemetry")}
										description={t("settings.telemetryDesc")}
										checked={props.settings.telemetryEnabled}
										onChange={(checked) =>
											props.onChange({ telemetryEnabled: checked })
										}
									/>
								</SettingsSection>
							</>
						)}
						{activeTab === "proxy" && (
							<>
								<SettingsSection
									title={t("settings.piProxy")}
									description={t("settings.piProxyDesc")}
								>
									<SettingSwitch
										title={t("settings.enablePiProxy")}
										description={t("settings.settingTakesEffectAfterRestart")}
										checked={props.settings.piProxyEnabled}
										onChange={(checked) =>
											props.onChange({ piProxyEnabled: checked })
										}
									/>
									{props.settings.piProxyEnabled && (
										<div className="setting-proxy-panel">
											<TextField
												className="setting-field"
												label={t("settings.proxyUrl")}
												value={props.settings.piProxyUrl}
												placeholder="http://127.0.0.1:7890"
												onChange={(value) =>
													props.onChange({ piProxyUrl: value })
												}
											/>
											<TextField
												className="setting-field"
												label={t("settings.proxyBypass")}
												value={props.settings.piProxyBypass}
												placeholder="localhost,127.0.0.1,::1"
												description={t("settings.noProxyHint")}
												onChange={(value) =>
													props.onChange({ piProxyBypass: value })
												}
											/>
											<div className="setting-row">
												<div>
													<strong>{t("settings.proxyTest")}</strong>
													<small>
														{t("settings.proxyNoApiKey")}
													</small>
													{props.piProxyNotice && (
														<small
															className={`setting-status ${props.piProxyNoticeTone}`}
														>
															{props.piProxyNotice}
														</small>
													)}
												</div>
												<Button
													onClick={props.onTestPiProxy}
													disabled={props.piProxyChecking}
												>
													{props.piProxyChecking ? t("settings.testingProxy") : t("settings.testProxy")}
												</Button>
											</div>
										</div>
									)}
								</SettingsSection>
								<SettingsSection
									title={t("settings.desktopProxy")}
									description={t("settings.desktopProxyDesc")}
								>
									<SettingSwitch
										title={t("settings.enableDesktopProxy")}
										description={t("settings.desktopProxyDesc")}
										checked={props.settings.desktopProxyEnabled}
										onChange={(checked) =>
											props.onChange({ desktopProxyEnabled: checked })
										}
									/>
									{props.settings.desktopProxyEnabled && (
										<div className="setting-proxy-panel">
											<TextField
												className="setting-field"
												label={t("settings.proxyUrl")}
												value={props.settings.desktopProxyUrl}
												placeholder="http://127.0.0.1:7890"
												onChange={(value) =>
													props.onChange({ desktopProxyUrl: value })
												}
											/>
											<TextField
												className="setting-field"
												label={t("settings.proxyBypass")}
												value={props.settings.desktopProxyBypass}
												placeholder="localhost,127.0.0.1,::1"
												description={t("settings.electronProxyHint")}
												onChange={(value) =>
													props.onChange({ desktopProxyBypass: value })
												}
											/>
										</div>
									)}
								</SettingsSection>
							</>
						)}
						{activeTab === "web" && (
							<SettingsSection
								title={t("settings.webLocalService")}
								description={t("settings.webLocalServiceDesc")}
							>
								<SettingSwitch
									title={t("settings.enableWebService")}
									description={
										props.webServiceChanging
											? t("settings.webOpening")
											: t("settings.webOffDesc")
									}
									checked={props.settings.webServiceEnabled}
									disabled={props.webServiceChanging}
									onChange={(checked) =>
										props.onChange({ webServiceEnabled: checked })
									}
								/>
								<div className="web-endpoint-panel">
									<div className="web-endpoint-grid">
										<div className="web-endpoint-metric">
											<span>{t("common.host")}</span>
											<code>{props.settings.webServiceHost}</code>
										</div>
										<label className="web-endpoint-metric editable">
											<span>{t("common.port")}</span>
											<input
												type="number"
												min={1}
												max={65535}
												value={webPortDraft}
												disabled={props.webServiceChanging}
												onChange={(event) => setWebPortDraft(event.target.value)}
												onBlur={applyWebPortDraft}
												onKeyDown={(event) => {
													if (event.key === "Enter") {
														event.preventDefault();
														applyWebPortDraft();
														event.currentTarget.blur();
													}
												}}
											/>
										</label>
									</div>
									<div className="web-endpoint-summary">
										<span className={props.settings.webServiceEnabled ? "online" : ""} />
										<div>
											<strong>
												http://127.0.0.1:{webPortDraft || props.settings.webServicePort}
											</strong>
											<small>{t("settings.localWebHint")}</small>
										</div>
										<Button
											buttonSize="sm"
											disabled={!props.settings.webServiceEnabled}
											onClick={() => props.onOpenWebService(webPortDraft || String(props.settings.webServicePort))}
										>
											{t("common.open")}
										</Button>
									</div>
								</div>
							</SettingsSection>
						)}
						{activeTab === "dev" && (
							<>
								<SettingsSection title={t("settings.environment")}>
									<div className="setting-row">
										<div>
											<strong>{t("settings.piEnvironment")}</strong>
											<small>
												{props.piStatus
													? props.piStatus.installed
														? t("settings.foundPi", {
																version: props.piStatus.version ?? "pi",
															})
														: t("settings.piMissing")
													: t("settings.piCliAvailable")}
											</small>
											{piPath && (
												<small className="setting-path">
													{t("settings.currentPath", { path: piPath })}
												</small>
											)}
											{props.piStatus && !props.piStatus.installed && props.piStatus.error && (
												<small className="setting-status error setting-error-detail">
													{t("settings.detectFailed", {
														error: props.piStatus.error,
													})}
												</small>
											)}
										</div>
										<Button onClick={props.onCheckPi} disabled={props.piChecking}>
											{props.piChecking ? t("settings.detecting") : t("settings.detectEnvironment")}
										</Button>
									</div>
									<div className="setting-pi-path-panel">
										<TextField
											className="setting-field"
											label={t("settings.customPiPath")}
											value={props.customPiPath}
											placeholder={
												piPath ||
												"D:\\mise-data\\installs\\node\\24 13 0\\pi.cmd"
											}
											description={t("settings.customPiPathHint")}
											disabled={props.customPathValidating}
											onChange={props.onCustomPathChange}
										/>
										<div className="setting-pi-path-actions">
											<Button
												onClick={props.onValidateCustomPath}
												disabled={!props.customPiPath.trim() || props.customPathValidating}
											>
												{props.customPathValidating
													? t("settings.validating")
													: t("settings.validatePiPath")}
											</Button>
											<Button
												onClick={props.onClearCustomPath}
												disabled={!props.settings.customPiPath || props.customPathValidating}
											>
												{t("settings.clearCustomPiPath")}
											</Button>
										</div>
										{props.customPathResult && (
											<small className={`setting-status ${props.customPathResult.installed ? "success" : "error"}`}>
												{props.customPathResult.installed
													? t("settings.validatePassed", {
															value:
																props.customPathResult.command ??
																props.customPathResult.version ??
																"pi",
														})
													: t("settings.validateFailed", {
															error:
																props.customPathResult.error ??
																t("environment.unableToRun"),
														})}
											</small>
										)}
									</div>
									<div className="setting-row">
										<div>
											<strong>{t("settings.currentVersion")}</strong>
											<small>v{props.appInfo.version}</small>
										</div>
										<Button onClick={props.onCheckUpdate} loading={props.updateChecking}>{t("settings.checkUpdate")}</Button>
									</div>
									<div className="setting-row">
										<div>
											<strong>{t("settings.piUpdate")}</strong>
											<small>{t("settings.piUpdateDesc")}</small>
											<small className="setting-status info">
												{t("settings.piUpdateVersions", {
													current: props.piUpdateCheck?.currentVersion ?? props.piStatus?.version ?? "-",
													latest: props.piUpdateCheck?.latestVersion ?? "-",
												})}
											</small>
										</div>
										<div className="setting-inline-actions">
											<Button onClick={props.onCheckPiUpdate} loading={props.piUpdateChecking}>{t("settings.checkPiUpdate")}</Button>
											<Button onClick={props.onUpdatePi} loading={props.piUpdating} disabled={!props.piUpdateCheck?.hasUpdate}>{t("settings.updatePi")}</Button>
										</div>
									</div>
									{props.piUpdateResult && (
										<pre className="setting-update-output">{props.piUpdateResult.command}\n{props.piUpdateResult.output}</pre>
									)}
								</SettingsSection>
								<SettingsSection title={t("settings.debug")}>
									<div className="setting-row">
										<div>
											<strong>{t("settings.restartApp")}</strong>
											<small>{t("settings.restartAppDesc")}</small>
										</div>
										<Button onClick={props.onRestartApp}>
											{t("settings.restartAppButton")}
										</Button>
									</div>
									<div className="setting-row">
										<div>
											<strong>{t("settings.devTools")}</strong>
											<small>{t("settings.devToolsDesc")}</small>
										</div>
										<Button onClick={props.onToggleDevTools}>
											{t("settings.toggle")}
										</Button>
									</div>
								</SettingsSection>
							</>
						)}
						{activeTab === "pet" && (
							<>
								<SettingsSection title={t("settings.pet.title")} description={t("settings.pet.sectionDesc")}>
									<SettingSwitch
										title={t("settings.pet.enable")}
										description={t("settings.pet.enableDesc")}
										checked={props.settings.petEnabled}
										onChange={(v) => props.onChange({ petEnabled: v })}
									/>
									<SettingSwitch
										title={t("settings.pet.alwaysOnTop")}
										description={t("settings.pet.alwaysOnTopDesc")}
										checked={props.settings.petAlwaysOnTop}
										onChange={(v) => props.onChange({ petAlwaysOnTop: v })}
									/>
									<SettingSwitch
										title={t("settings.pet.patrol")}
										description={t("settings.pet.patrolDesc")}
										checked={props.settings.petPatrolEnabled ?? true}
										onChange={(v) => props.onChange({ petPatrolEnabled: v })}
									/>
								</SettingsSection>
								<SettingsSection title={t("settings.pet.patrolPause")} description={t("settings.pet.patrolPauseDesc")}>
									<div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", maxWidth: 320 }}>
										<input
											type="range"
											min="1"
											max="30"
											step="1"
											value={props.settings.petPatrolPauseMin ?? 5}
											onChange={(e) => props.onChange({ petPatrolPauseMin: parseInt(e.target.value) })}
											style={{ flex: 1, accentColor: "var(--color-accent)" }}
										/>
										<span style={{
											fontFamily: "var(--font-family-business)",
											fontSize: "var(--font-size-sm)",
											color: "var(--color-text-muted)",
											minWidth: 60,
											textAlign: "right",
										}}>
											{props.settings.petPatrolPauseMin ?? 5} min
										</span>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.pet.choose")}>
									<SelectField
										className="setting-field"
										label={t("settings.pet.choose")}
										value={props.settings.petId}
										options={petOptions}
										onChange={(value) => props.onChange({ petId: value })}
									/>
									<small className="setting-status">{t("settings.pet.petdexHint")}</small>
									{(() => {
										// 当前选中宠物的完整清单项；未匹配时（如手输未知 id）走undefined，预览自降级为空。
										const selected = petList.find((p) => p.id === props.settings.petId);
										return (
											<>
												{selected && (
													<div className="pet-chooser-preview-row" style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: 8 }}>
														<PetChooserPreview pet={selected} mode={petPreviewMode} />
														<div style={{ minWidth: 0, flex: 1 }}>
															<strong style={{ display: "block", fontSize: "var(--font-size-control)", color: "var(--color-text-primary)" }}>{selected.displayName}</strong>
															{selected.description && (
																<small className="setting-status" style={{ display: "block", marginTop: 2 }}>{selected.description}</small>
															)}
														</div>
													</div>
												)
											}
											</>
										);
									})()}
								</SettingsSection>
								<SettingsSection title={t("settings.pet.scale")} description={t("settings.pet.scaleDesc")}>
									<div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", maxWidth: 320 }}>
										<input
											type="range"
											min="0.3"
											max="2.0"
											step="0.05"
											value={props.settings.petScale ?? 1}
											onChange={(e) => props.onChange({ petScale: parseFloat(e.target.value) })}
											style={{ flex: 1, accentColor: "var(--color-accent)" }}
										/>
										<span style={{
											fontFamily: "var(--font-family-business)",
											fontSize: "var(--font-size-sm)",
											color: "var(--color-text-muted)",
											minWidth: 36,
											textAlign: "right",
										}}>
											{((props.settings.petScale ?? 1) * 100).toFixed(0)}%
										</span>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.pet.preview")} description={t("settings.pet.previewDesc")}>
									<SelectField
										className="setting-field"
										label={t("settings.pet.previewMode")}
										value={petPreviewMode}
										options={[
											{ value: "__auto", label: t("settings.pet.previewAuto") },
											{ value: "idle", label: "😌 idle (行0)" },
											{ value: "running", label: "⚙️ running (行7)" },
											{ value: "failed", label: "😥 failed (行5)" },
											{ value: "waiting", label: "🥺 waiting (行6)" },
											{ value: "waving", label: "👋 waving (行3)" },
											{ value: "running-right", label: "→ running-right (行1)" },
											{ value: "running-left", label: "← running-left (行2)" },
											{ value: "jumping", label: "🤸 jumping (行4)" },
											{ value: "review", label: "🔍 review (行8)" },
										]}
										onChange={(value) => { setPetPreviewMode(value); void window.piDesktop.pet.setPreviewMode(value === "__auto" ? "" : value); }}
									/>
									<div className="setting-inline-actions pet-test-actions">
										<Button
											buttonSize="sm"
											variant="danger"
											onClick={() => void window.piDesktop.pet.testNotify("error")}
										>
											{t("settings.pet.testError")}
										</Button>
										<Button
											buttonSize="sm"
											onClick={() => void window.piDesktop.pet.testNotify("done")}
										>
											{t("settings.pet.testDone")}
										</Button>
									</div>
								</SettingsSection>
							</>
						)}
						<p>{props.notice || t("settings.restartNotice")}</p>
					</div>
				</div>
			</div>
		</div>
	);
}

export function CodexImportModal(props: {
	project: Project;
	sessions: CodexSessionSummary[];
	selectedPaths: string[];
	loading: boolean;
	importing: boolean;
	report: CodexImportReport | null;
	onClose: () => void;
	onRefresh: () => void;
	onToggle: (sourcePath: string) => void;
	onToggleAll: () => void;
	onImport: () => void;
}) {
	const selected = new Set(props.selectedPaths);
	const allSelected =
		props.sessions.length > 0 &&
		props.sessions.every((session) => selected.has(session.sourcePath));
	return (
		<div className="modal-backdrop">
			<section className="codex-import-modal">
				<div className="modal-header">
					<div>
						<strong>{t("codex.title")}</strong>
						<small>{props.project.name}</small>
					</div>
					<CloseIconButton
						label={t("common.close")}
						onClick={props.onClose}
					/>
				</div>
				<div className="codex-import-toolbar">
					<div>
						<strong>{t("codex.importCount", { count: props.sessions.length })}</strong>
						<span>{displayPath(props.project.path)}</span>
					</div>
					<div className="codex-import-actions">
						<button onClick={props.onRefresh} disabled={props.loading || props.importing}>
							<RefreshCw size={14} />
							{t("common.refresh")}
						</button>
						<button onClick={props.onToggleAll} disabled={props.sessions.length === 0}>
							<Check size={14} />
							{allSelected ? t("codex.selectNone") : t("common.selectAll")}
						</button>
						<button
							className="primary-action"
							onClick={props.onImport}
							disabled={props.importing || props.selectedPaths.length === 0}
						>
							<UploadCloud size={14} />
							{props.importing
								? t("codex.importing")
								: t("codex.importSelected", {
										count: props.selectedPaths.length,
									})}
						</button>
					</div>
				</div>
				<div className="codex-import-body">
					{props.loading ? (
						<div className="history-loading">
							<div className="loader" />
							<span>{t("codex.scanning")}</span>
						</div>
					) : props.sessions.length === 0 ? (
						<div className="codex-import-empty">
							<strong>{t("codex.emptyTitle")}</strong>
							<span>{t("codex.emptyDesc")}</span>
						</div>
					) : (
						<div className="codex-session-list">
							{props.sessions.map((session) => (
								<label key={session.sourcePath} className="codex-session-row">
									<input
										type="checkbox"
										checked={selected.has(session.sourcePath)}
										onChange={() => props.onToggle(session.sourcePath)}
									/>
									<div className="codex-session-main">
										<div className="codex-session-title">
											<strong>{session.title}</strong>
											<span className={`codex-status ${session.status}`}>
												{formatCodexStatus(session.status)}
											</span>
										</div>
										<p>{session.preview}</p>
										<small>
											{new Date(session.updatedAt).toLocaleString()} ·{" "}
											{t("drawer.sessionMessages", {
												count: session.messageCount,
											})} ·{" "}
											{formatBytes(session.sourceSize)}
										</small>
									</div>
								</label>
							))}
						</div>
					)}
				</div>
				{props.report && (
					<div className="codex-import-report">
						<strong>
							{t("codex.importDone", {
								imported: props.report.imported,
								failed: props.report.failed,
							})}
						</strong>
						<div>
							{props.report.results.map((result) => (
								<span
									key={result.sourcePath}
									className={result.success ? "success" : "error"}
									title={result.error || result.targetPath}
								>
									{result.success ? "✓" : "✗"} {result.title || result.sourcePath}
								</span>
							))}
						</div>
					</div>
				)}
			</section>
		</div>
	);
}

function formatCodexStatus(status: CodexSessionSummary["status"]) {
	if (status === "current") return t("codex.status.current");
	if (status === "outdated") return t("codex.status.outdated");
	return t("codex.status.new");
}

function formatClaudeStatus(status: ClaudeSessionSummary["status"]) {
	if (status === "current") return t("claude.status.current");
	if (status === "outdated") return t("claude.status.outdated");
	return t("claude.status.new");
}

function formatOpenCodeStatus(status: OpenCodeSessionSummary["status"]) {
	if (status === "current") return t("opencode.status.current");
	if (status === "outdated") return t("opencode.status.outdated");
	return t("opencode.status.new");
}

export function ClaudeImportModal(props: {
	project: Project;
	sessions: ClaudeSessionSummary[];
	selectedPaths: string[];
	loading: boolean;
	importing: boolean;
	report: ClaudeImportReport | null;
	onClose: () => void;
	onRefresh: () => void;
	onToggle: (sourcePath: string) => void;
	onToggleAll: () => void;
	onImport: () => void;
}) {
	const selected = new Set(props.selectedPaths);
	const allSelected =
		props.sessions.length > 0 &&
		props.sessions.every((session) => selected.has(session.sourcePath));
	return (
		<div className="modal-backdrop">
			<section className="codex-import-modal">
				<div className="modal-header">
					<div>
						<strong>{t("claude.title")}</strong>
						<small>{props.project.name}</small>
					</div>
					<CloseIconButton
						label={t("common.close")}
						onClick={props.onClose}
					/>
				</div>
				<div className="codex-import-toolbar">
					<div>
						<strong>{t("claude.importCount", { count: props.sessions.length })}</strong>
						<span>{displayPath(props.project.path)}</span>
					</div>
					<div className="codex-import-actions">
						<button onClick={props.onRefresh} disabled={props.loading || props.importing}>
							<RefreshCw size={14} />
							{t("common.refresh")}
						</button>
						<button onClick={props.onToggleAll} disabled={props.sessions.length === 0}>
							<Check size={14} />
							{allSelected ? t("claude.selectNone") : t("common.selectAll")}
						</button>
						<button
							className="primary-action"
							onClick={props.onImport}
							disabled={props.importing || props.selectedPaths.length === 0}
						>
							<UploadCloud size={14} />
							{props.importing
								? t("claude.importing")
								: t("claude.importSelected", {
										count: props.selectedPaths.length,
									})}
						</button>
					</div>
				</div>
				<div className="codex-import-body">
					{props.loading ? (
						<div className="history-loading">
							<div className="loader" />
							<span>{t("claude.scanning")}</span>
						</div>
					) : props.sessions.length === 0 ? (
						<div className="codex-import-empty">
							<strong>{t("claude.emptyTitle")}</strong>
							<span>{t("claude.emptyDesc")}</span>
						</div>
					) : (
						<div className="codex-session-list">
							{props.sessions.map((session) => (
								<label key={session.sourcePath} className="codex-session-row">
									<input
										type="checkbox"
										checked={selected.has(session.sourcePath)}
										onChange={() => props.onToggle(session.sourcePath)}
									/>
									<div className="codex-session-main">
										<div className="codex-session-title">
											<strong>{session.title}</strong>
											<span className={`codex-status ${session.status}`}>
												{formatClaudeStatus(session.status)}
											</span>
										</div>
										<p>{session.preview}</p>
										<small>
											{new Date(session.updatedAt).toLocaleString()} ·{" "}
											{t("drawer.sessionMessages", {
												count: session.messageCount,
											})} ·{" "}
											{formatBytes(session.sourceSize)}
										</small>
									</div>
								</label>
							))}
						</div>
					)}
				</div>
				{props.report && (
					<div className="codex-import-report">
						<strong>
							{t("claude.importDone", {
								imported: props.report.imported,
								failed: props.report.failed,
							})}
						</strong>
						<div>
							{props.report.results.map((result) => (
								<span
									key={result.sourcePath}
									className={result.success ? "success" : "error"}
									title={result.error || result.targetPath}
								>
									{result.success ? "✓" : "✗"} {result.title || result.sourcePath}
								</span>
							))}
						</div>
					</div>
				)}
			</section>
		</div>
	);
}

export function OpenCodeImportModal(props: {
	project: Project;
	sessions: OpenCodeSessionSummary[];
	selectedPaths: string[];
	loading: boolean;
	importing: boolean;
	report: OpenCodeImportReport | null;
	onClose: () => void;
	onRefresh: () => void;
	onToggle: (sourcePath: string) => void;
	onToggleAll: () => void;
	onImport: () => void;
}) {
	const selected = new Set(props.selectedPaths);
	const allSelected =
		props.sessions.length > 0 &&
		props.sessions.every((session) => selected.has(session.sourcePath));
	return (
		<div className="modal-backdrop">
			<section className="codex-import-modal">
				<div className="modal-header">
					<div>
						<strong>{t("opencode.title")}</strong>
						<small>{props.project.name}</small>
					</div>
					<CloseIconButton
						label={t("common.close")}
						onClick={props.onClose}
					/>
				</div>
				<div className="codex-import-toolbar">
					<div>
						<strong>{t("opencode.importCount", { count: props.sessions.length })}</strong>
						<span>{displayPath(props.project.path)}</span>
					</div>
					<div className="codex-import-actions">
						<button onClick={props.onRefresh} disabled={props.loading || props.importing}>
							<RefreshCw size={14} />
							{t("common.refresh")}
						</button>
						<button onClick={props.onToggleAll} disabled={props.sessions.length === 0}>
							<Check size={14} />
							{allSelected ? t("opencode.selectNone") : t("common.selectAll")}
						</button>
						<button
							className="primary-action"
							onClick={props.onImport}
							disabled={props.importing || props.selectedPaths.length === 0}
						>
							<UploadCloud size={14} />
							{props.importing
								? t("opencode.importing")
								: t("opencode.importSelected", {
										count: props.selectedPaths.length,
									})}
						</button>
					</div>
				</div>
				<div className="codex-import-body">
					{props.loading ? (
						<div className="history-loading">
							<div className="loader" />
							<span>{t("opencode.scanning")}</span>
						</div>
					) : props.sessions.length === 0 ? (
						<div className="codex-import-empty">
							<strong>{t("opencode.emptyTitle")}</strong>
							<span>{t("opencode.emptyDesc")}</span>
						</div>
					) : (
						<div className="codex-session-list">
							{props.sessions.map((session) => (
								<label key={session.sourcePath} className="codex-session-row">
									<input
										type="checkbox"
										checked={selected.has(session.sourcePath)}
										onChange={() => props.onToggle(session.sourcePath)}
									/>
									<div className="codex-session-main">
										<div className="codex-session-title">
											<strong>{session.title}</strong>
											<span className={`codex-status ${session.status}`}>
												{formatOpenCodeStatus(session.status)}
											</span>
										</div>
										<p>{session.preview}</p>
										<small>
											{new Date(session.updatedAt).toLocaleString()} ·{" "}
											{t("drawer.sessionMessages", {
												count: session.messageCount,
											})} ·{" "}
											{formatBytes(session.sourceSize)}
										</small>
									</div>
								</label>
							))}
						</div>
					)}
				</div>
				{props.report && (
					<div className="codex-import-report">
						<strong>
							{t("opencode.importDone", {
								imported: props.report.imported,
								failed: props.report.failed,
							})}
						</strong>
						<div>
							{props.report.results.map((result) => (
								<span
									key={result.sourcePath}
									className={result.success ? "success" : "error"}
									title={result.error || result.targetPath}
								>
									{result.success ? "✓" : "✗"} {result.title || result.sourcePath}
								</span>
							))}
						</div>
					</div>
				)}
			</section>
		</div>
	);
}

function formatBytes(value: number) {
	if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
	if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${value} B`;
}

type SettingsTabId = "base" | "proxy" | "web" | "dev" | "pet";

function SettingsSection(props: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<section className="settings-section">
			<div className="settings-section-header">
				<strong>{props.title}</strong>
				{props.description && <small>{props.description}</small>}
			</div>
			<div className="settings-section-body">{props.children}</div>
		</section>
	);
}

function SettingSwitch(props: {
	title: string;
	description?: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="setting-switch-row">
			<span>
				<strong>{props.title}</strong>
				{props.description && <small>{props.description}</small>}
			</span>
			<input
				type="checkbox"
				checked={props.checked}
				disabled={props.disabled}
				onChange={(event) => props.onChange(event.target.checked)}
			/>
		</label>
	);
}
