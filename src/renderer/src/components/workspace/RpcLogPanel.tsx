import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, ChevronDown, ClipboardList, Copy, Radio, Save, X } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { cn } from "../../lib/utils";
import { showNotice } from "../../utils/notice";
import { MessageScroller, type MessageScrollerScrollApi } from "../agents/message-scroller";
import { isModelTraceLogData, type RpcLogBatch, type RpcLogEntry } from "../../../../shared/types/rpcLog";
import { ModelTraceDetail } from "./ModelTraceDetail";

/**
 * 实时 RPC 日志面板（右侧工作区抽屉的 rpcLog 面板，替代旧的模态弹窗）。
 *
 * 为什么不是弹窗：模态弹窗（Dialog/Sheet/beui drawer 都自带遮罩与焦点陷阱）打开期间
 * 无法给会话发消息，用户要边看日志边操作必须关窗。抽屉面板是并排的非模态视图，
 * 可与消息区同时使用；面板本身不持有开关语义，关闭/恢复由 useWorkspacePanels 负责。
 *
 * 数据链路：主进程 RpcLogger 环形缓冲（初始历史）→ 订阅 agentsRpcLog 批量推送（~80ms 一批）→ 本组件追加渲染。
 * 挂载时向主进程登记「正在看该 agent」（rpcLogsSetWatching），卸载时取消：没有观看者就不广播。
 * 性能设计（日志高频时不能拖垮会话流式）：
 * - 内存：条目总量封顶 MAX_ENTRIES，超限丢最旧；主进程只广播环形缓冲里 data 已截断的副本；
 * - 渲染：无筛选时只渲染最近 WINDOW_UNFILTERED 条（窗口化）；行组件 React.memo 且回调引用稳定
 *   （行内自己绑定 log），追加重渲染只落在新增行；追底用 instant 而非弹簧，避免逐帧强制重排；
 * - 搜索：命中判定用按条目缓存的全文（WeakMap），不每批重新 stringify；
 * - 自动滚动：复用 MessageScroller 的 stick-to-bottom 引擎（用户上翻即脱离，回底按钮归位）。
 */
const MAX_ENTRIES = 3000;
/** 无筛选时最多渲染的条数：日常查看只看最近一段，超出部分靠搜索/筛选/保存到文件取回 */
const WINDOW_UNFILTERED = 800;
/** 一次保存的最大条目数（主进程侧同样有 10000 上限兜底） */
const SAVE_ENTRY_CAP = 10000;

/**
 * 模型请求行的展开状态：完整请求体不在条目里（上百 KB），展开时才按 traceId 回读。
 * loaded 的 payload 在面板生命周期内缓存，折叠再展开不重复 IPC。
 */
type ModelTraceView = { status: "loading" | "loaded" | "missing"; payload?: string };

export interface RpcLogPanelProps {
	/** 日志所属 agent（由打开入口给出；抽屉面板不可见时无副作用） */
	agentId: string;
	/** 可选的磁盘历史加载器（从文件补回缓冲之外的旧日志，如会话右键入口） */
	loadHistory?: (agentId: string) => Promise<RpcLogEntry[]>;
	/** 查询日志记录开关；不传则视为已开启 */
	getLogging?: (agentId: string) => Promise<boolean>;
	/** 开启日志记录；不传则隐藏“未开启”提示条 */
	setLogging?: (agentId: string, enabled: boolean) => Promise<boolean>;
	/** 关闭面板（由 App 还原打开前的抽屉面板，面板自身不感知还原目标） */
	onClose: () => void;
}

/**
 * 合并初始历史与实时追加：按 id 去重、按时间升序、封顶 MAX_ENTRIES。
 *
 * 每批新日志都会跑这里（~80ms 一次），所以避免无条件全量 sort：实时追加天然升序，
 * 先做一次线性扫描确认有序，只有乱序（初始历史 + 环形缓冲拼接）才排序。
 */
