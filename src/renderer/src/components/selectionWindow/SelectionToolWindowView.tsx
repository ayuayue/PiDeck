import { Check, ChevronDown, Copy, Globe, Loader2, Play, RefreshCw, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { AGENT_INVOKE_TEXT_MAX_CHARS, AGENT_TRANSLATE_TARGETS, type AgentInvokeAction, type AgentTranslateTarget } from "../../../../shared/types/agentProfile";
import { SELECTION_TOOL_TEXT_MAX_CHARS, SELECTION_TOOL_WINDOW_COLLAPSED_HEIGHT, SELECTION_TOOL_WINDOW_COLLAPSED_WIDTH, SELECTION_TOOL_WINDOW_EXPANDED_HEIGHT, SELECTION_TOOL_WINDOW_WIDTH, type SelectionToolShowPayload } from "../../../../shared/types/selectionTool";
import { desktopApi } from "../../desktopApi";
import { t, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { applySelectionWindowAppearance } from "../../selection-tool/appearance";
import { subscribeSelectionCapture } from "../../selection-tool/captureBridge";
import { writeClipboard } from "../../utils/clipboard";
import { showNotice } from "../../utils/notice";
import { AGENT_TRANSLATE_TARGET_LABEL_KEYS } from "../../utils/selectionToolPolicy";
import { AgentInvokeAgentPicker } from "../selectionTool/AgentInvokeAgentPicker";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { Textarea } from "../ui-shadcn/textarea";
import { useSelectionWindowAgents } from "./useSelectionWindowAgents";
import { useSelectionWindowInvoke } from "./useSelectionWindowInvoke";

/** 每次主进程推送捕获都生成递增 id：同一段文本再次触发（复制/快捷键）也要重新翻译。 */
type CaptureEntry = { id: number; payload: SelectionToolShowPayload };

const INVOKE_ACTIONS: readonly AgentInvokeAction[] = ["translate", "chat"];
const ACTION_LABEL_KEYS: Record<AgentInvokeAction, TranslationKey> = { translate: "selectionTool.translate", chat: "selectionTool.ask" };

const ICON_BUTTON = "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-soft hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/** 目标语言下拉：替代旧版一排 9 个 chip，让顶部保持 Magpie 式单行工具条。 */
function TargetLanguagePicker({ value, onChange }: { value: AgentTranslateTarget; onChange: (target: AgentTranslateTarget) => void }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button type="button" aria-label={t("selectionTool.targetLabel")} title={t("selectionTool.targetLabel")} className="inline-flex h-7 max-w-[104px] min-w-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent-soft hover:text-foreground">
					<Globe size={12} className="shrink-0" aria-hidden="true" />
					<span className="min-w-0 truncate">{t(AGENT_TRANSLATE_TARGET_LABEL_KEYS[value])}</span>
					<ChevronDown size={11} className="shrink-0" aria-hidden="true" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={6} className="max-h-[min(320px,50vh)] w-[170px] overflow-y-auto">
				<DropdownMenuLabel>{t("selectionTool.targetLabel")}</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{AGENT_TRANSLATE_TARGETS.map((target) => (
					<DropdownMenuItem key={target} onSelect={() => onChange(target)}>
						<span className="min-w-0 flex-1 truncate">{t(AGENT_TRANSLATE_TARGET_LABEL_KEYS[target])}</span>
						{target === value ? <Check size={13} className="shrink-0 text-primary" aria-hidden="true" /> : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** 捕获失败/平台不支持的提示文案（reason 来自主进程，不在这里重新判断平台）。 */
function captureHint(reason: SelectionToolShowPayload["reason"]): string {
	if (reason === "unsupported") return t("selectionTool.unsupported");
	if (reason === "capture-failed") return t("selectionTool.captureFailed");
	return "";
}

/**
 * 系统级划词浮窗（独立 BrowserWindow，无 App 装配、无 Jotai Provider）。
 *
 * 视觉对齐应用内划词/Magpie：顶部一条操作栏（智能体 / 翻译·问答 / 目标语言 / 复制·发送·关闭），
 * 正文只放「原文引用 + 结果」，不再用一排语言 chip 和嵌套表单把窗口塞满。
 *
 * 触发（Magpie 式两段式）：
 * - 外部应用复制文字 → 光标附近只出现一条紧凑操作栏，不自动调用模型、不抢焦点；
 * - 点「翻译 / 问答」才展开结果面板并调用智能体；换语言/智能体等于另一次请求；
 * - 快捷键兜底：取词失败时直接展开输入面板。
 *
 * 结果可复制或发送到 PiDeck（插入主窗口当前会话输入框，成功后收起浮窗）。
 */
export function SelectionToolWindowView() {
	const { agents, defaultAgent, refresh: refreshAgents } = useSelectionWindowAgents();
	const { state: invokeState, run: runInvoke, cancel: cancelInvoke, reset: resetInvoke } = useSelectionWindowInvoke();
	const [capture, setCapture] = useState<CaptureEntry | null>(null);
	const [agentId, setAgentId] = useState<string | null>(null);
	const [action, setAction] = useState<AgentInvokeAction>("translate");
	const [targetLanguage, setTargetLanguage] = useState<AgentTranslateTarget>("auto");
	const [draft, setDraft] = useState("");
	const [inserting, setInserting] = useState(false);
	/** false = 只有顶部操作栏（复制即触发的初始态）；true = 展开原文与结果面板。 */
	const [expanded, setExpanded] = useState(false);

	// 事件回调里不能用过期闭包：reset 放到 ref，捕获订阅整个生命周期只注册一次。
	const resetRef = useRef(resetInvoke);
	resetRef.current = resetInvoke;
	const refreshAgentsRef = useRef(refreshAgents);
	refreshAgentsRef.current = refreshAgents;
	const captureSeqRef = useRef(0);

	const selectedAgent = useMemo(() => {
		const configured = agentId ? agents.find((agent) => agent.id === agentId) : null;
		return configured ?? defaultAgent;
	}, [agentId, agents, defaultAgent]);

	const capturedText = capture?.payload.text ?? "";
	const reasonHint = captureHint(capture?.payload.reason);
	const sourceText = capturedText.trim() ? capturedText : draft;
	const running = invokeState.phase === "starting" || invokeState.phase === "streaming";
	const hasResult = invokeState.text.trim().length > 0;

	// 捕获订阅：模块级 bridge 会缓存「React 挂载前就到达」的首个载荷，挂载时立即回放。
	useEffect(() => {
		const unsubscribe = subscribeSelectionCapture((payload) => {
			captureSeqRef.current += 1;
			setCapture({ id: captureSeqRef.current, payload });
			setDraft("");
			setAction("translate");
			// 有文本 = 先只弹操作栏（Magpie 式）；没读到文本/平台不支持 = 直接展开输入面板。
			setExpanded(!payload.text.trim());
			resetRef.current();
			// 窗口常驻复用：每次弹出都重读智能体列表与主题，否则会拿着启动瞬间的旧配置。
			refreshAgentsRef.current();
			void applySelectionWindowAppearance();
		});
		return unsubscribe;
	}, []);

	// 折叠条/展开面板切换窗口尺寸（主进程 setContentSize）；首次挂载也同步一次，避免 280 残影。
	useEffect(() => {
		void desktopApi.selectionTool
			.resize({
				width: expanded ? SELECTION_TOOL_WINDOW_WIDTH : SELECTION_TOOL_WINDOW_COLLAPSED_WIDTH,
				height: expanded ? SELECTION_TOOL_WINDOW_EXPANDED_HEIGHT : SELECTION_TOOL_WINDOW_COLLAPSED_HEIGHT,
			})
			.catch(() => undefined);
		// capture.id 也参与：连续两次空捕获时 expanded 可能同为 true，主进程 show 已重置折叠尺寸，
		// 必须重新请求一次展开尺寸，否则内容会被裁在折叠栏高度里。
	}, [capture?.id, expanded]);

	const canRun = Boolean(selectedAgent) && sourceText.trim().length > 0 && !running;

	const handleHide = useCallback(() => {
		void desktopApi.selectionTool.hide().catch(() => undefined);
	}, []);

	/** 展开面板并立即发起一次请求（显式点击动作/换语言/换智能体时用）。 */
	const runRequest = useCallback(
		(nextAction: AgentInvokeAction, nextTarget: AgentTranslateTarget, agent = selectedAgent) => {
			setExpanded(true);
			if (!agent) return;
			const text = sourceText.trim();
			if (!text) return;
			// 换动作/语言/智能体时允许打断正在跑的 run：reset 清 runId 后立刻发新请求。
			resetInvoke();
			void runInvoke({ agent, text, action: nextAction, targetLanguage: nextTarget });
		},
		[resetInvoke, runInvoke, selectedAgent, sourceText],
	);

	const handleRun = useCallback(() => {
		runRequest(action, targetLanguage);
	}, [action, runRequest, targetLanguage]);

	// 键盘：Escape 收起，Ctrl/Cmd+Enter 重新执行（与调用面板同一套键位习惯）。
	const handleRunRef = useRef(handleRun);
	handleRunRef.current = handleRun;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				handleHide();
				return;
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				handleRunRef.current();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [handleHide]);

	const handleDraftChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
		setDraft(event.target.value);
	}, []);

	const handleActionChange = useCallback(
		(next: AgentInvokeAction) => {
			if (next !== action) {
				setAction(next);
				resetInvoke();
			}
			// 点当前动作 = 重跑；点另一个动作 = 展开并跑新动作。
			runRequest(next, targetLanguage);
		},
		[action, resetInvoke, runRequest, targetLanguage],
	);

	const handleTargetChange = useCallback(
		(next: AgentTranslateTarget) => {
			if (next === targetLanguage) return;
			setTargetLanguage(next);
			resetInvoke();
			runRequest(action, next);
		},
		[action, resetInvoke, runRequest, targetLanguage],
	);

	const handleAgentSelect = useCallback(
		(nextAgentId: string) => {
			setAgentId(nextAgentId);
			resetInvoke();
			const nextAgent = agents.find((agent) => agent.id === nextAgentId) ?? defaultAgent;
			runRequest(action, targetLanguage, nextAgent);
		},
		[action, agents, defaultAgent, resetInvoke, runRequest, targetLanguage],
	);

	const handleCopy = useCallback(() => {
		if (!hasResult) return;
		void writeClipboard(invokeState.text).then((ok) => {
			showNotice(ok ? t("common.copied") : t("copy.failed"), 2400, ok ? undefined : "error");
		});
	}, [hasResult, invokeState.text]);

	const insertableText = (hasResult ? invokeState.text : sourceText).trim();
	const handleInsert = useCallback(() => {
		// 主进程按 SELECTION_TOOL_TEXT_MAX_CHARS 拒绝超长入参（不截断）：译文可能比原文长，
		// 这里先按同一上限截断，避免「模型给了结果却发不出去」。
		const text = insertableText.slice(0, SELECTION_TOOL_TEXT_MAX_CHARS);
		if (!text || inserting) return;
		setInserting(true);
		void desktopApi.selectionTool
			.insertToMain({ text })
			.then((ok) => {
				if (ok) {
					// 文本已进入主窗口输入框：浮窗继续挡着没有意义，直接收起。
					handleHide();
					return;
				}
				showNotice(t("selectionTool.insertEmpty"), 3000, "warning");
			})
			.catch(() => {
				showNotice(t("enhance.error.unavailable"), 4000, "error");
			})
			.finally(() => setInserting(false));
	}, [handleHide, insertableText, inserting]);

	return (
		<div role="dialog" aria-label={t("selectionTool.windowTitle")} className="flex h-full w-full flex-col overflow-hidden rounded-[12px] border border-border/80 bg-popover text-popover-foreground shadow-[0_16px_40px_-16px_rgba(0,0,0,0.55)]">
			{/* 折叠条只留智能体 / 翻译·问答 / 关闭；目标语言与复制·发送在展开面板里。 */}
			<header className={expanded ? "flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle/70 px-2 [-webkit-app-region:drag]" : "flex h-full shrink-0 items-center gap-2 px-2.5 [-webkit-app-region:drag]"}>
				<div className="min-w-0 shrink-0 [-webkit-app-region:no-drag]">
					<AgentInvokeAgentPicker agents={agents} selected={selectedAgent} onSelect={handleAgentSelect} compact={!expanded} />
				</div>
				<span className="h-3.5 w-px shrink-0 bg-border/70" aria-hidden="true" />
				<div className="flex min-w-0 shrink-0 items-center gap-1 [-webkit-app-region:no-drag]" role="group" aria-label={t("agentInvoke.title")}>
					{INVOKE_ACTIONS.map((candidate) => (
						<button
							key={candidate}
							type="button"
							aria-pressed={action === candidate}
							onClick={() => handleActionChange(candidate)}
							className={cn("rounded-md px-2 py-1 text-xs font-medium transition-colors", action === candidate ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent-soft hover:text-foreground")}
						>
							{t(ACTION_LABEL_KEYS[candidate])}
						</button>
					))}
				</div>
				{expanded && action === "translate" ? (
					<div className="[-webkit-app-region:no-drag]">
						<TargetLanguagePicker value={targetLanguage} onChange={handleTargetChange} />
					</div>
				) : null}
				<span className="min-w-0 flex-1" />
				{expanded ? (
					<div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
						<button type="button" className={ICON_BUTTON} aria-label={t("selectionTool.copy")} title={t("selectionTool.copy")} disabled={!hasResult} onClick={handleCopy}>
							<Copy size={13} aria-hidden="true" />
						</button>
						<button type="button" className={ICON_BUTTON} aria-label={t("selectionTool.insertToMain")} title={t("selectionTool.insertToMain")} disabled={!insertableText || inserting} onClick={handleInsert}>
							{inserting ? <Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
						</button>
					</div>
				) : null}
				<button type="button" className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-soft hover:text-foreground [-webkit-app-region:no-drag]" aria-label={t("selectionTool.hide")} title={t("selectionTool.hide")} onClick={handleHide}>
					<X size={13} aria-hidden="true" />
				</button>
			</header>

			{expanded ? (
				<div className="flex min-h-0 flex-1 flex-col gap-2 px-2.5 pt-2">
					{reasonHint ? <div className="shrink-0 rounded-md bg-warning/10 px-2 py-1 text-micro leading-relaxed text-warning">{reasonHint}</div> : null}

					{capturedText.trim() ? (
						<div className="shrink-0 border-l-2 border-primary/25 pl-2 text-micro leading-relaxed text-muted-foreground">
							<div className="max-h-12 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{capturedText}</div>
						</div>
					) : (
						<div className="flex shrink-0 flex-col gap-1.5">
							<Textarea value={draft} onChange={handleDraftChange} maxLength={AGENT_INVOKE_TEXT_MAX_CHARS} rows={2} placeholder={t("selectionTool.windowEmpty")} aria-label={t("agentInvoke.sourceTitle")} className="max-h-16 min-h-10 resize-none border-border-subtle bg-muted/15 text-xs" />
							<div className="flex justify-end">
								<Button size="sm" variant="outline" disabled={!canRun} onClick={handleRun}>
									<Play size={12} aria-hidden="true" />
									{t(ACTION_LABEL_KEYS[action])}
								</Button>
							</div>
						</div>
					)}

					<section className="flex min-h-0 flex-1 flex-col">
						<div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap pb-1 text-control leading-relaxed [overflow-wrap:anywhere]">
							{invokeState.phase === "starting" ? (
								<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
									<Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" />
									{t("agentInvoke.starting")}
								</span>
							) : invokeState.phase === "error" ? (
								<div className="flex flex-col gap-1">
									<span className="text-xs font-medium text-destructive">{t("agentInvoke.errorTitle")}</span>
									<span className="whitespace-pre-wrap text-xs text-muted-foreground">{invokeState.errorText}</span>
								</div>
							) : invokeState.text ? (
								<span>{invokeState.text}</span>
							) : running ? (
								<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
									<Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" />
									{action === "translate" ? t("selectionTool.translating") : t("agentInvoke.running")}
								</span>
							) : (
								<span className="text-xs text-muted-foreground">{t("agentInvoke.emptyResult")}</span>
							)}
						</div>

						{running || invokeState.phase === "error" || hasResult ? (
							<div className="flex shrink-0 items-center gap-1 border-t border-border-subtle/60 pt-1.5">
								{running ? (
									<>
										<Loader2 size={11} className="shrink-0 animate-pideck-spin text-muted-foreground" aria-hidden="true" />
										<span className="min-w-0 truncate text-micro text-muted-foreground">{action === "translate" ? t("selectionTool.translating") : t("agentInvoke.running")}</span>
										<span className="min-w-0 flex-1" />
										<button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-muted-foreground transition-colors hover:bg-accent-soft hover:text-foreground" onClick={cancelInvoke}>
											<Square size={10} aria-hidden="true" />
											{t("agentInvoke.stop")}
										</button>
									</>
								) : (
									<>
										<span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">{invokeState.phase === "error" ? t("agentInvoke.errorTitle") : ""}</span>
										<button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-muted-foreground transition-colors hover:bg-accent-soft hover:text-foreground" onClick={handleRun}>
											<RefreshCw size={10} aria-hidden="true" />
											{t("agentInvoke.retry")}
										</button>
									</>
								)}
							</div>
						) : null}
					</section>
				</div>
			) : null}
		</div>
	);
}
