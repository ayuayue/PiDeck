import { AlertTriangle, ArrowDownToLine, Check, FileText, Loader2, RefreshCw, Server } from "lucide-react";
import { useEffect } from "react";
import { desktopApi } from "../../desktopApi";
import { REMOTE_SESSION_UNWIRED_CODE, useRemoteSessions, type RemoteSessionImportResult } from "../../hooks/useRemoteSessions";
import { useRemoteSessionTitles } from "../../hooks/useRemoteSessionTitles";
import { formatI18nDateTime, t } from "../../i18n";
import { REMOTE_SESSION_LIMIT_CODES, type RemoteSessionEntryView } from "../session/remoteSessionListState";
import { isProvisionalTitleOrigin, isTitleTailDegraded, type RemoteSessionTitleEntry } from "../session/remoteSessionTitleState";
import type { RemoteSessionImportFeedback } from "../../atoms/remote-sessions-atoms";
import { Button } from "../ui-shadcn/button";

/**
 * 侧栏「远端会话」区块（H2）：按主机只读列出远端 pi 会话，可按需取标题、可导入本地 catalog。
 *
 * 三个"分开"是刻意的：
 * - 空 / 加载 / 错误三态分开呈现：扫描成功但为空，和扫描失败是两件事，不能共用一句话；
 * - 标题与占位分开：列表先用扫描给的 stem，进入视口才惰性取真实标题；只有 origin=authoritative 是真实
 *   名字，inferred/fallback（以及未接线/失败）都必须标「暂定」，不能把兜底当解析结果；
 * - 超过硬上限是**稳定码拒绝**（不是截断）：单独提示「被整体拒绝」，绝不假装列表完整。
 *
 * 导入成功后由宿主（App 的 sessions.importRemoteSession）刷新本地会话列表并选中新会话；
 * created=false（已在本地存在）也要有明确回执，不能静默。
 */
