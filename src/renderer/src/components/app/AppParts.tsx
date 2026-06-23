import {
	isValidElement,
	memo,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	Check,
	ChevronDown,
	ChevronRight,
	GitBranch,
	Brain,
	Folder,
	Globe2,
	MessageCircle,
	Network,
	Pencil,
	Pin,
	Plus,
	RefreshCw,
	Settings2,
	UploadCloud,
	Wrench,
	X,
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
	PiCommand,
	PiInstallStatus,
	Project,
	SessionSummary,
} from "../../../../shared/types";
import { parseRichInputChips, type RichInputChip } from "./RichInput";

export type DrawerPanel = "files" | "sessions";

export type SessionModifiedFile = {
	path: string;
	toolName: string;
	status: string;
	changedLines?: number;
	/** 工具执行前的文件原始内容，用于历史会话恢复时展示差异对比。 */
	originalContent?: string;
};

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
			{props.state.cacheTotal != null && (
				<span className="cache-chip">{t("app.cache")}: {formatCompact(props.state.cacheTotal)}</span>
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
	return (
		<div className="composer-toolbar">
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
}) {
	const [modelPickerSearch, setModelPickerSearch] = useState("");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
	const normalizedSearch = modelPickerSearch.trim().toLowerCase();
	const currentModelKey = props.current?.provider && props.current?.modelId
		? `${props.current.provider}/${props.current.modelId}`
		: undefined;
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
	
	// 按供应商分组
	const groupedModels = filteredModels.reduce<Record<string, AvailableModel[]>>((groups, model) => {
		const provider = model.provider || 'other';
		if (!groups[provider]) {
			groups[provider] = [];
		}
		groups[provider].push(model);
		return groups;
	}, {});
	
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
					{sortedProviders.length > 0 ? (
						sortedProviders.map((provider) => (
							<div key={provider} className="model-group">
								<div
									className={`model-group-header${collapsedGroups.has(provider) && !normalizedSearch ? ' collapsed' : ''}`}
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
								{!(collapsedGroups.has(provider) && !normalizedSearch) && groupedModels[provider].map((model) => {
									const modelKey = `${model.provider}/${model.id}`;
									const selected = modelKey === currentModelKey;
									return (
										<button
											key={modelKey}
											className={`picker-palette-item${selected ? " selected" : ""}`}
											onClick={() => props.onPick(model)}
										>
											<span className="picker-palette-label">{model.name ?? model.id}</span>
											<span className="picker-palette-desc">
												{model.provider}/{model.id}
											</span>
											{selected && <span className="picker-palette-check">✓</span>}
										</button>
									);
								})}
							</div>
						))
					) : (
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

export const ThinkingGroup = memo(function ThinkingGroup(props: {
	group: ThinkingGroupItem;
	showThinking?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	if (!props.showThinking || !props.group.text.trim()) return null;

	const previewLen = 220;
	const needsTruncate = props.group.text.length > previewLen;
	const previewText =
		expanded || !needsTruncate
			? props.group.text
			: `${props.group.text.slice(0, previewLen)}...`;

	return (
		<section className="thinking-block thinking-group-block">
			<button
				className="thinking-header"
				onClick={() => setExpanded((value) => !value)}
			>
				<Brain size={14} />
				<span>{t("thinking.title")}</span>
				<small>{formatTime(props.group.endedAt)}</small>
				<em>{expanded ? t("common.collapse") : t("common.expand")}</em>
			</button>
			{expanded && <div className="thinking-content">{previewText}</div>}
		</section>
	);
});

type RunActivityItem = MessageItem | ToolGroupItem | ThinkingGroupItem;

type ActivityEvent =
	| {
			kind: "thinking";
			id: string;
			text: string;
			timestamp: number;
			sourceCount: number;
	  }
	| {
			kind: "tool";
			id: string;
			message: ChatMessage;
			name: string;
			status: "running" | "done" | "error";
			tone: "running" | "ok" | "warning" | "error";
			statusLabel: string;
			detailText: string;
			timestamp: number;
	  }
	| {
			kind: "answer";
			id: string;
			preview: string;
			text: string;
			timestamp: number;
	  };

function RunActivity(props: {
	items: RunActivityItem[];
	showThinking?: boolean;
}) {
	const events = buildActivityEvents(props.items, Boolean(props.showThinking));
	const toolEvents = events.filter((event) => event.kind === "tool");
	const thinkingEvents = events.filter((event) => event.kind === "thinking");
	const answerEvents = events.filter((event) => event.kind === "answer");
	const hasProcessEvents = toolEvents.length > 0 || thinkingEvents.length > 0;
	const runningCount = toolEvents.filter((event) => event.tone === "running").length;
	const warningCount = toolEvents.filter(
		(event) => event.tone === "warning" || event.tone === "error",
	).length;
	const visibleTools = toolEvents.slice(0, 8);
	const hiddenToolCount = toolEvents.length - visibleTools.length;
	const defaultExpanded =
		runningCount > 0 || warningCount > 0 || answerEvents.length === 0;
	const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
	const expanded = manualExpanded ?? defaultExpanded;
	const toggleExpanded = () =>
		setManualExpanded((value) => !(value ?? defaultExpanded));

	if (!hasProcessEvents) return null;

	return (
		<section
			className={[
				"run-activity",
				expanded ? "expanded" : "",
				runningCount > 0 ? "running" : "",
				warningCount > 0 ? "has-warning" : "",
			]
				.filter(Boolean)
				.join(" ")}
		>
			<button
				className="run-activity-header"
				onClick={toggleExpanded}
				aria-expanded={expanded}
			>
				<ChevronRight
					size={14}
					className={expanded ? "run-activity-chevron open" : "run-activity-chevron"}
				/>
				<Wrench size={14} />
				<span className="run-activity-title">{t("activity.title")}</span>
				<span className="run-activity-summary">
					{thinkingEvents.length > 0 && (
						<b>{t("activity.thinkingCount", { count: thinkingEvents.length })}</b>
					)}
					{toolEvents.length > 0 && (
						<b>{t("activity.toolCount", { count: toolEvents.length })}</b>
					)}
					{answerEvents.length > 0 && (
						<b>{t("activity.answerCount", { count: answerEvents.length })}</b>
					)}
					{warningCount > 0 && (
						<b className="warning">
							{t("activity.warningCount", { count: warningCount })}
						</b>
					)}
					{runningCount > 0 && (
						<b className="running">{t("activity.running")}</b>
					)}
				</span>
				<em>{expanded ? t("common.collapse") : t("common.details")}</em>
			</button>
			{!expanded && toolEvents.length > 0 && (
				<div className="run-activity-strip">
					{visibleTools.map((event) => (
						<button
							key={event.id}
							className={`activity-tool-chip ${event.tone}`}
							title={`${event.name} · ${event.statusLabel}`}
							onClick={() => setManualExpanded(true)}
						>
							{event.name}
						</button>
					))}
					{hiddenToolCount > 0 && (
						<span className="activity-tool-chip muted">+{hiddenToolCount}</span>
					)}
				</div>
			)}
			{expanded && (
				<div className="run-activity-timeline">
					{events.map((event) => (
						<ActivityEventRow key={event.id} event={event} />
					))}
				</div>
			)}
		</section>
	);
}

function buildActivityEvents(
	items: RunActivityItem[],
	showThinking: boolean,
): ActivityEvent[] {
	const events: ActivityEvent[] = [];
	for (const item of items) {
		if (item.kind === "thinking-group") {
			if (showThinking && item.text.trim()) {
				events.push({
					kind: "thinking",
					id: item.id,
					text: item.text,
					timestamp: item.endedAt,
					sourceCount: item.messages.length,
				});
			}
			continue;
		}
		if (item.kind === "tool-group") {
			for (const message of item.messages) {
				events.push(createToolActivityEvent(message));
			}
			continue;
		}
		const message = item.message;
		if (showThinking && message.thinking?.trim()) {
			events.push({
				kind: "thinking",
				id: `${message.id}-thinking`,
				text: stripAnsi(message.thinking),
				timestamp: message.timestamp,
				sourceCount: 1,
			});
		}
		const answerText = getMessageDisplayText(message);
		if (message.role === "assistant" && answerText.trim()) {
			events.push({
				kind: "answer",
				id: `${message.id}-answer`,
				preview: createAnswerPreview(answerText),
				text: answerText,
				timestamp: message.timestamp,
			});
		}
	}
	return events;
}

function createToolActivityEvent(message: ChatMessage): ActivityEvent {
	const status = getToolStatus(message);
	const exitCode = getToolExitCode(message);
	const isToolError = status === "error" || message.meta?.isError === true;
	const tone =
		status === "running"
			? "running"
			: isToolError
				? "error"
				: typeof exitCode === "number" && exitCode !== 0
					? "warning"
					: "ok";
	const statusLabel =
		status === "running"
			? t("tool.statusRunning")
			: isToolError
				? t("tool.statusError")
				: typeof exitCode === "number"
					? t("activity.exitCode", { code: exitCode })
					: t("tool.statusDone");
	return {
		kind: "tool",
		id: message.id,
		message,
		name: getToolName(message),
		status,
		tone,
		statusLabel,
		detailText: getToolDetailText(message),
		timestamp: message.timestamp,
	};
}

function ActivityEventRow(props: { event: ActivityEvent }) {
	const [expanded, setExpanded] = useState(false);
	const event = props.event;
	const canExpand = event.kind !== "answer" || event.text.length > 180;
	const tone = event.kind === "tool" ? event.tone : event.kind;
	const label =
		event.kind === "thinking"
			? t("activity.thinking")
			: event.kind === "tool"
				? t("activity.tool")
				: t("activity.answer");
	const title =
		event.kind === "thinking"
			? t("thinking.title")
			: event.kind === "tool"
				? event.name
				: event.preview;
	const meta =
		event.kind === "thinking"
			? event.sourceCount > 1
				? t("activity.thinkingParts", { count: event.sourceCount })
				: t("activity.thinking")
			: event.kind === "tool"
				? event.statusLabel
				: t("activity.answerMarker");
	const eventContent = (
		<>
			<span className="activity-event-kind">
				{event.kind === "thinking" ? (
					<Brain size={13} />
				) : event.kind === "tool" ? (
					<Wrench size={13} />
				) : (
					<Check size={13} />
				)}
				{label}
			</span>
			<strong title={title}>{title}</strong>
			<small title={meta}>
				{formatTime(event.timestamp)} · {meta}
			</small>
			{canExpand && (
				<em>{expanded ? t("common.collapse") : t("common.details")}</em>
			)}
		</>
	);

	return (
		<div className={`activity-event ${event.kind} ${tone}`}>
			<span className="activity-event-rail" aria-hidden="true">
				<span className="activity-event-dot" />
			</span>
			{canExpand ? (
				<button
					className="activity-event-main"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
				>
					{eventContent}
				</button>
			) : (
				<div className="activity-event-main static">{eventContent}</div>
			)}
			{expanded && event.kind === "thinking" && (
				<pre className="activity-event-detail thinking-detail">{event.text}</pre>
			)}
			{expanded && event.kind === "answer" && (
				<div className="activity-event-detail answer-detail">{event.text}</div>
			)}
			{expanded && event.kind === "tool" && (
				<div className="activity-event-detail tool-event-detail">
					<pre>{event.detailText}</pre>
					<button
						onClick={() => navigator.clipboard.writeText(event.detailText)}
						title={t("tool.copyDetail")}
					>
						{t("common.copy")}
					</button>
				</div>
			)}
		</div>
	);
}

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

function getMessageDisplayText(message: ChatMessage) {
	return stripThinkingTags(stripAnsi(message.text));
}

function createAnswerPreview(text: string) {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > 180 ? `${collapsed.slice(0, 180)}...` : collapsed;
}

export function ThinkingBubble(props: { thinking?: string; showThinking?: boolean }) {
	const hasThinking =
		props.showThinking && props.thinking && props.thinking.length > 0;
	const [expanded, setExpanded] = useState(false);
	const previewLen = 200;
	const needsTruncate = (props.thinking?.length ?? 0) > previewLen;
	const displayText =
		expanded || !needsTruncate
			? (props.thinking ?? "")
			: (props.thinking ?? "").slice(0, previewLen) + "...";

	return (
		<article className="chat-message assistant thinking-message">
			<div className="msg-avatar">P</div>
			<div className="msg-content">
				<div className="msg-name">
					<span>pi</span>
					<time>{hasThinking ? t("thinking.streaming") : t("thinking.responding")}</time>
				</div>
				{hasThinking && (
					<div className="thinking-block streaming">
						<div className="thinking-header">
							<Brain size={14} />
							<span>{t("thinking.title")}</span>
						</div>
						<div className="thinking-content">{displayText}</div>
						{needsTruncate && (
							<button
								className="thinking-toggle"
								onClick={() => setExpanded((v) => !v)}
							>
								{expanded ? t("common.collapse") : t("thinking.expandAll")}
							</button>
						)}
					</div>
				)}
				{!hasThinking && (
					<div className="msg-bubble typing-bubble">
						<span /> <span /> <span />
					</div>
				)}
			</div>
		</article>
	);
}


export const ToolGroup = memo(function ToolGroup(props: {
	group: ToolGroupItem;
	index?: number;
	total?: number;
}) {
	const [expanded, setExpanded] = useState(false);
	// 工具消息按 toolCallId 原地更新;最后一条仍为 running 时,表示当前工具组还没收尾。
	const running =
		props.group.messages.length > 0 &&
		props.group.messages[props.group.messages.length - 1].meta?.status ===
			"running";

	// 移除错误判断 - 工具调用成功就是成功，不管命令结果
	const errorCount = 0;
	const failed = false;

	const visibleChips = props.group.messages.slice(0, 6);
	const hiddenCount = props.group.messages.length - visibleChips.length;

	// 计算进度
	const showProgress = props.index !== undefined && props.total !== undefined && props.total > 1;
	const progressText = showProgress ? `${(props.index ?? 0) + 1}/${props.total ?? 0}` : '';

	// 计算时长
	const firstTimestamp = props.group.messages[0]?.timestamp ?? 0;
	const lastTimestamp = props.group.messages[props.group.messages.length - 1]?.timestamp ?? 0;
	const duration = lastTimestamp > firstTimestamp ? lastTimestamp - firstTimestamp : 0;
	const showDuration = !running && duration > 100; // 只显示已完成且超过 100ms 的

	return (
		<article
			className={`tool-group ${running ? "running streaming" : "done"}`}
			data-message-id={props.group.id}
		>
			<button
				className="tool-group-header"
				onClick={() => setExpanded((value) => !value)}
			>
				<span className="tool-status-dot" />
				{showProgress && (
					<span className="tool-progress">{progressText}</span>
				)}
				<span className="tool-group-title">
					{running ? t("tool.running") : t("tool.done")}
				</span>
				<strong>
					{props.group.messages.length}
					{t("tool.countSuffix")}
					{showDuration && ` · ${formatDuration(duration)}`}
				</strong>
				<em>{expanded ? t("common.collapse") : t("common.details")}</em>
			</button>
			{expanded ? (
				<div className="tool-group-list">
					{props.group.messages.map((message) => (
						<ToolSummary key={message.id} message={message} />
					))}
				</div>
			) : (
				<div className="tool-compact-row">
					{visibleChips.map((message) => (
						<ToolChip
							key={message.id}
							message={message}
							onClick={() => setExpanded(true)}
						/>
					))}
					{hiddenCount > 0 && (
						<span className="tool-chip muted">+{hiddenCount}</span>
					)}
				</div>
			)}
		</article>
	);
});

function ToolChip(props: { message: ChatMessage; onClick?: () => void }) {
	const status = String(props.message.meta?.status ?? "done");
	const toolName = String(props.message.meta?.toolName ?? props.message.text);
	return (
		<button
			className={`tool-chip ${status}`}
			title={props.message.text}
			onClick={props.onClick}
		>
			{toolName}
		</button>
	);
}

function ToolSummary(props: { message: ChatMessage }) {
	const [expanded, setExpanded] = useState(false);
	const status = String(props.message.meta?.status ?? "done");
	const toolName = String(props.message.meta?.toolName ?? props.message.text);
	const statusLabel =
		status === "running"
			? t("tool.statusRunning")
			: status === "error"
				? t("tool.statusError")
				: t("tool.statusDone");
	const detailText =
		typeof props.message.meta?.detailText === "string"
			? props.message.meta.detailText
			: JSON.stringify(props.message.meta ?? {}, null, 2);
	return (
		<div className={`tool-summary ${status}`}>
			<div
				className="tool-summary-main"
				onClick={() => setExpanded((value) => !value)}
				style={{ cursor: 'pointer' }}
			>
				<strong>{toolName}</strong>
				<small>
					{statusLabel} · {formatTime(props.message.timestamp)}
				</small>
			</div>
			<div className="tool-summary-actions">
				<button onClick={() => setExpanded((value) => !value)}>
					{expanded ? t("common.collapse") : t("common.details")}
				</button>
				<button
					onClick={() => navigator.clipboard.writeText(detailText)}
					title={t("tool.copyDetail")}
				>
					{t("common.copy")}
				</button>
			</div>
			{expanded && <pre className="tool-detail">{detailText}</pre>}
		</div>
	);
}

export const AgentRun = memo(function AgentRun(props: {
	run: AgentRunItem;
	onPreviewImage: (image: ImageContent) => void;
	showThinking?: boolean;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
	onDiffFile?: (path: string) => void;
	onResendUserMessage?: (message: ChatMessage) => void;
	fileSummariesByMessage?: Record<string, SessionModifiedFile[]>;
}) {
	const activityItems = props.run.items;
	const messageItems = props.run.items.filter(
		(item): item is MessageItem => item.kind === "message",
	);
	const isComplete = props.run.endedAt > 0;

	return (
		<article className="agent-run" data-message-id={props.run.id}>
			<div className="msg-avatar">P</div>
			<div className="agent-run-content">
				<div className="msg-name">
					<span>pi</span>
					<time>{formatTime(props.run.endedAt)}</time>
					{isComplete && props.run.startedAt > 0 && (
						<span className="agent-run-duration">
							⏱ {formatDuration(props.run.endedAt - props.run.startedAt)}
						</span>
					)}
				</div>
				<RunActivity
					items={activityItems}
					showThinking={props.showThinking}
				/>
				<div className="agent-run-stack">
					{/* 合并本轮所有 assistant 消息为一个气泡 */}
					{(() => {
						const textParts: string[] = [];
						const thinkingParts: string[] = [];
						const assistantMessages = messageItems.filter(
							(item): item is MessageItem => item.message.role === "assistant",
						);
						if (assistantMessages.length === 0) return null;
						const firstMsg = assistantMessages[0]!;
						for (const item of assistantMessages) {
							const t = item.message.text.trim();
							if (t) textParts.push(t);
							if (item.message.thinking?.trim()) thinkingParts.push(item.message.thinking);
						}
						if (textParts.length === 0) return null;
						const merged: ChatMessage = {
							...firstMsg.message,
							text: textParts.join("\n\n"),
							thinking: thinkingParts.join("\n\n") || firstMsg.message.thinking,
							id: assistantMessages.map((m) => m.message.id).join("|"),
						};
						const fileSummary = props.fileSummariesByMessage?.[assistantMessages[0]!.message.id];
						return (
							<div className="agent-run-message-stack">
								<ChatBubble
									message={merged}
									onPreviewImage={props.onPreviewImage}
									onOpenExternal={props.onOpenExternal}
									onOpenFile={props.onOpenFile}
									onResendUserMessage={props.onResendUserMessage}
									showThinking={false}
									compact
								/>
								{fileSummary && fileSummary.length > 0 && (
									<SessionFileSummary files={fileSummary} onOpenFile={props.onOpenFile} onDiffFile={props.onDiffFile} />
								)}
							</div>
						);
					})()}
				</div>
			</div>
		</article>
	);
});

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
function renderChipText(text: string, onOpenFile?: (path: string) => void): ReactNode[] {
	const chips = parseRichInputChips(text);
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

export const ChatBubble = memo(function ChatBubble(props: {
	message: ChatMessage;
	onPreviewImage: (image: ImageContent) => void;
	showThinking?: boolean;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
	onResendUserMessage?: (message: ChatMessage) => void;
	compact?: boolean;
}) {
	const { message } = props;
	const [expanded, setExpanded] = useState(false);
	const isUser = message.role === "user";
	const isTool = message.role === "tool";
	const isAssistant = message.role === "assistant";
	const hasThinking =
		isAssistant &&
		props.showThinking &&
		message.thinking &&
		message.thinking.length > 0;
	const [thinkingExpanded, setThinkingExpanded] = useState(false);
	const thinkingPreviewLen = 200;
	const thinkingNeedsTruncate =
		(message.thinking?.length ?? 0) > thinkingPreviewLen;
	const thinkingDisplayText =
		thinkingExpanded || !thinkingNeedsTruncate
			? (message.thinking ?? "")
			: (message.thinking ?? "").slice(0, thinkingPreviewLen) + "...";
	const label = message.role === "assistant" ? "pi" : message.role;
	const deliveryBehavior =
		message.role === "user" ? message.meta?.streamingBehavior : undefined;
	const deliveryLabel =
		deliveryBehavior === "steer"
			? t("app.messageDeliverySteer")
			: deliveryBehavior === "followUp"
				? t("app.messageDeliveryFollowUp")
				: null;
	const detailText =
		typeof message.meta?.detailText === "string"
			? message.meta.detailText
			: JSON.stringify(message.meta ?? {}, null, 2);
	// 过滤 ANSI 转义码,pi 终端输出的颜色序列在桌面 UI 中无意义
	const cleanText = stripThinkingTags(stripAnsi(message.text));
	const cleanDetail = stripAnsi(detailText);
	return (
		<article
			data-message-id={message.id}
			className={[
				isUser ? "chat-message mine" : `chat-message ${message.role}`,
				props.compact ? "compact-message" : "",
			]
				.filter(Boolean)
				.join(" ")}
		>
			<div className="msg-avatar">
				{isUser ? t("app.userAvatar") : label.slice(0, 1).toUpperCase()}
			</div>
			<div className="msg-content">
				<div className="msg-name">
					<span>{label}</span>
					<time>
						{deliveryLabel && (
							<span
								className={`message-delivery-badge ${deliveryBehavior === "followUp" ? "follow-up" : "steer"}`}
								title={
									deliveryBehavior === "followUp"
										? t("app.messageDeliveryFollowUpTitle")
										: t("app.messageDeliverySteerTitle")
								}
							>
								{deliveryLabel}
							</span>
						)}
						{formatTime(message.timestamp)}
					</time>
				</div>
				<div className={`msg-bubble ${isUser ? "" : "markdown-body"}`}>
					{/* 思考内容展示:可折叠,默认收起长文本 */}
					{hasThinking && (
						<div className="thinking-block">
							<div
								className="thinking-header"
								onClick={() => setThinkingExpanded((v) => !v)}
							>
								<Brain size={14} />
								<span>{t("thinking.title")}</span>
								<em>{thinkingExpanded ? t("common.collapse") : t("common.expand")}</em>
							</div>
							{thinkingExpanded && (
								<div className="thinking-content">{thinkingDisplayText}</div>
							)}
						</div>
					)}
					{/* 显示消息中附加的图片 */}
					{message.images && message.images.length > 0 && (
						<div className="message-images">
							{message.images.map((img, index) => (
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
					{/* 用户消息使用纯文本显示,避免特殊字符被 markdown 解释导致渲染异常 */}
					{isUser ? (
						<div className="user-message-text">{renderChipText(cleanText, props.onOpenFile)}</div>
					) : (
						<ReactMarkdown
							remarkPlugins={[remarkGfm]}
							urlTransform={markdownUrlTransform}
							components={{
								pre: CodeBlock,
								a: (linkProps) => (
									<MarkdownLink
										{...linkProps}
										onOpenExternal={props.onOpenExternal}
										onOpenFile={props.onOpenFile}
									/>
								),
							}}
						>
							{linkifyFilePaths(cleanText)}
						</ReactMarkdown>
					)}
					{expanded && <pre className="tool-detail">{cleanDetail}</pre>}
				</div>
				<div className="msg-actions">
					<button
						onClick={() =>
							navigator.clipboard.writeText(
								expanded && isTool ? cleanDetail : cleanText,
							)
						}
					>
						{t("common.copy")}
					</button>
					{isTool && (
						<button onClick={() => setExpanded((value) => !value)}>
							{expanded ? t("common.collapse") : t("common.details")}
						</button>
					)}
					{isUser && (
						<>
							<button
								onClick={() => {
									const text = message.text;
									// 编辑只把原消息放回输入框,不自动发送,方便用户二次加工。
									document
										.querySelector<HTMLTextAreaElement>(".composer-box textarea")
										?.focus();
									// 触发自定义事件让 App 层处理编辑
									window.dispatchEvent(
										new CustomEvent("user-message-edit", {
											detail: { text },
										}),
									);
								}}
							>
								{t("common.edit")}
							</button>
							<button
								onClick={() => props.onResendUserMessage?.(message)}
								title={t("app.resendTitle")}
							>
								{t("app.resend")}
							</button>
						</>
					)}
				</div>
			</div>
		</article>
	);
});

function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
	const text = extractText(props.children);
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

/**
 * 将文本中的文件路径转换为可点击的 Markdown 链接。
 * 只处理 Markdown 链接之外的裸路径，避免把 `[path](file://...)` 二次改写成非法嵌套链接。
 */
function linkifyFilePaths(text: string): string {
	const protectedRanges = collectMarkdownLinkRanges(text);
	// 支持常见文件路径：Windows 盘符路径、Unix 绝对路径、./ 或 ../ 相对路径、src/file.ts 这类项目相对路径。
	// 排除 Markdown 控制字符和 URL 常见字符，防止匹配到已有链接语法或普通 http(s) 地址。
	const filePathRegex = /(?:['"`])?(?:(?:[A-Z]:\\|[A-Z]:\/|\.\.?\/|\/)[^\s<>"'`|?*\n\[\]()]+|(?:[a-zA-Z_][a-zA-Z0-9_-]*[\\/])+[^\s<>"'`|?*\n\[\]()]+)\.[a-zA-Z0-9]+(?:['"`])?/g;
	const replacements: Array<{ start: number; end: number; value: string }> = [];

	for (const match of text.matchAll(filePathRegex)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (protectedRanges.some((range) => start >= range.start && end <= range.end)) continue;

		let path = match[0].trim();
		if (/^['"`]/.test(path)) path = path.slice(1);
		if (/['"`]$/.test(path)) path = path.slice(0, -1);
		if (!path) continue;

		replacements.push({
			start,
			end,
			value: `[${path}](file://${encodeURIComponent(path)})`,
		});
	}

	let result = text;
	// 从后向前替换，避免前面的替换改变后续匹配下标。
	for (const item of replacements.reverse()) {
		result = `${result.slice(0, item.start)}${item.value}${result.slice(item.end)}`;
	}
	return result;
}

/** 收集 Markdown inline link 的范围，用于保护已存在链接不被文件路径自动链接逻辑破坏。 */
function collectMarkdownLinkRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	const linkRegex = /\[[^\]\n]+\]\([^\)\n]+\)/g;
	for (const match of text.matchAll(linkRegex)) {
		const start = match.index ?? 0;
		ranges.push({ start, end: start + match[0].length });
	}
	return ranges;
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
	return messages
		.filter(
			(message) => message.role === "user" || message.role === "assistant",
		)
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

export function ConversationOutline(props: {
	items: Array<{ id: string; role: string; title: string; time: string }>;
	onJump: (id: string) => void;
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
			style={{ top }}
		>
			<button
				className="outline-trigger"
				title={t("outline.trigger", { count: props.items.length })}
				onPointerDown={startDrag}
			>
				☰
			</button>
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
	onDiffFile?: (path: string) => void;
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
	/** 当前会话中 agent 修改过的文件 */
	modifiedFiles: SessionModifiedFile[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshFiles: () => void;
	onDiffFile?: (path: string) => void;
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
					<div className="modified-files-header">{t("drawer.gitChangedFiles")}</div>
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
								onClick={() => props.onDiffFile?.(file.path)}
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
	onDiffFile?: (path: string) => void;
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
								onClick={() => props.onDiffFile?.(file.path)}
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

function mergeCommands(commands: PiCommand[]) {
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
	const isFile = props.menu.node.type === "file";
	const isDir = props.menu.node.type === "directory";
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: props.menu.x, top: props.menu.y }}
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
	onShowLogs: () => void;
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
				<button disabled={Boolean(props.actionLoading)} onClick={props.onShowLogs}>{t("menu.rpcLogs")}</button>
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
	onShowLogs: () => void;
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
	onCustomPathChange: (path: string) => void;
	onValidateCustomPath: () => void;
	onClearCustomPath: () => void;
	onCheckPi: () => void;
	onTestPiProxy: () => void;
	onCheckUpdate: () => void;
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
	];
	const themeOptions = [
		{ value: "system", label: t("settings.themeSystem") },
		{ value: "light", label: t("settings.themeLight") },
		{ value: "dark", label: t("settings.themeDark") },
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
											const seconds = Math.max(30, parseInt(value) || 600);
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

type SettingsTabId = "base" | "proxy" | "web" | "dev";

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
