import { useCallback, useEffect, useReducer, useState } from "react";
import { RefreshCw } from "lucide-react";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { AddHostDialog } from "./AddHostDialog";
import type { RemoteHostListItem, RemoteHostRebindPending, RemoteHostRebindStage } from "../../../../../shared/types/remoteHost";
import { INITIAL_REBIND_WIZARD, reduceRebindWizard } from "../../../utils/rebindWizardState";

/**
 * 重新绑定主机的设置页入口（设计 §3.1 的 E1/E2 合并成一处：用户已定只放设置页）。
 *
 * 三块内容，都有明确的所有权：
 * 1. 横幅：`describeRebind()`（只读）——有残留 journal 时显示阶段与计数，给「继续收敛」；
 * 2. 入口按钮：打开向导；没有可选目标时禁用并说明原因，不给一个点不通的按钮；
 * 3. 向导：5 步单模态，预检/确认/执行分别对应 plan → continue → answer，状态机在
 *    `rebindWizardState.ts` 里（改一对 host 就作废旧摘要）。
 *
 * 界面只显示计数与稳定码；recordId、路径、pin 都不在任何一步出现（main 也不发）。
 */
function txLabel(tx: RemoteHostRebindPending["tx"] | "idle" | "journal-present" | "busy" | "lock-unreadable"): string {
	switch (tx) {
		case "idle":
			return t("settings.connections.rebind.tx.idle");
		case "journal-present":
			return t("settings.connections.rebind.tx.journalPresent");
		case "busy":
			return t("settings.connections.rebind.tx.busy");
		default:
			return t("settings.connections.rebind.tx.lockUnreadable");
	}
}

function stageLabel(stage: RemoteHostRebindStage): string {
	switch (stage) {
		case "prepared":
			return t("settings.connections.rebind.stage.prepared");
		case "source-disabled":
			return t("settings.connections.rebind.stage.sourceDisabled");
		case "projects-written":
			return t("settings.connections.rebind.stage.projectsWritten");
		case "sessions-written":
			return t("settings.connections.rebind.stage.sessionsWritten");
		case "source-retired":
			return t("settings.connections.rebind.stage.sourceRetired");
		default:
			return t("settings.connections.rebind.stage.committed");
	}
}

