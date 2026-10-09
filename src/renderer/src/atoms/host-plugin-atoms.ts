import { atom } from "jotai";
import type { HostPluginCatalog } from "../../../shared/types/hostPlugin";
import { desktopApi } from "../desktopApi";

export type HostPluginCatalogState = { catalog?: HostPluginCatalog; error?: string };
/** One catalog subscription for the settings page, command palette and panel host. */
export const hostPluginCatalogAtom = atom<HostPluginCatalogState>({});
hostPluginCatalogAtom.onMount = (set) => {
	let disposed = false;
	let revision = 0;
	const refresh = async () => {
		const current = ++revision;
		try {
			const result = await desktopApi.hostPlugins.list();
			if (!disposed && current === revision) set(result.ok ? { catalog: result.value } : { error: result.code });
		} catch {
			if (!disposed && current === revision) set({ error: "plugin-host-unavailable" });
		}
	};
	let unsubscribe: (() => void) | undefined;
	try {
		unsubscribe = desktopApi.hostPlugins.onChanged(() => void refresh());
	} catch {
		/* Missing desktop preload has no plugin host. */
	}
	void refresh();
	return () => {
		disposed = true;
		revision += 1;
		unsubscribe?.();
	};
};

/** Phase one has one independent surface per desktop window, not one per pi process. */
export const hostPluginPanelAtom = atom<{ pluginId: string; panelId: string } | null>(null);
