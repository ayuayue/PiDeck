import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Check, ChevronDown, ChevronRight, Clipboard, CornerDownLeft, Loader2, MessageSquarePlus, Send, X } from "lucide-react";
import removeMarkdown from "remove-markdown";
import { useAskPanel } from "../../hooks/useAskPanel";
import { claimSessionRuntimeUiResponseAtom, rollbackSessionRuntimeUiResponseAtom, sessionMessageCacheBySessionIdAtomFamily } from "../../atoms/session-atoms";
import { recordAskEchoAtom } from "../../atoms/ask-echo-atoms";
import { sessionRuntimeBySessionIdAtomFamily, sessionRuntimeUiBySessionIdAtomFamily } from "../../atoms/session-selectors";
import { setSessionDraftAtom } from "../../atoms/composer-atoms";
import { Input } from "../ui-shadcn/input";
import { createSessionRuntimeUiResponder, SessionRuntimeUiOverlay } from "../overlays/SessionRuntimeUiOverlay";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { clampCapsulePosition, expandedPanelSize, PANEL_GAP, VIEWPORT_MARGIN } from "../../utils/askPanelGeometry";
import { OwnedSessionMessageTimeline } from "../session/OwnedSessionMessageTimeline";

/** 拖动与点击的区分阈值（px）：小于该位移视为点击 */
const DRAG_THRESHOLD_PX = 4;

/**
 * 并行问询悬浮胶囊（AskPanel）：
 * - 发送后会话区域右上方出现一枚可拖动的胶囊：状态点（创建中/运行中/已完成）
 *   + 最新响应的纯文本摘要；点击胶囊展开/收起详情浮层（复用 SessionMessageTimeline
 *   流式渲染 markdown 结果）。
 * - 详情浮层头部 X = 最小化（仅收起详情）；胶囊上的 X = 关闭（停止匿名 runtime 并回收）。
 */
