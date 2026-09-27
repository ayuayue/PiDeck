import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteHostListResult } from "../../shared/types/remoteHost";
import type { RemoteHostStoreState } from "../remote/RemoteHostStore";

/** Dev-only host listing: never expose pins, identity paths or endpoint trust metadata to renderer. */
export function registerRemoteHostIpc(input: { enabled: boolean; list: () => Promise<RemoteHostStoreState> }): void {
	ipcMain.handle(ipcChannels.remoteHostsList, async (): Promise<RemoteHostListResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		try {
			const snapshot = await input.list();
			return {
				ok: true,
				status: snapshot.status,
				hosts: snapshot.profiles.map(({ id, label, sshHost, verifiedEndpoint, disabledAt }) => ({ id, label, sshHost, verified: verifiedEndpoint !== undefined, disabled: disabledAt !== undefined })),
			};
		} catch {
			return { ok: false, code: "REMOTE_HOST_LIST_UNAVAILABLE" };
		}
	});
}