function formatSize(bytes: number): string {
	// B/KB/MB 是单位符号而不是文案，不占 i18n key。
	if (bytes < 1024) return bytes + " B";
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
	return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** 扫描失败文案：未接线 / 上限拒绝 / 未连接 / home 不可用 / 稳定码，五类给不同说法。 */
function scanErrorText(code: string | null): string {
	if (code === null) return t("sidebar.remoteSessions.scanRejected");
	if (code === REMOTE_SESSION_UNWIRED_CODE) return t("sidebar.remoteSessions.unwired");
	if (REMOTE_SESSION_LIMIT_CODES.has(code)) return t("sidebar.remoteSessions.limitExceeded");
	if (code === "SSH_HOST_NOT_READY" || code === "SSH_CONNECTION_FAILED") return t("sidebar.remoteSessions.notConnected");
	if (code === "REMOTE_SESSION_HOME_UNAVAILABLE") return t("sidebar.remoteSessions.homeUnavailable");
	return t("sidebar.remoteSessions.scanFailed", { code });
}

/** 登记反馈文案：created 两种结果都必须说清，失败给可行动的稳定码解释。 */
function importFeedbackText(feedback: RemoteSessionImportFeedback): string {
	if (feedback.kind === "imported") return feedback.created ? t("sidebar.remoteSessions.imported") : t("sidebar.remoteSessions.alreadyImported");
	if (feedback.kind === "refresh-failed") return t("sidebar.remoteSessions.refreshFailed");
	const code = feedback.code;
	if (code === null) return t("sidebar.remoteSessions.importRejected");
	if (code === REMOTE_SESSION_UNWIRED_CODE) return t("sidebar.remoteSessions.unwired");
	if (code === "REMOTE_SESSION_PROJECT_UNRESOLVED") return t("sidebar.remoteSessions.projectUnresolved");
	if (code === "REMOTE_SESSION_CATALOG_UNAVAILABLE") return t("sidebar.remoteSessions.catalogUnavailable");
	return t("sidebar.remoteSessions.importFailed", { code });
}

/** 一条远端会话：标题惰性获取，导入按钮在已导入时变成标记。 */
function RemoteSessionRow(props: { entry: RemoteSessionEntryView; title: RemoteSessionTitleEntry; imported: boolean; importing: boolean; busy: boolean; onRequestTitle: (remoteSessionId: string) => void; onImport: () => void }) {
	const { entry, title } = props;
	// 进入视口（本行渲染）才按需取标题：不为列表里没看的几百条各发一次远端读取。
	useEffect(() => {
		props.onRequestTitle(entry.remoteSessionId);
	}, [entry.remoteSessionId, props.onRequestTitle]);
	const displayTitle = title.title ?? entry.name;
	// 只有 origin=authoritative 才是会话的真实名字；inferred（首条消息弱兜底）/ fallback（stem）/ 未接线 / 失败
	// 都必须标「暂定」。判据本身在 origin 的词表模块里（isProvisionalTitleOrigin），避免两处各写一遍。
	const tentative = isProvisionalTitleOrigin(title.origin);
	// K2-3：「尾窗没读到」是**另一个**判据（标题可能仍是权威名，只是这次没看到文件尾）。
	// 与「暂定」分开、不合并成一个词：两个标记可以同时出现。
	const tailDegraded = isTitleTailDegraded(title);
	return (
		<li data-remote-session-id={entry.remoteSessionId} className="shrink-0 rounded-md px-1 py-1 hover:bg-bg-hover">
			<div className="flex items-center gap-1.5">
				{title.status === "loading" ? <Loader2 className="size-3 shrink-0 animate-pideck-spin text-muted-foreground" aria-label={t("sidebar.remoteSessions.titleParsing")} /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
				<span data-testid="remote-session-title" className="min-w-0 flex-1 truncate text-label" title={tailDegraded ? t("sidebar.remoteSessions.tailDegradedHint") : tentative ? t("sidebar.remoteSessions.tentativeHint") : displayTitle}>
					{displayTitle}
				</span>
				{tentative ? (
					<span data-testid="remote-session-tentative" className="shrink-0 rounded bg-muted px-1 text-micro leading-4 text-muted-foreground">
						{t("sidebar.remoteSessions.tentative")}
					</span>
				) : null}
				{/* 降级标记：比「暂定」更轻（同色系更淡、无背景），只说明「这次没读到文件尾」，不是错误。 */}
				{tailDegraded ? (
					<span data-testid="remote-session-tail-degraded" className="shrink-0 rounded px-1 text-micro leading-4 text-muted-foreground/70">
						{t("sidebar.remoteSessions.tailDegraded")}
					</span>
				) : null}
				{/* 「已导入」是状态标记，不夺走入口：登记是幂等的，再次点它必须能给出 created=false 的区分回执。 */}
				{props.imported ? (
					<span className="flex shrink-0 items-center gap-0.5 text-micro leading-4 text-muted-foreground">
						<Check className="size-3" aria-hidden="true" />
						{t("sidebar.remoteSessions.importedTag")}
					</span>
				) : null}
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					data-testid="remote-session-import"
					className="size-6 shrink-0 text-muted-foreground hover:bg-bg-hover hover:text-foreground"
					disabled={props.busy || props.importing}
					title={props.importing ? t("sidebar.remoteSessions.importing") : t("sidebar.remoteSessions.import")}
					aria-label={props.importing ? t("sidebar.remoteSessions.importing") : t("sidebar.remoteSessions.import")}
					onClick={props.onImport}
				>
					{props.importing ? <Loader2 className="size-3 animate-pideck-spin" /> : <ArrowDownToLine className="size-3" />}
				</Button>
			</div>
			<div className="flex items-center gap-2 pl-5 text-micro leading-4 text-muted-foreground">
				<span>{formatSize(entry.size)}</span>
				<span>{formatI18nDateTime(entry.mtimeMs)}</span>
			</div>
		</li>
	);
}

/** 侧栏「远端会话」区块主体：header（标题 + 扫描/重扫） + 三态 + 列表 + 登记反馈。 */
export function RemoteSessionsSection(props: { hostId: string; projectId: string; importedRemoteSessionIds: ReadonlySet<string>; onImported: (result: RemoteSessionImportResult) => void | Promise<void> }) {
	const sessions = useRemoteSessions(desktopApi, { hostId: props.hostId, projectId: props.projectId, onImported: props.onImported });
	const titles = useRemoteSessionTitles(desktopApi, props.hostId);
	const { state } = sessions;
	const importing = sessions.importingRemoteSessionId !== null;
	const scanning = state.phase === "scanning";
	const scanLabel = state.scannedAt === null ? t("sidebar.remoteSessions.scan") : t("sidebar.remoteSessions.rescan");
	return (
		<section data-testid="remote-sessions-section" aria-label={t("sidebar.remoteSessions.title")} className="mt-1 border-t border-border-subtle pt-1">
			<div className="flex items-center justify-between gap-1 px-1">
				<span className="flex min-w-0 items-center gap-1 text-caption font-medium text-muted-foreground">
					<Server className="size-3.5 shrink-0" aria-hidden="true" />
					<span className="truncate">{t("sidebar.remoteSessions.title")}</span>
					{state.phase === "entries" ? <span className="shrink-0">{t("sidebar.remoteSessions.count", { count: state.entries.length })}</span> : null}
				</span>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					data-testid="remote-sessions-scan"
					className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-bg-hover hover:text-foreground"
					title={scanLabel}
					aria-label={scanLabel}
					disabled={scanning || importing}
					onClick={() => void sessions.scan()}
				>
					{scanning ? <Loader2 className="size-3.5 animate-pideck-spin" /> : <RefreshCw className="size-3.5" />}
				</Button>
			</div>
			{/* 三态分开：没扫过 / 加载中 / 失败 / 空 / 有结果 各自一句，不能共用。 */}
			{state.phase === "idle" ? <p className="px-1 py-1 text-micro leading-4 text-muted-foreground">{t("sidebar.remoteSessions.idleHint")}</p> : null}
			{scanning ? (
				<p className="flex items-center gap-1 px-1 py-1 text-micro leading-4 text-muted-foreground">
					<Loader2 className="size-3 animate-pideck-spin" aria-hidden="true" />
					{t("sidebar.remoteSessions.scanning")}
				</p>
			) : null}
			{state.phase === "error" ? (
				<p className="flex items-start gap-1 px-1 py-1 text-micro leading-4 text-muted-foreground">
					<AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
					{scanErrorText(state.errorCode)}
				</p>
			) : null}
			{state.phase === "empty" ? <p className="px-1 py-1 text-micro leading-4 text-muted-foreground">{t("sidebar.remoteSessions.empty")}</p> : null}
			{state.phase === "entries" ? (
				<ul className="mt-0.5 flex flex-col gap-0.5">
					{state.entries.map((entry) => (
						<RemoteSessionRow
							key={entry.remoteSessionId}
							entry={entry}
							title={titles.statusOf(entry.remoteSessionId)}
							imported={props.importedRemoteSessionIds.has(entry.remoteSessionId)}
							importing={sessions.importingRemoteSessionId === entry.remoteSessionId}
							busy={scanning || importing}
							onRequestTitle={titles.request}
							onImport={() => void sessions.importSession(entry)}
						/>
					))}
				</ul>
			) : null}
			{/* 登记反馈：created=true/false 与失败都必须显式出现，不能只活在一次点击里。 */}
			{sessions.feedback !== null ? (
				<p data-testid="remote-sessions-feedback" className="px-1 py-1 text-micro leading-4 text-muted-foreground">
					{importFeedbackText(sessions.feedback)}
				</p>
			) : null}
		</section>
	);
}
