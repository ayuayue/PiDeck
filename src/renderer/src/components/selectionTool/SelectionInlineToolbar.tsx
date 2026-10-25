import { useAtomValue } from "jotai";
import { Check, ChevronDown, Copy, Globe, Loader2, RefreshCw, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AGENT_TRANSLATE_TARGETS, type AgentInvokeAction, type AgentTranslateTarget } from "../../../../shared/types/agentProfile";
import { agentMarketSettingsAtom, agentProfilesAtom } from "../../atoms/agent-atoms";
import { useAgentInvoke } from "../../hooks/useAgentInvoke";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { writeClipboard } from "../../utils/clipboard";
import { showNotice } from "../../utils/notice";
import { AGENT_TRANSLATE_TARGET_LABEL_KEYS, clampFloatingPosition, resolveSelectionInlineWidth, SELECTION_INLINE_ACTION_LABEL_KEYS, SELECTION_TOOL_UI_SELECTOR, type SelectionAnchorRect } from "../../utils/selectionToolPolicy";
import { resolveDefaultSelectionAgent } from "../agents/agentMarketFilters";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { Input } from "../ui-shadcn/input";
import { AgentInvokeAgentPicker } from "./AgentInvokeAgentPicker";

/** 动作顺序：翻译是默认动作（划词的主用途），问答紧随其后。 */
const INVOKE_ACTIONS: readonly AgentInvokeAction[] = ["translate", "chat"];
/** 工具栏与选区的间距 / 视口留白：与浮出按钮同一档，翻转到上方时视觉位置一致。 */
const TOOLBAR_GAP = 6;
const TOOLBAR_MARGIN = 8;
/** 无选区锚点（浮窗复用兜底）：居中偏上，避开窗口拖拽条与通知区。 */
const TOOLBAR_TOP_RATIO = 0.12;
/** 测量前的估算高度：只影响首帧定位，useLayoutEffect 在绘制前换成真实高度。 */
const TOOLBAR_FALLBACK_HEIGHT = 120;

export type SelectionInlineToolbarProps = {
	/** 选区锚点（fixed 视口坐标）；null = 居中偏上（独立浮窗复用时的兜底定位）。 */
	anchorRect: SelectionAnchorRect | null;
	/** 打开时带入的原文；空串 = 空状态（提示 + 内联输入框，供系统浮窗没捕获到文本时手动输入）。 */
	sourceText: string;
	/** 打开时预选的智能体 id；缺省或指向已删除的智能体时回退市场默认智能体。 */
	initialAgentId?: string | null;
	/** 关闭：宿主收起选区快照并还原焦点。 */
	onClose: () => void;
	/** 「发送到会话」：新建草稿会话，把原文（+ 已有结果）交给智能体继续处理。 */
	onSendToSession: (input: { agentId: string; text: string }) => Promise<boolean>;
};

