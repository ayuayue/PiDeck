import { useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Pencil, Plus, Server, TerminalSquare, Trash2 } from "lucide-react";
import { desktopApi } from "../../../desktopApi";
import { wslProjectPickerAtom } from "../../../atoms/wsl-project-atoms";
import { t } from "../../../i18n";
import { cn } from "../../../lib/utils";
import { REMOTE_HOST_TONE_DOT_CLASS, resolveRemoteHostConnectionTone } from "../../../utils/remoteHostIdentity";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { AddHostDialog } from "./AddHostDialog";
import type { AddHostEditSeed } from "./AddHostDialog";
import { RemoteConnectionProgressDialog } from "./RemoteConnectionProgressDialog";
import { RepairPanel } from "./RepairPanel";
import { RemoteProjectTrustPanel } from "./RemoteProjectTrustPanel";
import type { RemoteHostConnectionState, RemoteHostDiagnosticEntry, RemoteHostListItem } from "../../../../../shared/types/remoteHost";
import type { WslHostListItem } from "../../../../../shared/types/wslHost";
import { detectRendererPlatform } from "../../../lib/detectRendererPlatform";
import { isLiveHostState } from "../../../../../shared/projectCapabilities";

/**
 * 设置 → 连接：远端主机列表 + 连接开关 + 状态/诊断。
 *
 * 交互模型对齐成熟做法（Codex 的 SSH 面板）：每行只有「名字 + 一个状态点 + 一句人话」，
 * 复杂概念（fingerprint、端口、bootstrap、helper）不出现在列表里——它们属于诊断，用户
 * 需要排查时才展开。目标是「一眼看出哪台连上了、点一下能连」。
 *
 * 本面板只做启用/停用和只读诊断；添加主机（扫描 ~/.ssh/config + 指纹确认）是后续步骤，
 * 因此这里没有「添加」按钮——不给用户一个点不通的入口。
 *
 * 状态语义（设计文档 §10）：这里是**主机连接状态**，与 Agent 的 send state 是两回事，
 * 主机 ready 不代表每个 Agent runtime ready，两者不得混成一个指示灯。
 */
