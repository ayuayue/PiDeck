import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import type { RemoteWorkspaceEntry } from "../../../../shared/types/remoteHost";

/**
 * 远端项目只读浏览（Phase 3 第二段）。
 *
 * 与设置页的「远端工作区」不同：这个视图的根来自 `ProjectStore` 中该项目持有的 canonical
 * `remotePath`，因此**跨重启恢复**——它不依赖设置页那个临时的已确认 root。渲染层只给
 * `projectId` 与**相对路径**，主进程解析 host/root 并串行切换会话。
 *
 * 只读：不开放写入、搜索、Git、终端或 Agent。这些能力在远端项目上必须显式禁用，而不是
 * 悄悄落到本机实现（各本地 IPC 已按 locator 拒绝）。
 */
export function RemoteProjectPanel(props: { projectId: string; projectName: string }) {
	const [entries, setEntries] = useState<RemoteWorkspaceEntry[]>([]);
	const [relative, setRelative] = useState<string[]>([]);
	const [file, setFile] = useState<{ path: string; text: string; bytes: number } | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	// 与 message 分开：列出成功但为空，和列出失败，是两件不同的事，不能同时显示。
	const [listed, setListed] = useState(false);

	const relativePath = relative.join("/");

	const loadDirectory = useCallback(
		async (segments: string[]) => {
			setBusy(true);
			try {
				const result = await desktopApi.remoteHosts.listProject(props.projectId, segments.join("/"));
				if (!result.ok) {
					setMessage(result.code === "SSH_HOST_NOT_READY" || result.code === "SSH_CONNECTION_FAILED" ? t("project.remote.notConnectedHint") : t("project.remote.listFailed", { code: result.code }));
					setListed(false);
					setEntries([]);
					return;
				}
				setMessage(null);
				setFile(null);
				setListed(true);
				setRelative(segments);
				// 目录在前、文件在后，同类按名字：和本地文件树一致的读法。
				setEntries([...result.entries].sort((first, second) => (first.kind === second.kind ? first.name.localeCompare(second.name) : first.kind === "directory" ? -1 : 1)));
			} finally {
				setBusy(false);
			}
		},
		[props.projectId],
	);

	// 切换项目时必须重读，且不能沿用上一个项目的目录状态。
	useEffect(() => {
		setRelative([]);
		setFile(null);
		void loadDirectory([]);
	}, [loadDirectory]);

	const openFile = useCallback(
		async (segments: string[]) => {
			setBusy(true);
			try {
				const result = await desktopApi.remoteHosts.readProjectFile(props.projectId, segments.join("/"));
				if (!result.ok) {
					setMessage(t("project.remote.readFailed", { code: result.code }));
					return;
				}
				// 只读文本预览：二进制在这里没有意义，直接说明而不是渲染乱码。
				const bytes = Uint8Array.from(atob(result.contentBase64), (char) => char.charCodeAt(0));
				const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
				setMessage(null);
				setFile({ path: segments.join("/"), text: text.includes("\u0000") ? t("project.remote.binary") : text, bytes: result.bytes });
			} finally {
				setBusy(false);
			}
		},
		[props.projectId],
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
			<div className="flex flex-wrap items-center gap-2 text-label">
				<span className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">{t("project.remote.badge")}</span>
				<strong className="text-body font-semibold text-foreground">{props.projectName}</strong>
				<span className="text-muted-foreground">{t("project.remote.title")}</span>
			</div>
			<nav className="flex flex-wrap items-center gap-1 text-label">
				<button type="button" className="underline" disabled={busy} onClick={() => void loadDirectory([])}>
					/
				</button>
				{relative.map((crumb, index) => (
					<span key={relative.slice(0, index + 1).join("/")} className="flex items-center gap-1">
						<button type="button" className="underline" disabled={busy} onClick={() => void loadDirectory(relative.slice(0, index + 1))}>
							{crumb}
						</button>
						{index < relative.length - 1 ? <span className="text-muted-foreground">/</span> : null}
					</span>
				))}
			</nav>
			<ul className="flex flex-col gap-0.5">
				{listed && entries.length === 0 ? <li className="text-label text-muted-foreground">{t("project.remote.empty")}</li> : null}
				{entries.map((entry) => (
					<li key={entry.name} className="shrink-0">
						<button type="button" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-label hover:bg-muted/60" disabled={busy || entry.kind === "other"} onClick={() => void (entry.kind === "directory" ? loadDirectory([...relative, entry.name]) : openFile([...relative, entry.name]))}>
							<span className="truncate">{entry.kind === "directory" ? "📁" : entry.kind === "file" ? "📄" : "🔗"}</span>
							<span className="min-w-0 flex-1 truncate">{entry.name}</span>
							{entry.bytes !== undefined ? <span className="shrink-0 text-muted-foreground">{entry.bytes} B</span> : null}
							{/* 符号链接不跟随：helper 把它报为 other，这里如实禁用而不是假装能打开。 */}
							{entry.kind === "other" ? <span className="shrink-0 text-muted-foreground">{t("project.remote.linkNotFollowed")}</span> : null}
						</button>
					</li>
				))}
			</ul>
			{file !== null ? (
				<div className="flex flex-col gap-1">
					<span className="font-mono text-label text-muted-foreground">
						{file.path === "" ? relativePath : file.path} · {file.bytes} B
					</span>
					<pre className="overflow-auto rounded bg-muted/40 p-2 text-label">{file.text.slice(0, 100_000)}</pre>
				</div>
			) : null}
			{message !== null ? <span className="text-label text-muted-foreground">{message}</span> : null}
			<Button variant="ghost" size="sm" className="self-start" disabled={busy} onClick={() => void loadDirectory(relative)}>
				{t("common.refresh")}
			</Button>
		</div>
	);
}
