import { useAtom, useSetAtom } from "jotai";
import { useCallback, useState } from "react";import type { TranslationKey } from "../../i18n/rendererCopy.zh-CN";
import { openSettingsAtom } from "../../atoms";
import { remoteEnrollDialogOpenAtom } from "../../atoms/remote-project-atoms";
import { desktopApi } from "../../desktopApi";
import { REMOTE_ENROLL_CONFIRM_EXPIRED, REMOTE_ENROLL_REQUEST_FAILED, REMOTE_HOST_STORE_NEEDS_REPAIR, type RemoteProjectEnrollState, useRemoteProjectEnroll } from "../../hooks/useRemoteProjectEnroll";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { Input } from "../ui-shadcn/input";
import { Label } from "../ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { DirectoryBrowser, type DirectoryLoadResult } from "./DirectoryBrowser";
import { isValidNewLeaf, joinRemotePath } from "./remoteDirectoryPath";

/** 新建空目录模式下需要专门解释的稳定码（其余沿用登记域的通用错误文案）。 */
const CREATE_ERROR_KEYS: Partial<Record<string, TranslationKey>> = {
	REMOTE_PROJECT_TARGET_EXISTS: "sidebar.remoteEnroll.createExists",
	REMOTE_PROJECT_PARENT_NOT_FOUND: "sidebar.remoteEnroll.parentMissing",
	REMOTE_PROJECT_CREATE_FAILED: "sidebar.remoteEnroll.createFailed",
	REMOTE_PROJECT_CREATE_UNCONFIRMED: "sidebar.remoteEnroll.createUnconfirmed",
	REMOTE_PROJECT_ROOT_CHANGED: "sidebar.remoteEnroll.createFailed",
};

/**
 * 远端项目登记弹框：全应用唯一挂载点（App 装配），侧栏「+」与空态引导只写开关 atom。
 *
 * 产品行为（交接文档 §3 B + 文件管理 §7）：
 * - 「使用已有目录」（默认，行为不变）：选主机 → 输入绝对路径 → 展示 canonical 路径确认 → 登记；
 * - 「新建空目录」：输入一个当前不存在的绝对路径 → 确认框展示父目录/将创建的目录 → main 创建、复核、登记；
 * - 无「已验证且未禁用」主机时引导去设备设置，而不是给一个注定失败的输入框；
 * - 登记成功后由宿主刷新项目清单并选中返回的 projectId，本弹框不创建任何本地会话。
 *
 * 状态机、请求关联与 IPC 错误处理都在 useRemoteProjectEnroll；这里只做呈现与事件转发。
 */
function errorText(state: RemoteProjectEnrollState): string | null {
	if (state.errorCode === null) return null;
	if (state.errorCode === REMOTE_ENROLL_REQUEST_FAILED) return t("sidebar.remoteEnroll.requestFailed");
	if (state.errorCode === REMOTE_ENROLL_CONFIRM_EXPIRED) return t("sidebar.remoteEnroll.expired");
	if (state.mode === "create" && CREATE_ERROR_KEYS[state.errorCode] !== undefined) return t(CREATE_ERROR_KEYS[state.errorCode] as TranslationKey, { code: state.errorCode });
	// 同一 errorCode 在不同阶段含义不同：确认阶段是「回答失败」，路径阶段是「解析失败」。
	if (state.stage === "confirm" || state.stage === "create-confirm") return t("sidebar.remoteEnroll.answerFailed", { code: state.errorCode });
	if (state.stage === "unavailable") return t("sidebar.remoteEnroll.loadFailed", { code: state.errorCode });
	return t("sidebar.remoteEnroll.resolveFailed", { code: state.errorCode });
}

/** 不可用态的三类原因分开说：功能未启用 / 存储需修复 / 清单读取失败。 */
function unavailableText(state: RemoteProjectEnrollState): string {
	if (state.errorCode === "REMOTE_FEATURE_DISABLED") return t("sidebar.remoteEnroll.featureDisabled");
	if (state.errorCode === REMOTE_HOST_STORE_NEEDS_REPAIR) return t("sidebar.remoteEnroll.needsRepair");
	return errorText(state) ?? t("sidebar.remoteEnroll.loadFailed", { code: state.errorCode ?? "" });
}

