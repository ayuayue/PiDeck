import { createContext, useContext, useMemo } from "react";
import type { PiDesktopApi } from "../../../preload";
import type { PiConfigTarget } from "../../../shared/piConfig";
import { desktopApi } from "../desktopApi";
import { createRemoteConfigEditorApi } from "./remoteConfigEditorApi";
import { useRemoteHostConnection } from "./useRemoteHostConnection";

import type { RemoteModelCatalogEntry } from "../../../shared/types/remoteModel";
type ConfigEditor = {
	api: PiDesktopApi;
	rawApi: PiDesktopApi;
	remote: boolean;
	reload?: () => void;
	loadRemoteModels?: (force?: boolean) => Promise<RemoteModelCatalogEntry[]>;
	fetchRemoteProviderModels?: (provider: string) => ReturnType<PiDesktopApi["config"]["fetchModels"]>;
	copyProviderSecrets?: (from: string, to: string) => void;
};
export const ConfigEditorContext = createContext<ConfigEditor>({ api: desktopApi, rawApi: desktopApi, remote: false });

/** Shared forms and their nested provider pages use the same selected-environment API. */
export function useConfigEditor() {
	return useContext(ConfigEditorContext);
}

export function useConfigEditorApi(target: PiConfigTarget, api: PiDesktopApi, projectId?: string) {
	const { ensureConnected } = useRemoteHostConnection();
	const hostId = target.kind === "ssh" ? target.hostId : undefined;
	return useMemo<ConfigEditor>(() => {
		if (!hostId) return { api, rawApi: api, remote: false };
		const remoteApi = createRemoteConfigEditorApi(api, hostId, ensureConnected, projectId);
		return { api: remoteApi, rawApi: remoteApi.rawApi, remote: true, reload: remoteApi.reloadRemoteConfig, loadRemoteModels: remoteApi.loadRemoteModels, fetchRemoteProviderModels: remoteApi.fetchRemoteProviderModels, copyProviderSecrets: remoteApi.copyProviderSecrets };
	}, [api, hostId, projectId, ensureConnected]);
}