export function ConnectionsTab() {
	const [hosts, setHosts] = useState<RemoteHostListItem[]>([]);
	const [states, setStates] = useState<Record<string, RemoteHostConnectionState>>({});
	const [busy, setBusy] = useState<Record<string, boolean>>({});
	const [message, setMessage] = useState<string | null>(null);
	const [diagnostics, setDiagnostics] = useState<Record<string, RemoteHostDiagnosticEntry[]>>({});
	const [adding, setAdding] = useState(false);
	/** 正在编辑的主机初值；加载失败时保留稳定码，不打开一个空表单。 */
	const [editing, setEditing] = useState<AddHostEditSeed | null>(null);
	const [editLoading, setEditLoading] = useState<string | null>(null);
	/** 当前正在展示进度的那次连接；errorCode 只来自这次 connect 的结果。 */
	const [progress, setProgress] = useState<{ hostId: string; label: string; errorCode: string | null } | null>(null);
	/** 每台主机最近一次 connect 的稳定失败码；成功后清除，用于行内重试。 */
	const [failures, setFailures] = useState<Record<string, string>>({});
	/** 待确认的移除目标：删除 profile/pin 属于破坏性动作，必须先确认。 */
	const [removing, setRemoving] = useState<RemoteHostListItem | null>(null);
	const [removingBusy, setRemovingBusy] = useState(false);
	const [removeError, setRemoveError] = useState<string | null>(null);
	// WSL 档案：只在 Windows 出现；列表只读写本机清单，不连接发行版。
	const wslSupported = detectRendererPlatform() === "win32";
	const [wslHosts, setWslHosts] = useState<WslHostListItem[]>([]);
	const [wslError, setWslError] = useState<string | null>(null);
	const [addingWsl, setAddingWsl] = useState(false);
	const [removingWsl, setRemovingWsl] = useState<WslHostListItem | null>(null);
	const [wslRemoveBusy, setWslRemoveBusy] = useState(false);
	const [wslRemoveError, setWslRemoveError] = useState<string | null>(null);
	// 「添加项目」交给 App 挂载的 WSL 目录选择器：这里只递档案 id，不自己开系统对话框。
	const openWslProjectPicker = useSetAtom(wslProjectPickerAtom);
	/** 取消/重试会换代：旧 connect 的迟到结果不得回写新一次的状态。 */
	const attemptRef = useRef(0);

	/**
	 * 订阅连接状态推送。
	 *
	 * `connect()` 只返回它当时到达的状态，之后的迁移（degraded、重连、ready 之后的 shutdown）只有
	 * 推送能带来。实跑时连接确实到达了 ready，界面却显示「已离线」——因为界面只看返回值。
	 * 同样必须退订：窗口销毁后继续收推送会让「连接状态」脱离用户看得见的上下文。
	 */
	useEffect(() => {
		const unsubscribe = desktopApi.remoteHosts.onStateChange(({ hostId, state }) => {
			setStates((current) => ({ ...current, [hostId]: state }));
		});
		return unsubscribe;
	}, []);

	/** 拉取主机目录。功能未启用、目录不可读等都以稳定码返回，转成人话提示而不是抛错。 */
	const refresh = useCallback(async () => {
		const result = await desktopApi.remoteHosts.list();
		if (!result.ok) {
			// REMOTE_FEATURE_DISABLED 是能力下线的稳定状态，不是请求异常。
			setMessage(result.code === "REMOTE_FEATURE_DISABLED" ? t("settings.connections.disabled") : t("settings.connections.listUnavailable"));
			setHosts([]);
			return;
		}
		setMessage(null);
		setHosts(result.hosts);
		// 重新挂载时没有历史推送可重放：用列表带回的状态快照补齐，否则已连接的主机会显示成「未连接」。
		if (result.states !== undefined) setStates((current) => ({ ...current, ...result.states }));
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const refreshWsl = useCallback(async () => {
		if (!wslSupported) return;
		const result = await desktopApi.remoteHosts.listWslHosts();
		if (!result.ok) {
			setWslHosts([]);
			setWslError(t("settings.connections.wsl.remove.failed", { code: result.code }));
			return;
		}
		setWslError(null);
		setWslHosts(result.hosts);
	}, [wslSupported]);

	useEffect(() => {
		void refreshWsl();
	}, [refreshWsl]);

	/**
	 * 用该档案添加项目：打开内置 WSL 目录选择器（App 唯一挂载点），主进程按档案写入 distro/user/hostId。
	 * 不再走系统「打开文件夹」——它只能按 Windows 身份访问 \\wsl.localhost，发行版内目录会报「无法访问网络资源」。
	 */
	const addWslProject = useCallback(
		(host: WslHostListItem) => {
			setWslError(null);
			openWslProjectPicker({ hostId: host.id });
		},
		[openWslProjectPicker],
	);

	const confirmRemoveWsl = useCallback(async () => {
		if (removingWsl === null) return;
		setWslRemoveBusy(true);
		setWslRemoveError(null);
		try {
			const result = await desktopApi.remoteHosts.removeWslHost(removingWsl.id);
			if (!result.ok) {
				setWslRemoveError(result.code === "WSL_HOST_REFERENCED" ? t("settings.connections.wsl.remove.referenced") : t("settings.connections.wsl.remove.failed", { code: result.code }));
				return;
			}
			setRemovingWsl(null);
			await refreshWsl();
		} finally {
			setWslRemoveBusy(false);
		}
	}, [refreshWsl, removingWsl]);

	/** 连接/断开共用一条路径：置忙 → 调用 → 用稳定码或状态回填 → 清忙。 */
	const [passwordRequest, setPasswordRequest] = useState<{ hostId: string; label: string } | null>(null);
	const [passwordDraft, setPasswordDraft] = useState("");
	/** 打开编辑表单：初值（含已存口令）由主进程一次性给出。 */
	const openEditor = useCallback(async (hostId: string) => {
		setEditLoading(hostId);
		setMessage(null);
		try {
			const result = await desktopApi.remoteHosts.editDraft(hostId);
			if (!result.ok) {
				setMessage(t("settings.connections.edit.loadFailed", { code: result.code }));
				return;
			}
			setEditing({
				hostId: result.hostId,
				label: result.draft.label,
				hostName: result.draft.hostName,
				...(result.draft.user === undefined ? {} : { user: result.draft.user }),
				...(result.draft.port === undefined ? {} : { port: result.draft.port }),
				...(result.draft.identityFile === undefined ? {} : { identityFile: result.draft.identityFile }),
				...(result.draft.authMethod === undefined ? {} : { authMethod: result.draft.authMethod }),
				...(result.secret === null ? {} : { secret: result.secret }),
			});
		} finally {
			setEditLoading(null);
		}
	}, []);

	const toggle = useCallback(async (hostId: string, connect: boolean, label?: string, password?: string) => {
		const attempt = ++attemptRef.current;
		setBusy((current) => ({ ...current, [hostId]: true }));
		if (connect) setProgress({ hostId, label: label ?? hostId, errorCode: null });
		try {
			if (connect) {
				const result = await desktopApi.remoteHosts.connect(hostId, password);
				// 取消/重试已换代：这次 attempt 的迟到结果整体丢弃。
				if (attemptRef.current !== attempt) return;
				if (result.ok) {
					setStates((current) => ({ ...current, [hostId]: result.state }));
					setMessage(null);
					setFailures((current) => {
						if (!(hostId in current)) return current;
						const next = { ...current };
						delete next[hostId];
						return next;
					});
				} else if (result.code === "SSH_PASSWORD_REQUIRED") {
					// The secret lives in main memory only, so it is gone after a restart or a disconnect:
					// ask for it again instead of reporting a generic connection failure.
					setProgress(null);
					setStates((current) => ({ ...current, [hostId]: "offline" }));
					setPasswordRequest({ hostId, label: label ?? hostId });
				} else {
					// 失败不猜状态：显示稳定码，具体原因去诊断里看。
					setMessage(t("settings.connections.connectFailed", { code: result.code }));
					setStates((current) => ({ ...current, [hostId]: "offline" }));
					setProgress((current) => (current?.hostId === hostId ? { ...current, errorCode: result.code } : current));
					setFailures((current) => ({ ...current, [hostId]: result.code }));
				}
			} else {
				const result = await desktopApi.remoteHosts.disconnect(hostId);
				if (attemptRef.current !== attempt) return;
				if (result.ok) {
					setStates((current) => ({ ...current, [hostId]: "disconnected" }));
					setMessage(null);
					setFailures((current) => {
						if (!(hostId in current)) return current;
						const next = { ...current };
						delete next[hostId];
						return next;
					});
				} else {
					setMessage(t("settings.connections.disconnectFailed", { code: result.code }));
				}
			}
		} finally {
			// 被取消/重试取代的那次 attempt 不再回写忙碌与诊断。
			if (attemptRef.current === attempt) {
				setBusy((current) => ({ ...current, [hostId]: false }));
				// 诊断随开关一起刷新，用户失败后立刻能看到阶段停在哪儿。
				const result = await desktopApi.remoteHosts.diagnostics(hostId);
				if (result.ok) setDiagnostics((current) => ({ ...current, [hostId]: result.entries }));
			}
		}
	}, []);

	/** 移除失败一律翻译成可行动的说法；稳定码只作兜底。 */
	const removeErrorText = useCallback((code: string): string => {
		if (code === "REMOTE_HOST_REFERENCED") return t("settings.connections.remove.referenced");
		if (code === "REMOTE_HOST_STORE_NEEDS_REPAIR") return t("settings.connections.remove.needsRepair");
		if (code === "REMOTE_HOST_STORE_UNAVAILABLE") return t("settings.connections.remove.unavailable");
		return t("settings.connections.remove.failed", { code });
	}, []);

	const confirmRemove = useCallback(async () => {
		if (removing === null) return;
		const hostId = removing.id;
		setRemovingBusy(true);
		setRemoveError(null);
		try {
			const result = await desktopApi.remoteHosts.remove(hostId);
			if (!result.ok) {
				setRemoveError(removeErrorText(result.code));
				return;
			}
			// 退役成功后清掉这台主机的本地视图状态，避免幽灵行/幽灵诊断留到下次刷新。
			setRemoving(null);
			setStates((current) => {
				const next = { ...current };
				delete next[hostId];
				return next;
			});
			setDiagnostics((current) => {
				const next = { ...current };
				delete next[hostId];
				return next;
			});
			setFailures((current) => {
				const next = { ...current };
				delete next[hostId];
				return next;
			});
			setProgress((current) => (current?.hostId === hostId ? null : current));
			await refresh();
		} finally {
			setRemovingBusy(false);
		}
	}, [refresh, removeErrorText, removing]);

	return (
		<div className="flex min-w-0 flex-col gap-3">
			{/* 放在列表之前：store 进入 needs-repair 时列表读不出来，恢复入口必须先可见。 */}
			<RepairPanel onRepaired={() => void refresh()} />
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-body text-muted-foreground">{t("settings.connections.overview")}</p>
				<Button size="sm" onClick={() => setAdding(true)}>
					<Plus className="size-4" aria-hidden="true" />
					{t("settings.connections.new")}
				</Button>
			</div>
			<div className="flex items-center justify-between gap-3 pt-4">
				<h3 className="text-body font-medium">{t("settings.connections.devices", { count: String(hosts.length + wslHosts.length) })}</h3>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						void refresh();
						void refreshWsl();
					}}
				>
					{t("settings.connections.refresh")}
				</Button>
			</div>
			<section aria-label={t("settings.connections.title")}>
				<div className="flex flex-col gap-3">
					{hosts.length === 0 ? (
						<div className="flex items-center gap-2 rounded-lg border border-dashed border-border-subtle px-4 py-5 text-body text-muted-foreground">
							<Server className="size-4" aria-hidden="true" />
							{t("settings.connections.emptyTitle")}
						</div>
					) : (
						<div className="flex flex-col gap-3">
							{hosts.map((host) => {
								const state = states[host.id] ?? (host.disabled ? "offline" : "disconnected");
								const tone = resolveRemoteHostConnectionTone(state);
								// 「已连接」只有一个判据（shared/projectCapabilities）：与远端面板共用同一份，避免两个答案。
								const connected = isLiveHostState(state);
								const pending = busy[host.id] === true;
								// 未验证的主机没有信任锚，连接必然在路由校验处失败（SSH_HOST_NOT_READY）。
								const connectable = host.verified && !host.disabled;
								const dotClass = tone === "connecting" ? undefined : REMOTE_HOST_TONE_DOT_CLASS[tone];
								return (
									<div key={host.id} className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-bg-panel px-4 py-4">
										<div className="flex items-center gap-3">
											<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
												<Server className="size-4" />
											</span>
											<div className="flex min-w-0 flex-1 flex-col gap-0.5">
												<div className="flex min-w-0 items-center gap-2">
													<strong className="truncate text-body font-semibold text-foreground">{host.label}</strong>
													{host.disabled ? <span className="shrink-0 text-micro text-muted-foreground">{t("settings.connections.disabledTag")}</span> : null}
													{host.verified ? null : <span className="shrink-0 text-micro text-muted-foreground">{t("settings.connections.unverifiedTag")}</span>}
												</div>
												<span className="truncate font-mono text-label text-muted-foreground">{host.sshHost}</span>
											</div>
											<span
												role="status"
												aria-atomic="true"
												className={cn(
													"inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-micro font-semibold",
													tone === "online" ? "border-success/25 bg-success/10 text-success" : null,
													tone === "connecting" ? "border-warning/25 bg-warning/10 text-warning" : null,
													tone === "error" ? "border-destructive/25 bg-destructive/10 text-destructive" : null,
													tone === "offline" ? "border-border-subtle bg-muted text-muted-foreground" : null,
												)}
											>
												{tone === "connecting" ? <LoaderCircle className="size-2.5 shrink-0 animate-pideck-spin motion-reduce:animate-none" aria-hidden="true" /> : <span className={cn("size-1.5 shrink-0 rounded-full", dotClass)} aria-hidden="true" />}
												{t(`settings.connections.state.${state}`)}
											</span>
											<Button variant={connected ? "ghost" : "secondary"} size="sm" className="shrink-0" disabled={pending || !connectable} onClick={() => void toggle(host.id, !connected, host.label)} aria-label={connected ? t("settings.connections.disconnect") : t("settings.connections.connect")}>
												{connected ? t("settings.connections.disconnect") : t("settings.connections.connect")}
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												className="shrink-0 text-muted-foreground hover:text-foreground"
												title={t("settings.connections.edit.title")}
												aria-label={t("settings.connections.edit.title")}
												disabled={pending || editLoading === host.id}
												onClick={() => void openEditor(host.id)}
											>
												<Pencil className="size-3.5" aria-hidden="true" />
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												className="shrink-0 text-muted-foreground hover:text-destructive"
												title={t("settings.connections.remove")}
												aria-label={t("settings.connections.remove")}
												onClick={() => {
													setRemoveError(null);
													setRemoving(host);
												}}
											>
												<Trash2 className="size-3.5" aria-hidden="true" />
											</Button>
										</div>
										{/* 行内失败 + 重试：关闭进度框后仍能直接知道上次卡在哪，不用再开一次对话框。 */}
										{failures[host.id] !== undefined ? (
											<div className="flex items-center gap-2 pl-12 text-label text-warning">
												<span className="min-w-0 truncate">{t("settings.connections.lastFailure", { code: failures[host.id] })}</span>
												<Button variant="ghost" size="sm" className="shrink-0" disabled={pending || !connectable} onClick={() => void toggle(host.id, true, host.label)}>
													{t("common.retry")}
												</Button>
											</div>
										) : null}
										{/* 诊断只在有内容且非空时展示：连上时它通常只有几行阶段记录。 */}
										{(diagnostics[host.id] ?? []).length > 0 ? (
											<details className="pl-12 text-label text-muted-foreground">
												<summary className="cursor-pointer select-none">{t("settings.connections.diagnostics")}</summary>
												<ul className="mt-1 flex flex-col gap-0.5 font-mono">
													{(diagnostics[host.id] ?? []).slice(-8).map((entry) => (
														<li key={`${entry.at}-${entry.code}`}>
															{entry.phase} · {entry.state} · {entry.code}
														</li>
													))}
												</ul>
											</details>
										) : null}
									</div>
								);
							})}
						</div>
					)}
					{message !== null ? <p className="text-label text-muted-foreground">{message}</p> : null}
				</div>
			</section>
			{wslSupported ? (
				<section aria-label={t("settings.connections.wsl.title")}>
					<div className="flex flex-col gap-2">
						{wslHosts.length === 0 ? (
							<div className="flex items-center gap-2 rounded-xl border border-dashed border-border-subtle px-4 py-4 text-body text-muted-foreground">
								<TerminalSquare className="size-4 shrink-0" aria-hidden="true" />
								{t("settings.connections.wsl.empty")}
							</div>
						) : null}
						{wslHosts.length > 0 ? (
							<div className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle">
								{wslHosts.map((host) => (
									<div key={host.id} className="flex items-center gap-3 bg-bg-panel px-3 py-2.5 transition-colors hover:bg-muted/35">
										<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
											<TerminalSquare className="size-4" />
										</span>
										<div className="flex min-w-0 flex-1 flex-col gap-0.5">
											<div className="flex min-w-0 items-center gap-2">
												<strong className="truncate text-body font-semibold text-foreground">{host.label}</strong>
												<span className="shrink-0 rounded border border-border-subtle px-1 text-micro text-muted-foreground">{t("settings.connections.wsl.badge")}</span>
											</div>
											<span className="truncate font-mono text-label text-muted-foreground">
												{host.distro} · {host.user}
											</span>
										</div>
										<Button variant="secondary" size="sm" className="ml-auto shrink-0" onClick={() => addWslProject(host)}>
											{t("settings.connections.wsl.addProject")}
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="shrink-0 text-muted-foreground hover:text-destructive"
											title={t("settings.connections.wsl.remove")}
											aria-label={t("settings.connections.wsl.remove")}
											onClick={() => {
												setWslRemoveError(null);
												setRemovingWsl(host);
											}}
										>
											<Trash2 className="size-3.5" aria-hidden="true" />
										</Button>
									</div>
								))}
							</div>
						) : null}
						<div className="flex items-center gap-2">
							<Button variant="ghost" size="sm" onClick={() => setAddingWsl(true)}>
								{t("settings.connections.wsl.add")}
							</Button>
							{wslError !== null ? <span className="text-label text-muted-foreground">{wslError}</span> : null}
						</div>
					</div>
				</section>
			) : null}
			{/* 远端信任清单：与主机列表同一页（都是「远端开发」这一域的设置），但状态权威是决策存储而非连接状态。 */}
			<RemoteProjectTrustPanel />
			{passwordRequest !== null ? (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) {
							setPasswordRequest(null);
							setPasswordDraft("");
						}
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{t("settings.connections.password.title", { host: passwordRequest.label })}</DialogTitle>
							<DialogDescription>{t("settings.connections.password.description")}</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-1">
							<Label htmlFor="remote-connect-password">{t("settings.connections.password.label")}</Label>
							<Input id="remote-connect-password" type="password" autoComplete="off" spellCheck={false} value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} />
						</div>
						<DialogFooter>
							<Button
								variant="ghost"
								onClick={() => {
									setPasswordRequest(null);
									setPasswordDraft("");
								}}
							>
								{t("settings.connections.password.cancel")}
							</Button>
							<Button
								disabled={passwordDraft.length === 0}
								onClick={() => {
									const request = passwordRequest;
									const value = passwordDraft;
									setPasswordRequest(null);
									setPasswordDraft("");
									void toggle(request.hostId, true, request.label, value);
								}}
							>
								{t("settings.connections.password.submit")}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}
			{editing !== null ? (
				<AddHostDialog
					edit={editing}
					onClose={() => setEditing(null)}
					onSubmitted={(hostId, label, password) => {
						const host = editing;
						setEditing(null);
						void refresh();
						// 地址或凭据变了，旧连接已不代表新配置：先断开再按新值连一次。
						if (states[hostId] === "ready" || states[hostId] === "degraded") {
							void (async () => {
								await desktopApi.remoteHosts.disconnect(hostId).catch(() => undefined);
								await toggle(hostId, true, label, password);
							})();
						} else {
							void toggle(hostId, true, label, password);
						}
						void host;
					}}
				/>
			) : null}
			{adding ? (
				<AddHostDialog
					onClose={() => setAdding(false)}
					onSubmitted={(hostId, label, password) => {
						// 添加即已验证（首次信任在主进程内完成）：关框、刷新列表，并直接把这条新主机连上——
						// 用户的下一步永远是「连上它」，多一次点击只是仪式。
						setAdding(false);
						void refresh();
						void toggle(hostId, true, label, password);
					}}
					onWslSubmitted={(host) => {
						setAdding(false);
						setMessage(t("settings.connections.wsl.added", { host: host.label }));
						void refreshWsl();
					}}
				/>
			) : null}
			{addingWsl ? (
				<AddHostDialog
					initialKind="wsl"
					onClose={() => setAddingWsl(false)}
					onSubmitted={(hostId, label) => {
						setAddingWsl(false);
						void refresh();
						void toggle(hostId, true, label);
					}}
					onWslSubmitted={(host) => {
						setAddingWsl(false);
						setMessage(t("settings.connections.wsl.added", { host: host.label }));
						void refreshWsl();
					}}
				/>
			) : null}
			{/* WSL 档案移除：只删本机清单，发行版数据不动。 */}
			<Dialog
				open={removingWsl !== null}
				onOpenChange={(open) => {
					if (!open && !wslRemoveBusy) setRemovingWsl(null);
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>{t("settings.connections.wsl.remove.title", { host: removingWsl?.label ?? "" })}</DialogTitle>
						<DialogDescription>{t("settings.connections.wsl.remove.body")}</DialogDescription>
					</DialogHeader>
					{wslRemoveError !== null ? <p className="text-label text-destructive">{wslRemoveError}</p> : null}
					<DialogFooter>
						<Button variant="ghost" disabled={wslRemoveBusy} onClick={() => setRemovingWsl(null)}>
							{t("common.cancel")}
						</Button>
						<Button variant="destructive" disabled={wslRemoveBusy} onClick={() => void confirmRemoveWsl()}>
							{t("settings.connections.wsl.remove.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{/* 连接进度：添加/连接后立即出现；阶段来自诊断历史，状态来自 main 推送。 */}
			{/* 移除确认：删掉的是本机 profile 与 host key pin，远端数据不动。 */}
			<Dialog
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open && !removingBusy) setRemoving(null);
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>{t("settings.connections.remove.title", { host: removing?.label ?? "" })}</DialogTitle>
						<DialogDescription>{t("settings.connections.remove.body")}</DialogDescription>
					</DialogHeader>
					<p className="text-label text-muted-foreground">{t("settings.connections.remove.hint")}</p>
					{removeError !== null ? <p className="text-label text-destructive">{removeError}</p> : null}
					<DialogFooter>
						<Button variant="ghost" disabled={removingBusy} onClick={() => setRemoving(null)}>
							{t("common.cancel")}
						</Button>
						<Button variant="destructive" disabled={removingBusy} onClick={() => void confirmRemove()}>
							{t("settings.connections.remove.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{progress !== null ? (
				<RemoteConnectionProgressDialog
					open
					hostId={progress.hostId}
					hostLabel={progress.label}
					state={states[progress.hostId]}
					errorCode={progress.errorCode}
					busy={busy[progress.hostId] === true}
					onCancel={() => void toggle(progress.hostId, false, progress.label)}
					onRetry={() => void toggle(progress.hostId, true, progress.label)}
					onClose={() => setProgress(null)}
				/>
			) : null}
		</div>
	);
}
