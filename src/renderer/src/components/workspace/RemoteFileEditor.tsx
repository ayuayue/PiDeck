import { lazy, Suspense, useState } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { useRemoteFileDraft } from "../../hooks/useRemoteFileDraft";
import type { ProjectServices } from "../../services/projectServiceContracts";
import { imageMimeForPath } from "../../utils/imageMime";
import { RemoteImagePreview } from "./RemoteImagePreview";
import { t } from "../../i18n";
// CodeMirror 静态链（DrawerSurface → RemoteProjectPanel → 本文件）会把它拉进主 chunk：
// 抽屉默认收起，编辑器却随启动解析。与 FileDiffViewer 同款懒加载，首次打开远端文件才拉取。
const CodeMirrorEditor = lazy(() => import("../app/CodeMirrorEditor").then((m) => ({ default: m.CodeMirrorEditor })));
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";

/**
 * 远端文件预览/编辑的宿主外框（抽屉文件栏的底部区域）。
 *
 * 谁还会走到这里：只剩**兜底宿主**——宿主没有注入中间栏入口时（`remoteFileOpenPlan` 的
 * `hasWorkbench=false`）才在面板内预览。正常入口（文件抽屉、远端空态浏览）一律与本机文件同路：
 * 进中间栏阅读面，二进制读通道见 `files:read-base64` 的远端分支。
 *
 * 为什么它必须自己拿高度而不能只写 `flex-1`：宿主是滚动区（`.files-panel`）里的兄弟，目录树
 * 一旦超过抽屉高度，负剩余空间就把它压成 0 高——用户点远端文件看到的是「什么都没发生」。
 * 贴底悬挂（sticky）+ 自带占比与下限后，树再长也总能看见预览；不透明底色避免滑过的树行透出来。
 */
export function RemoteFilePreviewPane(props: { services: ProjectServices; path: string; canWrite?: boolean }) {
	// scroll-ok: bounded —— 单文件预览宿主，内部只有一个 CodeMirror 编辑器，没有行列表可虚拟化；高度是固定占比 + 下限。
	return (
		<div data-testid="remote-file-preview" className="sticky bottom-0 z-20 flex h-[40%] min-h-40 shrink-0 flex-col overflow-y-auto border-t border-border/40 bg-bg-page-raised pt-2">
			<RemoteFileEditor services={props.services} path={props.path} canWrite={props.canWrite} />
		</div>
	);
}

/**
 * 复用CodeMirror的远端编辑宿主；不触达本机files API，不自动保存或自动丢弃冲突草稿。
 *
 * 图片走独立预览：远端文本通道拒绝非 UTF-8 内容，把 PNG 喂给草稿编辑器只会得到
 * `REMOTE_FILE_NOT_TEXT`——那不是"文件坏了"，是"这个文件不该用编辑器打开"。
 */
export function RemoteFileEditor(props: { services: ProjectServices; path: string; canWrite?: boolean }) {
	if (imageMimeForPath(props.path) !== undefined) return <RemoteImagePreview projectId={props.services.projectId} path={props.path} />;
	// 缺省 true：只有明确声明「不能写」的调用方才降级，既有调用方零行为变化。
	return <RemoteTextFileEditor services={props.services} path={props.path} canWrite={props.canWrite ?? true} />;
}

/**
 * Ctrl/Cmd+S 的处理结论：只读时仍吞掉浏览器默认动作（不弹「另存网页」），但绝不发保存。
 * 抽成纯函数，让「只读时快捷键不保存」可以离开渲染树单测。
 */
/**
 * 编辑器只读门禁：能力位关闭，或草稿仍在加载（内容还没到，输入会被覆盖）。
 * 抽成纯函数，让懒加载包装（Suspense 只渲染 fallback）也能被单测钉住。
 */
export function remoteFileEditorReadOnly(canWrite: boolean, phase: string): boolean {
	return !canWrite || phase === "loading";
}

export function remoteFileSaveShortcut(event: { ctrlKey: boolean; metaKey: boolean; key: string }, canWrite: boolean): "save" | "swallow" | "pass" {
	if (!((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s")) return "pass";
	return canWrite ? "save" : "swallow";
}

function RemoteTextFileEditor(props: { services: ProjectServices; path: string; canWrite: boolean }) {
	const { draft, loadError, change, save, reload, dirty } = useRemoteFileDraft(props.services, props.path);
	const { canWrite } = props;
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
				const action = remoteFileSaveShortcut(event, canWrite);
				if (action === "pass") return;
				// 只读也拦下默认动作：浏览器「另存网页」不是这里要的保存。
				event.preventDefault();
				event.stopPropagation();
				if (action === "save") void save();
			}}
		>
			<div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/40 px-2">
				<strong className="min-w-0 flex-1 truncate font-mono text-label">{props.path}</strong>
				<span className="text-label text-muted-foreground">{draft?.phase === "saving" ? t("remoteFile.saving") : dirty ? t("remoteFile.unsaved") : draft?.phase === "ready" ? t("remoteFile.saved") : ""}</span>
				<Button size="icon-sm" variant="ghost" aria-label={t("remoteFile.save")} title={t("remoteFile.save")} disabled={!canWrite || !dirty || draft?.phase !== "ready" || draft.blocked} onClick={() => void save()}>
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
			{/* 能力位只读：先说清原因，避免「能打字、点了保存才拿到稳定码」。 */}
			{canWrite ? null : (
				<p data-testid="remote-file-read-only" className="text-label text-muted-foreground">
					{t("remoteFile.readOnlyReason")}
				</p>
			)}
			{errorText ? (
				<p role="alert" className="text-label text-destructive">
					{errorText}
				</p>
			) : null}
			{draft?.phase === "loading" ? <Loader2 className="size-4 animate-pideck-spin" aria-label={t("remoteFile.loading")} /> : null}
			{draft && (draft.phase === "ready" || draft.phase === "saving" || dirty) ? (
				<div className="min-h-0 flex-1 overflow-hidden">
					<Suspense
						fallback={
							<div className="flex h-full items-center justify-center">
								<Loader2 className="size-4 animate-pideck-spin" aria-label={t("remoteFile.loading")} />
							</div>
						}
					>
						<CodeMirrorEditor key={draft.rejectedEdits ?? 0} value={draft.content} lineSeparator={draft.savedContent.includes("\r\n") ? "\r\n" : "\n"} onChange={change} language={props.path.split(".").at(-1)} readOnly={remoteFileEditorReadOnly(canWrite, draft.phase)} />
					</Suspense>
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
