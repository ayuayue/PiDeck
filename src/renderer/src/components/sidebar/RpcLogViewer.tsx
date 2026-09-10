import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Radio } from "lucide-react";
import { t } from "../../i18n";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { showNotice } from "../../utils/notice";
import {
	MessageScroller,
	type MessageScrollerScrollApi,
} from "../agents/message-scroller";
import type { RpcLogBatch, RpcLogEntry } from "../../../../shared/types/rpcLog";

/**
 * 实时 RPC 日志查看弹窗（替代旧的静态日志弹窗）。
 *
 * 数据链路：主进程 RpcLogger 环形缓冲（初始历史）→ 订阅 agentsRpcLog 批量推送（~80ms 一批）→ 本组件追加渲染。
 * 性能设计：
 * - 内存：条目总量封顶 MAX_ENTRIES，超限丢最旧；主进程侧批量节流，避免高频 IPC；
 * - 渲染：无筛选时只渲染最近 WINDOW_UNFILTERED 条（窗口化），行组件 React.memo，追加重渲染只落在新增行；
 * - 自动滚动：复用 MessageScroller 的 stick-to-bottom 引擎（用户上翻即脱离，回底按钮归位）。
 */
const MAX_ENTRIES = 3000;
/** 无筛选时最多渲染的条数：日常查看只看最近一段，超出部分靠搜索/筛选/保存到文件取回 */
const WINDOW_UNFILTERED = 800;
/** 一次保存的最大条目数（主进程侧同样有 10000 上限兜底） */
const SAVE_ENTRY_CAP = 10000;

export interface RpcLogViewerProps {
	/** 日志所属 agent */
	agentId: string;
	/** 可选的磁盘历史加载器（从文件补回缓冲之外的旧日志，如会话右键入口） */
	loadHistory?: (agentId: string) => Promise<RpcLogEntry[]>;
	/** 查询日志记录开关；不传则视为已开启 */
	getLogging?: (agentId: string) => Promise<boolean>;
	/** 开启日志记录；不传则隐藏“未开启”提示条 */
	setLogging?: (agentId: string, enabled: boolean) => Promise<boolean>;
	onClose: () => void;
}

/** 合并初始历史与实时追加：按 id 去重、按时间升序、封顶 MAX_ENTRIES */
export function mergeLogEntries(
	existing: RpcLogEntry[],
	incoming: RpcLogEntry[],
): RpcLogEntry[] {
	if (incoming.length === 0) return existing;
	const seen = new Set(existing.map((entry) => entry.id));
	const merged = existing.slice();
	for (const entry of incoming) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		merged.push(entry);
	}
	merged.sort((a, b) => a.time - b.time);
	return merged.length > MAX_ENTRIES
		? merged.slice(merged.length - MAX_ENTRIES)
		: merged;
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

