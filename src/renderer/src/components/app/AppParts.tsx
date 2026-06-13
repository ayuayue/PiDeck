import {
	isValidElement,
	useEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	Check,
	ChevronDown,
	ChevronRight,
	GitBranch,
	Brain,
	Folder,
	Globe2,
	Network,
	Pencil,
	Pin,
	RefreshCw,
	Settings2,
	UploadCloud,
	Wrench,
	X,
} from "lucide-react";
import { t } from "../../i18n";
import type {
	AgentRuntimeState,
	AgentTab,
	AppInfo,
	AppSettings,
	AvailableModel,
	ChatMessage,
	CodexImportReport,
	CodexSessionSummary,
	FileTreeNode,
	GitBranchInfo,
	ImageContent,
	PiCommand,
	PiInstallStatus,
	Project,
	SessionSummary,
} from "../../../../shared/types";

export type DrawerPanel = "files" | "sessions";

export type SessionModifiedFile = {
	path: string;
	toolName: string;
	status: string;
	changedLines?: number;
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
					<button onClick={props.onClose}>×</button>
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
										<span className="ref-label">CMD</span>
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
			<span>{t("app.think")}: {props.state.thinkingLevel ?? "-"}</span>
			{props.duration != null && (
				<span title="本次会话耗时">⏱ {formatDuration(props.duration)}</span>
			)}
			{props.state.contextPercent != null && (
				<span>
					ctx:{" "}
					{props.state.contextPercent?.toFixed?.(1) ??
						props.state.contextPercent}
					% / {formatCompact(props.state.contextWindow)}
				</span>
			)}
			{props.state.cacheTotal != null && (
				<span>cache: {formatCompact(props.state.cacheTotal)}</span>
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
}) {
	const ctxPercent = props.state?.contextPercent;
	const showCompact = ctxPercent != null && ctxPercent > 30;
	return (
		<div className="composer-toolbar">
			<button onClick={props.onPickModel} disabled={props.disabled}>
				{t("app.model")}: {props.state?.provider ? `${props.state.provider}/` : ""}{props.state?.modelName ?? "-"}
			</button>
			<button onClick={props.onCycleModel} disabled={props.disabled}>
				{t("app.cycleModel")}
			</button>
			<button onClick={props.onPickThinking} disabled={props.disabled}>
				{t("app.think")}: {props.state?.thinkingLevel ?? "-"}
			</button>
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
					title={`上下文: ${ctxPercent.toFixed(1)}% - 点击压缩上下文释放空间`}
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
	return (
		<div className="picker-backdrop" onClick={props.onClose}>
			<div
				className="picker-palette model-picker"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="picker-palette-header">
					<span>选择模型</span>
					<button className="picker-palette-close" onClick={props.onClose}>×</button>
				</div>
				<div className="picker-palette-search">
					<input
						autoFocus
						value={modelPickerSearch}
						onChange={(event) => setModelPickerSearch(event.target.value)}
						placeholder="搜索模型、Provider 或 ID"
					/>
				</div>
				<div className="picker-palette-list">
					{filteredModels.length > 0 ? (
						filteredModels.map((model) => {
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
						})
					) : (
						<div className="picker-palette-empty">没有匹配的模型</div>
					)}
				</div>
			</div>
		</div>
	);
}

const THINKING_LEVELS = [
	{ value: "off", label: "Off", description: "关闭模型思考,优先速度和成本" },
	// minimal 是 pi/Codex reasoning 的最轻量档位,放在 Off 与 Low 之间便于按强度递增选择。
	{ value: "minimal", label: "Minimal", description: "最少量思考,适合简单问答和轻量修改" },
	{ value: "low", label: "Low", description: "更快响应,适合日常小改动" },
	{ value: "medium", label: "Medium", description: "平衡速度和推理深度" },
	{ value: "high", label: "High", description: "更深推理,适合复杂任务" },
	// xhigh 只在部分模型上可用;选择后以前端收到的 runtime state 为准,必要时提示用户已被回退。
	{ value: "xhigh", label: "XHigh", description: "最高推理档,需当前模型支持" },
];

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
					<span>选择思考级别</span>
					<button className="picker-palette-close" onClick={props.onClose}>×</button>
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
								<span className="picker-palette-label">{level.label}</span>
								<span className="picker-palette-desc">{level.description}</span>
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
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	// 点击外部区域自动关闭下拉
	useEffect(() => {
		if (!open) return;
		const handler = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	const current = props.gitInfo.current ?? "";
	const branches = props.gitInfo.branches;

	// 无分支信息时不渲染
	if (!current && branches.length === 0) return null;

	return (
		<div className="branch-select" ref={ref}>
			<button
				className="branch-trigger"
				disabled={Boolean(props.switchingBranch)}
				onClick={() => setOpen((v) => !v)}
				title={`当前分支: ${current},共 ${branches.length} 个分支`}
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
						<div className="branch-empty-hint">仅此一个分支</div>
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
								{switching ? "切换中..." : branch}
							</span>
						</button>
					);
					})}
				</div>
			)}
		</div>
	);
}

