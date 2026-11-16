import { useEffect, useRef, useState } from "react";
import type { RemoteProject } from "../../../../shared/types/project";
import { useRemoteProjectTrust } from "../../hooks/useRemoteProjectTrust";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

/** Reuse the existing project-resource decision, explicitly disclosing pi's next-spawn effect; never grant hooks/filters. */
export function RemoteGitTrustGate({ project, onApproved }: { project: RemoteProject; onApproved: () => void }) {
	const trust = useRemoteProjectTrust();
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const approve = async () => {
		if (busy) return;
		setBusy(true);
		setFailed(false);
		const result = await trust.decide({ hostId: project.locator.hostId, remoteRoot: project.locator.remotePath }, "approve");
		if (!mounted.current) return;
		setBusy(false);
		if (!result.ok) setFailed(true);
		else onApproved();
	};
	return (
		<div className="flex shrink-0 flex-col gap-2 px-2.5 pb-3 text-micro text-[var(--git-desc-fg)]">
			<p>{t("remoteGit.trustEffect")}</p>
			<span className="select-all break-all font-mono">{project.locator.remotePath}</span>
			<Button
				size="sm"
				disabled={busy}
				onClick={() => {
					void approve();
				}}
			>
				{t("remoteGit.trustApprove")}
			</Button>
			{failed ? (
				<p role="alert" className="text-danger">
					{t("remoteGit.trustFailed")}
				</p>
			) : null}
		</div>
	);
}