/** 行组件：memo 后追加重渲染只更新新增行，历史行直接跳过 */
const RpcLogRow = memo(function RpcLogRow(props: {
	log: RpcLogEntry;
	expanded: boolean;
	onToggle: () => void;
}) {
	const { log, expanded, onToggle } = props;
	const jsonText = log.data !== undefined ? JSON.stringify(log.data, null, 2) : "";
	return (
		<div className="rpc-log-entry-wrap">
			<div
				className={`rpc-log-entry ${log.direction === "send" ? "log-send" : "log-recv"}`}
				onClick={onToggle}
				title={log.summary}
			>
				<time>
					{new Date(log.time).toLocaleTimeString(undefined, {
						hour: "2-digit",
						minute: "2-digit",
						second: "2-digit",
					})}
				</time>
				<span className="log-direction">{log.direction === "send" ? "→" : "←"}</span>
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
					{log.data !== undefined && (
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
			{expanded && log.data !== undefined && <pre className="rpc-log-detail">{jsonText}</pre>}
		</div>
	);
});

export function RpcLogViewer(props: RpcLogViewerProps) {
	const { agentId, onClose } = props;
	const [entries, setEntries] = useState<RpcLogEntry[]>([]);
	const [keyword, setKeyword] = useState("");
	const [directionFilter, setDirectionFilter] = useState<"all" | "send" | "recv">("all");
	const [expandedId, setExpandedId] = useState<string | null>(null);
	/** 自动滚动开关：关掉后新日志不再追底，方便上翻排查 */
	const [autoScroll, setAutoScroll] = useState(true);
	/** 用户是否仍在实时尾部（MessageScroller 引擎上报） */
	const [following, setFollowing] = useState(true);
	const [loggingOn, setLoggingOn] = useState<boolean | null>(null);
	const [saving, setSaving] = useState(false);
	const scrollApiRef = useRef<MessageScrollerScrollApi | null>(null);

	// ── 数据流：初始历史 + 实时订阅 ──
	useEffect(() => {
		let disposed = false;
		// 初始历史 = 主进程环形缓冲（最近 MAX_LIVE 条）+ 可选的磁盘历史（文件里更早的日志）
		void Promise.all([
			window.piDesktop.rpcLogs.getLive(agentId),
			props.loadHistory ? props.loadHistory(agentId) : Promise.resolve([]),
		]).then(([live, history]) => {
			if (disposed) return;
			setEntries((current) => mergeLogEntries(current, [...history, ...live]));
		});
		// 实时追加：主进程 ~80ms 聚合一批推送，直接追加（行组件 memo，成本只在新增行）
		const unsubscribe = window.piDesktop.rpcLogs.onLog((batch: RpcLogBatch) => {
			if (disposed || batch.agentId !== agentId) return;
			setEntries((current) => mergeLogEntries(current, batch.entries));
		});
		// 开关状态：未开启时提示用户先开启记录
		if (props.getLogging) {
			void props.getLogging(agentId).then((enabled) => {
				if (!disposed) setLoggingOn(enabled);
			});
		} else {
			setLoggingOn(true);
		}
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [agentId, props.loadHistory, props.getLogging]);

	// ── 筛选与窗口化 ──
	const hasActiveFilter = keyword.trim() !== "" || directionFilter !== "all";
	const visibleEntries = useMemo(() => {
		const normalizedKeyword = keyword.trim().toLowerCase();
		return entries.filter((log) => {
			if (directionFilter !== "all" && log.direction !== directionFilter) return false;
			if (!normalizedKeyword) return true;
			return formatRpcLogForCopy(log).toLowerCase().includes(normalizedKeyword);
		});
	}, [entries, keyword, directionFilter]);
	// 无筛选时只渲染最近一段，避免大块渲染拖垮流式场景；筛选态放开到全部命中（总量已被 MAX_ENTRIES 封顶）
	const renderedEntries = hasActiveFilter
		? visibleEntries
		: visibleEntries.slice(-WINDOW_UNFILTERED);

	const copyLogs = useCallback((logs: RpcLogEntry[]) => {
		void navigator.clipboard.writeText(logs.map(formatRpcLogForCopy).join("\n"));
		// 复制完成给全局 toast 反馈（剪贴板操作无视觉落点，避免用户以为没点中）
		showNotice(t("common.copied"), 2000);
	}, []);

	const handleSave = useCallback(async () => {
		setSaving(true);
		try {
			// 保存用户当前视角的内容：有筛选存筛选结果，无筛选存缓冲全量
			const saveEntries = hasActiveFilter
				? visibleEntries.slice(0, SAVE_ENTRY_CAP)
				: entries.slice(-SAVE_ENTRY_CAP);
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
		const enabled = await props.setLogging(agentId, true);
		setLoggingOn(enabled);
		// 开启记录是异步生效，成功后给 toast 反馈，失败也明确告知
		showNotice(enabled ? t("rpc.loggingEnabled") : t("rpc.loggingEnableFailed"), 2500);
	}, [agentId, props.setLogging]);

	/** 停止记录：仅在记录开启时显示入口；agent 停止/应用重启也会自动关闭 */
	const handleDisableLogging = useCallback(async () => {
		if (!props.setLogging) return;
		const enabled = await props.setLogging(agentId, false);
		setLoggingOn(enabled);
		showNotice(enabled ? t("rpc.loggingDisableFailed") : t("rpc.loggingDisabled"), 2500);
	}, [agentId, props.setLogging]);

	const handleScrollToBottom = useCallback(() => {
		scrollApiRef.current?.scrollToBottom({ animation: "smooth" });
		setAutoScroll(true);
	}, []);

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent
				showCloseButton={false}
				className={cn(
					"flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1000px,92vw)] h-[min(720px,82vh)]",
				)}
			>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle className="flex items-center gap-2">
						<span>{t("rpc.title", { visible: renderedEntries.length, total: entries.length })}</span>
						{entries.length > 0 && (
							<span
								className={cn(
									"inline-flex items-center gap-1 text-caption font-normal",
									following ? "text-text-secondary" : "text-text-tertiary",
								)}
							>
								<Radio size={11} strokeWidth={2.2} className={following ? "animate-pulse text-primary" : ""} aria-hidden="true" />
								{t("rpc.live")}
							</span>
						)}
					</DialogTitle>
					<div className="flex items-center gap-2">
						<Button variant="default" size="sm" disabled={saving || entries.length === 0} onClick={() => void handleSave()}>
							{t("rpc.saveFile")}
						</Button>
						<Button variant="secondary" size="sm" disabled={entries.length === 0} onClick={() => copyLogs(entries)}>
							{t("common.copyAll")}
						</Button>
						<Button variant="secondary" size="sm" disabled={renderedEntries.length === 0} onClick={() => copyLogs(renderedEntries)}>
							{t("common.copyVisible")}
						</Button>
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X size={18} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>

				<div className="rpc-log-toolbar">
					<div className="rpc-log-filter-tabs">
						<Button
							variant="outline"
							size="sm"
							className={`h-auto px-2 py-1 text-caption shadow-none${directionFilter === "all" ? " active" : ""}`}
							onClick={() => setDirectionFilter("all")}
						>
							{t("rpc.filterAll")}
						</Button>
						<Button
							variant="outline"
							size="sm"
							className={`h-auto px-2 py-1 text-caption shadow-none${directionFilter === "send" ? " active" : ""}`}
							onClick={() => setDirectionFilter("send")}
						>
							{t("rpc.filterSend")}
						</Button>
						<Button
							variant="outline"
							size="sm"
							className={`h-auto px-2 py-1 text-caption shadow-none${directionFilter === "recv" ? " active" : ""}`}
							onClick={() => setDirectionFilter("recv")}
						>
							{t("rpc.filterReceive")}
						</Button>
					</div>
					{loggingOn === true && props.setLogging && (
						<Button
							variant="outline"
							size="sm"
							className="h-auto px-2 py-1 text-caption shadow-none"
							onClick={() => void handleDisableLogging()}
						>
							{t("rpc.disableLogging")}
						</Button>
					)}
					<Input
						value={keyword}
						onChange={(e) => setKeyword(e.target.value)}
						placeholder={t("rpc.searchPlaceholder")}
						className="h-auto min-w-0 flex-1 border-[var(--rpc-log-border)] bg-[var(--rpc-log-input-bg)] px-2.5 py-1.5 text-caption text-[var(--rpc-log-strong)]"
					/>
					<Button
						variant="outline"
						size="sm"
						className={`rpc-log-autoscroll h-auto px-2 py-1 text-caption shadow-none${autoScroll ? " active" : ""}`}
						onClick={() => setAutoScroll((current) => !current)}
						title={t("rpc.autoScroll")}
					>
						{t("rpc.autoScroll")}
					</Button>
				</div>

				{!hasActiveFilter && entries.length > WINDOW_UNFILTERED && (
					<div className="border-b border-[var(--rpc-log-border)] px-4 py-1.5 text-caption text-text-tertiary">
						{t("rpc.windowHint", { count: WINDOW_UNFILTERED })}
					</div>
				)}
				{loggingOn === false && (
					<div className="flex items-center gap-3 border-b border-[var(--rpc-log-border)] px-4 py-2">
						<span className="text-caption text-text-secondary">{t("rpc.noLogging")}</span>
						{props.setLogging && (
							<Button variant="outline" size="sm" className="h-auto px-2 py-1 text-caption shadow-none" onClick={() => void handleEnableLogging()}>
								{t("rpc.enableLogging")}
							</Button>
						)}
					</div>
				)}

				<div className="relative min-h-0 flex-1">
					<MessageScroller
						className="h-full"
						followOutput={autoScroll}
						followThreshold={56}
						onFollowChange={setFollowing}
						scrollApiRef={scrollApiRef}
						label={t("rpc.title", { visible: renderedEntries.length, total: entries.length })}
						viewportClassName="rpc-log-list"
						smooth
					>
						{renderedEntries.map((log) => (
							<RpcLogRow
								key={log.id}
								log={log}
								expanded={expandedId === log.id}
								onToggle={() => setExpandedId((current) => (current === log.id ? null : log.id))}
							/>
						))}
						{renderedEntries.length === 0 && (
							<div className="rpc-log-empty">{t("rpc.empty")}</div>
						)}
					</MessageScroller>
					{!following && entries.length > 0 && (
						<button
							className="scroll-to-bottom-btn"
							onClick={handleScrollToBottom}
							title={t("app.scrollToBottom")}
							aria-label={t("app.scrollToBottom")}
						>
							<ChevronDown size={18} />
						</button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
