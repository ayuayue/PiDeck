import { AlertTriangle, ArrowUp, ChevronDown, ChevronUp, Clock, FileText, ListOrdered, LoaderCircle, Pencil, Split, Square, X, XCircle } from "lucide-react";
import { useId, type RefObject } from "react";
import { useAtomValue, useStore } from "jotai";
import type { ImageContent } from "../../../../shared/types";
import { imageContentSrc } from "../../../../shared/imageContentSrc";
import { formatBytes } from "../../../../shared/formatBytes";
import { replaceExpandedRefBlocksWithLabels } from "./composer/quoteChip";
import type { PastedTextFile } from "../../atoms";
import type { QueuedPromptSnapshot } from "../../utils/queuedPromptQueue";
import { resolveComposerSendButtonState } from "../../utils/composerSendButton";
import { buildAskContextBlock } from "../../utils/askPanelContext";
import { canChangeQueuedPromptBehavior, canDiscardQueuedPrompt, canRetractQueuedPromptToInput, discardControlHint, retractControlHint } from "../../utils/queuedPromptQueue";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { ButtonGroup } from "../ui-shadcn/button-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { sessionRecordByIdAtomFamily } from "../../atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms/session-selectors";
import { useAskPanel } from "../../hooks/useAskPanel";
import { sessionMessageCacheBySessionIdAtomFamily } from "../../atoms/session-atoms";
import { isSessionRuntimeBusy } from "../../hooks/useSessionTimelineController";
import { ExtensionWidgetCard } from "./ComposerParts";
import { ComposerWidgetFrame, useComposerWidgetCollapsed } from "./ComposerWidgetLayout";

export function ComposerAttachmentBar(props: {
	images: ImageContent[];
	onPreview: (image: ImageContent) => void;
	onRemove: (index: number) => void;
	onClear: () => void;
	/** 粘贴大文本转文件 chip（与图片预览同一附件栏展示） */
	pasteFiles?: PastedTextFile[];
	onRemovePasteFile?: (index: number) => void;
	onClearPasteFiles?: () => void;
}) {
	const hasImages = props.images.length > 0;
	const hasPasteFiles = Boolean(props.pasteFiles?.length);
	if (!hasImages && !hasPasteFiles) return null;
	return (
		<div className="image-preview-area w-full">
			{props.images.map((image, index) => {
				// 附件栏图片来自内存（内联 base64）；重发历史生图时是落盘引用，统一解析
				const src = imageContentSrc(image);
				if (!src) return null;
				return (
					<div key={index} className="image-preview-item">
						<img src={src} alt={t("app.imageAlt", { index: index + 1 })} onClick={() => props.onPreview(image)} style={{ cursor: "pointer" }} />
						<Button variant="ghost" size="icon" className="image-remove-btn" aria-label={t("app.imageRemove")} title={t("app.imageRemove")} onClick={() => props.onRemove(index)}>
							<X size={12} strokeWidth={2.4} aria-hidden="true" />
						</Button>
					</div>
				);
			})}
			{props.pasteFiles?.map((file, index) => (
				<div key={file.id} className="paste-file-chip" title={file.path}>
					<FileText size={14} strokeWidth={2} className="shrink-0" aria-hidden="true" />
					<span className="paste-file-chip-name">{file.fileName}</span>
					<span className="paste-file-chip-size">{formatBytes(file.bytes)}</span>
					<Button variant="ghost" size="icon" className="image-remove-btn paste-file-remove-btn" aria-label={t("app.pasteFileRemove")} title={t("app.pasteFileRemove")} onClick={() => props.onRemovePasteFile?.(index)}>
						<X size={12} strokeWidth={2.4} aria-hidden="true" />
					</Button>
				</div>
			))}
			{(hasImages || hasPasteFiles) && (
				<Button
					variant="secondary"
					size="sm"
					className="image-clear-btn"
					onClick={() => {
						props.onClear();
						props.onClearPasteFiles?.();
					}}
				>
					{t("app.clearImages")}
				</Button>
			)}
		</div>
	);
}