export function RebindPanel(props: { hosts: RemoteHostListItem[]; onChanged?: () => void }) {
	const [pending, setPending] = useState<RemoteHostRebindPending | null>(null);
	const [pendingError, setPendingError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	// 空态里的「添加主机」：复用既有 AddHostDialog，添加完成后刷新主机列表（不在这里自动连接）。
	const [adding, setAdding] = useState(false);
	const [busy, setBusy] = useState(false);
	const [state, dispatch] = useReducer(reduceRebindWizard, INITIAL_REBIND_WIZARD);

	const refreshPending = useCallback(async () => {
		const result = await desktopApi.remoteHosts.describeRebind();
		if (!result.ok) {
			setPendingError(result.code);
			setPending(null);
			return;
		}
		setPendingError(null);
		setPending(result.pending);
	}, []);

	useEffect(() => {
		void refreshPending();
	}, [refreshPending]);

	const close = useCallback(
		async (choice: "approve" | "deny") => {
			if ((state.step === "preview" || state.step === "confirm") && state.requestId !== null && choice === "deny") {
				// 拒绝必须回到 main 收尾，否则确认会留到 TTL 才过期。
				await desktopApi.remoteHosts.answerRebind(state.requestId, "deny");
			}
			setOpen(false);
			dispatch({ type: "reset" });
		},
		[state.step, state.requestId],
	);

	const preview = useCallback(async () => {
		if (state.sourceHostId === null || state.targetHostId === null) return;
		setBusy(true);
		try {
			const result = await desktopApi.remoteHosts.planRebind(state.sourceHostId, state.targetHostId);
			if (!result.ok) dispatch({ type: "failed", code: result.code });
			else dispatch({ type: "previewed", summary: result.summary, requestId: result.requestId });
		} finally {
			setBusy(false);
		}
	}, [state.sourceHostId, state.targetHostId]);

	const approve = useCallback(async () => {
		if (state.requestId === null) return;
		dispatch({ type: "approved" });
		setBusy(true);
		try {
			const result = await desktopApi.remoteHosts.answerRebind(state.requestId, "approve");
			if (!result.ok) dispatch({ type: "failed", code: result.code });
			else if (!result.ran) dispatch({ type: "failed", code: "HOST_REBIND_CONFIRMATION_REQUIRED" });
			else dispatch({ type: "answered", outcome: result.outcome });
		} finally {
			setBusy(false);
			void refreshPending();
			props.onChanged?.();
		}
	}, [state.requestId, refreshPending, props]);

	const resume = useCallback(async () => {
		setBusy(true);
		try {
			const result = await desktopApi.remoteHosts.resumeRebind();
			if (!result.ok) setPendingError(result.code);
			else await refreshPending();
		} finally {
			setBusy(false);
			props.onChanged?.();
		}
	}, [refreshPending, props]);

	const targets = props.hosts.filter((host) => host.verified && !host.disabled && host.id !== state.sourceHostId);
	const canOpen = props.hosts.some((host) => host.verified && !host.disabled);

	return (
		<div className="flex min-w-0 flex-col gap-2 rounded-md border border-border/60 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="min-w-0">
					<p className="text-body font-medium">{t("settings.connections.rebind.title")}</p>
					<p className="text-caption text-muted-foreground">{t("settings.connections.rebind.subtitle")}</p>
				</div>
				<Button
					size="sm"
					variant="outline"
					disabled={!canOpen}
					title={canOpen ? undefined : t("settings.connections.rebind.emptyTargets")}
					onClick={() => {
						dispatch({ type: "reset" });
						setOpen(true);
					}}
				>
					{t("settings.connections.rebind.action")}
				</Button>
			</div>

			{pendingError !== null ? <p className="text-caption text-destructive">{t("settings.connections.rebind.error", { code: pendingError })}</p> : null}
			{pending?.present === true ? (
				<div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/60 bg-muted/30 p-2">
					<div className="min-w-0 text-caption">
						<p className="font-medium">{t("settings.connections.rebind.pending.title", { stage: stageLabel(pending.stage) })}</p>
						<p className="text-muted-foreground">{t("settings.connections.rebind.records", { projects: String(pending.records.projects), sessions: String(pending.records.sessions) })}</p>
					</div>
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void resume()}>
						<RefreshCw className="size-4" aria-hidden="true" />
						{t("settings.connections.rebind.pending.resume")}
					</Button>
				</div>
			) : null}

			{pending !== null && !pending.present && pending.tx === "busy" ? <p className="text-caption text-muted-foreground">{txLabel("busy")}</p> : null}
			{pending !== null && !pending.present && pending.tx === "lock-unreadable" ? <p className="text-caption text-destructive">{txLabel("lock-unreadable")}</p> : null}

			{adding ? (
				<AddHostDialog
					onClose={() => setAdding(false)}
					onChanged={() => props.onChanged?.()}
				/>
			) : null}

			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) void close("deny");
				}}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{t("settings.connections.rebind.title")}</DialogTitle>
						<DialogDescription>{t("settings.connections.rebind.subtitle")}</DialogDescription>
					</DialogHeader>

					{state.step === "select" ? (
						<div className="flex flex-col gap-3">
							<label className="flex flex-col gap-1 text-caption">
								{t("settings.connections.rebind.source")}
								<select className="h-9 rounded-md border border-input bg-transparent px-2 text-body" value={state.sourceHostId ?? ""} disabled={busy} onChange={(event) => dispatch({ type: "select-source", hostId: event.target.value })}>
									<option value="">{t("settings.connections.rebind.selectPlaceholder")}</option>
									{props.hosts
										.filter((host) => host.verified && !host.disabled)
										.map((host) => (
											<option key={host.id} value={host.id}>
												{host.label}
											</option>
										))}
								</select>
							</label>
							<label className="flex flex-col gap-1 text-caption">
								{t("settings.connections.rebind.target")}
								<select className="h-9 rounded-md border border-input bg-transparent px-2 text-body" value={state.targetHostId ?? ""} disabled={busy || targets.length === 0} onChange={(event) => dispatch({ type: "select-target", hostId: event.target.value })}>
									<option value="">{t("settings.connections.rebind.selectPlaceholder")}</option>
									{targets.map((host) => (
										<option key={host.id} value={host.id}>
											{host.label}
										</option>
									))}
								</select>
							</label>
							{state.sourceHostId !== null && targets.length === 0 ? (
								<div className="flex flex-wrap items-center gap-2">
									<p className="text-caption text-muted-foreground">{t("settings.connections.rebind.emptyTargets")}</p>
									<Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
										{t("settings.connections.new")}
									</Button>
								</div>
							) : null}
							{state.errorCode !== null ? <p className="text-caption text-destructive">{t("settings.connections.rebind.error", { code: state.errorCode })}</p> : null}
						</div>
					) : null}

					{state.step === "preview" && state.summary !== null ? (
						<div className="flex flex-col gap-2 text-caption">
							<p>{t("settings.connections.rebind.records", { projects: String(state.summary.records.projects), sessions: String(state.summary.records.sessions) })}</p>
							<p className="text-muted-foreground">{t("settings.connections.rebind.referenceScan", { count: String(state.summary.referenceScan.count) })}</p>
							<p className="text-muted-foreground">{txLabel(state.summary.tx)}</p>
						</div>
					) : null}

					{state.step === "confirm" ? (
						<div className="flex flex-col gap-2 text-caption">
							<p className="font-medium">{t("settings.connections.rebind.confirm.title")}</p>
							<p>{t("settings.connections.rebind.confirm.sourceDisabled")}</p>
							{/* 三句硬事实（设计 §3.2 ③）：少任何一句都是在替用户猜。 */}
							<p>{t("settings.connections.rebind.confirm.noCancel")}</p>
							<p>{t("settings.connections.rebind.confirm.trust")}</p>
							{state.errorCode !== null ? <p className="text-destructive">{t("settings.connections.rebind.error", { code: state.errorCode })}</p> : null}
						</div>
					) : null}

					{state.step === "running" ? <p className="text-caption text-muted-foreground">{t("settings.connections.rebind.running")}</p> : null}

					{state.step === "result" && state.outcome !== null ? (
						<div className="flex flex-col gap-2 text-caption">
							<p className="font-medium">{state.outcome.code === "REMOTE_HOST_REBIND_COMMITTED" ? t("settings.connections.rebind.result.committed") : t("settings.connections.rebind.result.committedWithWarnings")}</p>
							<p>{t("settings.connections.rebind.records", { projects: String(state.outcome.migratedProjects), sessions: String(state.outcome.migratedSessions) })}</p>
							{state.outcome.warnings.length > 0 ? <p className="text-muted-foreground">{t("settings.connections.rebind.result.warnings", { warnings: state.outcome.warnings.join(", ") })}</p> : null}
						</div>
					) : null}

					<DialogFooter>
						{state.step === "select" ? (
							<>
								<Button variant="outline" size="sm" onClick={() => void close("deny")}>
									{t("settings.connections.rebind.cancel")}
								</Button>
								<Button size="sm" disabled={busy || state.sourceHostId === null || state.targetHostId === null} onClick={() => void preview()}>
									{t("settings.connections.rebind.preview")}
								</Button>
							</>
						) : null}
						{state.step === "preview" ? (
							<>
								<Button variant="outline" size="sm" onClick={() => void close("deny")}>
									{t("settings.connections.rebind.cancel")}
								</Button>
								<Button size="sm" onClick={() => dispatch({ type: "continue" })}>
									{t("settings.connections.rebind.continue")}
								</Button>
							</>
						) : null}
						{state.step === "confirm" ? (
							<>
								<Button variant="outline" size="sm" disabled={busy} onClick={() => void close("deny")}>
									{t("settings.connections.rebind.cancel")}
								</Button>
								<Button size="sm" variant="destructive" disabled={busy} onClick={() => void approve()}>
									{t("settings.connections.rebind.confirm.run")}
								</Button>
							</>
						) : null}
						{state.step === "result" ? (
							<Button size="sm" onClick={() => void close("deny")}>
								{t("settings.connections.rebind.close")}
							</Button>
						) : null}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
