import { useAtom, useAtomValue } from "jotai";
import { AlertTriangle, FileDown } from "lucide-react";
import { sessionExportRequestAtom } from "../../atoms/session-export-atoms";
import { sessionRecordByIdAtomFamily } from "../../atoms/session-selectors";
import { isElectronRuntime } from "../../desktopApi";
import { useSessionShareExport } from "../../hooks/useSessionShareExport";
import { t } from "../../i18n";
import type { SessionShareOptions } from "../../../../shared/types/sessionExport";
import { Alert, AlertDescription } from "../ui-shadcn/alert";
import { Button } from "../ui-shadcn/button";
import { Checkbox } from "../ui-shadcn/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { Label } from "../ui-shadcn/label";
import { Separator } from "../ui-shadcn/separator";

/** 唯一挂载点：侧栏、Tab 和历史抽屉都只发起稳定 sessionId 的导出请求。 */
export function SessionExportDialogHost() {
	const [request, setRequest] = useAtom(sessionExportRequestAtom);
	return request ? <SessionExportDialog key={request.sessionId} sessionId={request.sessionId} onClose={() => setRequest(null)} /> : null;
}

function SessionExportDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
	const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const state = useSessionShareExport(sessionId, onClose);
	const supported = isElectronRuntime && record?.locator?.kind !== "ssh" && (!record?.backend || record.backend === "pi" || record.backend === "dsh");
	const inventory = state.inventory;
	const fields: Array<{ key: keyof SessionShareOptions; label: string; count?: number; visible?: boolean }> = [
		{ key: "excludeThinking", label: t("sessionShare.excludeThinking"), count: inventory?.thinking },
		{ key: "excludeToolArguments", label: t("sessionShare.excludeToolArguments"), count: inventory?.toolArguments },
		{ key: "excludeToolResults", label: t("sessionShare.excludeToolResults"), count: inventory?.toolResults },
		{ key: "excludeImages", label: t("sessionShare.excludeImages"), count: inventory?.images },
		{ key: "excludeSystemMessages", label: t("sessionShare.excludeSystemMessages"), count: inventory?.systemMessages, visible: (inventory?.systemMessages ?? 0) > 0 },
		{ key: "excludeWorkspace", label: t("sessionShare.excludeWorkspace"), visible: inventory?.workspace !== false },
		{ key: "redactSecrets", label: t("sessionShare.redactSecrets") },
		{ key: "redactPaths", label: t("sessionShare.redactPaths") },
	];
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !state.busy) onClose();
			}}
		>
			<DialogContent
				className="flex max-h-[calc(100vh-64px)] flex-col sm:max-w-[1000px]"
				onInteractOutside={(event) => {
					if (state.busy) event.preventDefault();
				}}
				onEscapeKeyDown={(event) => {
					if (state.busy) event.preventDefault();
				}}
			>
				<DialogHeader>
					<DialogTitle>{t("sessionShare.title")}</DialogTitle>
					<DialogDescription>{t("sessionShare.description")}</DialogDescription>
				</DialogHeader>
				{/* scroll-ok: transient —— 导出对话框的选项与预览两栏，字段固定、随弹窗关闭即销毁，行数不随会话增长。 */}
				{supported ? (
					<div className="grid min-h-0 flex-1 gap-5 overflow-y-auto sm:grid-cols-[260px_minmax(0,1fr)]">
						<div className="flex flex-col gap-3">
							<fieldset className="flex min-w-0 flex-col gap-3" disabled={state.busy}>
								<legend className="mb-3 text-control font-semibold">{t("sessionShare.contents")}</legend>
								{fields
									.filter((field) => field.visible !== false)
									.map((field) => (
										<Label key={field.key} className="flex items-start gap-2 leading-5">
											<Checkbox checked={state.options[field.key]} disabled={state.busy} onCheckedChange={(checked) => state.updateOption(field.key, checked === true)} />
											<span>
												{field.label}
												{field.count !== undefined ? ` (${field.count})` : ""}
											</span>
										</Label>
									))}
							</fieldset>
							<p className="text-caption text-muted-foreground">{t("sessionShare.coverage")}</p>
							{!state.options.excludeImages && <p className="text-caption text-muted-foreground">{t("sessionShare.imageWarning")}</p>}
							<Button variant="outline" disabled={state.busy} onClick={() => void state.prepare()}>
								{state.busy ? t("sessionShare.processing") : t("sessionShare.preview")}
							</Button>
						</div>
						<div className="flex min-h-[320px] min-w-0 flex-col gap-2">
							<h3 className="text-control font-semibold">{t("sessionShare.previewTitle")}</h3>
							{state.preview ? (
								<>
									<p className="text-caption text-muted-foreground" role="status">
										{t("sessionShare.summary", { backend: state.preview.backend, messages: state.preview.inventory.messages, fields: state.preview.redactedFields })}
									</p>
									{/* 脚本/外部加载均不允许；预览只拿 main 生成的已处理静态 HTML。 */}
									<iframe title={t("sessionShare.previewTitle")} sandbox="" srcDoc={state.preview.html} className="min-h-[320px] w-full flex-1 rounded-md border border-border bg-background" />
									{state.preview.truncated && <p className="text-caption text-muted-foreground">{t("sessionShare.partialNotice")}</p>}
								</>
							) : (
								<p className="flex min-h-[320px] items-center justify-center rounded-md border border-border p-6 text-control text-muted-foreground">{t("sessionShare.previewEmpty")}</p>
							)}
						</div>
					</div>
				) : (
					<p className="text-control text-muted-foreground">{t("sessionShare.unsupported")}</p>
				)}
				<Alert>
					<AlertTriangle />
					<AlertDescription>{t("sessionShare.warning")}</AlertDescription>
				</Alert>
				{state.error && (
					<p role="alert" className="text-control text-destructive">
						{state.error}
					</p>
				)}
				{supported && (
					<Label className="flex items-start gap-2 leading-5">
						<Checkbox checked={state.confirmed} disabled={!state.preview || state.busy} onCheckedChange={(checked) => state.setConfirmed(checked === true)} />
						<span>{t("sessionShare.confirm")}</span>
					</Label>
				)}
				<Separator />
				<DialogFooter>
					<Button variant="ghost" disabled={state.busy} onClick={() => void state.exportComplete()}>
						{t("sessionShare.complete")}
					</Button>
					<Button variant="outline" disabled={state.busy} onClick={onClose}>
						{t("common.cancel")}
					</Button>
					{supported && (
						<Button disabled={state.busy || !state.preview || !state.confirmed} onClick={() => void state.save()}>
							<FileDown data-icon="inline-start" />
							{t("sessionShare.save")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