export function ExtensionWidgetPanel(props: {
	widgets?: Record<string, string[]>;
	sessionId?: string;
	/** @deprecated A8 compatibility for the pre-leaf App call site. */
	sessionKey?: string;
	dismissedKeys: string[];
	collapsed: boolean;
	onDismiss: (widgetKey: string) => void;
}) {
	const sessionId = props.sessionId ?? props.sessionKey;
	if (!sessionId || !props.widgets || !Object.keys(props.widgets).length) return null;
	return (
		<div className="extension-widgets-container w-full">
			{!props.collapsed &&
				Object.entries(props.widgets)
					.filter(([widgetKey]) => !props.dismissedKeys.includes(widgetKey))
					.map(([widgetKey, lines]) => <ExtensionWidgetCard key={widgetKey} widgetKey={widgetKey} lines={lines} sessionIdOrPath={sessionId} onClose={() => props.onDismiss(widgetKey)} />)}
		</div>
	);
}

function QueueStatusGlyph(props: { status: QueuedPromptSnapshot["status"] }) {
	const status = props.status ?? "pending";
	if (status === "sending") {
		return <LoaderCircle size={14} strokeWidth={2} className="shrink-0 animate-pideck-spin text-text-secondary" aria-hidden="true" />;
	}
	if (status === "failed") {
		return <XCircle size={14} strokeWidth={2} className="shrink-0 text-[var(--color-danger)]" aria-hidden="true" />;
	}
	if (status === "unknown") {
		return <AlertTriangle size={14} strokeWidth={2} className="shrink-0 text-[var(--color-warning)]" aria-hidden="true" />;
	}
	return <Clock size={14} strokeWidth={2} className="shrink-0 text-text-tertiary" aria-hidden="true" />;
}

