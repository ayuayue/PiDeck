/**
 * WebComposer — Web 端消息输入区（与桌面 ComposerArea 的 composer-box 同风格）。
 *
 * 复用桌面 .composer / .composer-box 样式类 + shadcn Button：
 * - textarea 由 .composer textarea 统一样式（透明底、内边距、随内容撑高）
 * - Enter 发送、Shift/Ctrl+Enter 换行
 * - 两行工具区（DeepSeek 式）：操作行（后端/图片/提示词/计划模式 + 发送）在上，
 *   模型行（模型/思考选择器）驻留在底部
 * - 计划模式复用桌面 composerBehavior 的 buildComposerPromptSubmission：
 *   agentMessage 携带隐藏标记，由内置扩展 pi-deck-plan-mode 识别后切只读工具集；
 *   一次性提交流（发完自动回普通模式），斜线命令原样发送不受标记污染
 * - 图片附件：文件选择 + 粘贴，发送前经 webImageCompress 压缩（P2）
 * - 提示词库：内嵌 WebPromptPicker，选中后回填 draft（P2）
 * - prefill：重发（prepare-resend）/提示词插入时由父级填充文本，nonce 变化触发
 * - 无会话时禁用；流式期间提交按钮转为停止
 */
import { useEffect, useRef, useState, type FocusEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ClipboardList, CornerDownLeft, ImagePlus, ListEnd, X } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { AgentBackend, AvailableModel, ComposerAgentMode, SessionModelPreference } from "../../../shared/types";
import { buildComposerPromptSubmission } from "../composerBehavior";
import { compressImageToDataUrl, imagesFromPasteEvent } from "./webImageCompress";
import { WebModelSelector } from "./WebModelSheet";
import { WebBackendSelector } from "./WebBackendSelector";
import { WebThinkingSelector } from "./WebThinkingSelector";
import { WebPromptPicker } from "./WebPromptPicker";
import { useIsMobileViewport } from "./useIsMobileViewport";
import { resolveComposerCollapsed } from "./composerCollapse";

/** 单会话图片上限（压缩后每张约 100–300KB，4 张足够多数场景且 body 可控）。 */
const MAX_ATTACHED_IMAGES = 4;

/**
 * 输入框提示文案：没有选中会话时不能再写「发送到当前会话」——此时输入是新建会话的入口，
 * 文案必须说清这一点（Web 走查 #5）。
 */
function composerPlaceholder(hasSession: boolean, planMode: boolean): string {
	if (planMode) return t("app.composerPlanPlaceholder");
	return hasSession ? t("web.promptPlaceholder") : t("web.promptPlaceholderEmpty");
}

const BLUR_COLLAPSE_DELAY_MS = 250;

