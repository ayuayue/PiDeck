import { useEffect, useState } from "react";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { SettingSwitchRow } from "./SettingRows";

/** Registry state is the only source of truth; no settings.json mirror. */
export function QuickTaskMenuSetting() {
	const [state, setState] = useState({ supported: false, registered: false });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		let alive = true;
		void desktopApi.shellMenu
			.getQuickTaskState()
			.then((value) => {
				if (alive) setState(value);
			})
			.catch(() => {
				if (alive) setError(t("quickTask.error.unknown"));
			});
		return () => {
			alive = false;
		};
	}, []);
	return (
		<>
			<SettingSwitchRow
				anchor="common-quick-task-menu"
				title={t("quickTask.menuTitle")}
				description={t("quickTask.menuDescription")}
				checked={state.registered}
				disabled={busy || !state.supported}
				onChange={(enabled) => {
					setBusy(true);
					setError("");
					void desktopApi.shellMenu
						.setQuickTaskEnabled(enabled)
						.then(setState)
						.catch(() => {
							setError(t("quickTask.error.unknown"));
							void desktopApi.shellMenu
								.getQuickTaskState()
								.then(setState)
								.catch(() => undefined);
						})
						.finally(() => setBusy(false));
				}}
			/>
			{error && (
				<p role="alert" className="px-4 pb-2 text-xs text-destructive">
					{error}
				</p>
			)}
		</>
	);
}