function QueuedPromptRow(props: {
	prompt: QueuedPromptSnapshot;
	index: number;
	showQueueGlyph: boolean;
	sessionId: string;
	agentBusy: boolean;
	onRetract: (sessionId: string, prompt: QueuedPromptSnapshot) => void;
	onDiscard: (sessionId: string, promptId: string) => void;
	onChangeBehavior: (sessionId: string, promptId: string, behavior: "steer" | "followUp") => void;
	onSendAsk: (prompt: QueuedPromptSnapshot) => void;
}) {
	const status = props.prompt.status ?? "pending";
	// displayText 可能含 quote/session/skill/template 自包含块；纯文本预览只保留其 chip label，
	// 避免队列面板露出完整模型上下文或 XML 标签。
	const previewText = replaceExpandedRefBlocksWithLabels(props.prompt.displayText.trim()) || t("app.queuedImageMessage");
	const retractHint = retractControlHint(status);
	const discardHint = discardControlHint(status);
	const canChangeBehavior = canChangeQueuedPromptBehavior(status);
	const isSteer = props.prompt.behavior === "steer";
	const isFollowUp = props.prompt.behavior === "followUp" || props.prompt.behavior === "direct";
	// 并行问询只投递纯文本，带图的排队项不能误丢附件。
	const canAsk = canChangeBehavior && Boolean((props.prompt.message || props.prompt.displayText).trim()) && !props.prompt.images?.length;
	const retractTitle = [t("app.retractToInput"), !retractHint.disabled ? "" : retractHint.reason === "unknown" ? t("app.queuedRetractDisabledUnknown") : t("app.queuedRetractDisabledSending")].filter(Boolean).join("\n");
	const discardTitle = discardHint.disabled ? [t("app.retractDiscard"), t("app.queuedDiscardDisabledSending")].filter(Boolean).join("\n") : t("app.retractDiscard");
	const steerTitle = canChangeBehavior ? (props.agentBusy ? t("app.sendSteerTitle") : t("app.queuedSteerUnavailable")) : t("app.queuedBehaviorLocked");
	const followUpTitle = canChangeBehavior ? t("app.sendFollowUpTitle") : t("app.queuedBehaviorLocked");
	const askTitle = !canChangeBehavior ? t("app.queuedBehaviorLocked") : props.prompt.images?.length ? t("app.queuedAskUnsupported") : t("app.sendAskTitle");
	const rowTitle = [t("app.queuedOrder", { n: props.index + 1 }), isSteer ? t("app.sendSteerTitle") : t("app.sendFollowUpTitle"), previewText, props.prompt.error, status === "unknown" ? t("app.queuedUnknown") : ""].filter(Boolean).join("\n");
	const actionClass = "size-7 rounded-full text-text-tertiary hover:bg-muted/70 hover:text-foreground";

	return (
		<li className={`queued-row flex h-9 min-h-9 shrink-0 items-center gap-2.5 border-transparent px-3 transition-[border-color,background-color] duration-100 ${status} queued-behavior-${props.prompt.behavior}`} title={rowTitle}>
			{props.showQueueGlyph ? <ListOrdered size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" /> : <QueueStatusGlyph status={status} />}
			<span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-text-secondary">{previewText}</span>
			{props.prompt.images?.length ? <span className="shrink-0 font-mono text-micro leading-none text-text-tertiary">{t("app.queuedImageCount", { count: String(props.prompt.images.length) })}</span> : null}
			{status === "sending" ? (
				<span className="shrink-0 font-mono text-micro leading-none text-text-tertiary">{t("app.queuedSending")}</span>
			) : status === "failed" ? (
				<span className="shrink-0 font-mono text-micro leading-none text-[var(--color-danger)]">{t("app.queuedFailed")}</span>
			) : status === "unknown" ? (
				<span className="shrink-0 font-mono text-micro leading-none text-[var(--color-warning)]">{t("app.queuedUnknownShort")}</span>
			) : (
				<span className="shrink-0 font-mono text-micro leading-none text-text-tertiary">{isSteer ? t("app.queuedBehaviorSteerShort") : t("app.queuedBehaviorFollowUpShort")}</span>
			)}
			<div className="inline-flex shrink-0 items-center gap-0.5">
				<Button variant="ghost" size="icon-xs" className={`${actionClass}${isSteer ? " text-foreground" : ""}`} aria-label={t("app.sendSteerTitle")} title={steerTitle} disabled={!canChangeBehavior || !props.agentBusy} onClick={() => props.onChangeBehavior(props.sessionId, props.prompt.id, "steer")}>
					<ArrowUp size={14} strokeWidth={2} aria-hidden="true" />
				</Button>
				<Button variant="ghost" size="icon-xs" className={`${actionClass}${isFollowUp ? " text-foreground" : ""}`} aria-label={t("app.sendFollowUpTitle")} title={followUpTitle} disabled={!canChangeBehavior} onClick={() => props.onChangeBehavior(props.sessionId, props.prompt.id, "followUp")}>
					<ListOrdered size={14} strokeWidth={2} aria-hidden="true" />
				</Button>
				<Button variant="ghost" size="icon-xs" className={actionClass} aria-label={t("app.sendAskTitle")} title={askTitle} disabled={!canAsk} onClick={() => props.onSendAsk(props.prompt)}>
					<Split size={14} strokeWidth={2} aria-hidden="true" />
				</Button>
				<Button
					variant="ghost"
					size="icon-xs"
					className="size-7 rounded-full text-text-tertiary hover:bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] hover:text-[color:var(--color-accent)]"
					aria-label={t("app.retractToInput")}
					title={retractTitle}
					disabled={!canRetractQueuedPromptToInput(status)}
					onClick={() => props.onRetract(props.sessionId, props.prompt)}
				>
					<Pencil size={14} strokeWidth={2} aria-hidden="true" />
				</Button>
				<Button
					variant="ghost"
					size="icon-xs"
					className="size-7 rounded-full text-text-tertiary hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
					aria-label={t("app.retractDiscard")}
					title={discardTitle}
					disabled={!canDiscardQueuedPrompt(status)}
					onClick={() => props.onDiscard(props.sessionId, props.prompt.id)}
				>
					<X size={14} strokeWidth={2} aria-hidden="true" />
				</Button>
			</div>
		</li>
	);
}

/**
 * composer 上方的排队消息卡（移植自 dsh-web QueueDock 的独立卡形态）。
 * 与 todo / goal 同列同宽：1 条直接一行；多条默认折叠计数头，展开后 180px 内滚动。
 * 行内操作：插入当前回合 / 排队下一轮 / 并行发送，以及撤回进输入框 / 丢弃。
 */
export function QueuedPromptPanel(props: {
	trackRef: RefObject<HTMLElement | null>;
	sessionId?: string;
	prompts: QueuedPromptSnapshot[];
	/** @deprecated 独立卡展示全部排队项并由 180px 列表滚动；保留以免调用点同步炸掉。 */
	visiblePrompts: QueuedPromptSnapshot[];
	onRetract: (sessionId: string, prompt: QueuedPromptSnapshot) => void;
	onDiscard: (sessionId: string, promptId: string) => void;
	onChangeBehavior: (sessionId: string, promptId: string, behavior: "steer" | "followUp") => void;
}) {
	const listId = useId();
	const sessionId = props.sessionId;
	const { collapsed, toggleCollapsed } = useComposerWidgetCollapsed(`queue:${sessionId ?? "unbound"}`, true);
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId ?? ""));
	const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(sessionId ?? ""));
	const askPanel = useAskPanel();
	const store = useStore();
	const agentBusy = isSessionRuntimeBusy(runtime?.status, runtime?.state);
	if (!sessionId || !props.prompts.length) return null;

	const multiple = props.prompts.length > 1;
	const listVisible = !multiple || !collapsed;

	const sendAsk = (prompt: QueuedPromptSnapshot) => {
		const projectId = sessionRecord?.projectId;
		const text = prompt.message.trim() || prompt.displayText.trim();
		if (!projectId || !text) return;
		// 上下文继承：把发起排队的主会话最近对话（纯函数生成，见 askPanelContext.ts）
		// 随并行问询一并带上（经 agentMessage 注入，只有模型可见），让独立会话
		// 能回答需要主会话前因后果的问题（对齐 pi-btw 的 side thread 上下文继承）。
		const mainMessages = store.get(sessionMessageCacheBySessionIdAtomFamily(sessionId))?.messages ?? [];
		const context = buildAskContextBlock(mainMessages, {
			title: t("askPanel.contextTitle"),
			userLabel: t("askPanel.contextUser"),
			assistantLabel: t("askPanel.contextAssistant"),
		});
		// 并行是立刻开独立会话，不再占着当前会话队列；成功后再从排队区拿掉。
		void askPanel
			.sendToAsk(projectId, text, {
				// 携带主会话上下文：并行会话能理解前因后果（null 表示无上下文可带，自动跳过）
				...(context ? { context } : {}),
				// 记录来源主会话：详情浮层「插入主会话 composer」时把回答送回这个会话
				originSessionId: sessionId,
			})
			.then((ok) => {
				if (ok) props.onDiscard(sessionId, prompt.id);
			});
	};

	return (
		<ComposerWidgetFrame ref={props.trackRef} className="queued-track" data-testid="session-queue-strip" aria-label={t("app.queuedMessagesLabel")}>
			{multiple ? (
				<button type="button" className="flex h-9 w-full items-center gap-2.5 px-3 text-left" aria-controls={listId} aria-expanded={listVisible} onClick={toggleCollapsed}>
					<ListOrdered size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
					<span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-6 text-foreground">{t("sessionQueue.count", { n: props.prompts.length })}</span>
					<span className="shrink-0 text-text-tertiary" aria-hidden="true">
						{listVisible ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
					</span>
				</button>
			) : null}
			{listVisible ? (
				<ul id={listId} className={multiple ? "mb-1 flex max-h-[180px] flex-col overflow-y-auto overscroll-contain [contain:layout_paint]" : "flex flex-col"}>
					{props.prompts.map((prompt, index) => (
						<QueuedPromptRow key={prompt.id} prompt={prompt} index={index} showQueueGlyph={!multiple} sessionId={sessionId} agentBusy={agentBusy} onRetract={props.onRetract} onDiscard={props.onDiscard} onChangeBehavior={props.onChangeBehavior} onSendAsk={sendAsk} />
					))}
				</ul>
			) : null}
		</ComposerWidgetFrame>
	);
}

