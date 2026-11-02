import { useState } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { useRemoteFileDraft } from "../../hooks/useRemoteFileDraft";
import type { ProjectServices } from "../../services/projectServiceContracts";
import { imageMimeForPath } from "../../utils/imageMime";
import { RemoteImagePreview } from "./RemoteImagePreview";
import { t } from "../../i18n";
import { CodeMirrorEditor } from "../app/CodeMirrorEditor";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";

/**
 * 复用CodeMirror的远端编辑宿主；不触达本机files API，不自动保存或自动丢弃冲突草稿。
 *
 * 图片走独立预览：远端文本通道拒绝非 UTF-8 内容，把 PNG 喂给草稿编辑器只会得到
 * `REMOTE_FILE_NOT_TEXT`——那不是"文件坏了"，是"这个文件不该用编辑器打开"。
 */
export function RemoteFileEditor(props: { services: ProjectServices; path: string }) {
	if (imageMimeForPath(props.path) !== undefined) return <RemoteImagePreview projectId={props.services.projectId} path={props.path} />;
	return <RemoteTextFileEditor services={props.services} path={props.path} />;
}

function RemoteTextFileEditor(props: { services: ProjectServices; path: string }) {
	const { draft, loadError, change, save, reload, dirty } = useRemoteFileDraft(props.services, props.path);
	const [confirmReload, setConfirmReload] = useState(false);
	const code = loadError ?? draft?.errorCode;
	const errorText =
		code === "SSH_HOST_NOT_READY" || code === "SSH_HOST_DISCONNECTED"
			? t("remoteFile.connection")
			: code === "REMOTE_FILE_DRAFT_TOO_LARGE"
				? t("remoteFile.inputTooLarge")
				: code === "REMOTE_FILE_CHANGED"
					? t("remoteFile.conflict")
					: code === "REMOTE_FILE_VERSION_INVALID"
						? t("remoteFile.expired")
						: code === "PROJECT_SERVICE_VERSION_REQUIRED"
							? t("remoteFile.expired")
							: code === "PROJECT_SERVICE_GENERATION_STALE"
								? t("remoteFile.connection")
								: code === "REMOTE_FILE_TOO_LARGE"
									? t("remoteFile.tooLarge")
									: code === "REMOTE_FILE_NOT_TEXT" || code === "REMOTE_FILE_LINE_ENDING_UNSUPPORTED"
										? t("remoteFile.notText")
										: code === "REMOTE_FILE_NOT_FOUND"
											? t("remoteFile.notFound")
											: code === "REMOTE_FILE_PERMISSION_DENIED"
												? t("remoteFile.permission")
												: code === "REMOTE_FILE_PLATFORM_UNSUPPORTED"
													? t("remoteFile.platform")
													: code === "REMOTE_FILE_DRAFT_LIMIT"
														? t("remoteFile.draftLimit")
														: code
															? t("remoteFile.failure", { code })
															: null;
	return (
		<section
			className="flex min-h-0 flex-1 flex-col overflow-hidden"
			aria-label={t("remoteFile.editor")}
			onKeyDownCapture={(event) => {
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
					event.preventDefault();
					event.stopPropagation();
					void save();
				}
			}}
		>
			<div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/40 px-2">
				<strong className="min-w-0 flex-1 truncate font-mono text-label">{props.path}</strong>
				<span className="text-label text-muted-foreground">{draft?.phase === "saving" ? t("remoteFile.saving") : dirty ? t("remoteFile.unsaved") : draft?.phase === "ready" ? t("remoteFile.saved") : ""}</span>
				<Button size="icon-sm" variant="ghost" aria-label={t("remoteFile.save")} title={t("remoteFile.save")} disabled={!dirty || draft?.phase !== "ready" || draft.blocked} onClick={() => void save()}>
					<Save className="size-4" />
				</Button>
				<Button
					size="icon-sm"
					variant="ghost"
					aria-label={t("remoteFile.reload")}
					title={t("remoteFile.reload")}
					disabled={draft?.phase === "saving" || draft?.phase === "loading"}
					onClick={() => {
						if (dirty) setConfirmReload(true);
						else void reload();
					}}
				>
					<RefreshCw className="size-4" />
				</Button>
			</div>
			{/* 脏草稿在 rename/delete 后保留并标 stale（§5.7）：保存会失败，但绝不自动丢弃用户输入。 */}
			{draft?.stale ? <p className="text-label text-muted-foreground">{t("remoteFileEntry.staleDraft")}</p> : null}
			{errorText ? (
				<p role="alert" className="text-label text-destructive">
					{errorText}
				</p>
			) : null}
			{draft?.phase === "loading" ? <Loader2 className="size-4 animate-pideck-spin" aria-label={t("remoteFile.loading")} /> : null}
			{draft && (draft.phase === "ready" || draft.phase === "saving" || dirty) ? (
				<div className="min-h-0 flex-1 overflow-hidden">
					<CodeMirrorEditor key={draft.rejectedEdits ?? 0} value={draft.content} lineSeparator={draft.savedContent.includes("\r\n") ? "\r\n" : "\n"} onChange={change} language={props.path.split(".").at(-1)} readOnly={draft.phase === "loading"} />
				</div>
			) : null}
			<Dialog open={confirmReload} onOpenChange={setConfirmReload}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("remoteFile.reloadTitle")}</DialogTitle>
						<DialogDescription>{t("remoteFile.reloadBody")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setConfirmReload(false)}>
							{t("remoteFile.keepDraft")}
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								setConfirmReload(false);
								void reload();
							}}
						>
							{t("remoteFile.discardReload")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}
