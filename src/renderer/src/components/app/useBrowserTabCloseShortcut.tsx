import { useRef, useState } from "react";
import { t } from "../../i18n";
import { useCloseShortcutAction } from "../../hooks/useCloseShortcutAction";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";

/** A close during navigation interrupts the browser guest's current load. */
export function useBrowserTabCloseShortcut(activeTabId: string | null, isLoading: boolean, closeTab: (id: string) => void) {
	const panelRef = useRef<HTMLDivElement>(null);
	const [pendingCloseId, setPendingCloseId] = useState<string>();
	useCloseShortcutAction(panelRef, true, (focusedId) => {
		const id = focusedId ?? activeTabId;
		if (!id) return;
		if (isLoading && id === activeTabId) setPendingCloseId(id);
		else closeTab(id);
	});
	const confirmClose = pendingCloseId && (
		<ConfirmDialog
			title={t("browser.closeLoadingTitle")}
			message={t("browser.closeLoadingBody")}
			confirmLabel={t("browser.closeTab")}
			onCancel={() => setPendingCloseId(undefined)}
			onConfirm={() => {
				setPendingCloseId(undefined);
				closeTab(pendingCloseId);
			}}
			layer="drawer"
		/>
	);
	return { panelRef, confirmClose };
}