export function SessionDeliveryNotice(props: { status: "unknown" | "idle" | "activating" | "sending" | "error"; message?: string; images?: ImageContent[]; error?: string; onAcknowledge: () => void }) {
	if (props.status !== "unknown") return null;
	// unknownSnapshot.message 是发送期展开后的文本；提示条只保留各类引用的 label，
	// 避免暴露 XML 块及其长上下文。
	const preview = replaceExpandedRefBlocksWithLabels(props.message?.trim() ?? "") || (props.images?.length ? t("app.queuedImageMessage") : "");
	return (
		<div className="session-delivery-notice" role="status">
			<div className="session-delivery-notice-copy">
				<strong>{t("app.queuedUnknownShort")}</strong>
				{preview ? <span title={preview}>{preview}</span> : null}
				<small>{t("app.queuedUnknown")}</small>
				{props.error ? <small>{props.error}</small> : null}
			</div>
			<Button variant="secondary" size="sm" onClick={props.onAcknowledge}>
				{t("common.confirm")}
			</Button>
		</div>
	);
}

export function ComposerSendControls(props: {
	isAgentBusy: boolean;
	isAgentStarting: boolean;
	/** 输入框是否有内容（文本/附件/粘贴文件）：忙碌但有内容时圆钮仍是发送。 */
	hasContent: boolean;
	canSend: boolean;
	/** 生图进行中：发送按钮显示转圈并禁用（与 busy 区分，不显示停止按钮） */
	isGeneratingImage?: boolean;
	onSend: () => void;
	onStop: () => void;
	/** 拆分菜单：加入当前回合（steer）。仅忙碌时可用，由组件内部按 isAgentBusy 禁用。 */
	onSendSteer?: () => void;
	/** 拆分菜单：排队到下一轮（followUp）。 */
	onSendFollowUp?: () => void;
	/** 拆分菜单：并行发送（新建独立会话后台处理）。无图片附件时可用。 */
	onSendParallel?: () => void;
	/** 并行发送可用性（如有图片附件则置灰）。 */
	canSendParallel?: boolean;
}) {
	// 主题色圆钮（随外观主题主色：经典=近黑、森系绿=鼠尾草绿）。
	// 空闲发送；忙碌且输入框为空时才变停止（清空输入即回到停止）；
	// 忙碌但有内容时保持发送（走 steer/followUp 投递，见 busySendDelivery）。
	// 主钮尺寸对齐底栏其余按钮（28px），避免「过大不统一」。
	const buttonState = resolveComposerSendButtonState({
		isAgentBusy: props.isAgentBusy,
		hasContent: props.hasContent,
		isGeneratingImage: props.isGeneratingImage,
	});
	const primaryStops = buttonState === "stop";
	const label = primaryStops ? t("app.stop") : t("app.send");
	const disabled = primaryStops ? false : props.isAgentStarting || props.isGeneratingImage || !props.canSend;
	// 拆分菜单：把「加入当前回合 / 排队到下一轮 / 并行发送」从「发出后的队列行」前置到发送现场，
	// 让用户在发送前就能发现这三种投递方式（此前只能发出去之后在队列面板里逐条切换）。
	// 菜单项可用性按当前状态收口：加入当前回合仅忙碌时可用；并行要求无图片附件。
	const hasSplitMenu = Boolean(props.onSendSteer || props.onSendFollowUp || props.onSendParallel);
	const splitDisabled = props.isAgentStarting || props.isGeneratingImage || !props.canSend;
	return (
		// shadcn ButtonGroup 官方 split-button 形态：DropdownMenu 直接作为组内子项
		// （Radix 的 DropdownMenu 不产生 DOM 节点，trigger 按钮自然成为第二个成员，
		// 由 ButtonGroup 收平相邻内侧角拼成一颗胶囊），组内不加中间分隔线。
		<ButtonGroup className="composer-send-controls">
			<Button
				variant="default"
				size="icon-sm"
				className="composer-send-primary size-7 rounded-full bg-[var(--color-accent)] px-0 text-[var(--color-text-inverse)] shadow-none hover:bg-[color:color-mix(in_srgb,var(--color-accent)_88%,black)] disabled:opacity-40"
				aria-label={label}
				title={label}
				disabled={disabled}
				onClick={primaryStops ? props.onStop : props.onSend}
			>
				{props.isGeneratingImage ? <LoaderCircle size={14} strokeWidth={2.4} className="animate-pideck-spin" aria-hidden="true" /> : primaryStops ? <Square size={12} strokeWidth={0} fill="currentColor" aria-hidden="true" /> : <ArrowUp size={14} strokeWidth={2.4} aria-hidden="true" />}
			</Button>
			{hasSplitMenu ? (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="default"
							size="icon-sm"
							className="h-7 rounded-full bg-[var(--color-accent)] px-1.5 text-[var(--color-text-inverse)] shadow-none hover:bg-[color:color-mix(in_srgb,var(--color-accent)_88%,black)] disabled:opacity-40"
							aria-label={t("app.sendBehaviorTitle")}
							title={t("app.sendBehaviorTitle")}
							disabled={splitDisabled}
						>
							<ChevronDown size={14} strokeWidth={2.4} aria-hidden="true" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" side="top" sideOffset={6} className="min-w-52">
						{props.onSendSteer ? (
							<DropdownMenuItem disabled={!props.isAgentBusy} onSelect={() => props.onSendSteer?.()}>
								<ArrowUp size={14} strokeWidth={2} aria-hidden="true" />
								<span className="flex min-w-0 flex-1 flex-col">
									<span>{t("app.sendSteerTitle")}</span>
									<span className="truncate text-micro text-muted-foreground">{t("app.sendSteerDesc")}</span>
								</span>
							</DropdownMenuItem>
						) : null}
						{props.onSendFollowUp ? (
							<DropdownMenuItem onSelect={() => props.onSendFollowUp?.()}>
								<ListOrdered size={14} strokeWidth={2} aria-hidden="true" />
								<span className="flex min-w-0 flex-1 flex-col">
									<span>{t("app.sendFollowUpTitle")}</span>
									<span className="truncate text-micro text-muted-foreground">{t("app.sendFollowUpDesc")}</span>
								</span>
							</DropdownMenuItem>
						) : null}
						{props.onSendParallel ? (
							<DropdownMenuItem disabled={props.canSendParallel === false} onSelect={() => props.onSendParallel?.()}>
								<Split size={14} strokeWidth={2} aria-hidden="true" />
								<span className="flex min-w-0 flex-1 flex-col">
									<span>{t("app.sendAskTitle")}</span>
									<span className="truncate text-micro text-muted-foreground">{t("app.sendAskDesc")}</span>
								</span>
							</DropdownMenuItem>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</ButtonGroup>
	);
}
