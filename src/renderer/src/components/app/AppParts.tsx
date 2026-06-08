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
	Network,
	Pencil,
	RefreshCw,
	Settings2,
	UploadCloud,
	Wrench,
} from "lucide-react";
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
	PendingPrompt,
	PiCommand,
	PiInstallStatus,
	Project,
	SessionSummary,
} from "../../../../shared/types";

export type DrawerPanel = "files" | "sessions";

export function EnvironmentDialog(props: {
	status: PiInstallStatus | null;
	checking: boolean;
	onClose: () => void;
	onRecheck: () => void;
	onOpenInstallDocs: () => void;
}) {
	const installed = props.status?.installed;
	const searchedDirs = props.status?.searchedDirs.slice(0, 16) ?? [];
	return (
		<div className="modal-backdrop environment-backdrop">
			<section className="environment-modal">
				<div className="modal-header">
					<strong>pi 环境检测</strong>
					<button onClick={props.onClose}>×</button>
				</div>
				<div className="environment-body">
					{props.checking ? (
						<div className="check-row">
							<div className="loader" />
							<span>正在检测 pi CLI…</span>
						</div>
					) : installed ? (
						<div className="env-success">
							<strong>检测通过</strong>
							<span>
								已找到 {props.status?.command}{" "}
								{props.status?.version ? `(${props.status.version})` : ""}
							</span>
							<small>窗口将在 3 秒后自动关闭。</small>
						</div>
					) : (
						<>
							<p className="lead">
								没有检测到可用的 <strong>pi</strong>{" "}
								命令。你仍可浏览项目，但创建 agent 前需要先安装并配置 pi CLI。
							</p>
							<div className="setup-steps">
								<div>
									<strong>打开官方安装指引</strong>
									<span>请按 pi 官方 quickstart 安装并配置 CLI。</span>
									<button
										onClick={props.onOpenInstallDocs}
									>
										打开安装文档
									</button>
								</div>
								<div>
									<strong>配置后重新检测</strong>
									<span>安装完成后重新打开应用，或点击下方“重新检测”。</span>
								</div>
							</div>
							{props.status?.error && (
								<pre className="onboarding-error">{props.status.error}</pre>
							)}
						</>
					)}
				</div>
				<div className="environment-footer">
					<button onClick={props.onRecheck} disabled={props.checking}>
						重新检测
					</button>
				</div>
				<div className="searched-paths">
					<strong>检测路径</strong>
					{searchedDirs.length > 0 ? (
						<ul>
							{searchedDirs.map((dir) => (
								<li key={dir}>{dir}</li>
							))}
						</ul>
					) : (
						<span>检测完成后显示已搜索路径。</span>
					)}
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
			<span>think: {props.state.thinkingLevel ?? "-"}</span>
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
	onCycleThinking: () => void;
	onCompact: () => void;
}) {
	const ctxPercent = props.state?.contextPercent;
	const showCompact = ctxPercent != null && ctxPercent > 30;
	return (
		<div className="composer-toolbar">
			<button onClick={props.onPickModel} disabled={props.disabled}>
				Model: {props.state?.provider ? `${props.state.provider}/` : ""}{props.state?.modelName ?? "-"}
			</button>
			<button onClick={props.onCycleModel} disabled={props.disabled}>
				Cycle Model
			</button>
			<button onClick={props.onCycleThinking} disabled={props.disabled}>
				Think: {props.state?.thinkingLevel ?? "-"}
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
					title={`上下文: ${ctxPercent.toFixed(1)}% — 点击压缩上下文释放空间`}
					onClick={props.onCompact}
				>
					{props.state?.isCompacting || props.compacting
						? "压缩中…"
						: `Compact ${ctxPercent.toFixed(0)}%`}
				</button>
			)}
		</div>
	);
}

