import { useCallback, useEffect, useRef, useState } from "react";
import type { GitRecoveryEntry, GitRecoveryListing } from "../../../../shared/types";
import { t } from "../../i18n";
import { localGitOperationErrorText } from "../../utils/gitErrorPresentation";
import { relativeTimeParts } from "../../utils/providerUsageDisplay";
import { PaneHeader } from "../app/git/GitPanelControls";
import { GitInlineErrorNotice } from "../app/git/GitInlineErrorNotice";
import { Button } from "../ui-shadcn/button";

/**
 * 本机「恢复区」：与远端同一个分区、同一套文案，区别只在数据来源。
 *
 * 本机丢弃在改写工作区之前把文件字节写进仓库对象库，快照 ref 挂在 `refs/pideck/recovery/*`；
 * 展开才读、drop 二次确认、restore 直接执行。它不是共用面板的分区（远端有独立的令牌语义），
 * 所以和远端一样只作为面板底部的宿主插槽出现。
 */
export function LocalGitRecoverySection(props: { list: () => Promise<GitRecoveryListing>; restore: (entry: Pick<GitRecoveryEntry, "ref" | "oid" | "path">) => Promise<{ path: string; bytes: number }>; drop: (entry: Pick<GitRecoveryEntry, "ref" | "oid">) => Promise<void>; reloadKey: string; enabled: boolean }) {
	const [open, setOpen] = useState(false);
	const [listing, setListing] = useState<GitRecoveryListing>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const [pendingDrop, setPendingDrop] = useState<GitRecoveryEntry | null>(null);
	const [notice, setNotice] = useState<{ kind: "restored" | "dropped"; path: string }>();
	const active = useRef(0);

	const load = useCallback(async () => {
		const request = ++active.current;
		setLoading(true);
		setError(undefined);
		try {
			const next = await props.list();
			if (request === active.current) setListing(next);
		} catch (caught) {
			if (request === active.current) setError(localGitOperationErrorText(caught) || t("git.recoveryFailed"));
		} finally {
			if (request === active.current) setLoading(false);
		}
	}, [props.list]);

	// 仓库/项目变化后旧列表不再可信：清空，等下一次展开重新读。
	useEffect(() => {
		active.current += 1;
		setListing(undefined);
		setPendingDrop(null);
		setNotice(undefined);
	}, [props.reloadKey]);

	useEffect(() => {
		if (open && props.enabled && listing === undefined && !loading) void load();
	}, [open, props.enabled, listing, loading, load]);

	const restore = async (entry: GitRecoveryEntry) => {
		try {
			await props.restore(entry);
			setNotice({ kind: "restored", path: entry.path });
			void load();
		} catch (caught) {
			setError(localGitOperationErrorText(caught) || t("git.recoveryFailed"));
		}
	};
	const drop = async (entry: GitRecoveryEntry) => {
		setPendingDrop(null);
		try {
			await props.drop(entry);
			setNotice({ kind: "dropped", path: entry.path });
			void load();
		} catch (caught) {
			setError(localGitOperationErrorText(caught) || t("git.recoveryFailed"));
		}
	};

	return (
		<section data-testid="local-git-recovery" id="git-pane-local-recovery" className="border-b border-[var(--git-panel-border)] last:border-b-0">
			<PaneHeader
				id="local-recovery"
				title={t("remoteGit.recoveryTitle")}
				count={listing?.entries.length}
				open={open}
				onToggle={() => {
					if (open && error !== undefined) void load();
					else setOpen(!open);
				}}
			/>
			{open ? (
				props.enabled ? (
					<>
						{loading ? <p className="px-2.5 text-micro text-[var(--git-desc-fg)]">{t("remoteGit.loading")}</p> : null}
						{error !== undefined ? <GitInlineErrorNotice message={error} className="px-2.5 text-micro text-danger" /> : null}
						{listing && listing.entries.length === 0 ? <p className="px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">{t("remoteGit.recoveryEmpty")}</p> : null}
						{listing?.truncated ? <p className="px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">{t("remoteGit.recoveryTruncated")}</p> : null}
						{listing?.entries.map((entry) => (
							<div key={entry.ref} data-testid="local-git-recovery-row" className="flex items-center gap-2 px-2.5 py-0.5 text-micro hover:bg-muted">
								<span className="min-w-0 flex-1 truncate">{entry.path}</span>
								<span className="shrink-0 text-[var(--git-desc-fg)]">
									{Math.max(1, Math.round(entry.bytes / 1024))} KiB · {t(relativeTimeParts(entry.at).key, relativeTimeParts(entry.at).params)}
								</span>
								<Button type="button" variant="ghost" size="xs" data-testid="local-git-recovery-restore" onClick={() => void restore(entry)}>
									{t("remoteGit.recoveryRestore")}
								</Button>
								<Button type="button" variant="ghost" size="xs" data-testid="local-git-recovery-drop" onClick={() => setPendingDrop(entry)}>
									{t("remoteGit.recoveryDrop")}
								</Button>
							</div>
						))}
						{pendingDrop ? (
							<div data-testid="local-git-recovery-drop-confirm-bar" className="mx-2.5 my-1 rounded-sm border border-danger p-2 text-micro">
								<p>{t("remoteGit.recoveryDropConfirm", { path: pendingDrop.path })}</p>
								<div className="flex items-center gap-2 pt-1">
									<Button type="button" size="xs" data-testid="local-git-recovery-drop-confirm" onClick={() => void drop(pendingDrop)}>
										{t("remoteGit.recoveryDropAction")}
									</Button>
									<Button type="button" variant="ghost" size="xs" data-testid="local-git-recovery-drop-cancel" onClick={() => setPendingDrop(null)}>
										{t("remoteGit.recoveryDropCancel")}
									</Button>
								</div>
							</div>
						) : null}
						{notice ? (
							<p data-testid="local-git-recovery-outcome" className="px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">
								{t(notice.kind === "restored" ? "remoteGit.recoveryRestored" : "remoteGit.recoveryDropped", { path: notice.path })}
							</p>
						) : null}
					</>
				) : (
					<p data-testid="local-git-recovery-closed" className="px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">
						{t("remoteGit.unsupported")}
					</p>
				)
			) : null}
		</section>
	);
}