export function AskPanelOverlay() {
	const panel = useAskPanel();
	const [expanded, setExpanded] = useState(false);
	// 追问输入框内容（详情浮层底部，复用同一条匿名会话继续对话）
	const [followUpText, setFollowUpText] = useState("");
	const setInsertComposer = useSetAtom(setSessionDraftAtom);
	// 拖拽位置：null 表示未拖动（使用默认定位，会话区域右上方）；拖动后切换为自由定位
	const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
	// 拖动会话快照：起点坐标 + 起始容器坐标 + 是否已超过点击阈值
	const dragRef = useRef<{
		startX: number;
		startY: number;
		origX: number;
		origY: number;
		moved: boolean;
	} | null>(null);
	// pointerup 时把「本次是否拖动过」留给随后的 click 判断（避免拖动后误触发展开）
	const lastDragMovedRef = useRef(false);

	const sessionId = panel.sessionId;
	const cache = useAtomValue(sessionMessageCacheBySessionIdAtomFamily(sessionId ?? ""));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId ?? ""));
	// ask 提问卡片状态（阻塞式交互，如 ask_question）：由主进程 ui 事件推送
	const sessionRuntimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(sessionId ?? ""));
	const claimSessionUiResponse = useSetAtom(claimSessionRuntimeUiResponseAtom);
	const rollbackSessionUiResponse = useSetAtom(rollbackSessionRuntimeUiResponseAtom);
	const setRecordAskEcho = useSetAtom(recordAskEchoAtom);
	const runtimeRef = useRef(runtime);
	runtimeRef.current = runtime;

	// 与 SessionRuntimeInjector 相同的 UI 响应器：渲染 ask 卡片并回传回答；
	// 绑定本会话的 agentId/runtimeGeneration，拒绝旧 runtime 的迟到响应
	const runtimeUiResponder = useMemo(() => {
		// 组件在 !panel.isOpen || !sessionId 时提前 return，但 TS 无法收窄闭包内的 sessionId
		if (!sessionId || !runtime?.agentId) return undefined;
		const binding = {
			sessionId,
			agentId: runtime.agentId,
			runtimeGeneration: runtime.runtimeGeneration,
		};
		return createSessionRuntimeUiResponder({
			binding,
			readBinding: () => {
				const latest = runtimeRef.current;
				return latest?.agentId
					? {
							sessionId,
							agentId: latest.agentId,
							runtimeGeneration: latest.runtimeGeneration,
						}
					: undefined;
			},
			claim: claimSessionUiResponse,
			rollback: rollbackSessionUiResponse,
			send: (input) => desktopApi.sessions.sendUiResponse(input),
			// 与 SessionRuntimeInjector 同源：应答成功后捕获 DSH 时间线回显（atom 内部按 backend 门控）
			onAccepted: (request, response) => setRecordAskEcho({ sessionId, request, response }),
			onError: (error) => showNotice(error instanceof Error ? error.message : String(error), 4000),
		});
	}, [claimSessionUiResponse, rollbackSessionUiResponse, setRecordAskEcho, runtime?.agentId, runtime?.runtimeGeneration, sessionId]);

	// 会话切换（新的并行问询）时收起上次的详情浮层并回到默认位置
	useEffect(() => {
		setExpanded(false);
		setDragPos(null);
	}, [sessionId]);

	// 窗口缩放 / 展开状态变化后，把拖动定位钳回可见区域：拖动位置是绝对像素，
	// 窗口变小、或展开面板（悬于胶囊上方）时会越出视口（issue：不随窗口同步）
	useEffect(() => {
		const clampNow = () => {
			setDragPos((prev) =>
				prev
					? clampCapsulePosition(
							prev.x,
							prev.y,
							{
								width: window.innerWidth,
								height: window.innerHeight,
							},
							expanded,
						)
					: prev,
			);
		};
		clampNow();
		window.addEventListener("resize", clampNow);
		return () => window.removeEventListener("resize", clampNow);
	}, [expanded]);

	if (!panel.isOpen || !sessionId) return null;

	// 胶囊摘要：取最新一条非空 assistant 正文，去掉 markdown 后截断；问题摘要取最新一条 user 消息
	// （追问会追加新的 user 消息，取最新才能反映当前在问什么）
	const messages = cache?.messages ?? [];
	const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.text.trim().length > 0);
	const summary = lastAssistant ? removeMarkdown(lastAssistant.text).replace(/\s+/g, " ").trim().slice(0, 36) : "";
	const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.text.trim().length > 0);
	const questionSummary = lastUser ? removeMarkdown(lastUser.text).replace(/\s+/g, " ").trim().slice(0, 36) : "";
	// 完整答案文本（复制/插入主会话 composer 用）：汇聚全部 assistant 正文，保留 markdown 供插入带格式
	const fullAnswer = messages
		.filter((m) => m.role === "assistant" && m.text.trim().length > 0)
		.map((m) => m.text.trim())
		.join("\n\n");
	// 就绪态 = idle（空闲）或 running（处理中）：agent 启动完成后为 idle，发送后才变 running
	const running = runtime?.status === "running" || runtime?.status === "idle";
	// 有响应文本且 runtime 不在运行 → 视为已完成（可安全查看完整结果）
	const done = !running && summary.length > 0;

	// 复制完整答案到剪贴板（带回主线最轻量的一步）
	const copyAnswer = () => {
		if (!fullAnswer) return;
		void navigator.clipboard
			.writeText(fullAnswer)
			.then(() => showNotice(t("askPanel.copyAnswerDone"), 3000))
			.catch((error) => showNotice(error instanceof Error ? error.message : String(error), 4000, "error"));
	};

	// 把完整答案插入发起并行问询的主会话输入框：不改写主会话时间线，只填 composer draft
	//（对齐 pi-btw 的 bring-to-main：答案回到主线程 draft 供预览/继续编辑，不自动发送）
	const insertToComposer = () => {
		const origin = panel.originSessionId;
		if (!origin || !fullAnswer) return;
		setInsertComposer({
			sessionId: origin,
			value: (current) => (current ? `${current}\n\n${fullAnswer}` : fullAnswer),
		});
		showNotice(t("askPanel.insertToComposerDone"), 3000);
	};

	// 追问提交：复用同一条匿名会话（sendFollowUp 不经 ensureSession/setCreating）
	const submitFollowUp = () => {
		const text = followUpText.trim();
		if (!text) return;
		void panel.sendFollowUp(text).then((ok) => {
			if (ok) setFollowUpText("");
		});
	};

	const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
		// 只响应左键拖动
		if (event.button !== 0) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const drag = {
			startX: event.clientX,
			startY: event.clientY,
			origX: dragPos?.x ?? rect.left,
			origY: dragPos?.y ?? rect.top,
			moved: false,
		};
		dragRef.current = drag;
		lastDragMovedRef.current = false;

		// 用 window 级监听代替 setPointerCapture：capture 会把 click 事件重定向到捕获元素，
		// 导致胶囊 button 的展开/关闭点击失效（详情点击无反应）。window 监听不拦截 click 派发。
		const onMove = (moveEvent: PointerEvent) => {
			const current = dragRef.current;
			if (!current) return;
			const dx = moveEvent.clientX - current.startX;
			const dy = moveEvent.clientY - current.startY;
			// 未超过点击阈值前不移动，保证「点一下展开」不被微抖动干扰
			if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
			current.moved = true;
			// 拖动过程同步钳制：展开时面板悬于胶囊上方，坐标区间随展开状态收窄
			setDragPos(
				clampCapsulePosition(
					current.origX + dx,
					current.origY + dy,
					{
						width: window.innerWidth,
						height: window.innerHeight,
					},
					expanded,
				),
			);
		};
		const onUp = () => {
			lastDragMovedRef.current = dragRef.current?.moved ?? false;
			dragRef.current = null;
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	return (
		<div
			className="ask-panel-root fixed z-50 flex flex-col items-end"
			style={
				dragPos
					? { left: dragPos.x, top: dragPos.y }
					: expanded
						? // 展开时面板悬于胶囊上方（高 min(48vh,400px)），默认 25% 高度会让面板
							// 越出视口顶部——顶部位置改由「面板完整可见」推导（面板顶缘 ≥ 8px）
							{
								right: 16,
								top: expandedPanelSize(window.innerWidth, window.innerHeight).height + PANEL_GAP + VIEWPORT_MARGIN,
							}
						: // 默认位置：会话区域右上方（水平贴右，垂直约 1/4 高度处），拖动后可自由摆放
							{ right: 16, top: "25%" }
			}
		>
			{expanded && (
				<div className="ask-panel-detail mb-2 flex h-[min(48vh,400px)] w-[min(560px,calc(100vw-2rem))] animate-in fade-in-0 zoom-in-95 duration-base flex-col overflow-hidden rounded-xl border bg-popover shadow-lg">
					{/* 详情头部：标题 + 问题摘要 + 运行状态 + 最小化（仅收起详情，会话继续运行） */}
					<div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
						<MessageSquarePlus size={14} className="text-muted-foreground" aria-hidden="true" />
						<div className="min-w-0">
							<div className="truncate text-sm font-medium">{t("askPanel.title")}</div>
							{questionSummary || summary ? (
								<div className="truncate text-[11px] text-muted-foreground" title={questionSummary || summary}>
									{questionSummary || summary}
								</div>
							) : null}
						</div>
						{running ? (
							<span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
								<span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
								{t("askPanel.running")}
							</span>
						) : done ? (
							<Check size={13} className="shrink-0 text-emerald-500" aria-hidden="true" />
						) : null}
						<span className="flex-1" />
						<button className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40" aria-label={t("askPanel.copyAnswer")} title={t("askPanel.copyAnswer")} disabled={!fullAnswer} onClick={copyAnswer}>
							<Clipboard size={13} aria-hidden="true" />
						</button>
						<button
							className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
							aria-label={t("askPanel.insertToComposer")}
							title={panel.originSessionId ? t("askPanel.insertToComposer") : t("askPanel.insertToComposerUnavailable")}
							disabled={!fullAnswer || !panel.originSessionId}
							onClick={insertToComposer}
						>
							<CornerDownLeft size={13} aria-hidden="true" />
						</button>
						<button className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label={t("askPanel.minimize")} title={t("askPanel.minimize")} onClick={() => setExpanded(false)}>
							<X size={14} aria-hidden="true" />
						</button>
					</div>
					{/* 结果区：有消息才渲染时间线（避免 timeline 空态/新建会话提示干扰）；
              无消息时显示等待占位，消息流式到达后自动切换 */}
					<div className="min-h-0 flex-1">
						{messages.length > 0 ? (
							<OwnedSessionMessageTimeline
								sessionId={sessionId}
								hasProject={false}
								onCreateSession={() => undefined}
								showThinking={false}
								validCommandNames={new Set()}
								validFilePaths={new Set()}
								onPreviewImage={() => undefined}
								onOpenExternal={(url) => void desktopApi.app.openExternal(url)}
								onToast={showNotice}
								runtimeUi={runtimeUiResponder ? <SessionRuntimeUiOverlay sessionId={sessionId} runtime={runtime} ui={sessionRuntimeUi} responder={runtimeUiResponder} /> : undefined}
							/>
						) : (
							<div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
								<Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" />
								{t("askPanel.waiting")}
							</div>
						)}
					</div>
					{/* 追问输入：复用同一条匿名会话继续对话；禁用条件 = 无会话 / 正在创建 */}
					<form
						className="flex shrink-0 items-center gap-1.5 border-t px-3 py-2"
						onSubmit={(event) => {
							event.preventDefault();
							submitFollowUp();
						}}
					>
						<Input className="min-w-0 flex-1 h-8 rounded-md px-2.5 py-1 text-sm focus-visible:ring-0" value={followUpText} onChange={(event) => setFollowUpText(event.target.value)} placeholder={t("askPanel.followUpPlaceholder")} aria-label={t("askPanel.followUpPlaceholder")} disabled={panel.creating} />
						<button type="submit" className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40" aria-label={t("askPanel.sendFollowUp")} title={t("askPanel.sendFollowUp")} disabled={panel.creating || !followUpText.trim()}>
							<Send size={13} aria-hidden="true" />
						</button>
					</form>
				</div>
			)}
			{/* 胶囊本体：状态点 + 摘要 + 关闭 + 展开指示；整条可拖拽（touch-none 避免触屏滚动抢占指针） */}
			<button
				className="ask-panel-pill flex h-9 max-w-[min(340px,calc(100vw-2rem))] cursor-grab touch-none items-center gap-2 rounded-full border bg-popover pl-2.5 pr-1 shadow-lg hover:bg-accent-soft active:cursor-grabbing"
				aria-label={t("askPanel.title")}
				aria-expanded={expanded}
				onPointerDown={handlePointerDown}
				onClick={() => {
					// 拖动后不触发展开切换
					if (lastDragMovedRef.current) {
						lastDragMovedRef.current = false;
						return;
					}
					setExpanded((value) => !value);
				}}
			>
				{panel.creating ? (
					<Loader2 size={14} className="animate-pideck-spin text-muted-foreground" aria-hidden="true" />
				) : running ? (
					<span className="relative flex size-2" aria-hidden="true">
						<span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
						<span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
					</span>
				) : done ? (
					<Check size={14} className="text-emerald-500" aria-hidden="true" />
				) : (
					<MessageSquarePlus size={14} className="text-muted-foreground" aria-hidden="true" />
				)}
				<span className="truncate text-xs text-foreground/90">{questionSummary || summary || (panel.creating ? t("askPanel.creating") : t("askPanel.waiting"))}</span>
				{running && !panel.creating ? (
					<span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
						<span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
						{t("askPanel.running")}
					</span>
				) : null}
				<span
					className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
					aria-label={t("askPanel.close")}
					title={t("askPanel.close")}
					role="button"
					tabIndex={-1}
					onClick={(event) => {
						// 关闭按钮：阻止冒泡避免触发胶囊的展开切换
						event.stopPropagation();
						void panel.close();
					}}
				>
					<X size={12} aria-hidden="true" />
				</span>
				{expanded ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
			</button>
		</div>
	);
}
