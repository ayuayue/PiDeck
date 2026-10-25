import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { History, ExternalLink, StopCircle, CheckCircle2, XCircle, AlertCircle, Clock, Coins, Wrench, FileCode, Trash2 } from "lucide-react";
import { automationRunsAtom } from "../../atoms/automation-atoms";
import { projectInventoryAtom } from "../../atoms/project-atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import { Checkbox } from "../ui-shadcn/checkbox";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { isAutomationRunTerminal, type AutomationRun } from "../../../../shared/types";

interface AutomationHistoryListProps {
	/** Omit for the global run inbox; a project task page only exposes its own runs. */
	projectId?: string;
	/** 点击查看执行会话时的回调 */
	onViewSession?: (projectId: string, sessionId: string) => void;
}

function formatDuration(ms?: number) {
	if (!ms || ms <= 0) return "-";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSec = seconds % 60;
	return `${minutes}m ${remainingSec}s`;
}

function formatTime(timestamp?: number) {
	if (!timestamp) return "-";
	const date = new Date(timestamp);
	return date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/**
 * 历史执行记录与实时运行看板。
 * 删除/清空只作用于已结束记录：queued/starting/running 必须留在看板上，否则无法中止。
 */
export function AutomationHistoryList({ projectId, onViewSession }: AutomationHistoryListProps) {
	const allRuns = useAtomValue(automationRunsAtom);
	const runs = useMemo(() => (projectId ? allRuns.filter((run) => run.projectId === projectId) : allRuns), [allRuns, projectId]);
	const projects = useAtomValue(projectInventoryAtom);

	const [abortingRunIds, setAbortingRunIds] = useState<Set<string>>(new Set());
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [confirm, setConfirm] = useState<"delete" | "clear" | null>(null);
	const [busy, setBusy] = useState(false);

	const projectMap = new Map<string, string>();
	for (const p of projects) {
		projectMap.set(p.id, p.name);
	}

	const terminalRuns = useMemo(() => runs.filter((run) => isAutomationRunTerminal(run.status)), [runs]);
	const terminalIdSet = useMemo(() => new Set(terminalRuns.map((run) => run.id)), [terminalRuns]);

	useEffect(() => {
		setSelectedIds((prev) => {
			const next = new Set([...prev].filter((id) => terminalIdSet.has(id)));
			if (next.size === prev.size) return prev;
			return next;
		});
	}, [terminalIdSet]);

	const allSelected = terminalRuns.length > 0 && selectedIds.size === terminalRuns.length;
	const someSelected = selectedIds.size > 0 && !allSelected;

	const handleAbort = async (run: AutomationRun) => {
		try {
			setAbortingRunIds((prev) => new Set(prev).add(run.id));
			await desktopApi.automation.abortRun(run.id);
			showNotice(t("automation.runAborted"), 2500);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 3500);
		} finally {
			setAbortingRunIds((prev) => {
				const next = new Set(prev);
				next.delete(run.id);
				return next;
			});
		}
	};

	const handleDeleteSelected = async () => {
		const ids = [...selectedIds];
		setConfirm(null);
		if (ids.length === 0) return;
		setBusy(true);
		try {
			const deleted = await desktopApi.automation.deleteRuns(ids);
			setSelectedIds(new Set());
			showNotice(t("automation.historyDeleted", { count: deleted }), 2000);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 3500);
		} finally {
			setBusy(false);
		}
	};

	const handleClear = async () => {
		setConfirm(null);
		setBusy(true);
		try {
			const deleted = await desktopApi.automation.clearRuns();
			setSelectedIds(new Set());
			showNotice(t("automation.historyCleared", { count: deleted }), 2000);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 3500);
		} finally {
			setBusy(false);
		}
	};

	const toggleSelectAll = () => {
		if (allSelected) {
			setSelectedIds(new Set());
			return;
		}
		setSelectedIds(new Set(terminalRuns.map((run) => run.id)));
	};

	const toggleRow = (runId: string, checked: boolean) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (checked) next.add(runId);
			else next.delete(runId);
			return next;
		});
	};

	// 状态一律用 badge 的语义档（info/success/danger/warning/neutral），色值走 foundation
	// 的 --color-* token，暗色与皮肤自动翻转；不再逐处重写 h-5 px-1.5 text-micro。
	const renderStatusBadge = (status: AutomationRun["status"]) => {
		switch (status) {
			case "queued":
			case "starting":
			case "running":
				return (
					<Badge variant="info" size="sm" className="animate-pulse">
						{status === "queued" ? t("automation.status.queued") : status === "starting" ? t("automation.status.starting") : t("automation.status.running")}
					</Badge>
				);
			case "succeeded":
				return (
					<Badge variant="success" size="sm">
						<CheckCircle2 className="size-3" />
						{t("automation.status.succeeded")}
					</Badge>
				);
			case "failed":
			case "timed-out":
			case "budget-exhausted":
			case "interrupted":
				return (
					<Badge variant="danger" size="sm">
						<XCircle className="size-3" />
						{status === "timed-out" ? t("automation.status.timedOut") : status === "interrupted" ? t("automation.status.interrupted") : t("automation.status.failed")}
					</Badge>
				);
			case "aborted":
				return (
					<Badge variant="warning" size="sm">
						<AlertCircle className="size-3" />
						{t("automation.status.aborted")}
					</Badge>
				);
			case "skipped":
				return (
					<Badge variant="neutral" size="sm">
						{t("automation.status.skipped")}
					</Badge>
				);
			default:
				return null;
		}
	};

	if (runs.length === 0) {
		return (
			<div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
				<History className="size-8 opacity-40" />
				<span className="text-xs">{t("automation.historyEmpty")}</span>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex flex-wrap items-center justify-between gap-2 pb-0.5">
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<Checkbox checked={allSelected ? true : someSelected ? "indeterminate" : false} disabled={terminalRuns.length === 0 || busy} onCheckedChange={toggleSelectAll} aria-label={t("common.selectAll")} />
					<span>
						{t("automation.historyTab")} ({runs.length})
					</span>
				</div>
				<div className="flex items-center gap-1.5">
					<Button variant="outline" size="sm" className="h-6 px-2 text-micro" disabled={selectedIds.size === 0 || busy} onClick={() => setConfirm("delete")}>
						<Trash2 className="mr-1 size-3" />
						{t("common.deleteSelected")}
						{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
					</Button>
					{!projectId && (
						<Button variant="ghost" size="sm" className="h-6 px-2 text-micro" disabled={terminalRuns.length === 0 || busy} onClick={() => setConfirm("clear")}>
							{t("automation.clearHistory")}
						</Button>
					)}
				</div>
			</div>

			<div className="flex flex-col gap-2">
				{runs.map((run) => {
					const projectName = projectMap.get(run.projectId) || run.projectId;
					const isRunning = !isAutomationRunTerminal(run.status);
					const isAborting = abortingRunIds.has(run.id);
					const totalTokens = (run.inputTokens || 0) + (run.outputTokens || 0);

					return (
						<div key={run.id} className="flex flex-col gap-2 rounded-lg border border-border/50 bg-bg-panel/30 p-2.5 transition-colors hover:border-border">
							<div className="flex items-center justify-between gap-2">
								<div className="flex min-w-0 items-center gap-2">
									{!isRunning && <Checkbox checked={selectedIds.has(run.id)} disabled={busy} onCheckedChange={(checked) => toggleRow(run.id, checked === true)} aria-label={run.taskName} />}
									<span className="truncate text-xs font-medium text-foreground">{run.taskName}</span>
									{!projectId && (
										<Badge variant="outline" size="sm" className="font-normal text-muted-foreground">
											{projectName}
										</Badge>
									)}
									{renderStatusBadge(run.status)}
									<span className="font-mono text-micro text-muted-foreground">{run.trigger}</span>
								</div>

								<div className="flex shrink-0 items-center gap-1.5">
									{isRunning && (
										<Button variant="destructive" size="sm" className="h-6 gap-1 px-2 text-micro" disabled={isAborting} onClick={() => handleAbort(run)}>
											<StopCircle className="size-3" />
											{t("automation.abortRun")}
										</Button>
									)}
									{run.sessionId && onViewSession && (
										<Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-micro" onClick={() => onViewSession(run.projectId, run.sessionId!)}>
											<ExternalLink className="size-3" />
											{t("automation.viewSession")}
										</Button>
									)}
								</div>
							</div>

							{run.error && <div className="break-all rounded bg-destructive/10 px-2 py-1 font-mono text-micro text-destructive">{run.error}</div>}

							<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/20 pt-1.5 text-micro text-muted-foreground">
								<span className="flex items-center gap-1">
									<Clock className="size-3 opacity-70" />
									{formatTime(run.startedAt ?? run.queuedAt)}
								</span>
								{run.durationMs != null && (
									<span>
										{t("automation.duration", {
											duration: formatDuration(run.durationMs),
										})}
									</span>
								)}
								{totalTokens > 0 && (
									<span className="flex items-center gap-0.5">
										<Coins className="size-3 opacity-70" />
										{t("automation.tokensUsed", {
											tokens: totalTokens.toLocaleString(),
										})}
									</span>
								)}
								{run.costUsd > 0 && (
									<span>
										{t("automation.costUsed", {
											cost: run.costUsd.toFixed(4),
										})}
									</span>
								)}
								{run.stepCount > 0 && (
									<span className="flex items-center gap-0.5">
										<Wrench className="size-3 opacity-70" />
										{t("automation.stepsCount", {
											steps: String(run.stepCount),
										})}
									</span>
								)}
								{run.changedFiles != null && run.changedFiles > 0 && (
									<span className="flex items-center gap-0.5 text-foreground/80">
										<FileCode className="size-3 opacity-70" />
										{t("automation.changedFiles", {
											count: String(run.changedFiles),
										})}
									</span>
								)}
							</div>
						</div>
					);
				})}
			</div>

			{confirm === "delete" && <ConfirmDialog title={t("common.deleteSelected")} message={t("common.deleteBatchConfirm", { count: selectedIds.size })} confirmLabel={t("common.delete")} danger onConfirm={() => void handleDeleteSelected()} onCancel={() => setConfirm(null)} />}
			{confirm === "clear" && <ConfirmDialog title={t("automation.clearHistory")} message={t("automation.clearHistoryConfirm")} confirmLabel={t("common.clear")} danger onConfirm={() => void handleClear()} onCancel={() => setConfirm(null)} />}
		</div>
	);
}
