import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import type { RemoteWorkspaceEntry, RemoteWorkspaceRootRequest } from "../../../../../shared/types/remoteHost";

/**
 * 远端工作区（Phase 3 只读）。
 *
 * 交互顺序是刻意的：**先解析再确认**。用户输入的路径会被远端 canonical 化，确认框展示的是 canonical
 * 值 —— 因为那才是真正会被 confinement 的目录，而符号链接会在握手处被拒（P3-1 真机已实测）。
 * 让用户确认一个「看起来对但会被拒」的路径，是最坏的体验。
 *
 * 已确认的 root 由主进程持有；这里只命名**相对位置**（根为空串），不能自己扩大边界。
 */
export function RemoteWorkspacePanel(props: { hostId: string; label: string }) {
	const [pathInput, setPathInput] = useState("");
	const [root, setRoot] = useState<string | null>(null);
	const [confirmRequest, setConfirmRequest] = useState<RemoteWorkspaceRootRequest | null>(null);
	const [entries, setEntries] = useState<RemoteWorkspaceEntry[]>([]);
	const [relative, setRelative] = useState("");
	const [file, setFile] = useState<{ path: string; text: string; bytes: number } | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	/** 已确认的 root 属于哪台主机由主进程记录，这里只问「有没有」。 */
	const refreshRoot = useCallback(async () => {
		const result = await desktopApi.remoteHosts.getWorkspaceRoot();
		if (result.ok) {
			setRoot(result.canonicalPath);
			return;
		}
		setRoot(null);
		setEntries([]);
		setFile(null);
	}, []);

	useEffect(() => {
		void refreshRoot();
	}, [refreshRoot]);

	/** 确认推送必须订阅且退订：窗口没了还继续收，会让「确认」脱离用户看得见的上下文。 */
	useEffect(() => {
		const unsubscribe = desktopApi.remoteHosts.onWorkspaceRootConfirm((request) => setConfirmRequest(request));
		return unsubscribe;
	}, []);

	const loadDirectory = useCallback(
		async (relativePath: string) => {
			setBusy(true);
			try {
				const result = await desktopApi.remoteHosts.listWorkspace(props.hostId, relativePath);
				if (!result.ok) {
					setMessage(t("settings.connections.workspace.listFailed", { code: result.code }));
					return;
				}
				setMessage(null);
				setFile(null);
				setRelative(relativePath);
				// 目录在前、文件在后，同类按名字：和本地文件树一致的读法。
				setEntries([...result.entries].sort((first, second) => (first.kind === second.kind ? first.name.localeCompare(second.name) : first.kind === "directory" ? -1 : 1)));
			} finally {
				setBusy(false);
			}
		},
		[props.hostId],
	);

	const resolveRoot = useCallback(async () => {
		setBusy(true);
		try {
			const result = await desktopApi.remoteHosts.resolveWorkspaceRoot(props.hostId, pathInput.trim());
			if (!result.ok) setMessage(t("settings.connections.workspace.resolveFailed", { code: result.code }));
		} finally {
			setBusy(false);
		}
	}, [pathInput, props.hostId]);

	const openFile = useCallback(
		async (relativePath: string) => {
			setBusy(true);
			try {
				const result = await desktopApi.remoteHosts.readWorkspaceFile(props.hostId, relativePath);
				if (!result.ok) {
					setMessage(t("settings.connections.workspace.readFailed", { code: result.code }));
					return;
				}
				// 只读文本预览：二进制在这里没有意义，直接说明而不是渲染乱码。
				const bytes = Uint8Array.from(atob(result.contentBase64), (char) => char.charCodeAt(0));
				const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
				setMessage(null);
				setFile({ path: relativePath, text: text.includes("\u0000") ? t("settings.connections.workspace.binary") : text, bytes: result.bytes });
			} finally {
				setBusy(false);
			}
		},
		[props.hostId],
	);

	const answerRoot = useCallback(
		async (requestId: string, choice: "approve" | "deny") => {
			setBusy(true);
			try {
				const result = await desktopApi.remoteHosts.answerWorkspaceRoot(requestId, choice);
				if (!result.ok) setMessage(t("settings.connections.workspace.resolveFailed", { code: result.code }));
			} finally {
				setBusy(false);
				setConfirmRequest(null);
				await refreshRoot();
				// 拒绝会清空 root（fail-closed），因此这里必须重新读而不是假设还留着旧值。
				const after = await desktopApi.remoteHosts.getWorkspaceRoot();
				if (after.ok && choice === "approve") await loadDirectory("");
			}
		},
		[loadDirectory, refreshRoot],
	);

	/** 面包屑：把相对路径拆成可点击的层级，根永远可达。 */
	const crumbs = relative === "" ? [] : relative.split("/");
	const crumbTarget = (index: number): string => crumbs.slice(0, index + 1).join("/");

	return (
		<section className="mt-3 flex flex-col gap-2 rounded-lg border border-border-subtle px-3 py-2">
			<strong className="text-body font-semibold text-foreground">{t("settings.connections.workspace.title")}</strong>
			{root === null ? (
				<>
					<p className="text-label text-muted-foreground">{t("settings.connections.workspace.hint")}</p>
					<div className="flex items-end gap-2">
						<div className="grid flex-1 gap-1.5">
							<Label htmlFor="remote-workspace-path">{t("settings.connections.workspace.path")}</Label>
							<Input id="remote-workspace-path" placeholder="/home/user/project" value={pathInput} onChange={(event) => setPathInput(event.target.value)} />
						</div>
						<Button size="sm" disabled={busy || pathInput.trim().length === 0} onClick={() => void resolveRoot()}>
							{t("settings.connections.workspace.resolve")}
						</Button>
					</div>
				</>
			) : (
				<>
					{/* 已确认的 root 始终显示：用户必须能一眼看到当前边界是什么。 */}
					<div className="flex items-center gap-2 text-label text-muted-foreground">
						<span>{t("settings.connections.workspace.confirmed")}</span>
						<span className="select-all break-all font-mono">{root}</span>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setRoot(null);
								setEntries([]);
								setFile(null);
							}}
						>
							{t("settings.connections.workspace.change")}
						</Button>
					</div>
					<nav className="flex flex-wrap items-center gap-1 text-label">
						<button type="button" className="underline" disabled={busy} onClick={() => void loadDirectory("")}>
							/
						</button>
						{crumbs.map((crumb, index) => (
							<span key={crumbTarget(index)} className="flex items-center gap-1">
								<button type="button" className="underline" disabled={busy} onClick={() => void loadDirectory(crumbTarget(index))}>
									{crumb}
								</button>
								{index < crumbs.length - 1 ? <span className="text-muted-foreground">/</span> : null}
							</span>
						))}
					</nav>
					<ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
						{entries.length === 0 ? <li className="text-label text-muted-foreground">{t("settings.connections.workspace.empty")}</li> : null}
						{entries.map((entry) => (
							<li key={entry.name} className="shrink-0">
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-label"
									disabled={busy || entry.kind === "other"}
									onClick={() => void (entry.kind === "directory" ? loadDirectory(relative === "" ? entry.name : `${relative}/${entry.name}`) : openFile(relative === "" ? entry.name : `${relative}/${entry.name}`))}
								>
									<span className="truncate">{entry.kind === "directory" ? "📁" : entry.kind === "file" ? "📄" : "🔗"}</span>
									<span className="min-w-0 flex-1 truncate">{entry.name}</span>
									{entry.bytes !== undefined ? <span className="shrink-0 text-muted-foreground">{entry.bytes} B</span> : null}
									{/* 符号链接不跟随：helper 把它报为 other，这里如实禁用而不是假装能打开。 */}
									{entry.kind === "other" ? <span className="shrink-0 text-muted-foreground">{t("settings.connections.workspace.linkNotFollowed")}</span> : null}
								</button>
							</li>
						))}
					</ul>
					{file !== null ? (
						<div className="flex flex-col gap-1">
							<span className="font-mono text-label text-muted-foreground">
								{file.path} · {file.bytes} B
							</span>
							<pre className="max-h-64 overflow-auto rounded bg-muted/40 p-2 text-label">{file.text.slice(0, 100_000)}</pre>
						</div>
					) : null}
				</>
			)}
			{message !== null ? <span className="text-label text-muted-foreground">{message}</span> : null}
			{confirmRequest !== null ? (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) void answerRoot(confirmRequest.requestId, "deny");
					}}
				>
					<DialogContent className="max-w-lg">
						<DialogHeader>
							<DialogTitle>{t("settings.connections.workspace.confirmTitle")}</DialogTitle>
							<DialogDescription>{t("settings.connections.workspace.confirmHint")}</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-2 text-body">
							<div className="flex items-center justify-between gap-3">
								<span className="text-muted-foreground">{t("settings.connections.workspace.host")}</span>
								<span className="font-medium">{props.label}</span>
							</div>
							<div className="flex flex-col gap-0.5">
								<span className="text-muted-foreground">{t("settings.connections.workspace.requested")}</span>
								<span className="select-all break-all font-mono text-label">{confirmRequest.requestedPath}</span>
							</div>
							{/* 展示 canonical 值：它才是真正的边界，两者不同时必须让用户看见。 */}
							<div className="flex flex-col gap-0.5">
								<span className="text-muted-foreground">{t("settings.connections.workspace.canonical")}</span>
								<span className="select-all break-all font-mono text-label">{confirmRequest.canonicalPath}</span>
							</div>
							{confirmRequest.canonicalPath !== confirmRequest.requestedPath ? <p className="text-label text-muted-foreground">{t("settings.connections.workspace.redirected")}</p> : null}
						</div>
						<DialogFooter>
							<Button variant="ghost" disabled={busy} onClick={() => void answerRoot(confirmRequest.requestId, "deny")}>
								{t("common.cancel")}
							</Button>
							<Button disabled={busy} onClick={() => void answerRoot(confirmRequest.requestId, "approve")}>
								{t("settings.connections.workspace.confirmUse")}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}
		</section>
	);
}
