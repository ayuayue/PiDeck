import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Progress } from "../ui-shadcn/progress";
import { formatRemoteTransferBytes, isRemoteTransferActive, remoteTransferPercent, type RemoteTransferUiItem } from "../../utils/remoteProjectTransferState";

function operationText(item: RemoteTransferUiItem): string {
	return t(item.operation === "upload" ? "project.remote.transferUpload" : "project.remote.transferDownload");
}

function statusText(item: RemoteTransferUiItem): string {
	if (item.phase === "starting") return t("project.remote.transferPreparing");
	if (item.phase === "running") {
		return item.total > 0 ? t("project.remote.transferProgress", { transferred: formatRemoteTransferBytes(item.transferred), total: formatRemoteTransferBytes(item.total) }) : t("project.remote.transferTransferred", { transferred: formatRemoteTransferBytes(item.transferred) });
	}
	if (item.phase === "cancelling") return t("project.remote.transferCancelling");
	if (item.phase === "succeeded") return t("project.remote.transferSucceeded");
	if (item.phase === "partial") return t("project.remote.transferPartial", { count: item.failedCount ?? 0 });
	if (item.phase === "cancelled") return t("project.remote.transferCancelled");
	if (item.phase === "unknown") return t("project.remote.transferUnknown", { code: item.code ?? "REMOTE_TRANSFER_RESULT_UNKNOWN" });
	return t("project.remote.transferFailed", { code: item.code ?? "REMOTE_TRANSFER_FAILED" });
}

export function RemoteProjectTransferStatus(props: { items: readonly RemoteTransferUiItem[]; onCancel: (id: number) => void; onDismiss: (id: number) => void }) {
	if (props.items.length === 0) return null;
	return (
		<section data-testid="remote-transfer-status" aria-live="polite" className="flex flex-col gap-1.5">
			{props.items.map((item) => {
				const active = isRemoteTransferActive(item.phase);
				const percent = remoteTransferPercent(item);
				const operation = operationText(item);
				const status = statusText(item);
				return (
					<div key={item.id} data-testid={`remote-transfer-${item.id}`} data-phase={item.phase} className="rounded-md border border-border/50 bg-bg-muted/40 px-2 py-1.5">
						<div className="flex min-w-0 items-center gap-1.5">
							{active ? (
								<Loader2 className="size-3.5 shrink-0 animate-pideck-spin text-muted-foreground" aria-hidden="true" />
							) : item.phase === "succeeded" ? (
								<Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />
							) : (
								<AlertTriangle className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
							)}
							<span className="shrink-0 text-label font-medium">{operation}</span>
							<span className="min-w-0 flex-1 truncate text-label text-muted-foreground">{status}</span>
							{active ? (
								<Button type="button" size="xs" variant="ghost" data-testid={`remote-transfer-cancel-${item.id}`} disabled={item.phase === "cancelling"} onClick={() => props.onCancel(item.id)}>
									{t(item.phase === "cancelling" ? "project.remote.transferCancellingAction" : "project.remote.transferCancel")}
								</Button>
							) : (
								<Button type="button" size="icon-xs" variant="ghost" data-testid={`remote-transfer-dismiss-${item.id}`} aria-label={t("project.remote.transferDismiss")} title={t("project.remote.transferDismiss")} onClick={() => props.onDismiss(item.id)}>
									<X className="size-3" aria-hidden="true" />
								</Button>
							)}
						</div>
						{active ? <Progress className="mt-1.5" value={percent ?? 0} aria-label={t("project.remote.transferProgressAria", { operation })} /> : null}
					</div>
				);
			})}
		</section>
	);
}