export function mergeLogEntries(existing: RpcLogEntry[], incoming: RpcLogEntry[]): RpcLogEntry[] {
	if (incoming.length === 0) return existing;
	const seen = new Set<string>();
	// 不用 existing.map() 先复制一份 id 数组：这是每批都要做的额外分配
	for (const entry of existing) seen.add(entry.id);
	const merged = existing.slice();
	for (const entry of incoming) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		merged.push(entry);
	}
	let ordered = true;
	for (let i = 1; i < merged.length; i++) {
		if (merged[i].time < merged[i - 1].time) {
			ordered = false;
			break;
		}
	}
	if (!ordered) merged.sort((a, b) => a.time - b.time);
	return merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged;
}

/** 单条日志的复制文本：summary + 完整 data 的 JSON（搜索也基于它，便于查 502/terminated 等关键词） */
export function formatRpcLogForCopy(log: RpcLogEntry): string {
	return JSON.stringify({
		time: new Date(log.time).toISOString(),
		agentId: log.agentId,
		direction: log.direction,
		summary: log.summary,
		data: log.data,
	});
}

/**
 * 搜索用的全文（小写）。缓存按条目对象走 WeakMap：同一批历史在后续每批合并里都是
 * 同一对象引用，所以每条日志最多 JSON.stringify 一次，条目被淘汰后随 GC 释放。
 * 没有缓存时，每个 ~80ms 批次都会对最多 MAX_ENTRIES 条重新 stringify 整个 data，
 * 这是日志量大时流式卡顿的主要 CPU 开销之一。
 */
const searchHaystackCache = new WeakMap<RpcLogEntry, string>();
function searchHaystack(log: RpcLogEntry): string {
	const cached = searchHaystackCache.get(log);
	if (cached !== undefined) return cached;
	const built = formatRpcLogForCopy(log).toLowerCase();
	searchHaystackCache.set(log, built);
	return built;
}

/** 行组件：memo 后追加重渲染只更新新增行，历史行直接跳过 */
const RpcLogRow = memo(function RpcLogRow(props: { log: RpcLogEntry; expanded: boolean; onToggle: (log: RpcLogEntry) => void; traceView?: ModelTraceView }) {
	const { log, expanded, onToggle, traceView } = props;
	const trace = isModelTraceLogData(log.data) ? log.data : undefined;
	/** 模型请求行：展开时展示完整请求体（已回读到才可显示），否则退回条目 data */
	const tracePayload = trace?.kind === "request" && traceView?.status === "loaded" ? traceView.payload : undefined;
	const jsonText = tracePayload ?? (log.data !== undefined ? JSON.stringify(log.data, null, 2) : "");
	// 行配色/箭头按方向区分：模型行用独立颜色，箭头按请求(↑)/响应(↓)语义，不与 stdio 的 →/← 混淆
	const directionClass = log.direction === "send" ? "log-send" : log.direction === "recv" ? "log-recv" : "log-model";
	const directionGlyph = log.direction === "send" ? "→" : log.direction === "recv" ? "←" : trace?.kind === "response" ? "↓" : "↑";
	let detail: ReactNode = null;
	if (expanded) {
		if (trace?.kind === "request") {
			// 结构化轨迹视图（dsh-web Trajectory 式：指标行 + 系统提示词 + 完整消息流 + 工具定义）；
			// 解析失败（截断/畸形）时组件内部自动退回原始 JSON 兑底。
			if (tracePayload !== undefined) detail = <ModelTraceDetail payloadJson={tracePayload} summary={trace} />;
			else if (traceView?.status === "missing") detail = <div className="rpc-log-detail-note">{t("rpc.modelTraceMissing")}</div>;
			else
				detail = (
					<div className="rpc-log-detail-note flex items-center gap-1.5">
						<Loader2 size={12} className="animate-pideck-spin" aria-hidden="true" />
						{t("rpc.modelLoading")}
					</div>
				);
		} else if (log.data !== undefined) {
			detail = <pre className="rpc-log-detail">{jsonText}</pre>;
		}
	}
	return (
		<div className="rpc-log-entry-wrap">
			<div
				className={`rpc-log-entry ${directionClass}`}
				/* 展开查看完整 payload 的唯一入口，键盘必须可达；开发者面板同样遵守模态/行交互惯例 */
				role="button"
				tabIndex={0}
				aria-expanded={expanded}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onToggle(log);
					}
				}}
				onClick={() => onToggle(log)}
				title={log.summary}
			>
				<time>
					{new Date(log.time).toLocaleTimeString(undefined, {
						hour: "2-digit",
						minute: "2-digit",
						second: "2-digit",
					})}
				</time>
				<span className="log-direction">{directionGlyph}</span>
				<span className="log-summary">{log.summary}</span>
				<div className="rpc-log-entry-actions" onClick={(event) => event.stopPropagation()}>
					<Button
						variant="outline"
						size="sm"
						className="h-auto px-2 py-1 text-caption shadow-none"
						onClick={() => {
							void navigator.clipboard.writeText(formatRpcLogForCopy(log));
							showNotice(t("common.copied"), 2000);
						}}
					>
						{t("common.copy")}
					</Button>
					{jsonText !== "" && (
						<Button
							variant="outline"
							size="sm"
							className="h-auto px-2 py-1 text-caption shadow-none"
							onClick={() => {
								void navigator.clipboard.writeText(jsonText);
								showNotice(t("common.copied"), 2000);
							}}
						>
							{t("rpc.copyJson")}
						</Button>
					)}
				</div>
			</div>
			{detail}
		</div>
	);
});

