import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { settingsDirtyForWindowCloseAtom } from "../../atoms/workspace-page-atoms";

/** Advertise Settings' in-memory changes even when its tab is in the background. */
export function useSettingsCloseRisk(hasRisk: boolean) {
	const reportRisk = useSetAtom(settingsDirtyForWindowCloseAtom);
	useEffect(() => {
		reportRisk(hasRisk);
		return () => reportRisk(false);
	}, [hasRisk, reportRisk]);
}