export function WebComposer(props: {
	disabled: boolean;
	streaming: boolean;
	/** 第四批：后端选择驻留 composer（对齐桌面端后端切换，仅草稿期可切）。 */
	backend?: import("../../../shared/types").AgentBackend;
	backendLocked?: boolean;
	onBackendChange?: (backend: import("../../../shared/types").AgentBackend) => void;
	/** 第三批：模型/思考选择驻留 composer（从 WebHeader 迁入）。 */
	model?: SessionModelPreference;
	models: AvailableModel[];
	refreshingModels?: boolean;
	onRefreshModels?: () => void;
	onModelChange: (model: AvailableModel) => void;
	thinkingLevel?: string;
	onThinkingChange: (level: string) => void;
	/** 提交时携带的图片（data URL，已压缩）；父级在 onSend 后清空自己的附件态。 */
	onSend: (text: string, images: string[], agentMessage?: string) => void;
	onStop: () => void;
	/** 回合进行中提交 → 排队到本轮结束后自动发送（对齐桌面 followUp 语义）。 */
	onQueue?: (text: string, images: string[], agentMessage?: string) => void;
	/** 当前会话的待发送队列（只读投影：正文首行 + 图片数）。 */
	queued?: Array<{ id: string; text: string; imageCount: number }>;
	onRemoveQueued?: (id: string) => void;
	/** 停止后暂停自动发送（避免停止后立刻又自动发出下一条）。 */
	queuePaused?: boolean;
	/** 暂停态下恢复自动投递（等同于用户主动发送，但不必先打一条消息）。 */
	onResumeQueue?: () => void;
	/** 父级驱动的预填充（重发 / 提示词插入）；nonce 变化才生效，避免重复触发。 */
	prefill?: { text: string; nonce: number };
	onFocusChange?: (focused: boolean) => void;
	onEngagedChange?: (engaged: boolean) => void;
	hidden?: boolean;
	/** 是否已选中会话（无会话时输入框是新建会话入口，提示文案不同）。 */
	hasSession?: boolean;
}) {
	const [draft, setDraft] = useState("");
	const [images, setImages] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [attachError, setAttachError] = useState(false);
	// 计划模式：一次性提交流（对齐桌面 composer 语义），发送后自动回普通
	const [mode, setMode] = useState<ComposerAgentMode>("normal");
	const [focused, setFocused] = useState(false);
	const mobileViewport = useIsMobileViewport();
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const composerRef = useRef<HTMLDivElement | null>(null);
	const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const lastPrefillNonce = useRef<number>(-1);

	useEffect(() => {
		const prefill = props.prefill;
		if (!prefill || prefill.nonce === lastPrefillNonce.current) return;
		lastPrefillNonce.current = prefill.nonce;
		setDraft(prefill.text);
		textareaRef.current?.focus();
	}, [props.prefill]);

	const addFiles = async (files: File[]) => {
		const picks = files.filter((file) => file.type.startsWith("image/")).slice(0, MAX_ATTACHED_IMAGES);
		if (picks.length === 0) return;
		setBusy(true);
		setAttachError(false);
		try {
			const encoded = await Promise.all(picks.map((file) => compressImageToDataUrl(file)));
			setImages((prev) => [...prev, ...encoded].slice(0, MAX_ATTACHED_IMAGES));
		} catch {
			setAttachError(true);
		} finally {
			setBusy(false);
		}
	};

	const submit = () => {
		const text = draft.trim();
		if ((!text && images.length === 0) || props.disabled || busy) return;
		// 复用桌面单一来源：plan 模式生成隐藏 agentMessage（标记+只读分析指令），
		// 用户可见消息保持原文；斜线命令原样发送不受标记污染
		const submission = buildComposerPromptSubmission(text, mode);
		// 回合进行中：入队等待本轮结束后自动发送（桌面 followUp 队列同语义）。
		// 此前这里直接 return，用户只能干等——流式期间输入框看着可用却发不出去。
		if (props.streaming) {
			if (!props.onQueue) return;
			props.onQueue(text, images, submission.agentMessage);
		} else {
			props.onSend(text, images, submission.agentMessage);
		}
		setDraft("");
		setImages([]);
		if (mode === "plan") setMode("normal");
	};

	const clearBlurTimer = () => {
		if (blurTimerRef.current === null) return;
		clearTimeout(blurTimerRef.current);
		blurTimerRef.current = null;
	};
	useEffect(() => clearBlurTimer, []);
	const handleComposerFocus = () => {
		clearBlurTimer();
		setFocused(true);
		props.onFocusChange?.(true);
	};
	const handleComposerBlur = (event: FocusEvent<HTMLDivElement>) => {
		const next = event.relatedTarget;
		if (next && event.currentTarget.contains(next)) return;
		clearBlurTimer();
		blurTimerRef.current = setTimeout(() => {
			blurTimerRef.current = null;
			if (composerRef.current?.contains(document.activeElement)) return;
			setFocused(false);
			props.onFocusChange?.(false);
		}, BLUR_COLLAPSE_DELAY_MS);
	};

	const collapsed = resolveComposerCollapsed({ mobileViewport, draft, imageCount: images.length, streaming: props.streaming, focused, busy, attachError, planMode: mode === "plan" });
	const placeholder = composerPlaceholder(props.hasSession !== false, mode === "plan");
	const collapsedBackendPicker = collapsed && Boolean(props.onBackendChange) && !props.backendLocked;
	// 移动端按下工具行按钮不抢焦点（键盘不闪退）。但弹层/浮层经 portal 挂到 body，
	// React 事件仍沿组件树冒泡到这里——落点不在输入区 DOM 内时（模型/思考/后端弹层、
	// 提示词浮层的搜索框）绝不能 preventDefault，否则点击弹层搜索框不会聚焦、
	// 移动端模型搜索完全无法输入（2026-10 实测：activeElement 停在 composer textarea）。
	const suppressPointerFocus = mobileViewport
		? (event: ReactPointerEvent<HTMLDivElement>) => {
				if (!composerRef.current?.contains(event.target as Node)) return;
				event.preventDefault();
			}
		: undefined;
	const engaged = focused || draft !== "" || images.length > 0;
	useEffect(() => {
		props.onEngagedChange?.(engaged);
	}, [engaged, props.onEngagedChange]);
	const canQueueDraft = Boolean(props.onQueue) && (draft.trim().length > 0 || images.length > 0);
	const sendControls = (compact: boolean) =>
		props.streaming ? (
			// 流式中：有内容才显示「排队」按钮，与「停止」并列（窄屏只显示图标，避免挤掉停止）
			<span className="flex shrink-0 items-center gap-1">
				{canQueueDraft ? (
					<Button type="submit" variant="secondary" size="sm" className="h-8 shrink-0 gap-1 whitespace-nowrap px-2 pointer-coarse:h-10" data-testid={compact ? "web-composer-queue-compact" : "web-composer-queue"} title={t("app.sendFollowUpTitle")} aria-label={t("app.sendFollowUpTitle")}>
						<CornerDownLeft className="size-3.5 shrink-0" aria-hidden="true" />
						{compact ? null : <span className="text-caption">{t("app.queuedBehaviorFollowUpShort")}</span>}
					</Button>
				) : null}
				<Button type="button" variant="destructive" size="sm" className="h-8 shrink-0 pointer-coarse:h-10" data-testid={compact ? "web-composer-stop-compact" : "web-composer-stop"} onClick={props.onStop}>
					{t("app.stop")}
				</Button>
			</span>
		) : (
			<Button type="submit" size="sm" className="h-8 shrink-0 whitespace-nowrap pointer-coarse:h-10" data-testid={compact ? "web-composer-send-compact" : "web-composer-send"} disabled={props.disabled || busy || (!draft.trim() && images.length === 0)}>
				{t("app.send")}
			</Button>
		);

	return (
		<div className={cn("grid shrink-0 transition-[grid-template-rows] duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none", props.hidden ? "grid-rows-[0fr]" : "grid-rows-[1fr]")}>
			{/* 收起时同时 inert + aria-hidden：overflow-hidden 只裁剪，看不见的输入框仍可被 Tab 命中。
			    justify-end 让内容贴着底部滑出（否则是从下往上被“吃掉”）；配合同步 opacity 淡出，避免硬切感 */}
			<div className={cn("min-h-0 transition-[translate,opacity] duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none", props.hidden ? "translate-y-full opacity-0" : "translate-y-0 opacity-100")} inert={Boolean(props.hidden)} aria-hidden={props.hidden || undefined}>
				<form
					className="composer w-full min-w-0 flex-col gap-2 bg-background px-3 pb-3"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					{/* 待发送队列条：回合进行中入队的消息在此常显，可逐条撤回；停止后标「已暂停」，
					    用户再次发送（或点继续）才恢复自动投递，避免停止后又自己发出去。 */}
					{props.queued && props.queued.length > 0 ? (
						<div className="flex shrink-0 flex-col gap-1 rounded-lg border border-border bg-muted/40 px-2 py-1.5" data-testid="web-composer-queue-strip">
							<div className="flex items-center gap-1.5 text-micro text-muted-foreground">
								<ListEnd className="size-3 shrink-0" aria-hidden="true" />
								<span className="shrink-0 font-medium">{t("app.queuedMessagesLabel")}</span>
								<span className="tabular-nums">{props.queued.length}</span>
								{props.queuePaused ? (
									<>
										<span className="shrink-0 rounded bg-warning/15 px-1.5 py-px text-warning">{t("app.queueDrainPausedBadge")}</span>
										{props.onResumeQueue ? (
											<button type="button" className="ml-auto inline-flex shrink-0 items-center rounded bg-primary px-2 py-0.5 text-micro font-medium text-primary-foreground pointer-coarse:min-h-9 pointer-coarse:px-3" onClick={props.onResumeQueue} data-testid="web-composer-queue-resume">
												{t("web.queueResume")}
											</button>
										) : null}
									</>
								) : null}
							</div>
							<ul className="flex max-h-24 shrink-0 flex-col gap-1 overflow-y-auto">
								{props.queued.map((item) => (
									<li key={item.id} className="flex min-h-8 shrink-0 items-center gap-1.5 rounded-md bg-background/70 px-1.5 py-1">
										<span className="min-w-0 flex-1 truncate text-micro text-foreground">{item.text || t("app.queuedImageMessage")}</span>
										{item.imageCount > 0 ? <span className="shrink-0 text-micro text-muted-foreground">{t("app.queuedImageCount", { count: item.imageCount })}</span> : null}
										<button type="button" className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground pointer-coarse:p-2" aria-label={t("web.queueRemove")} title={t("web.queueRemove")} onClick={() => props.onRemoveQueued?.(item.id)}>
											<X className="size-3" aria-hidden="true" />
										</button>
									</li>
								))}
							</ul>
						</div>
					) : null}
					<div
						ref={composerRef}
						onFocus={handleComposerFocus}
						onBlur={handleComposerBlur}
						className={cn("composer-box relative flex min-w-0 flex-col overflow-visible rounded-xl border border-border bg-card text-card-foreground shadow-sm transition-[border-color,box-shadow,background-color]", collapsed ? "min-h-14" : "min-h-[7rem]")}
					>
						{images.length > 0 ? (
							<div className="flex flex-wrap gap-2 px-3 pt-3">
								{images.map((src, index) => (
									<span key={`${index}-${src.slice(-24)}`} className="relative inline-block size-14 overflow-hidden rounded-md border border-border">
										<img src={src} alt={t("web.messageImage")} className="size-full object-cover" />
										<button type="button" aria-label={t("web.removeImage")} className="absolute top-0.5 right-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground" onClick={() => setImages((prev) => prev.filter((_, position) => position !== index))}>
											<X className="size-3" aria-hidden="true" />
										</button>
									</span>
								))}
							</div>
						) : null}
						<textarea
							id="prompt"
							ref={textareaRef}
							/* legacy .composer textarea 带 height:100%（桌面横向布局遗留）：web 端纵列布局下会把工具行挤出，utilities 层覆盖为随内容自适应 */
							className={cn("h-auto max-h-[40dvh] min-h-14", collapsedBackendPicker && "pr-28")}
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onPaste={(event) => {
								const pasted = imagesFromPasteEvent(event.nativeEvent as ClipboardEvent);
								if (pasted.length > 0) {
									event.preventDefault();
									void addFiles(pasted);
								}
							}}
							placeholder={placeholder}
							disabled={props.disabled}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
									event.preventDefault();
									submit();
								}
							}}
							aria-label={placeholder}
						/>
						{attachError ? <div className="px-3 text-micro text-danger">{t("web.imageAttachFailed")}</div> : null}
						{collapsed ? (
							<div className="absolute right-2 bottom-2 flex items-center gap-1" onPointerDown={suppressPointerFocus}>
								{collapsedBackendPicker && props.onBackendChange ? <WebBackendSelector backend={props.backend ?? "pi"} locked={false} onChange={props.onBackendChange} /> : null}
								{sendControls(true)}
							</div>
						) : null}
						<div className={cn("grid shrink-0 transition-[grid-template-rows] duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none", collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]")} data-testid="web-composer-tool-rows" inert={collapsed} aria-hidden={collapsed || undefined}>
							<div className={cn("min-h-0 overflow-hidden transition-opacity duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none", collapsed ? "opacity-0" : "opacity-100")}>
								<div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-3 pt-2" data-testid="web-composer-ops-row" onPointerDown={suppressPointerFocus}>
									<span className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
										<input
											ref={fileInputRef}
											type="file"
											accept="image/*"
											multiple
											className="hidden"
											onChange={(event) => {
												const files = Array.from(event.target.files ?? []);
												void addFiles(files);
												event.target.value = "";
											}}
										/>
										{props.onBackendChange ? <WebBackendSelector backend={props.backend ?? "pi"} locked={Boolean(props.backendLocked)} onChange={props.onBackendChange} /> : null}
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="h-8 w-8 shrink-0 p-0 text-muted-foreground pointer-coarse:h-9 pointer-coarse:w-9"
											disabled={props.disabled || busy || images.length >= MAX_ATTACHED_IMAGES}
											title={t("web.attachImage")}
											aria-label={t("web.attachImage")}
											onClick={() => fileInputRef.current?.click()}
										>
											<ImagePlus className="size-4" aria-hidden="true" />
										</Button>
										<WebPromptPicker disabled={props.disabled} onPick={(content) => setDraft((prev) => (prev ? `${prev}\n\n${content}` : content))} />
										{/* 计划模式切换（复用桌面「+」菜单里的模式项语义）：激活态高亮；一次性提交流，发送后自动回普通 */}
										<Button
											type="button"
											variant={mode === "plan" ? "default" : "ghost"}
											size="sm"
											className="h-8 shrink-0 gap-1 px-2 pointer-coarse:h-9"
											aria-pressed={mode === "plan"}
											disabled={props.disabled}
											title={t("app.composerModePlanDesc")}
											onClick={() => setMode((prev) => (prev === "plan" ? "normal" : "plan"))}
										>
											<ClipboardList className="size-4" aria-hidden="true" />
											<span className="text-caption">{t("app.composerModePlan")}</span>
										</Button>
									</span>
									{sendControls(false)}
								</div>
								{/* 模型行（底部驻留）：模型/思考选择器 + 状态提示（计划模式时提示只读分析语义） */}
								<div className="flex shrink-0 items-center gap-1.5 px-3 pt-1.5 pb-2.5" data-testid="web-composer-model-row" onPointerDown={suppressPointerFocus}>
									{/* 模型+思考两个 pill 靠左成组，提示文案推到行尾两端对齐，避免整行挤在左侧留大片空白 */}
									<WebModelSelector model={props.model} models={props.models} refreshing={props.refreshingModels} onRefresh={props.onRefreshModels} onChange={props.onModelChange} />
									<WebThinkingSelector level={props.thinkingLevel} onChange={props.onThinkingChange} />
									<span className="composer-hint ml-auto hidden min-w-0 truncate text-caption text-muted-foreground sm:inline">{mode === "plan" ? t("app.composerPlanStatus") : t("web.composerHint")}</span>
								</div>
							</div>
						</div>
					</div>
				</form>
			</div>
		</div>
	);
}