export function RpcLogPanel(props: RpcLogPanelProps) {
	const { agentId, onClose } = props;
	const [entries, setEntries] = useState<RpcLogEntry[]>([]);
	const [keyword, setKeyword] = useState("");
	const [directionFilter, setDirectionFilter] = useState<"all" | "send" | "recv" | "model">("all");
	const [expandedId, setExpandedId] = useState<string | null>(null);
	/** 模型请求行的完整请求体（按条目 id 缓存；折叠再展开不重复回读） */
	const [traceViews, setTraceViews] = useState<Record<string, ModelTraceView>>({});
	/** 已发起回读的条目 id：同一行反复展开只拉一次（失败/未落盘时放开重试） */
	const traceRequestedRef = useRef(new Set<string>());
	/** 自动滚动开关：关掉后新日志不再追底，方便上翻排查 */
	const [autoScroll, setAutoScroll] = useState(true);
	/** 用户是否仍在实时尾部（MessageScroller 引擎上报） */
	const [following, setFollowing] = useState(true);
	const [loggingOn, setLoggingOn] = useState<boolean | null>(null);
	const [saving, setSaving] = useState(false);
	const scrollApiRef = useRef<MessageScrollerScrollApi | null>(null);

	// ── 数据流：初始历史 + 实时订阅 ──
	// 载入器 props 每次 App 渲染都会换新引用（sidebarActions 未 memo）：若进 effect 依赖，
	// 流式期间每个渲染都会退订重订 + 重发 getLive/getLogging IPC。用 ref 取最新一份，
	// effect 只随 agentId 变化运行（与 QuickMessagesDialog 的 latestRef 同款写法）。
	const loadersRef = useRef({ loadHistory: props.loadHistory, getLogging: props.getLogging });
	loadersRef.current = { loadHistory: props.loadHistory, getLogging: props.getLogging };
	useEffect(() => {
		let disposed = false;
		const { loadHistory, getLogging } = loadersRef.current;
		// 初始历史 = 主进程环形缓冲（最近 MAX_LIVE 条）+ 可选的磁盘历史（文件里更早的日志）
		void Promise.all([window.piDesktop.rpcLogs.getLive(agentId), loadHistory ? loadHistory(agentId) : Promise.resolve([])])
			.then(([live, history]) => {
				if (disposed) return;
				setEntries((current) => mergeLogEntries(current, [...history, ...live]));
			})
			// agent 已退出时主进程会拒绝（会话没有可用运行实例）：面板是快照视图，
			// 按“暂无历史”处理，不弹未处理异常（关闭 Agent 后面板仍留在抽屉里的正常路径）。
			.catch(() => undefined);
		// 实时追加：主进程 ~80ms 聚合一批推送，直接追加（行组件 memo，成本只在新增行）
		const unsubscribe = window.piDesktop.rpcLogs.onLog((batch: RpcLogBatch) => {
			if (disposed || batch.agentId !== agentId) return;
			setEntries((current) => mergeLogEntries(current, batch.entries));
		});
		// 观看登记：主进程只向「有面板在看」的 agent 广播实时批次（见 AgentManager.enqueueLiveRpcLog）。
		// 登记失败（agent 已退出等）不影响面板展示已有历史；卸载必须成对取消，否则广播闸门会一直开着。
		void window.piDesktop.rpcLogs.setWatching(agentId, true).catch(() => undefined);
		// 开关状态：未开启时提示用户先开启记录
		if (getLogging) {
			void getLogging(agentId)
				.then((enabled) => {
					if (!disposed) setLoggingOn(enabled);
				})
				// 同上：agent 已退出时不把“未知”当成“未开启”，避免出现无法点击的“开启记录”条
				.catch(() => undefined);
		} else {
			setLoggingOn(true);
		}
		return () => {
			disposed = true;
			unsubscribe();
			void window.piDesktop.rpcLogs.setWatching(agentId, false).catch(() => undefined);
		};
	}, [agentId]);

	// ── 筛选与窗口化 ──
	const hasActiveFilter = keyword.trim() !== "" || directionFilter !== "all";
	const visibleEntries = useMemo(() => {
		const normalizedKeyword = keyword.trim().toLowerCase();
		return entries.filter((log) => {
			if (directionFilter !== "all" && log.direction !== directionFilter) return false;
			if (!normalizedKeyword) return true;
			// 缓存过的全文（小写）做子串匹配；每条最多 stringify 一次，见 searchHaystack
			return searchHaystack(log).includes(normalizedKeyword);
		});
	}, [entries, keyword, directionFilter]);
	// 无筛选时只渲染最近一段，避免大块渲染拖垮流式场景；筛选态放开到全部命中（总量已被 MAX_ENTRIES 封顶）
	const renderedEntries = hasActiveFilter ? visibleEntries : visibleEntries.slice(-WINDOW_UNFILTERED);

	const copyLogs = useCallback((logs: RpcLogEntry[]) => {
		void navigator.clipboard.writeText(logs.map(formatRpcLogForCopy).join("\n"));
		// 复制完成给全局 toast 反馈（剪贴板操作无视觉落点，避免用户以为没点中）
		showNotice(t("common.copied"), 2000);
	}, []);

	/**
	 * 展开/折叠一行；模型请求行首次展开时回读完整请求体。
	 *
	 * 回读放这里而不是行内：行组件是 memo 的纯展示，取消订阅/组件卸载由面板统一管；
	 * 请求体可能上百 KB，绝不随日志广播下发，只在用户明确展开某行时拉一次。
	 */
	const handleToggleEntry = useCallback((log: RpcLogEntry) => {
		setExpandedId((current) => (current === log.id ? null : log.id));
		const trace = isModelTraceLogData(log.data) ? log.data : undefined;
		if (log.direction !== "model" || trace?.kind !== "request" || traceRequestedRef.current.has(log.id)) return;
		traceRequestedRef.current.add(log.id);
		setTraceViews((current) => ({ ...current, [log.id]: { status: "loading" } }));
		void window.piDesktop.rpcLogs
			.getModelTrace({ agentId: log.agentId, traceId: trace.traceId })
			.then((record) => {
				// 读不到（尚未落盘 / 已过期清理 / 会话已退出）：允许下次展开重试
				if (!record) traceRequestedRef.current.delete(log.id);
				setTraceViews((current) => ({ ...current, [log.id]: record ? { status: "loaded", payload: record.payloadJson } : { status: "missing" } }));
			})
			.catch(() => {
				traceRequestedRef.current.delete(log.id);
				setTraceViews((current) => ({ ...current, [log.id]: { status: "missing" } }));
			});
	}, []);

	const handleSave = useCallback(async () => {
		setSaving(true);
		try {
			// 保存用户当前视角的内容：有筛选存筛选结果，无筛选存缓冲全量
			const saveEntries = hasActiveFilter ? visibleEntries.slice(0, SAVE_ENTRY_CAP) : entries.slice(-SAVE_ENTRY_CAP);
			const paths = await window.piDesktop.rpcLogs.save({ entries: saveEntries });
			// 主进程返回实际写入的文件路径：单文件直接提示路径，跨日多文件提示首个 + 数量
			if (paths.length === 0) {
				showNotice(t("rpc.saveNoNew"), 2500);
			} else if (paths.length === 1) {
				showNotice(t("rpc.savedToFile", { path: paths[0] }), 4000);
			} else {
				showNotice(t("rpc.savedToFiles", { count: paths.length, path: paths[0] }), 4000);
			}
		} finally {
			setSaving(false);
		}
	}, [entries, visibleEntries, hasActiveFilter]);

	const handleEnableLogging = useCallback(async () => {
		if (!props.setLogging) return;
		// agent 可能在面板打开期间退出：主进程拒绝时给失败提示，不让 promise 裸崩
		try {
			const enabled = await props.setLogging(agentId, true);
			setLoggingOn(enabled);
			// 开启记录是异步生效，成功后给 toast 反馈，失败也明确告知
			showNotice(enabled ? t("rpc.loggingEnabled") : t("rpc.loggingEnableFailed"), 2500);
		} catch {
			showNotice(t("rpc.loggingEnableFailed"), 2500);
		}
	}, [agentId, props.setLogging]);

	/** 停止记录：仅在记录开启时显示入口；agent 停止/应用重启也会自动关闭 */
	const handleDisableLogging = useCallback(async () => {
		if (!props.setLogging) return;
		try {
			const enabled = await props.setLogging(agentId, false);
			setLoggingOn(enabled);
			showNotice(enabled ? t("rpc.loggingDisableFailed") : t("rpc.loggingDisabled"), 2500);
		} catch {
			showNotice(t("rpc.loggingDisableFailed"), 2500);
		}
	}, [agentId, props.setLogging]);

	const handleScrollToBottom = useCallback(() => {
		scrollApiRef.current?.scrollToBottom({ animation: "smooth" });
		setAutoScroll(true);
	}, []);

	/**
	 * 引擎在用户手动滚到底时会 relock（重新锁底跟随），这会让「自动滚动=关」形同虚设。
	 * 面板按开关状态补一次解锁：跟随与否只由用户点开关 / 回底按钮决定，滚动位置不改变它。
	 */
	useEffect(() => {
		if (!autoScroll && following) scrollApiRef.current?.stopScroll();
	}, [autoScroll, following]);

	const title = t("rpc.title", { visible: renderedEntries.length, total: entries.length });

	return (
		<div className="rpc-log-panel flex h-full min-h-0 flex-col overflow-hidden">
			{/* 面板不设独立标题栏（与其他抽屉面板一致，关闭/切换在右侧活动栏），
			    这里只保留日志自己的操作：保存 / 复制 / 关闭当前面板 */}
			<header className="flex shrink-0 items-center gap-2 border-b border-[var(--rpc-log-border)] bg-[var(--rpc-log-surface)] px-3 py-2">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<span className="truncate text-sm font-medium text-[var(--rpc-log-strong)]" title={title}>
						{title}
					</span>
					{entries.length > 0 && (
						<span className={cn("inline-flex shrink-0 items-center gap-1 text-caption font-normal", following ? "text-text-secondary" : "text-text-tertiary")}>
							<Radio size={11} strokeWidth={2.2} className={following ? "animate-pulse text-primary" : ""} aria-hidden="true" />
							{t("rpc.live")}
						</span>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<Button variant="ghost" size="icon-sm" className="size-7" disabled={saving || entries.length === 0} onClick={() => void handleSave()} title={t("rpc.saveFile")} aria-label={t("rpc.saveFile")}>
						<Save size={15} strokeWidth={2} aria-hidden="true" />
					</Button>
					<Button variant="ghost" size="icon-sm" className="size-7" disabled={entries.length === 0} onClick={() => copyLogs(entries)} title={t("common.copyAll")} aria-label={t("common.copyAll")}>
						<Copy size={15} strokeWidth={2} aria-hidden="true" />
					</Button>
					<Button variant="ghost" size="icon-sm" className="size-7" disabled={renderedEntries.length === 0} onClick={() => copyLogs(renderedEntries)} title={t("common.copyVisible")} aria-label={t("common.copyVisible")}>
						<ClipboardList size={15} strokeWidth={2} aria-hidden="true" />
					</Button>
					<Button variant="ghost" size="icon-sm" className="size-7" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
						<X size={16} strokeWidth={2.2} aria-hidden="true" />
					</Button>
				</div>
			</header>

			{/* 工具栏允许折行：抽屉最窄 240px，筛选/开关与搜索（basis-full 独占一行）在窄栏下纵向堆叠 */}
			<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--rpc-log-border)] px-3 py-1.5">
				<div className="flex shrink-0 items-center gap-1">
					<Button variant={directionFilter === "all" ? "secondary" : "ghost"} size="sm" className="h-7 px-2 text-caption" onClick={() => setDirectionFilter("all")}>
						{t("rpc.filterAll")}
					</Button>
					<Button variant={directionFilter === "send" ? "secondary" : "ghost"} size="sm" className="h-7 px-2 text-caption" onClick={() => setDirectionFilter("send")}>
						{t("rpc.filterSend")}
					</Button>
					<Button variant={directionFilter === "recv" ? "secondary" : "ghost"} size="sm" className="h-7 px-2 text-caption" onClick={() => setDirectionFilter("recv")}>
						{t("rpc.filterReceive")}
					</Button>
					<Button variant={directionFilter === "model" ? "secondary" : "ghost"} size="sm" className="h-7 px-2 text-caption" onClick={() => setDirectionFilter("model")}>
						{t("rpc.filterModel")}
					</Button>
				</div>
				<Button variant={autoScroll ? "secondary" : "ghost"} size="sm" className="h-7 px-2 text-caption" onClick={() => setAutoScroll((current) => !current)} title={t("rpc.autoScroll")}>
					{t("rpc.autoScroll")}
				</Button>
				{loggingOn === true && props.setLogging && (
					<Button variant="ghost" size="sm" className="h-7 px-2 text-caption" onClick={() => void handleDisableLogging()}>
						{t("rpc.disableLogging")}
					</Button>
				)}
				<Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={t("rpc.searchPlaceholder")} className="h-7 min-w-0 basis-full border-[var(--rpc-log-border)] bg-[var(--rpc-log-input-bg)] px-2.5 py-1 text-caption text-[var(--rpc-log-strong)]" />
			</div>

			{!hasActiveFilter && entries.length > WINDOW_UNFILTERED && <div className="shrink-0 border-b border-[var(--rpc-log-border)] px-3 py-1.5 text-caption text-text-tertiary">{t("rpc.windowHint", { count: WINDOW_UNFILTERED })}</div>}
			{loggingOn === false && (
				<div className="flex shrink-0 items-center gap-3 border-b border-[var(--rpc-log-border)] px-3 py-2">
					<span className="min-w-0 flex-1 text-caption text-text-secondary">{t("rpc.noLogging")}</span>
					{props.setLogging && (
						<Button variant="outline" size="sm" className="h-7 shrink-0 px-2 text-caption shadow-none" onClick={() => void handleEnableLogging()}>
							{t("rpc.enableLogging")}
						</Button>
					)}
				</div>
			)}

			{/* smooth={false}：日志追底用 instant。弹簧动画逐帧写 scrollTop，每帧都会强制这个
			    容器（最多 WINDOW_UNFILTERED 行）重排，高频日志下持续掉帧。 */}
			<div className="relative min-h-0 flex-1">
				<MessageScroller className="h-full" followOutput={autoScroll} followThreshold={56} onFollowChange={setFollowing} scrollApiRef={scrollApiRef} label={title} viewportClassName="rpc-log-list" smooth={false}>
					{renderedEntries.map((log) => (
						<RpcLogRow key={log.id} log={log} expanded={expandedId === log.id} onToggle={handleToggleEntry} traceView={expandedId === log.id ? traceViews[log.id] : undefined} />
					))}
					{renderedEntries.length === 0 && <div className="rpc-log-empty">{t("rpc.empty")}</div>}
				</MessageScroller>
				{!following && entries.length > 0 && (
					<button className="scroll-to-bottom-btn" onClick={handleScrollToBottom} title={t("app.scrollToBottom")} aria-label={t("app.scrollToBottom")}>
						<ChevronDown size={18} />
					</button>
				)}
			</div>
		</div>
	);
}