export function ModelPicker(props: {
	models: AvailableModel[];
	onClose: () => void;
	onPick: (model: AvailableModel) => void;
}) {
	return (
		<div className="modal-backdrop" onClick={props.onClose}>
			<div
				className="model-picker"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="modal-header">
					<strong>选择模型</strong>
					<button onClick={props.onClose}>×</button>
				</div>
				<div className="model-list">
					{props.models.map((model) => (
						<button
							key={`${model.provider}/${model.id}`}
							onClick={() => props.onPick(model)}
						>
							<strong>{model.name ?? model.id}</strong>
							<span>
								{model.provider}/{model.id}
							</span>
						</button>
					))}
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
				onClick={() => setOpen((v) => !v)}
				title={`当前分支: ${current}，共 ${branches.length} 个分支`}
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
					{branches.map((branch) => (
						<button
							key={branch}
							className={branch === current ? "active" : ""}
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
								{branch}
							</span>
						</button>
					))}
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
	// 项目名以 . 开头时，首字符头像会只显示一个点；跳过前导点/空白，保证隐藏目录也能显示可识别的业务名称首字母。
	const avatarText =
		props.name
			.replace(/^[.\s]+/, "")
			.slice(0, 1)
			.toUpperCase() || "π";
	return (
		<div className="conversation-avatar project-avatar">
			<span>{avatarText}</span>
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
	return friendly.length > 36 ? `…${friendly.slice(-35)}` : friendly;
}

function getHomePathPrefix() {
	// 浏览器侧无法直接读取 OS home；从常见 Windows 用户路径中提取到 /Users/name，其他路径保持原样。
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
			<h2>开始一个 pi agent</h2>
			<p>
				{props.hasProject
					? "创建 agent 后即可开始对话。"
					: "先从左侧添加项目目录。"}
			</p>
			{props.hasProject && (
				<button onClick={props.onCreate}>Create Agent</button>
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
		// 同一轮问答里的连续 tool 消息聚合显示，减少工具调用刷屏；详情仍保留在每条 tool 的 meta 里可展开查看。
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
			: (props.thinking ?? "").slice(0, previewLen) + "…";

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

export function PendingBubble(props: {
	pending: PendingPrompt;
	onCancel: () => void;
}) {
	const { pending } = props;
	const cleanText = stripAnsi(pending.message);
	return (
		<article className="chat-message mine pending-message">
			<div className="msg-avatar">我</div>
			<div className="msg-content">
				<div className="msg-name">
					<span>我</span>
					<time>
						<span className="pending-indicator" />
						排队中
					</time>
				</div>
				<div className="msg-bubble">
					{pending.images && pending.images.length > 0 && (
						<div className="message-images">
							{pending.images.map((img, index) => (
								<img
									key={index}
									src={`data:${img.mimeType};base64,${img.data}`}
									alt={`图片 ${index + 1}`}
									className="message-image"
								/>
							))}
						</div>
					)}
					<div className="user-message-text">{cleanText}</div>
				</div>
				<div className="msg-actions">
					<button onClick={props.onCancel}>取消排队</button>
				</div>
			</div>
		</article>
	);
}

export function ToolGroup(props: { group: ToolGroupItem }) {
	const [expanded, setExpanded] = useState(false);
	// 工具消息按 toolCallId 原地更新；最后一条仍为 running 时，表示当前工具组还没收尾。
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
					{running ? "工具调用中" : failed ? "工具调用有错误" : "工具调用完成"}
				</span>
				<strong>
					{props.group.messages.length} 个工具
					{errorCount > 0 ? ` · ${errorCount} 个失败` : ""}
				</strong>
				<em>{expanded ? "收起" : "详情"}</em>
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
		status === "running" ? "运行中" : status === "error" ? "失败" : "完成";
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
					{expanded ? "收起" : "详情"}
				</button>
				<button
					onClick={() => navigator.clipboard.writeText(detailText)}
					title="复制完整工具调用详情"
				>
					复制
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
					{props.run.items.map((item) =>
						item.kind === "tool-group" ? (
							<ToolGroup key={item.id} group={item} />
						) : (
							<ChatBubble
								key={item.message.id}
								message={item.message}
								onPreviewImage={props.onPreviewImage}
								onOpenExternal={props.onOpenExternal}
								onResendUserMessage={props.onResendUserMessage}
								showThinking={props.showThinking}
								compact
							/>
						),
					)}
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
			<button className="image-preview-close" onClick={props.onClose}>
				×
			</button>
			<img
				src={`data:${props.image.mimeType};base64,${props.image.data}`}
				alt="图片预览"
				onClick={(event) => event.stopPropagation()}
			/>
		</div>
	);
}

// ANSI 转义码正则：匹配 \x1b[...m 等终端颜色/样式序列
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** 去除 pi 输出中的 ANSI 终端转义码，避免在 React UI 中显示原始 \e[38;5;109m 等文本 */
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
			: (message.thinking ?? "").slice(0, thinkingPreviewLen) + "…";
	const label = message.role === "assistant" ? "pi" : message.role;
	const detailText =
		typeof message.meta?.detailText === "string"
			? message.meta.detailText
			: JSON.stringify(message.meta ?? {}, null, 2);
	// 过滤 ANSI 转义码，pi 终端输出的颜色序列在桌面 UI 中无意义
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
					<time>{formatTime(message.timestamp)}</time>
				</div>
				<div className={`msg-bubble ${isUser ? "" : "markdown-body"}`}>
					{/* 思考内容展示：可折叠，默认收起长文本 */}
					{hasThinking && (
						<div className="thinking-block">
							<div
								className="thinking-header"
								onClick={() => setThinkingExpanded((v) => !v)}
							>
								<Brain size={14} />
								<span>思考过程</span>
								<em>{thinkingExpanded ? "收起" : "展开"}</em>
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
					{/* 用户消息使用纯文本显示，避免特殊字符被 markdown 解释导致渲染异常 */}
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
						复制
					</button>
					{isTool && (
						<button onClick={() => setExpanded((value) => !value)}>
							{expanded ? "收起详情" : "查看详情"}
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
									// 编辑只把原消息放回输入框，不自动发送，方便用户二次加工。
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
				复制代码
			</button>
			<pre {...props}>{props.children}</pre>
		</div>
	);
}

/** Markdown 内的链接默认会在 Electron 窗口内导航，这里拦截点击统一用系统浏览器打开。 */
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

/** 将毫秒数格式化为短可读形式，如 "3.2s" "1m23s" */
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
	// 过滤 ANSI 转义码，避免 outline 标题显示乱码
	const cleaned = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	const firstLine =
		cleaned
			.replace(/```[\s\S]*?```/g, " ")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
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
	const visibleLogs = props.logs.slice(-200);

	useEffect(() => {
		const el = panelRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [props.logs.length]);

	return (
		<div className="modal-backdrop" onClick={props.onClose}>
			<div className="rpc-log-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<strong>RPC 日志 · {props.logs.length} 条</strong>
					<div className="modal-header-actions">
						<button onClick={props.onClose}>×</button>
					</div>
				</div>
				<div className="rpc-log-list" ref={panelRef}>
					{visibleLogs.map((log) => (
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
							</div>
							{expandedId === log.id && log.data != null && (
								<pre className="rpc-log-detail">
									{JSON.stringify(log.data, null, 2)}
								</pre>
							)}
						</div>
					))}
					{visibleLogs.length === 0 && (
						<div className="rpc-log-empty">
							暂无日志，发送消息后会记录 RPC 通信
						</div>
					)}
				</div>
			</div>
		</div>
	);
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
				title={`会话定位 · ${props.items.length} 条`}
				onPointerDown={startDrag}
			>
				☰
			</button>
			<nav className="conversation-outline">
				<div className="outline-title">
					<span
						className="outline-drag-handle"
						title="拖动调整位置"
						onPointerDown={startDrag}
					>
						⋮⋮
					</span>
					<span>会话定位</span>
					<span className="outline-count">{props.items.length}</span>
				</div>
				<div className="outline-list">
					{hasMore && !expanded && (
						<button
							className="outline-expand"
							onClick={() => setExpanded(true)}
						>
							显示全部 {props.items.length} 条
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
	modifiedFiles: { path: string; toolName: string; status: string }[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onClose: () => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshSessions: () => void;
	onOpenSession: (session: SessionSummary) => void;
	onRenameSession: (filePath: string, newName: string) => void;
}) {
	const title =
		props.panel === "files"
			? "文件"
			: props.project
				? `${props.project.name} · 历史会话`
				: "历史会话";
	return (
		<>
			<div className="drawer-header">
				<strong>{title}</strong>
				<button onClick={props.onClose}>×</button>
			</div>
			{props.panel === "files" && (
				<FilesPanel
					files={props.files}
					modifiedFiles={props.modifiedFiles}
					expandedDirs={props.expandedDirs}
					onToggleDirectory={props.onToggleDirectory}
					onFileContextMenu={props.onFileContextMenu}
				/>
			)}
			{props.panel === "sessions" && (
				<SessionsPanel
					sessions={props.sessions}
					onRefresh={props.onRefreshSessions}
					onOpen={props.onOpenSession}
					onRename={props.onRenameSession}
				/>
			)}
		</>
	);
}

function FilesPanel(props: {
	files: FileTreeNode[];
	/** 当前会话中 agent 修改过的文件 */
	modifiedFiles: { path: string; toolName: string; status: string }[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
}) {
	return (
		<div className="files-panel">
			{props.modifiedFiles.length > 0 && (
				<div className="modified-files-section">
					<div className="modified-files-header">本次会话修改</div>
					{props.modifiedFiles.map((file) => {
						const fileName = file.path.split(/[/\\]/).pop() ?? file.path;
						const isRunning = file.status === "running";
						// 构造最小的 FileTreeNode 以复用右键菜单
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
}) {
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
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

	return (
		<div className="sessions-panel">
			<div className="panel-action-row">
				<span>{props.sessions.length} sessions</span>
				<button onClick={props.onRefresh}>刷新</button>
			</div>
			{props.sessions.length === 0 && (
				<div className="sessions-empty">
					<strong>暂无历史会话</strong>
					<span>
						点击项目右侧历史按钮或右键项目打开历史会话；新会话完成后会出现在这里。
					</span>
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
							<button onClick={confirmRename}>保存</button>
							<button
								onClick={() => {
									setRenamingPath(null);
									setEditValue("");
								}}
							>
								取消
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
									<strong>{session.name || "Untitled"}</strong>
									<small>
										{new Date(session.updatedAt).toLocaleString()} ·{" "}
										{session.messageCount} messages
									</small>
								</div>
								<p>{session.preview}</p>
							</button>
							<button
								className="session-rename-button"
								title="重命名会话"
								onClick={() => startRename(session)}
							>
								<Pencil size={12} />
								<span>重命名</span>
							</button>
						</div>
					)}
				</div>
			))}
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
}) {
	return (
		<div className="modal-backdrop session-history-backdrop">
			<section className="session-history-modal">
				<div className="modal-header">
					<div>
						<strong>历史会话</strong>
						<span>{props.project.name}</span>
					</div>
					<button onClick={props.onClose}>×</button>
				</div>
				<div className="session-history-path" title={props.project.path}>
					{props.project.path}
				</div>
				<div className="session-history-body">
					{props.loading ? (
						<div className="session-history-loading">
							<div className="loader" />
							<span>正在读取该目录的历史会话...</span>
						</div>
					) : (
						<SessionsPanel
							sessions={props.sessions}
							onRefresh={props.onRefresh}
							onOpen={props.onOpen}
							onRename={props.onRename}
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
const HIDDEN_DESKTOP_COMMAND_NAMES = new Set([
	"new",
	"model",
	"resume",
	"fork",
	"name",
]);

function isVisibleDesktopCommand(command: PiCommand) {
	return !HIDDEN_DESKTOP_COMMAND_NAMES.has(command.name.toLowerCase());
}

// pi 内置斜杠命令，get_commands 只返回扩展注册的命令，这些需要手动补充
// desktop 已有独立 UI 入口或在 desktop 中不适合执行的命令由 HIDDEN_DESKTOP_COMMAND_NAMES 统一过滤。
const BUILTIN_COMMANDS: PiCommand[] = [
	{
		name: "session",
		description: "显示会话文件、ID、消息数、token 和费用",
		source: "builtin",
	},
	{
		name: "tree",
		description: "会话树导航，跳转到任意节点",
		source: "builtin",
	},
	{ name: "clone", description: "复制当前分支到新会话", source: "builtin" },
	{
		name: "compact",
		description: "压缩上下文，可选自定义提示词",
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
				<span>{tail.startsWith("/") ? "命令" : "文件"}</span>
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
				<span>↑↓ 选择</span>
				<span>Enter 确认</span>
				<span>Esc 关闭</span>
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
					加入对话引用
				</button>
				<button disabled={!isFile} onClick={props.onOpen}>
					默认方式打开
				</button>
				<button onClick={props.onReveal}>在文件夹中显示</button>
			</div>
		</div>
	);
}

export function ProjectContextMenu(props: {
	menu: { x: number; y: number; project: Project };
	onClose: () => void;
	onOpenSessions: () => void;
	onImportCodexSessions: () => void;
	onRemoveProject: () => void;
}) {
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: props.menu.x, top: props.menu.y }}
				onClick={(event) => event.stopPropagation()}
			>
				<button onClick={props.onOpenSessions}>历史会话</button>
				<button onClick={props.onImportCodexSessions}>
					导入 Codex 会话
				</button>
				<button onClick={props.onRemoveProject}>删除目录记录</button>
			</div>
		</div>
	);
}

export function AgentContextMenu(props: {
	menu: { x: number; y: number; agent: AgentTab };
	onClose: () => void;
	onActivate: () => void;
	onExport: () => void;
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
				<button onClick={props.onActivate}>打开会话</button>
				<button onClick={props.onExport}>导出 HTML</button>
				<button onClick={props.onShowLogs}>RPC 日志</button>
				<button onClick={props.onCloseAgent}>关闭 Agent</button>
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
	appInfo: AppInfo;
	onCheckPi: () => void;
	onTestPiProxy: () => void;
	onCheckUpdate: () => void;
	onToggleDevTools: () => void;
	onClose: () => void;
	onChange: (patch: Partial<AppSettings>) => void;
}) {
	const [activeTab, setActiveTab] = useState<SettingsTabId>("base");
	const tabs: Array<{
		id: SettingsTabId;
		label: string;
		description: string;
		icon: ReactNode;
	}> = [
		{
			id: "base",
			label: "基础设置",
			description: "界面、输入和会话行为",
			icon: <Settings2 size={16} />,
		},
		{
			id: "proxy",
			label: "代理设置",
			description: "agent 与桌面端网络",
			icon: <Network size={16} />,
		},
		{
			id: "dev",
			label: "开发设置",
			description: "环境、版本和调试",
			icon: <Wrench size={16} />,
		},
	];

	return (
		<div className="modal-backdrop">
			<div
				className="settings-modal"
			>
				<div className="modal-header">
					<strong>设置</strong>
					<button onClick={props.onClose}>×</button>
				</div>
				<div className="settings-layout">
					<nav className="settings-tabs" aria-label="设置分类">
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
								<SettingsSection title="界面">
									<SettingSwitch
										title="使用原生标题栏"
										checked={props.settings.useNativeTitleBar}
										onChange={(checked) =>
											props.onChange({ useNativeTitleBar: checked })
										}
									/>
									<SettingSwitch
										title="显示原生菜单"
										checked={props.settings.showNativeMenu}
										onChange={(checked) =>
											props.onChange({ showNativeMenu: checked })
										}
									/>
								</SettingsSection>
								<SettingsSection title="会话">
									<SettingSwitch
										title="关闭窗口时隐藏到系统托盘"
										checked={props.settings.closeToTray}
										onChange={(checked) =>
											props.onChange({ closeToTray: checked })
										}
									/>
									<SettingSwitch
										title="会话结束时发送系统通知"
										checked={props.settings.enableNotifications}
										onChange={(checked) =>
											props.onChange({ enableNotifications: checked })
										}
									/>
									<SettingSwitch
										title="显示思考过程"
										description="开启后可看到模型推理过程，帮助理解 agent 为什么“卡住”"
										checked={props.settings.showThinking}
										onChange={(checked) =>
											props.onChange({ showThinking: checked })
										}
									/>
									<div className="setting-field">
										<span>发送快捷键</span>
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
												Enter 发送，Ctrl/Shift+Enter 换行
											</option>
											<option value="ctrl-enter-send">
												Ctrl/⌘ + Enter 发送，Enter 换行
											</option>
											<option value="shift-enter-send">
												Shift + Enter 发送，Enter 换行
											</option>
										</select>
									</div>
								</SettingsSection>
							</>
						)}
						{activeTab === "proxy" && (
							<>
								<SettingsSection
									title="pi agent 代理"
									description="只注入给新启动的 pi agent 子进程"
								>
									<SettingSwitch
										title="启用 pi agent 代理"
										description="设置变更后，新建或重启 agent 才会生效"
										checked={props.settings.piProxyEnabled}
										onChange={(checked) =>
											props.onChange({ piProxyEnabled: checked })
										}
									/>
									{props.settings.piProxyEnabled && (
										<div className="setting-proxy-panel">
											<div className="setting-field">
												<span>代理地址</span>
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
												<span>绕过代理</span>
												<input
													type="text"
													value={props.settings.piProxyBypass}
													placeholder="localhost,127.0.0.1,::1"
													onChange={(event) =>
														props.onChange({ piProxyBypass: event.target.value })
													}
												/>
												<small className="setting-hint">
													对应 NO_PROXY，多个条目用英文逗号分隔
												</small>
											</div>
											<div className="setting-row">
												<div>
													<strong>代理检测</strong>
													<small>
														检测代理是否能连通 OpenAI API，不校验 API Key
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
													{props.piProxyChecking ? "检测中..." : "检测代理"}
												</button>
											</div>
										</div>
									)}
								</SettingsSection>
								<SettingsSection
									title="桌面端代理"
									description="用于模型拉取、模型测试等桌面自身请求"
								>
									<SettingSwitch
										title="启用桌面端网络代理"
										description="不影响已启动的 pi agent"
										checked={props.settings.desktopProxyEnabled}
										onChange={(checked) =>
											props.onChange({ desktopProxyEnabled: checked })
										}
									/>
									{props.settings.desktopProxyEnabled && (
										<div className="setting-proxy-panel">
											<div className="setting-field">
												<span>代理地址</span>
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
												<span>绕过代理</span>
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
													用于 Electron 网络栈，多个条目可用逗号或分号分隔
												</small>
											</div>
										</div>
									)}
								</SettingsSection>
							</>
						)}
						{activeTab === "dev" && (
							<>
								<SettingsSection title="环境">
									<div className="setting-row">
										<div>
											<strong>pi 环境</strong>
											<small>
												{props.piStatus
													? props.piStatus.installed
														? `已找到 ${props.piStatus.version ?? "pi"}`
														: "未检测到 pi CLI"
													: "检查 pi CLI 是否可用"}
											</small>
										</div>
										<button onClick={props.onCheckPi} disabled={props.piChecking}>
											{props.piChecking ? "检测中…" : "检测环境"}
										</button>
									</div>
									<div className="setting-row">
										<div>
											<strong>当前版本</strong>
											<small>v{props.appInfo.version}</small>
										</div>
										<button onClick={props.onCheckUpdate}>检测更新</button>
									</div>
								</SettingsSection>
								<SettingsSection title="调试">
									<div className="setting-row">
										<div>
											<strong>开发者控制台</strong>
											<small>打开 DevTools 查看控制台日志，排查问题</small>
										</div>
										<button onClick={props.onToggleDevTools}>
											打开/关闭
										</button>
									</div>
								</SettingsSection>
							</>
						)}
						<p>{props.notice || "标题栏设置保存后需要重启应用生效。"}</p>
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
						<strong>导入 Codex 会话</strong>
						<small>{props.project.name}</small>
					</div>
					<button onClick={props.onClose}>×</button>
				</div>
				<div className="codex-import-toolbar">
					<div>
						<strong>{props.sessions.length} 个可导入会话</strong>
						<span>{displayPath(props.project.path)}</span>
					</div>
					<div className="codex-import-actions">
						<button onClick={props.onRefresh} disabled={props.loading || props.importing}>
							<RefreshCw size={14} />
							刷新
						</button>
						<button onClick={props.onToggleAll} disabled={props.sessions.length === 0}>
							<Check size={14} />
							{allSelected ? "取消全选" : "全选"}
						</button>
						<button
							className="primary-action"
							onClick={props.onImport}
							disabled={props.importing || props.selectedPaths.length === 0}
						>
							<UploadCloud size={14} />
							{props.importing ? "导入中..." : `导入 ${props.selectedPaths.length}`}
						</button>
					</div>
				</div>
				<div className="codex-import-body">
					{props.loading ? (
						<div className="history-loading">
							<div className="loader" />
							<span>正在扫描当前项目的 Codex 会话...</span>
						</div>
					) : props.sessions.length === 0 ? (
						<div className="codex-import-empty">
							<strong>没有找到当前项目的 Codex 会话</strong>
							<span>只会扫描 `~/.codex/sessions` 中 cwd 与当前项目一致的会话。</span>
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
											{session.messageCount} messages ·{" "}
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
							导入完成：{props.report.imported} 成功，{props.report.failed} 失败
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
	if (status === "current") return "已是最新";
	if (status === "outdated") return "可覆盖更新";
	return "未导入";
}

function formatBytes(value: number) {
	if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
	if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${value} B`;
}

type SettingsTabId = "base" | "proxy" | "dev";

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
				onChange={(event) => props.onChange(event.target.checked)}
			/>
		</label>
	);
}
