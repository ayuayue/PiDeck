import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Eye, EyeOff, Folder, Link2, LoaderCircle, RefreshCw } from "lucide-react";
import type { RemoteDirectoryEntry } from "../../../../shared/types/remoteHost";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { isVisibleRemoteDirectory, joinRemotePath, remoteParentPath, remotePathSegments } from "./remoteDirectoryPath";

/**
 * 服务端目录浏览器（项目登记用）：SSH 远端与 WSL 发行版共用。
 *
 * 只列目录、只读：数据来源由调用方注入（`load`），本组件不认识 SSH 主机、wsl.exe 或 IPC 通道。
 * 导航本身不构成授权——用户点「解析路径」后仍由主进程做 canonical 复核 / 在发行版内重新校验。
 *
 * 代次闸门：快速连点目录时，旧请求的迟到结果不能覆盖新目录；卸载/换来源同样作废。
 */
export type DirectoryPage = { path: string; entries: RemoteDirectoryEntry[]; truncated: boolean };

/** 失败只带稳定码，文案由调用方按自己的域给（`describeError`）。 */
export type DirectoryLoadResult = { ok: true; page: DirectoryPage } | { ok: false; code: string };

/**
 * 「目标不是目录」在两条链路上的码：命中就退回父目录，而不是把用户卡在错误上
 * （父目录同样由服务端校验）。
 */
const NOT_A_DIRECTORY_CODES = new Set(["REMOTE_LIST_DIRS_NOT_A_DIRECTORY", "WSL_DIRECTORY_NOT_A_DIRECTORY"]);

export function DirectoryBrowser(props: { value: string; onChange: (path: string) => void; load: (path?: string) => Promise<DirectoryLoadResult>; describeError: (code: string) => string; disabled?: boolean }) {
	const [current, setCurrent] = useState("");
	const [entries, setEntries] = useState<RemoteDirectoryEntry[]>([]);
	const [truncated, setTruncated] = useState(false);
	const [loading, setLoading] = useState(false);
	const [errorCode, setErrorCode] = useState<string | null>(null);
	const [showHidden, setShowHidden] = useState(false);
	const gateRef = useRef(0);
	const onChangeRef = useRef(props.onChange);
	onChangeRef.current = props.onChange;
	// 每次渲染都取最新闭包：调用方的 load 通常是内联箭头函数，进依赖数组会让导航反复重载。
	const loadRef = useRef(props.load);
	loadRef.current = props.load;

	const load = useCallback(async (target?: string) => {
		const gate = ++gateRef.current;
		setLoading(true);
		setErrorCode(null);
		let result: DirectoryLoadResult;
		try {
			result = await loadRef.current(target);
		} catch {
			if (gate !== gateRef.current) return;
			setLoading(false);
			setErrorCode("DIRECTORY_LIST_FAILED");
			return;
		}
		if (gate !== gateRef.current) return;
		setLoading(false);
		if (!result.ok) {
			if (target !== undefined && NOT_A_DIRECTORY_CODES.has(result.code)) {
				const parent = remoteParentPath(target);
				if (parent !== target) {
					void load(parent);
					return;
				}
			}
			setErrorCode(result.code);
			return;
		}
		setCurrent(result.page.path);
		setEntries(result.page.entries);
		setTruncated(result.page.truncated);
		onChangeRef.current(result.page.path);
	}, []);

	// 只在来源变化时重新定位（调用方用 key 换来源）：导航写入的 value 不应反过来触发一次额外请求。
	useEffect(() => {
		setEntries([]);
		setCurrent("");
		setErrorCode(null);
		void load(props.value.trim().length > 0 ? props.value.trim() : undefined);
	}, [load]);

	const visible = entries.filter((entry) => isVisibleRemoteDirectory(entry.name, showHidden));
	const segments = remotePathSegments(current);
	const errorText = errorCode === null ? null : props.describeError(errorCode);

	return (
		<div data-testid="directory-picker" data-current-path={current} className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-bg-panel p-2">
			<div className="flex min-w-0 items-center gap-1">
				<Button type="button" variant="ghost" size="icon-xs" className="shrink-0" aria-label={t("sidebar.remoteEnroll.dirParent")} title={t("sidebar.remoteEnroll.dirParent")} disabled={props.disabled || loading || current === "" || current === "/"} onClick={() => void load(remoteParentPath(current))}>
					<ChevronLeft className="size-3.5" aria-hidden="true" />
				</Button>
				<nav aria-label={t("sidebar.remoteEnroll.dirCurrentPath")} className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-label">
					{segments.map((segment, index) => (
						<span key={segment.path} className="inline-flex items-center">
							{index > 0 ? <span className="px-0.5 text-muted-foreground">/</span> : null}
							<button type="button" className="rounded px-0.5 hover:bg-bg-hover disabled:opacity-60" disabled={props.disabled || loading} onClick={() => void load(segment.path)}>
								{segment.label}
							</button>
						</span>
					))}
				</nav>
				<Button type="button" variant="ghost" size="icon-xs" className="shrink-0" aria-label={t("sidebar.remoteEnroll.dirRefresh")} title={t("sidebar.remoteEnroll.dirRefresh")} disabled={props.disabled || loading || current === ""} onClick={() => void load(current)}>
					<RefreshCw className={cn("size-3.5", loading && "animate-pideck-spin")} aria-hidden="true" />
				</Button>
				<Button type="button" variant="ghost" size="icon-xs" className="shrink-0" aria-pressed={showHidden} aria-label={t("sidebar.remoteEnroll.dirShowHidden")} title={t("sidebar.remoteEnroll.dirShowHidden")} disabled={props.disabled} onClick={() => setShowHidden((shown) => !shown)}>
					{showHidden ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
				</Button>
			</div>

			{loading ? (
				<p className="flex items-center gap-1 px-1 py-2 text-label text-muted-foreground">
					<LoaderCircle className="size-3 animate-pideck-spin" aria-hidden="true" />
					{t("sidebar.remoteEnroll.dirLoading")}
				</p>
			) : errorText !== null ? (
				<p className="px-1 py-2 text-label text-muted-foreground">{errorText}</p>
			) : visible.length === 0 ? (
				<p className="px-1 py-2 text-label text-muted-foreground">{t("sidebar.remoteEnroll.dirEmpty")}</p>
			) : (
				<>
					{/* scroll-ok: bounded 目录选择候选，单层条目且由 max-h 收束 */}
					<ul className="flex max-h-52 flex-col gap-0.5 overflow-y-auto">
						{visible.map((entry) => (
							<li key={entry.name}>
								<button
									type="button"
									data-testid="directory-entry"
									data-symlink={entry.isSymlink ? "true" : undefined}
									className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-body hover:bg-bg-hover disabled:opacity-60"
									disabled={props.disabled}
									onClick={() => void load(joinRemotePath(current, entry.name))}
								>
									<Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
									<span className="min-w-0 flex-1 truncate">{entry.name}</span>
									{entry.isSymlink ? <Link2 className="size-3 shrink-0 text-muted-foreground" aria-label={t("sidebar.remoteEnroll.dirSymlink")} /> : null}
								</button>
							</li>
						))}
					</ul>
				</>
			)}
			{truncated && !loading && errorCode === null ? <p className="px-1 text-label text-muted-foreground">{t("sidebar.remoteEnroll.dirTruncated")}</p> : null}
		</div>
	);
}
