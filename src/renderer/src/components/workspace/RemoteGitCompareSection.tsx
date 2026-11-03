import { useState } from "react";
import type { RemoteGitCompare, RemoteGitRef, RemoteGitRefs } from "../../../../shared/types/git";
import { t } from "../../i18n";
import { GitInlineErrorNotice } from "../app/git/GitInlineErrorNotice";
import { Button } from "../ui-shadcn/button";
import { RemoteGitCapabilityNote } from "./RemoteGitCapabilityNote";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";

/**
 * G5b refs compare, kept out of RemoteGitPanel so the panel stays a composition surface. The component owns
 * only its own UI state (expanded, chosen pair); the controller owns flights, generations and facts. Expanding
 * it is the gesture that may load the refs list, and a run result is always rendered from the answer's own
 * resolved OIDs so a per-file read names the same two commits.
 */
export type RemoteGitCompareSectionProps = {
	refs: RemoteGitRefs | undefined;
	refsLoading: boolean;
	refsErrorCode: string | undefined;
	compare: RemoteGitCompare | undefined;
	compareLoading: boolean;
	compareErrorCode: string | undefined;
	errorMessage: (code: string) => string;
	/** Expanding the area is a user gesture; the panel may use it to load the refs list once. */
	onNeedRefs: () => void;
	onRun: (base: string, head: string) => void;
	/** Reuses the revision diff surface with the two OIDs the compare answer carried, never the ref names. */
	onOpenFile: (baseOid: string, headOid: string, path: string) => void;
};

function refLabel(ref: RemoteGitRef): string {
	return (ref.kind === "branch" ? t("remoteGit.refBranch") : t("remoteGit.refTag")) + " " + ref.name;
}

export function RemoteGitCompareSection(props: RemoteGitCompareSectionProps) {
	const [open, setOpen] = useState(false);
	const [baseChoice, setBaseChoice] = useState<string | null>(null);
	const [headChoice, setHeadChoice] = useState<string | null>(null);
	const options = props.refs?.refs ?? [];
	// A default pair is derived on every render; a stale manual choice falls back instead of pointing at a ref
	// that disappeared from the refreshed list (Radix Select would otherwise hold a value it cannot display).
	const defaultBase = props.refs?.branch ? "refs/heads/" + props.refs.branch : (options[0]?.fullName ?? "");
	const base = baseChoice !== null && options.some((option) => option.fullName === baseChoice) ? baseChoice : defaultBase;
	const head = headChoice !== null && options.some((option) => option.fullName === headChoice) ? headChoice : (options.find((option) => option.fullName !== base)?.fullName ?? "");
	const pairReady = options.length > 1 && base !== "" && head !== "" && base !== head;
	const toggle = () => {
		if (!open) props.onNeedRefs();
		setOpen(!open);
	};
	return (
		<section data-testid="remote-git-compare" className="pb-2">
			<button type="button" className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium text-text-secondary" aria-expanded={open} onClick={toggle}>
				{t("remoteGit.compareTitle")}
			</button>
			{open ? (
				<>
					{/* 说明条按答案的真实语义判断：merge-base 有 ahead/behind，不能再显示 trees-only 说明。 */}
					<RemoteGitCapabilityNote kind="compare" context={{ compareOpen: open, compareMode: props.compare?.mode }} />
					{props.refsLoading ? <p className="px-3 text-xs text-text-secondary">{t("remoteGit.loading")}</p> : null}
					{props.refsErrorCode ? <GitInlineErrorNotice message={props.errorMessage(props.refsErrorCode)} className="px-3 text-xs text-danger" /> : null}
					<div className="flex items-center gap-2 px-3 pb-1" data-testid="remote-git-compare-pickers">
						<Select value={base} onValueChange={(value) => setBaseChoice(value)} disabled={options.length === 0 || props.compareLoading}>
							<SelectTrigger data-testid="remote-git-compare-base" aria-label={t("remoteGit.compareBase")} size="sm" className="min-w-0 flex-1 text-xs">
								<SelectValue placeholder={t("remoteGit.compareBase")} />
							</SelectTrigger>
							<SelectContent>
								{options.map((ref) => (
									<SelectItem key={ref.fullName} value={ref.fullName}>
										{refLabel(ref)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select value={head} onValueChange={(value) => setHeadChoice(value)} disabled={options.length === 0 || props.compareLoading}>
							<SelectTrigger data-testid="remote-git-compare-head" aria-label={t("remoteGit.compareHead")} size="sm" className="min-w-0 flex-1 text-xs">
								<SelectValue placeholder={t("remoteGit.compareHead")} />
							</SelectTrigger>
							<SelectContent>
								{options.map((ref) => (
									<SelectItem key={ref.fullName} value={ref.fullName}>
										{refLabel(ref)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button type="button" size="sm" data-testid="remote-git-compare-run" disabled={!pairReady || props.compareLoading} onClick={() => props.onRun(base, head)}>
							{t("remoteGit.compareRun")}
						</Button>
					</div>
					{!pairReady ? <p className="px-3 text-xs text-text-secondary">{t("remoteGit.compareSameRef")}</p> : null}
					{props.compareLoading ? <p className="px-3 text-xs text-text-secondary">{t("remoteGit.loading")}</p> : null}
					{props.compareErrorCode ? <GitInlineErrorNotice message={props.errorMessage(props.compareErrorCode)} testId="remote-git-compare-error" className="px-3 text-xs text-danger" /> : null}
					{props.compare && props.compare.files.length === 0 ? (
						<p data-testid="remote-git-compare-empty" className="px-3 text-xs text-text-secondary">
							{t("remoteGit.compareEmpty")}
						</p>
					) : null}
					{props.compare?.files.map((file) => (
						<button
							key={file.status + ":" + file.path + ":" + (file.oldPath ?? "")}
							type="button"
							data-testid="remote-git-compare-file"
							data-status={file.status}
							data-path={file.path}
							data-old-path={file.oldPath}
							className="flex w-full items-center gap-2 px-3 py-0.5 text-left text-xs hover:bg-surface-secondary"
							onClick={() => props.onOpenFile(props.compare?.base.oid ?? "", props.compare?.head.oid ?? "", file.path)}
						>
							<span className="font-mono text-text-secondary">{file.status}</span>
							<span className="min-w-0 flex-1 truncate">{file.path}</span>
							{file.oldPath ? <span className="shrink-0 text-text-secondary">← {file.oldPath}</span> : null}
						</button>
					))}
				</>
			) : null}
		</section>
	);
}