export function LogoMark() {
	return (
		<div className="logo-mark" aria-label="pi desktop logo">
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

export function ProjectAvatar(props: { name: string }) {
	return (
		<div className="conversation-avatar project-avatar" title={`${props.name} 项目目录`}>
			<Folder size={16} strokeWidth={1.8} />
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
			<p>
				{props.hasProject
					? "创建 agent 后即可开始对话。"
					: "先从左侧添加项目目录。"}
			</p>
			{props.hasProject && (
				<button onClick={props.onCreate}>{t("app.createAgent")}</button>
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

export type AgentRunItem = {
	kind: "agent-run";
	id: string;
	items: Array<MessageItem | ToolGroupItem>;
	startedAt: number;
	endedAt: number;
};

export type RenderMessage = MessageItem | ToolGroupItem | AgentRunItem;

export function groupToolMessages(messages: ChatMessage[]): RenderMessage[] {
	const result: RenderMessage[] = [];
	let currentTools: ChatMessage[] = [];
	let currentRun: Array<MessageItem | ToolGroupItem> = [];
	let runStartedAt = 0;
	let runEndedAt = 0;

	function flushTools() {
		if (currentTools.length === 0) return;
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
		if (currentRun.length === 0) return;
		result.push({
			kind: "agent-run",
			id: currentRun
				.map((item) =>
					item.kind === "tool-group" ? item.id : item.message.id,
				)
				.join("|"),
			items: currentRun,
			startedAt: runStartedAt,
			endedAt: runEndedAt || runStartedAt,
		});
		currentRun = [];
		runStartedAt = 0;
		runEndedAt = 0;
	}

	function appendRunMessage(message: ChatMessage) {
		flushTools();
		if (currentRun.length === 0) runStartedAt = message.timestamp;
		runEndedAt = message.timestamp;
		currentRun.push({ kind: "message", message });
	}

	for (const message of messages) {
		if (message.role === "assistant") {
			appendRunMessage(message);
		} else if (message.role === "tool") {
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
					<time>{hasThinking ? "思考中" : "正在响应"}</time>
				</div>
				{hasThinking && (
					<div className="thinking-block streaming">
						<div className="thinking-header">
							<Brain size={14} />
							<span>思考过程</span>
						</div>
						<div className="thinking-content">{displayText}</div>
						{needsTruncate && (
							<button
								className="thinking-toggle"
								onClick={() => setExpanded((v) => !v)}
							>
								{expanded ? "收起" : "展开全部"}
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


export function ToolGroup(props: { group: ToolGroupItem }) {
	const [expanded, setExpanded] = useState(false);
	// 工具消息按 toolCallId 原地更新;最后一条仍为 running 时,表示当前工具组还没收尾。
	const running =
		props.group.messages.length > 0 &&
		props.group.messages[props.group.messages.length - 1].meta?.status ===
			"running";
	const errorCount = props.group.messages.filter(
		(message) =>
			message.meta?.status === "error" || message.meta?.isError === true,
	).length;
	const failed = props.group.messages.some(
		(message) =>
			message.meta?.status === "error" || message.meta?.isError === true,
	);
	const visibleChips = props.group.messages.slice(0, 6);
	const hiddenCount = props.group.messages.length - visibleChips.length;
	return (
		<article
			className={`tool-group ${running ? "running" : failed ? "error" : "done"}`}
			data-message-id={props.group.id}
		>
			<button
				className="tool-group-header"
				onClick={() => setExpanded((value) => !value)}
			>
				<span className="tool-status-dot" />
				<span className="tool-group-title">
					{running ? t("tool.running") : failed ? t("tool.error") : t("tool.done")}
				</span>
				<strong>
					{props.group.messages.length}
					{t("tool.countSuffix")}
					{errorCount > 0 ? ` · ${errorCount}${t("tool.failedSuffix")}` : ""}
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
						<ToolChip key={message.id} message={message} />
					))}
					{hiddenCount > 0 && (
						<span className="tool-chip muted">+{hiddenCount}</span>
					)}
				</div>
			)}
		</article>
	);
}

function ToolChip(props: { message: ChatMessage }) {
	const status = String(props.message.meta?.status ?? "done");
	const toolName = String(props.message.meta?.toolName ?? props.message.text);
	return (
		<span className={`tool-chip ${status}`} title={props.message.text}>
			{toolName}
		</span>
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
			<div className="tool-summary-main">
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

export function AgentRun(props: {
	run: AgentRunItem;
	onPreviewImage: (image: ImageContent) => void;
	showThinking?: boolean;
	onOpenExternal: (url: string) => void;
	onResendUserMessage?: (message: ChatMessage) => void;
	fileSummariesByMessage?: Record<string, SessionModifiedFile[]>;
}) {
	return (
		<article className="agent-run" data-message-id={props.run.id}>
			<div className="msg-avatar">P</div>
			<div className="agent-run-content">
				<div className="msg-name">
					<span>pi</span>
					<time>{formatTime(props.run.endedAt)}</time>
				</div>
				<div className="agent-run-stack">
					{props.run.items.map((item) => {
						if (item.kind === "tool-group") {
							return <ToolGroup key={item.id} group={item} />;
						}
						const fileSummary = props.fileSummariesByMessage?.[item.message.id];
						return (
							<div key={item.message.id} className="agent-run-message-stack">
								<ChatBubble
									message={item.message}
									onPreviewImage={props.onPreviewImage}
									onOpenExternal={props.onOpenExternal}
									onResendUserMessage={props.onResendUserMessage}
									showThinking={props.showThinking}
									compact
								/>
								{item.message.role === "assistant" && fileSummary && fileSummary.length > 0 && (
									<SessionFileSummary files={fileSummary} />
								)}
							</div>
						);
					})}
				</div>
			</div>
		</article>
	);
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
				aria-label="关闭图片预览"
			>
				<X size={20} strokeWidth={2.4} />
			</button>
			<img
				src={`data:${props.image.mimeType};base64,${props.image.data}`}
				alt="图片预览"
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

export function ChatBubble(props: {
	message: ChatMessage;
	onPreviewImage: (image: ImageContent) => void;
	showThinking?: boolean;
	onOpenExternal: (url: string) => void;
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
			? "下次调用前"
			: deliveryBehavior === "followUp"
				? "结束后排队"
				: null;
	const detailText =
		typeof message.meta?.detailText === "string"
			? message.meta.detailText
			: JSON.stringify(message.meta ?? {}, null, 2);
	// 过滤 ANSI 转义码,pi 终端输出的颜色序列在桌面 UI 中无意义
	const cleanText = stripAnsi(message.text);
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
				{isUser ? "我" : label.slice(0, 1).toUpperCase()}
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
										? "followUp:等待 agent 停止后发送"
										: "steer:当前工具调用后、下一次 LLM 调用前生效"
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
									alt={`图片 ${index + 1}`}
									className="message-image"
									onClick={() => props.onPreviewImage(img)}
								/>
							))}
						</div>
					)}
					{/* 用户消息使用纯文本显示,避免特殊字符被 markdown 解释导致渲染异常 */}
					{isUser ? (
						<div className="user-message-text">{cleanText}</div>
					) : (
						<ReactMarkdown
							remarkPlugins={[remarkGfm]}
							components={{
								pre: CodeBlock,
								a: (linkProps) => (
									<MarkdownLink
										{...linkProps}
										onOpenExternal={props.onOpenExternal}
									/>
								),
							}}
						>
							{cleanText}
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
								onClick={() => props.onResendUserMessage?.(message)}
								title="用同一条用户消息再次发送给 AI"
							>
								重新发送
							</button>
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
								编辑
							</button>
						</>
					)}
				</div>
			</div>
		</article>
	);
}

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

/** Markdown 内的链接默认会在 Electron 窗口内导航,这里拦截点击统一用系统浏览器打开。 */
function MarkdownLink(
	props: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
		onOpenExternal: (url: string) => void;
	},
) {
	const { onOpenExternal, ...anchorProps } = props;
	const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		if (props.href) void onOpenExternal(props.href);
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
						<button className="modal-close-btn" onClick={props.onClose}>×</button>
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
const CHANGED_LINES_ESTIMATE_HINT =
	"行数为估算:edit 按 oldText/newText 中较大的行数统计,多个 edit 会累加;write/create 按写入内容行数统计。它不是基于 git diff 的精确修改行数,末尾换行或多次编辑可能让数字偏大。";

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
	modifiedFiles: SessionModifiedFile[];
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
					modifiedFiles={props.modifiedFiles}
					expandedDirs={props.expandedDirs}
					onToggleDirectory={props.onToggleDirectory}
					onFileContextMenu={props.onFileContextMenu}
					onRefreshFiles={props.onRefreshFiles}
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

function FilesPanel(props: {
	files: FileTreeNode[];
	/** 当前会话中 agent 修改过的文件 */
	modifiedFiles: SessionModifiedFile[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshFiles: () => void;
}) {
	return (
		<div className="files-panel">
			<div className="panel-action-row">
				<span>{t("drawer.fileItems", { count: props.files.length })}</span>
				<button onClick={props.onRefreshFiles}>{t("common.refresh")}</button>
			</div>
			{props.modifiedFiles.length > 0 && (
				<div className="modified-files-section">
					<div className="modified-files-header">{t("drawer.modifiedThisSession")}</div>
					{props.modifiedFiles.map((file) => {
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
							>
								<span
									className={`modified-file-icon${isRunning ? "" : " done"}`}
								>
									{isRunning ? "◌" : "✓"}
								</span>
								<span className="modified-file-name">{fileName}</span>
								{Boolean(file.changedLines) && (
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
				</div>
			)}
			{props.files.map((node) => (
				<FileNode
					key={node.path}
					node={node}
					expandedDirs={props.expandedDirs}
					onToggleDirectory={props.onToggleDirectory}
					onFileContextMenu={props.onFileContextMenu}
				/>
			))}
		</div>
	);
}

export function SessionFileSummary(props: { files: SessionModifiedFile[] }) {
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
						<li key={file.path} className="session-file-summary-row" title={file.path}>
							<span className="session-file-summary-name">{fileName}</span>
							<span
								className="session-file-summary-lines"
								title={t("drawer.changedLinesEstimate")}
							>
								{file.changedLines
									? `~${t("drawer.changedLines", { count: file.changedLines })}`
									: t("drawer.changed")}
							</span>
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
}) {
	const { node, expandedDirs, onToggleDirectory } = props;
	const expanded = expandedDirs.has(node.path);
	const menu = (event: React.MouseEvent) => {
		event.preventDefault();
		props.onFileContextMenu(node, event.clientX, event.clientY);
	};
	if (node.type === "file")
		return (
			<div className="file-node">
				<button className="file" title={node.relativePath} onContextMenu={menu}>
					<span>{fileIcon(node.name)}</span>
					{node.name}
				</button>
			</div>
		);
	return (
		<div className="file-node">
			<button
				className="directory"
				onClick={() => onToggleDirectory(node.path)}
				onContextMenu={menu}
				title={node.relativePath}
			>
				<span>
					{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				</span>
				{node.name}
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
					<button className="command-palette-close" onClick={props.onClose}>×</button>
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

export function applySuggestion(current: string, value: string) {
	const index = findTriggerIndex(current);
	if (index === -1) return `${current}${value} `;
	return `${current.slice(0, index)}${value} `;
}

export function clearSuggestionTrigger(current: string) {
	const index = findTriggerIndex(current);
	if (index === -1) return current;
	return current.slice(0, index);
}

function findTriggerIndex(current: string) {
	const lastSlash = current.lastIndexOf("/");
	const lastAt = current.lastIndexOf("@");
	return Math.max(lastSlash, lastAt);
}

export type SuggestionItem = {
	key: string;
	label: string;
	description: string;
	value: string;
};

export function buildSuggestionItems(
	prompt: string,
	commands: PiCommand[],
	files: FileTreeNode[],
): SuggestionItem[] {
	const allCommands = mergeCommands(commands);
	const tail = prompt.split(/\s/).at(-1) ?? "";
	if (tail.startsWith("/")) {
		const keyword = tail.slice(1).toLowerCase();
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
	if (tail.startsWith("@")) {
		const keyword = tail.slice(1).toLowerCase();
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
	const extras = BUILTIN_COMMANDS.filter(
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
const BUILTIN_COMMANDS: PiCommand[] = [
	{
		name: "session",
		description: "显示会话文件、ID、消息数、token 和费用",
		source: "builtin",
	},
	{
		name: "tree",
		description: "会话树导航,跳转到任意节点",
		source: "builtin",
	},
	{ name: "clone", description: "复制当前分支到新会话", source: "builtin" },
	{
		name: "compact",
		description: "压缩上下文,可选自定义提示词",
		source: "builtin",
	},
	{ name: "copy", description: "复制最后一条回复到剪贴板", source: "builtin" },
	{ name: "export", description: "导出会话为 HTML 文件", source: "builtin" },
	{
		name: "share",
		description: "上传为 GitHub Gist 私密链接",
		source: "builtin",
	},
	{ name: "settings", description: "打开 pi 设置", source: "builtin" },
	{ name: "reload", description: "重载扩展、技能和配置", source: "builtin" },
	{ name: "hotkeys", description: "显示所有快捷键", source: "builtin" },
	{
		name: "login",
		description: "管理 OAuth 或 API key 认证",
		source: "builtin",
	},
	{ name: "logout", description: "退出登录", source: "builtin" },
];

export function PromptSuggestions(props: {
	prompt: string;
	items: SuggestionItem[];
	selectedIndex: number;
	onSelectedIndexChange: (index: number) => void;
	onClose: () => void;
	onPick: (value: string) => void;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const tail = props.prompt.split(/\s/).at(-1) ?? "";

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

	return (
		<div className="command-palette">
			<div className="command-palette-header">
				<span>{tail.startsWith("/") ? t("prompt.commands") : t("prompt.files")}</span>
				<button className="command-palette-close" onClick={props.onClose}>
					×
				</button>
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

export function FileContextMenu(props: {
	menu: { x: number; y: number; node: FileTreeNode };
	onClose: () => void;
	onOpen: () => void;
	onReveal: () => void;
	onAttach: () => void;
}) {
	const isFile = props.menu.node.type === "file";
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
			</div>
		</div>
	);
}

export function ProjectContextMenu(props: {
	menu: { x: number; y: number; project: Project };
	onClose: () => void;
	onImportCodexSessions: () => void;
	onRemoveProject: () => void;
}) {
	const isChatProject = props.menu.project.kind === "chat";
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: props.menu.x, top: props.menu.y }}
				onClick={(event) => event.stopPropagation()}
			>
				{!isChatProject && (
					<>
						<button onClick={props.onImportCodexSessions}>
							{t("menu.importCodex")}
						</button>
						<button onClick={props.onRemoveProject}>{t("menu.removeProject")}</button>
					</>
				)}
			</div>
		</div>
	);
}

export function AgentContextMenu(props: {
	menu: { x: number; y: number; agent: AgentTab };
	actionLoading?: "copy" | "export" | null;
	onClose: () => void;
	onActivate: () => void;
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
				<button disabled={Boolean(props.actionLoading)} onClick={props.onActivate}>{t("menu.openSession")}</button>
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
				<button onClick={props.onCloseAgent}>{t("menu.closeAgent")}</button>
			</div>
		</div>
	);
}

export function SessionContextMenu(props: {
	menu: { x: number; y: number; session: SessionSummary };
	actionLoading?: "copy" | "export" | null;
	onClose: () => void;
	onActivate: () => void;
	onRename: () => void;
	onExport: () => void;
	onCopySession: () => void;
	onShowLogs: () => void;
}) {
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: props.menu.x, top: props.menu.y }}
				onClick={(event) => event.stopPropagation()}
			>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onActivate}>{t("menu.openSession")}</button>
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
	onCustomPathChange: (path: string) => void;
	onValidateCustomPath: () => void;
	onClearCustomPath: () => void;
	onCheckPi: () => void;
	onTestPiProxy: () => void;
	onCheckUpdate: () => void;
	onToggleDevTools: () => void;
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

	return (
		<div className="modal-backdrop">
			<div
				className="settings-modal"
			>
				<div className="modal-header">
					<strong>{t("settings.title")}</strong>
					<button onClick={props.onClose}>×</button>
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
									<div className="setting-field">
										<span>{t("settings.theme")}</span>
										<select
											value={props.settings.theme}
											onChange={(event) =>
												props.onChange({
													theme: event.target
														.value as AppSettings["theme"],
												})
											}
										>
											<option value="system">
												{t("settings.themeSystem")}
											</option>
											<option value="light">{t("settings.themeLight")}</option>
											<option value="dark">{t("settings.themeDark")}</option>
										</select>
									</div>
									<div className="setting-field">
										<span>{t("settings.language")}</span>
										<select
											value={props.settings.language}
											onChange={(event) =>
												props.onChange({
													language: event.target
														.value as AppSettings["language"],
												})
											}
										>
											<option value="system">
												{t("settings.languageSystem")}
											</option>
											<option value="zh-CN">
												{t("settings.languageZh")}
											</option>
											<option value="en-US">
												{t("settings.languageEn")}
											</option>
											<option value="pseudo">
												{t("settings.languagePseudo")}
											</option>
										</select>
									</div>
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
									<div className="setting-field">
										<span>{t("settings.inputShortcut")}</span>
										<select
											value={props.settings.sendShortcut}
											onChange={(event) =>
												props.onChange({
													sendShortcut: event.target
														.value as AppSettings["sendShortcut"],
												})
											}
										>
											<option value="enter-send">
												{t("settings.sendShortcut.enter")}
											</option>
											<option value="ctrl-enter-send">
												{t("settings.sendShortcut.ctrl")}
											</option>
											<option value="shift-enter-send">
												{t("settings.sendShortcut.shift")}
											</option>
										</select>
									</div>
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
											<div className="setting-field">
												<span>{t("settings.proxyUrl")}</span>
												<input
													type="text"
													value={props.settings.piProxyUrl}
													placeholder="http://127.0.0.1:7890"
													onChange={(event) =>
														props.onChange({ piProxyUrl: event.target.value })
													}
												/>
											</div>
											<div className="setting-field">
												<span>{t("settings.proxyBypass")}</span>
												<input
													type="text"
													value={props.settings.piProxyBypass}
													placeholder="localhost,127.0.0.1,::1"
													onChange={(event) =>
														props.onChange({ piProxyBypass: event.target.value })
													}
												/>
												<small className="setting-hint">
													{t("settings.noProxyHint")}
												</small>
											</div>
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
												<button
													onClick={props.onTestPiProxy}
													disabled={props.piProxyChecking}
												>
													{props.piProxyChecking ? t("settings.testingProxy") : t("settings.testProxy")}
												</button>
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
											<div className="setting-field">
												<span>{t("settings.proxyUrl")}</span>
												<input
													type="text"
													value={props.settings.desktopProxyUrl}
													placeholder="http://127.0.0.1:7890"
													onChange={(event) =>
														props.onChange({
															desktopProxyUrl: event.target.value,
														})
													}
												/>
											</div>
											<div className="setting-field">
												<span>{t("settings.proxyBypass")}</span>
												<input
													type="text"
													value={props.settings.desktopProxyBypass}
													placeholder="localhost,127.0.0.1,::1"
													onChange={(event) =>
														props.onChange({
															desktopProxyBypass: event.target.value,
														})
													}
												/>
												<small className="setting-hint">
													{t("settings.electronProxyHint")}
												</small>
											</div>
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
											<span>HOST</span>
											<code>{props.settings.webServiceHost}</code>
										</div>
										<label className="web-endpoint-metric editable">
											<span>PORT</span>
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
										<button
											type="button"
											disabled={!props.settings.webServiceEnabled}
											onClick={() => props.onOpenWebService(webPortDraft || String(props.settings.webServicePort))}
										>
											{t("common.open")}
										</button>
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
										<button onClick={props.onCheckPi} disabled={props.piChecking}>
											{props.piChecking ? t("settings.detecting") : t("settings.detectEnvironment")}
										</button>
									</div>
									<div className="setting-pi-path-panel">
										<div className="setting-field">
											<span>{t("settings.customPiPath")}</span>
											<input
												type="text"
												value={props.customPiPath}
												placeholder={piPath || "D:\\mise-data\\installs\\node\\24 13 0\\pi.cmd"}
												onChange={(event) => props.onCustomPathChange(event.target.value)}
												disabled={props.customPathValidating}
											/>
											<small className="setting-hint">
												{t("settings.customPiPathHint")}
											</small>
										</div>
										<div className="setting-pi-path-actions">
											<button
												onClick={props.onValidateCustomPath}
												disabled={!props.customPiPath.trim() || props.customPathValidating}
											>
												{props.customPathValidating
													? t("settings.validating")
													: t("settings.validatePiPath")}
											</button>
											<button
												onClick={props.onClearCustomPath}
												disabled={!props.settings.customPiPath || props.customPathValidating}
											>
												{t("settings.clearCustomPiPath")}
											</button>
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
										<button onClick={props.onCheckUpdate}>{t("settings.checkUpdate")}</button>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.debug")}>
									<div className="setting-row">
										<div>
											<strong>{t("settings.devTools")}</strong>
											<small>{t("settings.devToolsDesc")}</small>
										</div>
										<button onClick={props.onToggleDevTools}>
											{t("settings.toggle")}
										</button>
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
					<button onClick={props.onClose}>×</button>
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
