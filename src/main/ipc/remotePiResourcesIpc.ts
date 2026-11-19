import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { REMOTE_RESOURCE_CODES } from "../../shared/types/remotePiManagement";
import { createRemotePiResourceBackend } from "../config/RemotePiResourceBackend";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";

/** Assemble the remote resource domain on the same verified connection used by Pi config and model listing. */
export function registerRemotePiResourcesIpc(deps: { enabled: boolean; service: () => Promise<RemoteHostConnectionService> | undefined; run: (input: { hostId: string; remoteCommand: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr?: string }> }): void {
	const backend = createRemotePiResourceBackend({
		request: async (hostId, method, params) => {
			const service = await deps.service();
			if (!deps.enabled || !service) throw new Error(REMOTE_RESOURCE_CODES.unavailable);
			return service.request(hostId, method, params, { timeoutMs: 30000 });
		},
		resolveFacts: async (hostId) => {
			const service = await deps.service();
			if (!deps.enabled || !service) throw new Error(REMOTE_RESOURCE_CODES.unavailable);
			const facts = await service.remotePiRuntimeFacts(hostId);
			const home = await service.remoteHome(hostId);
			if (!home) throw new Error(REMOTE_RESOURCE_CODES.unavailable);
			return { ...facts, home };
		},
		run: deps.run,
	});
	ipcMain.handle(ipcChannels.remotePiResources, (_event, hostId: unknown, input: unknown) => {
		if (!deps.enabled) throw new Error(REMOTE_RESOURCE_CODES.unavailable);
		return backend.execute(hostId, input);
	});
}