/** 目标语言下拉：紧凑头部放不下 9 个 chips，改成带当前值的小下拉。 */
function TargetLanguagePicker({ value, onChange }: { value: AgentTranslateTarget; onChange: (target: AgentTranslateTarget) => void }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={t("agentInvoke.targetLabel")}
					title={t("agentInvoke.targetLabel")}
					className="inline-flex h-6 max-w-[110px] min-w-0 items-center gap-1 rounded-md border border-border-subtle bg-transparent px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent-soft hover:text-foreground"
				>
					<Globe size={12} className="shrink-0" aria-hidden="true" />
					<span className="min-w-0 truncate">{t(AGENT_TRANSLATE_TARGET_LABEL_KEYS[value])}</span>
					<ChevronDown size={11} className="shrink-0" aria-hidden="true" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={6} data-selection-tool-ui className="max-h-[min(320px,50vh)] w-[170px] overflow-y-auto">
				<DropdownMenuLabel>{t("agentInvoke.targetLabel")}</DropdownMenuLabel>
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

/**
 * 应用内划词的「原地工具栏」（phase-2，用户反馈：不要弹窗，结果直接出现在划词工具栏上）。
 *
 * 形态参考浏览器划词扩展：单卡片贴在选区下方（放不下翻到上方），头部一行 = 智能体下拉 +
 * 翻译/问答切换 + 目标语言 + 复制 + 发送到会话 + 关闭；结果区紧接其下流式输出（max 40vh 滚动）。
 * 刻意没有大 textarea 面板，也没有「开始」按钮：有原文就自动跑翻译，换动作/语言/智能体会自动重跑。
 *
 * 边界：
 * - 自身带 [data-selection-tool-ui]：全局划选监听不会把工具栏内的选区当成正文；
 * - 点击工具栏外 / Escape 关闭（Radix 下拉 portal 层放行，否则选语言时工具栏先关）；
 * - 结果区只读展示；停止保留已有部分结果，retry 重新生成上一次请求；
 * - 「发送到会话」文案拼装与 phase-1 一致（原文 + 结果），发送成功/失败由宿主与自身 toast。
 */
export function SelectionInlineToolbar({ anchorRect, sourceText, initialAgentId, onClose, onSendToSession }: SelectionInlineToolbarProps) {
	const agents = useAtomValue(agentProfilesAtom);
	const settings = useAtomValue(agentMarketSettingsAtom);
	const defaultAgent = useMemo(() => resolveDefaultSelectionAgent(agents, settings), [agents, settings]);
	const [agentId, setAgentId] = useState<string | null>(initialAgentId ?? null);
	const selectedAgent = useMemo(() => agents.find((agent) => agent.id === agentId) ?? defaultAgent, [agentId, agents, defaultAgent]);
	const [action, setAction] = useState<AgentInvokeAction>("translate");
	const [targetLanguage, setTargetLanguage] = useState<AgentTranslateTarget>("auto");
	const [source, setSource] = useState(sourceText);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
	const [measuredHeight, setMeasuredHeight] = useState(0);
	const toolbarRef = useRef<HTMLDivElement | null>(null);
	const draftInputRef = useRef<HTMLInputElement | null>(null);
	/** 关闭入口经 ref 转发：全局 listener 只注册一次，避免依赖变化反复重挂。 */
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const { state, run, cancel, restart } = useAgentInvoke({ agent: selectedAgent, scopeKey: selectedAgent?.id ?? "" });

	const trimmedSource = source.trim();
	const trimmedResult = state.text.trim();
	const hasResult = trimmedResult.length > 0;
	const running = state.phase === "starting" || state.phase === "streaming";
	const canSend = Boolean(selectedAgent) && trimmedSource.length > 0 && !sending;

	/** 打开后由宿主换入新原文（同一实例复用时的兜底；正常情况下宿主按请求 key 重挂载）。 */
	useEffect(() => {
		setSource(sourceText);
	}, [sourceText]);

	/** 发起一次调用：先取消可能在跑的旧 run（换动作/语言/智能体 = 另一次请求）。 */
	const start = useCallback(
		(request: { text: string; action: AgentInvokeAction; targetLanguage: AgentTranslateTarget }) => {
			// cancel 同步清空本地 runId，随后 run 才不会被「运行中不重入」的守卫挡掉；
			// 主进程按 IPC 到达顺序先收到 cancelInvoke 再收到 invoke，不会误杀新 run。
			cancel();
			run(request);
		},
		[cancel, run],
	);
	// 自动运行只认「字符串依赖」：agents 快照刷新会换掉 selectedAgent 的对象身份（用量计数更新），
	// 若把 agent 对象放进 effect 依赖，每次成功调用都会触发新一轮自动重跑，形成无限循环。
	const startRef = useRef(start);
	startRef.current = start;
	const runAgentId = selectedAgent?.id ?? "";

	// 自动运行（浏览器划词扩展形态）：打开即有原文就跑，不等用户点按钮；
	// 换动作/目标语言/智能体同样视为新请求自动重跑（同一时间只有一个 run）。
	// 经 0ms 定时器而不是 effect 内直接调用：StrictMode 开发态 setup→cleanup→setup 会双跑 effect，
	// 直接调用会连发两个 run（后一个打断前一个，前一个的迟到受理回调还会误取消新 run）；
	// cleanup 清掉未触发的定时器，天然去重且生命周期配对。
	useEffect(() => {
		if (!trimmedSource || !runAgentId) return;
		const timer = window.setTimeout(() => {
			startRef.current({ text: trimmedSource, action, targetLanguage });
		}, 0);
		return () => window.clearTimeout(timer);
	}, [action, runAgentId, targetLanguage, trimmedSource]);

	// 空状态才聚焦内联输入框；有原文时工具栏不抢页面焦点。
	useEffect(() => {
		if (trimmedSource) return;
		draftInputRef.current?.focus({ preventScroll: true });
	}, [trimmedSource]);

	// 视口变化让宽度夹紧与定位重新计算（工具栏在打开期间不随页面滚动收起）。
	useEffect(() => {
		const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	// 点击工具栏外 / Escape 关闭。捕获阶段注册：先于页面其它键盘快捷键收口。
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest(SELECTION_TOOL_UI_SELECTOR)) return;
			// Radix 下拉内容 portal 到 body、不在工具栏子树内：放行，否则选目标语言时工具栏先关。
			if (target.closest("[data-radix-popper-content-wrapper]")) return;
			onCloseRef.current();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onCloseRef.current();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, []);

	// 流式增长/换动作后重测高度：定位依赖真实高度，工具栏不能越出视口下沿。
	useLayoutEffect(() => {
		const element = toolbarRef.current;
		if (!element) return;
		const next = element.offsetHeight;
		if (next > 0 && next !== measuredHeight) setMeasuredHeight(next);
	});

	const position = useMemo(() => {
		const width = resolveSelectionInlineWidth(viewport.width);
		const height = measuredHeight > 0 ? measuredHeight : TOOLBAR_FALLBACK_HEIGHT;
		if (anchorRect) {
			const placed = clampFloatingPosition({ anchor: anchorRect, viewport, size: { width, height }, gap: TOOLBAR_GAP, margin: TOOLBAR_MARGIN, prefer: "below" });
			return { left: placed.left, top: placed.top, width };
		}
		return { left: Math.max(TOOLBAR_MARGIN, Math.round((viewport.width - width) / 2)), top: Math.max(TOOLBAR_MARGIN, Math.round(viewport.height * TOOLBAR_TOP_RATIO)), width };
	}, [anchorRect, measuredHeight, viewport]);

	const handleCopy = useCallback(() => {
		if (!hasResult) return;
		void writeClipboard(state.text).then((ok) => {
			if (ok) showNotice(t("common.copied"), 2400);
			else showNotice(t("copy.failed"), 3000, "error");
		});
	}, [hasResult, state.text]);

	const handleSend = useCallback(() => {
		if (!canSend || !selectedAgent) return;
		// 有结果时把「原文 + 结果」一起交给会话：只发结果会让接入的智能体看不到源文，无法对照润色。
		const payload = hasResult ? t("agentInvoke.sessionPayload", { source: trimmedSource, result: trimmedResult }) : trimmedSource;
		if (!payload) return;
		setSending(true);
		void onSendToSession({ agentId: selectedAgent.id, text: payload })
			.then((ok) => {
				// false 表示宿主回调已经 toast 过具体失败原因，这里不重复弹通用错误。
				if (ok) showNotice(t("agentInvoke.sentToSession"), 3000);
			})
			.catch((error: unknown) => {
				showNotice(t("agentInvoke.sessionFailed", { error: error instanceof Error ? error.message : String(error) }), 5000, "error");
			})
			.finally(() => setSending(false));
	}, [canSend, hasResult, onSendToSession, selectedAgent, trimmedResult, trimmedSource]);

	const handleDraftChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value), []);
	const handleDraftSubmit = useCallback(() => {
		const text = draft.trim();
		if (!text) return;
		setSource(text);
		setDraft("");
	}, [draft]);
	const handleDraftKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLInputElement>) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			handleDraftSubmit();
		},
		[handleDraftSubmit],
	);

	const statusText = action === "translate" ? t("selectionTool.translating") : t("agentInvoke.running");

	return (
		<div
			ref={toolbarRef}
			data-selection-tool-ui=""
			role="dialog"
			aria-label={t("selectionTool.windowTitle")}
			className="fixed z-(--z-popover) flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md"
			style={{ left: position.left, top: position.top, width: position.width }}
		>
			<div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-1.5 py-1">
				<AgentInvokeAgentPicker agents={agents} selected={selectedAgent} onSelect={setAgentId} />
				<div className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border-subtle p-0.5" role="group" aria-label={t("agentInvoke.title")}>
					{INVOKE_ACTIONS.map((candidate) => (
						<button
							key={candidate}
							type="button"
							aria-pressed={action === candidate}
							onClick={() => setAction(candidate)}
							className={cn("rounded px-1.5 py-0.5 text-xs font-medium transition-colors", action === candidate ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent-soft hover:text-foreground")}
						>
							{t(SELECTION_INLINE_ACTION_LABEL_KEYS[candidate])}
						</button>
					))}
				</div>
				{action === "translate" ? <TargetLanguagePicker value={targetLanguage} onChange={setTargetLanguage} /> : null}
				<span className="min-w-0 flex-1" />
				<Button size="icon-xs" variant="ghost" aria-label={t("common.copy")} title={t("common.copy")} disabled={!hasResult} onClick={handleCopy}>
					<Copy size={13} aria-hidden="true" />
				</Button>
				<Button size="icon-xs" variant="ghost" aria-label={t("agentInvoke.sendToSession")} title={t("agentInvoke.sendToSessionHint")} disabled={!canSend} onClick={handleSend}>
					{sending ? <Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
				</Button>
				<Button size="icon-xs" variant="ghost" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>
					<X size={14} aria-hidden="true" />
				</Button>
			</div>

			{trimmedSource ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="max-h-[40vh] min-h-[52px] overflow-y-auto whitespace-pre-wrap px-2.5 py-2 text-control leading-relaxed font-mono [overflow-wrap:anywhere]">
						{state.phase === "starting" ? (
							<span className="inline-flex items-center gap-1.5 font-sans text-muted-foreground">
								<Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" />
								{t("agentInvoke.starting")}
							</span>
						) : state.phase === "error" ? (
							<span className="font-sans text-destructive">{state.errorText}</span>
						) : hasResult ? (
							<span className="font-sans">{state.text}</span>
						) : (
							<span className="font-sans text-muted-foreground">{selectedAgent ? t("agentInvoke.emptyResult") : t("agentInvoke.selectAgent")}</span>
						)}
					</div>
					{running || state.phase === "error" || hasResult ? (
						<div className="flex shrink-0 items-center gap-1 border-t border-border-subtle px-2 py-1">
							{running ? (
								<>
									<Loader2 size={11} className="shrink-0 animate-pideck-spin text-muted-foreground" aria-hidden="true" />
									<span className="min-w-0 truncate text-micro text-muted-foreground">{statusText}</span>
									<span className="min-w-0 flex-1" />
									<Button size="xs" variant="ghost" onClick={cancel}>
										<Square size={11} aria-hidden="true" />
										{t("agentInvoke.stop")}
									</Button>
								</>
							) : (
								<>
									<span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">{state.phase === "error" ? t("agentInvoke.errorTitle") : ""}</span>
									<Button size="xs" variant="ghost" onClick={restart}>
										<RefreshCw size={11} aria-hidden="true" />
										{t("agentInvoke.retry")}
									</Button>
								</>
							)}
						</div>
					) : null}
				</div>
			) : (
				<div className="flex shrink-0 flex-col gap-1.5 px-2.5 pb-2">
					<span className="text-micro text-muted-foreground">{t("selectionTool.windowEmpty")}</span>
					<Input ref={draftInputRef} size="sm" value={draft} onChange={handleDraftChange} onKeyDown={handleDraftKeyDown} placeholder={t("agentInvoke.placeholder")} aria-label={t("agentInvoke.sourceTitle")} className="text-xs" />
				</div>
			)}
		</div>
	);
}
