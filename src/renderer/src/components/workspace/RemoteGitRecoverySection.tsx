import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectGitRecoveryEntry, ProjectGitRecoveryListing, ProjectGitService } from "../../services/projectServiceContracts";
import type { ProjectFileTarget } from "../../../../shared/types";
import { t } from "../../i18n";
import { remoteGitErrorMessage } from "../../utils/gitErrorPresentation";
import { relativeTimeParts } from "../../utils/providerUsageDisplay";
import { PaneHeader } from "../app/git/GitPanelControls";
import { GitInlineErrorNotice } from "../app/git/GitInlineErrorNotice";
import { Button } from "../ui-shadcn/button";

const codeOf = (error: unknown): string => {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && code.length > 0 ? code : "GIT_WRITE_UNSUPPORTED";
};

/**
 * 远端专属的「恢复区」：丢弃的改动在主机上留了一份自带引用，可还原或删除。
 * 本机没有对应存储（本机丢弃不可恢复），所以它不是共用面板的分区，只作为面板底部的宿主插槽出现。
 * 展开才读、drop 二次确认、restore 直接执行；能力关闭时整区只说明原因。
 */
export function RemoteGitRecoverySection(props: { service: ProjectGitService; repo: ProjectFileTarget | undefined; enabled: boolean; closedText: string; reloadKey: string }) {
	const [open, setOpen] = useState(false);
	const [listing, setListing] = useState<ProjectGitRecoveryListing>();
	const [loading, setLoading] = useState(false);
	const [errorCode, setErrorCode] = useState<string>();
	const [pendingDrop, setPendingDrop] = useState<ProjectGitRecoveryEntry | null>(null);
	const [notice, setNotice] = useState<{ kind: "restored" | "dropped"; path: string }>();
	const active = useRef(0);

	const load = useCallback(async () => {
		const request = ++active.current;
		setLoading(true);
		setErrorCode(undefined);
		try {
			const next = await props.service.recoveryList(props.repo);
			if (request === active.current) setListing(next);
		} catch (error) {
			if (request === active.current) setErrorCode(codeOf(error));
		} finally {
			if (request === active.current) setLoading(false);
		}
	}, [props.service, props.repo]);

	// 仓库/连接代变化后旧列表不再可信：清空，等下一次展开重新读。
	useEffect(() => {
		active.current += 1;
		setListing(undefined);
		setPendingDrop(null);
		setNotice(undefined);
	}, [props.reloadKey]);

	useEffect(() => {
		if (open && props.enabled && listing === undefined && !loading) void load();
	}, [open, props.enabled, listing, loading, load]);

	const restore = async (entry: ProjectGitRecoveryEntry) => {
		try {
			await props.service.recoveryRestore(entry, props.repo);
			setNotice({ kind: "restored", path: entry.path });
			void load();
		} catch (error) {
			setErrorCode(codeOf(error));
		}
	};
	const drop = async (entry: ProjectGitRecoveryEntry) => {
		setPendingDrop(null);
		try {
			await props.service.recoveryDrop(entry, props.repo);
			setNotice({ kind: "dropped", path: entry.path });
			void load();
		} catch (error) {
			setErrorCode(codeOf(error));
		}
	};

	return (
		<section data-testid="remote-git-recovery" id="git-pane-remote-recovery" className="border-b border-[var(--git-panel-border)] last:border-b-0">
			<PaneHeader
				id="remote-recovery"
				title={t("remoteGit.recoveryTitle")}
				count={listing?.entries.length}
				open={open}
				onToggle={() => {
					if (open && errorCode !== undefined) void load();
					else setOpen(!open);
				}}
			/>
			{open ? (
				props.enabled ? (
					<>
						{loading ? <p className="px-2.5 text-micro text-[var(--git-desc-fg)]">{t("remoteGit.loading")}</p> : null}
						{errorCode ? <GitInlineErrorNotice message={remoteGitErrorMessage(errorCode)} className="px-2.5 text-micro text-danger" /> : null}
						{listing && listing.entries.length === 0 ? <p className="px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">{t("remoteGit.recoveryEmpty")}</p> : null}
						{listing?.truncated ? <p className="px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">{t("remoteGit.recoveryTruncated")}</p> : null}
						{listing?.entries.map((entry) => (
							<div key={entry.ref} data-testid="remote-git-recovery-row" className="flex items-center gap-2 px-2.5 py-0.5 text-micro hover:bg-muted">
								<span className="min-w-0 flex-1 truncate">{entry.path}</span>
								<span className="shrink-0 text-[var(--git-desc-fg)]">
									{Math.max(1, Math.round(entry.bytes / 1024))} KiB · {t(relativeTimeParts(entry.at).key, relativeTimeParts(entry.at).params)}
								</span>
								<Button type="button" variant="ghost" size="xs" data-testid="remote-git-recovery-restore" onClick={() => void restore(entry)}>
									{t("remoteGit.recoveryRestore")}
								</Button>
								<Button type="button" variant="ghost" size="xs" data-testid="remote-git-recovery-drop" onClick={() => setPendingDrop(entry)}>
									{t("remoteGit.recoveryDrop")}
								</Button>
							</div>
						))}
						{pendingDrop ? (
							<div data-testid="remote-git-recovery-drop-confirm-bar" className="mx-2.5 my-1 rounded-sm border border-danger p-2 text-micro">
								<p>{t("remoteGit.recoveryDropConfirm", { path: pendingDrop.path })}</p>
								<div className="flex items-center gap-2 pt-1">
									<Button type="button" size="xs" data-testid="remote-git-recovery-drop-confirm" onClick={() => void drop(pendingDrop)}>
										{t("remoteGit.recoveryDropAction")}
									</Button>
									<Button type="button" variant="ghost" size="xs" data-testid="remote-git-recovery-drop-cancel" onClick={() => setPendingDrop(null)}>
										{t("remoteGit.recoveryDropCancel")}
									</Button>
								</div>
							</div>
						) : null}
						{notice ? (
							<p data-testid="remote-git-recovery-outcome" className="px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">
								{t(notice.kind === "restored" ? "remoteGit.recoveryRestored" : "remoteGit.recoveryDropped", { path: notice.path })}
							</p>
						) : null}
					</>
				) : (
					<p data-testid="remote-git-recovery-closed" className="px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">
						{props.closedText}
					</p>
				)
			) : null}
		</section>
	);
}