export function RemoteProjectEnrollDialog(props: { onEnrolled: (projectId: string) => void }) {
	const [open, setOpen] = useAtom(remoteEnrollDialogOpenAtom);
	const openSettings = useSetAtom(openSettingsAtom);
	const enroll = useRemoteProjectEnroll({
		open,
		onClose: () => setOpen(false),
		// 引导去设备设置：关掉弹框再深链到「连接」页，避免两个弹层叠在一起。
		onOpenDeviceSettings: () => {
			setOpen(false);
			openSettings({ tab: "connections" });
		},
		onEnrolled: props.onEnrolled,
	});
	const { state } = enroll;
	// 目录浏览器与 WSL 共用同一组件（DirectoryBrowser）：这里只负责把 SSH 的 IPC 结果与错误码翻译成它的口径。
	const listHostDirs = useCallback(async (hostId: string, path?: string): Promise<DirectoryLoadResult> => {
		const result = await desktopApi.remoteHosts.listDirs(hostId, path);
		return result.ok ? { ok: true, page: { path: result.path, entries: result.entries, truncated: result.truncated } } : { ok: false, code: result.code };
	}, []);
	const describeDirError = useCallback((code: string) => {
		if (code === "SSH_HOST_NOT_READY" || code === "SSH_HOST_DISCONNECTED" || code === "SSH_CONNECTION_FAILED") return t("sidebar.remoteEnroll.dirNotConnected");
		if (code === "REMOTE_LIST_DIRS_NOT_A_DIRECTORY") return t("sidebar.remoteEnroll.dirNotADirectory");
		return t("sidebar.remoteEnroll.dirFailed", { code });
	}, []);
	// 新建空目录模式：浏览器只选父目录，叶名单独输入；两者合成后才交给登记流程。
	const [createParent, setCreateParent] = useState("");
	const [leaf, setLeaf] = useState("");
	const createPathReady = createParent !== "" && isValidNewLeaf(leaf);
	const syncCreatePath = (parent: string, nextLeaf: string) => {
		// 叶名还没填好时不能提交一个半成品路径（join(parent, "") 会带尾斜杠）。
		enroll.setPath(parent !== "" && isValidNewLeaf(nextLeaf) ? joinRemotePath(parent, nextLeaf) : "");
	};
	const chooseMode = (mode: "existing" | "create") => {
		if (mode === "create") {
			setCreateParent("");
			setLeaf("");
			enroll.setPath("");
		} else {
			setLeaf("");
		}
		enroll.selectMode(mode);
	};
	if (!open) return null;
	const error = errorText(state);
	const formLocked = state.busy || state.stage === "awaiting-confirm";
	const hostLabel = state.request === null ? "" : (state.hosts.find((host) => host.id === state.request?.hostId)?.label ?? state.request.hostId);
	const createHostLabel = state.createRequest === null ? "" : (state.hosts.find((host) => host.id === state.createRequest?.hostId)?.label ?? state.createRequest.hostId);
	const creating = state.stage === "create-confirm";
	const confirming = state.stage === "confirm";
	const title = creating ? t("sidebar.remoteEnroll.createConfirmTitle") : confirming ? t("sidebar.remoteEnroll.confirmTitle") : t("sidebar.remoteEnroll.title");
	const description = creating ? t("sidebar.remoteEnroll.createConfirmBody", { host: createHostLabel, path: state.createRequest?.requestedPath ?? "" }) : confirming ? t("sidebar.remoteEnroll.confirmHint") : t("sidebar.remoteEnroll.hint");
	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next) enroll.close();
			}}
		>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{state.stage === "loading" ? <p className="py-3 text-body text-muted-foreground">{t("sidebar.remoteEnroll.loading")}</p> : null}

				{state.stage === "unavailable" ? (
					<div className="flex flex-col gap-3 py-1">
						<p className="text-body text-muted-foreground">{unavailableText(state)}</p>
						<Button variant="secondary" size="sm" className="self-start" onClick={enroll.goToDeviceSettings}>
							{t("sidebar.remoteEnroll.openDeviceSettings")}
						</Button>
					</div>
				) : null}

				{/* 无可用主机不是错误，是一条「先去设置」的路径：不给注定失败的输入框。 */}
				{state.stage === "no-host" ? (
					<div className="flex flex-col gap-3 py-1">
						<p className="text-body text-muted-foreground">{t("sidebar.remoteEnroll.noHost")}</p>
						<Button variant="secondary" size="sm" className="self-start" onClick={enroll.goToDeviceSettings}>
							{t("sidebar.remoteEnroll.openDeviceSettings")}
						</Button>
					</div>
				) : null}

				{state.stage === "path" || state.stage === "awaiting-confirm" ? (
					<div className="flex flex-col gap-3 py-1">
						<fieldset className="grid gap-1.5">
							<legend className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.modeLabel")}</legend>
							<div className="flex flex-wrap gap-4 text-body">
								<label htmlFor="remote-enroll-mode-existing" className="flex items-center gap-1.5">
									<input id="remote-enroll-mode-existing" data-testid="remote-enroll-mode-existing" type="radio" name="remote-enroll-mode" checked={state.mode === "existing"} disabled={formLocked} onChange={() => chooseMode("existing")} />
									{t("sidebar.remoteEnroll.modeExisting")}
								</label>
								<label htmlFor="remote-enroll-mode-create" className="flex items-center gap-1.5">
									<input id="remote-enroll-mode-create" data-testid="remote-enroll-mode-create" type="radio" name="remote-enroll-mode" checked={state.mode === "create"} disabled={formLocked} onChange={() => chooseMode("create")} />
									{t("sidebar.remoteEnroll.modeCreate")}
								</label>
							</div>
						</fieldset>
						<div className="grid gap-1.5">
							<Label htmlFor="remote-enroll-host">{t("sidebar.remoteEnroll.host")}</Label>
							<Select value={state.hostId ?? ""} onValueChange={enroll.selectHost} disabled={formLocked}>
								<SelectTrigger id="remote-enroll-host">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{state.hosts.map((host) => (
										<SelectItem key={host.id} value={host.id}>
											<span className="flex min-w-0 items-center gap-1.5">
												<span className="min-w-0 truncate">{host.label}</span>
												{/* 主机类型标记：远端登记只能选 SSH 主机，标出类型避免与 WSL 档案混淆。 */}
												<span className="shrink-0 rounded border border-border-subtle px-1 text-micro text-muted-foreground">{t("settings.connections.ssh.badge")}</span>
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						{state.hostId === undefined ? null : state.mode === "create" ? (
							<>
								<div className="grid gap-1.5">
									<Label>{t("sidebar.remoteEnroll.createParent")}</Label>
									<DirectoryBrowser
										key={`create-${state.hostId}`}
										value={createParent}
										disabled={formLocked}
										load={(path) => listHostDirs(state.hostId!, path)}
										describeError={describeDirError}
										onChange={(parent) => {
											setCreateParent(parent);
											syncCreatePath(parent, leaf);
										}}
									/>
								</div>
								<div className="grid gap-1.5">
									<Label htmlFor="remote-enroll-leaf">{t("sidebar.remoteEnroll.leaf")}</Label>
									<Input
										id="remote-enroll-leaf"
										placeholder={t("sidebar.remoteEnroll.leafPlaceholder")}
										value={leaf}
										disabled={formLocked}
										onChange={(event) => {
											const nextLeaf = event.target.value;
											setLeaf(nextLeaf);
											syncCreatePath(createParent, nextLeaf);
										}}
									/>
									{leaf.length > 0 && !isValidNewLeaf(leaf) ? <p className="text-label text-destructive">{t("sidebar.remoteEnroll.badLeaf")}</p> : null}
								</div>
								<p className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.createHint")}</p>
							</>
						) : (
							<div className="grid gap-1.5">
								<Label>{t("sidebar.remoteEnroll.path")}</Label>
								<DirectoryBrowser key={`existing-${state.hostId}`} value={state.path} disabled={formLocked} load={(path) => listHostDirs(state.hostId!, path)} describeError={describeDirError} onChange={enroll.setPath} />
							</div>
						)}
						{state.stage === "awaiting-confirm" ? <p className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.awaitingConfirm")}</p> : null}
						{error !== null ? <p className="text-label text-muted-foreground">{error}</p> : null}
						<DialogFooter>
							<Button variant="ghost" onClick={enroll.close}>
								{t("common.cancel")}
							</Button>
							<Button disabled={formLocked || state.hostId === undefined || (state.mode === "create" ? !createPathReady : state.path.trim() === "")} onClick={() => void enroll.submit()}>
								{t("sidebar.remoteEnroll.resolve")}
							</Button>
						</DialogFooter>
					</div>
				) : null}

				{confirming && state.request !== null ? (
					<div className="flex flex-col gap-3 py-1">
						<div className="flex items-center justify-between gap-3 text-body">
							<span className="text-muted-foreground">{t("sidebar.remoteEnroll.host")}</span>
							<span className="font-medium">{hostLabel}</span>
						</div>
						<div className="flex flex-col gap-0.5">
							<span className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.requested")}</span>
							<span className="select-all break-all font-mono text-label">{state.request.requestedPath}</span>
						</div>
						{/* canonical 才是真正会被 confinement 的目录，两者不同时必须让用户看见。 */}
						<div className="flex flex-col gap-0.5">
							<span className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.canonical")}</span>
							<span className="select-all break-all font-mono text-label">{state.request.canonicalPath}</span>
						</div>
						{state.request.canonicalPath !== state.request.requestedPath ? <p className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.redirected")}</p> : null}
						{error !== null ? <p className="text-label text-muted-foreground">{error}</p> : null}
						<DialogFooter>
							<Button variant="ghost" disabled={state.busy} onClick={() => void enroll.answer("deny")}>
								{t("common.cancel")}
							</Button>
							<Button disabled={state.busy} onClick={() => void enroll.answer("approve")}>
								{t("sidebar.remoteEnroll.confirmUse")}
							</Button>
						</DialogFooter>
					</div>
				) : null}

				{creating && state.createRequest !== null ? (
					<div className="flex flex-col gap-3 py-1">
						<div className="flex items-center justify-between gap-3 text-body">
							<span className="text-muted-foreground">{t("sidebar.remoteEnroll.host")}</span>
							<span className="font-medium">{createHostLabel}</span>
						</div>
						{/* 创建确认必须把父目录与叶目录分开显示：用户确认的是「将创建什么」，不是一条输入。 */}
						<div className="flex flex-col gap-0.5">
							<span className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.createParent")}</span>
							<span className="select-all break-all font-mono text-label">{state.createRequest.parentPath}</span>
						</div>
						<div className="flex flex-col gap-0.5">
							<span className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.createLeaf")}</span>
							<span className="select-all break-all font-mono text-label">{state.createRequest.leaf}</span>
						</div>
						<div className="flex flex-col gap-0.5">
							<span className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.path")}</span>
							<span className="select-all break-all font-mono text-label">{state.createRequest.requestedPath}</span>
						</div>
						{error !== null ? <p className="text-label text-muted-foreground">{error}</p> : null}
						<DialogFooter>
							<Button variant="ghost" disabled={state.busy} onClick={() => void enroll.answer("deny")}>
								{t("common.cancel")}
							</Button>
							<Button disabled={state.busy} onClick={() => void enroll.answer("approve")}>
								{t("sidebar.remoteEnroll.createConfirmAction")}
							</Button>
						</DialogFooter>
					</div>
				) : null}

				{state.stage === "enrolled" ? (
					<div className="flex flex-col gap-3 py-1">
						<p className="text-body font-medium text-foreground">{t("sidebar.remoteEnroll.enrolled")}</p>
						<p className="text-body text-muted-foreground">{t("sidebar.remoteEnroll.enrolledHint")}</p>
						<DialogFooter>
							<Button onClick={enroll.close}>{t("sidebar.remoteEnroll.done")}</Button>
						</DialogFooter>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
