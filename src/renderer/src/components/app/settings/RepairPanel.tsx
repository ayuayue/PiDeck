import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import type { RemoteHostRepairAction, RemoteHostRepairFinding, RemoteHostRepairRequest } from "../../../../../shared/types/remoteHost";

/**
 * needs-repair 面板：把「存储坏了」变成「哪儿坏了、能做什么」。
 *
 * 为什么必须存在：store 进入 `needs-repair` 后拒绝一切写入（这是对的——它发现了跨文件不一致），
 * 但在此之前用户只看到一句 `REMOTE_HOST_STORE_NEEDS_REPAIR`：看不出原因、也**没有出路**。
 * 持久化面有四处（主档案、备份、写锁、pin 目录），任何一处残留都会落到这个状态；
 * 而修复动作在主进程里早就实现了（`RemoteHostRepair`），只是一直没接出来。
 *
 * 只展示诊断给出的**合法**动作，不发明按钮——主进程也会再校验一次，界面不是权威。
 */

/** 只有会写东西的动作需要确认；只读/人工动作直接呈现为说明。 */
const EXECUTABLE: ReadonlySet<RemoteHostRepairAction> = new Set(["complete-activation-from-pin", "discard-orphan-pin", "clear-stale-lock", "forget-trust-anchor"]);

/** 动作靠显式映射而不是拼 key：远端回来的字符串拼出的 key 不存在。 */
function actionLabel(action: RemoteHostRepairAction): string {
	switch (action) {
		case "complete-activation-from-pin":
			return t("settings.connections.repair.action.completeActivation");
		case "discard-orphan-pin":
			return t("settings.connections.repair.action.discardOrphanPin");
		case "clear-stale-lock":
			return t("settings.connections.repair.action.clearStaleLock");
		case "forget-trust-anchor":
			return t("settings.connections.repair.action.forgetTrustAnchor");
		case "rebuild-target-and-rebind":
			return t("settings.connections.repair.action.rebuildTarget");
		case "inspect-snapshot-pair":
			return t("settings.connections.repair.action.inspectSnapshot");
		case "refresh-then-recheck":
			return t("settings.connections.repair.action.refreshThenRecheck");
		case "fix-filesystem-permissions":
			return t("settings.connections.repair.action.fixPermissions");
		default:
			return t("settings.connections.repair.action.humanReview");
	}
}

function actionHint(action: RemoteHostRepairAction): string {
	switch (action) {
		case "complete-activation-from-pin":
			return t("settings.connections.repair.hint.completeActivation");
		case "discard-orphan-pin":
			return t("settings.connections.repair.hint.discardOrphanPin");
		case "clear-stale-lock":
			return t("settings.connections.repair.hint.clearStaleLock");
		case "forget-trust-anchor":
			return t("settings.connections.repair.hint.forgetTrustAnchor");
		default:
			return t("settings.connections.repair.hint.manual");
	}
}

export function RepairPanel(props: { onRepaired: () => void }) {
	const [findings, setFindings] = useState<RemoteHostRepairFinding[]>([]);
	const [none, setNone] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [request, setRequest] = useState<RemoteHostRepairRequest | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		const result = await desktopApi.remoteHosts.diagnoseRepair();
		if (!result.ok) {
			setMessage(t("settings.connections.repair.unavailable", { code: result.code }));
			setFindings([]);
			return;
		}
		setMessage(null);
		// 空列表是正常状态（store 健康），由调用方决定是否隐藏本面板。
		setNone(result.findings.length === 0);
		setFindings(result.findings);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/** 确认推送到达后才算「等用户回答」；订阅必须退订。 */
	useEffect(() => {
		const unsubscribe = desktopApi.remoteHosts.onRepairConfirm((incoming) => setRequest(incoming));
		return unsubscribe;
	}, []);

	const run = useCallback(async (action: RemoteHostRepairAction, hostId?: string) => {
		setBusy(true);
		try {
			const result = await desktopApi.remoteHosts.runRepair(action, hostId);
			if (!result.ok) setMessage(t("settings.connections.repair.failed", { code: result.code }));
		} finally {
			setBusy(false);
		}
	}, []);

	if (none && message === null) return null;

	return (
		<section className="mt-3 flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2">
			<strong className="text-body font-semibold text-foreground">{t("settings.connections.repair.title")}</strong>
			<p className="text-label text-muted-foreground">{t("settings.connections.repair.hint")}</p>
			{findings.map((finding) => (
				<div key={finding.reason} className="flex flex-col gap-1">
					<span className="text-label font-medium">{t("settings.connections.repair.reasonPrefix", { reason: finding.reason })}</span>
					{finding.actions.length === 0 ? (
						<span className="text-label text-muted-foreground">{t("settings.connections.repair.noActions")}</span>
					) : (
						<div className="flex flex-wrap gap-2">
							{finding.actions.map((action) =>
								EXECUTABLE.has(action) ? (
									// 目标主机唯一时直接带上；多个候选时逐个列出，不替用户选。
									<Button key={action} size="sm" disabled={busy} onClick={() => void run(action, finding.hostIds[0])}>
										{actionLabel(action)}
									</Button>
								) : (
									<span key={action} className="text-label text-muted-foreground" title={actionHint(action)}>
										{actionLabel(action)}
									</span>
								),
							)}
						</div>
					)}
				</div>
			))}
			<div className="flex items-center gap-2">
				<Button variant="ghost" size="sm" onClick={() => void refresh()}>
					{t("settings.connections.repair.recheck")}
				</Button>
				{message !== null ? <span className="text-label text-muted-foreground">{message}</span> : null}
			</div>
			{request !== null ? (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) void answer(request.requestId, "deny");
					}}
				>
					<DialogContent className="max-w-md">
						<DialogHeader>
							<DialogTitle>{t("settings.connections.repair.confirmTitle")}</DialogTitle>
							<DialogDescription>{actionHint(request.action)}</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-1 text-body">
							<div className="flex items-center justify-between gap-3">
								<span className="text-muted-foreground">{t("settings.connections.repair.confirmAction")}</span>
								<span className="font-medium">{actionLabel(request.action)}</span>
							</div>
							{request.label.length > 0 ? (
								<div className="flex items-center justify-between gap-3">
									<span className="text-muted-foreground">{t("settings.connections.repair.confirmTarget")}</span>
									<span className="font-medium">{request.label}</span>
								</div>
							) : null}
						</div>
						<DialogFooter>
							<Button variant="ghost" disabled={busy} onClick={() => void answer(request.requestId, "deny")}>
								{t("common.cancel")}
							</Button>
							<Button disabled={busy} onClick={() => void answer(request.requestId, "approve")}>
								{t("settings.connections.repair.confirmRun")}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}
		</section>
	);

	async function answer(requestId: string, choice: "approve" | "deny"): Promise<void> {
		setBusy(true);
		try {
			const result = await desktopApi.remoteHosts.answerRepair(requestId, choice);
			if (!result.ok) setMessage(t("settings.connections.repair.failed", { code: result.code }));
		} finally {
			setBusy(false);
			setRequest(null);
			// 修完必须重拉：成功的话原因消失，失败的话原因还在。
			await refresh();
			props.onRepaired();
		}
	}
}
