import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { REMOTE_RESOURCE_CODES } from "../../shared/types/remotePiManagement";
import { createRemotePiResourceBackend } from "../config/RemotePiResourceBackend";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import type { SshProjectLocator } from "../../shared/projectLocation";

/**
 * Assemble the remote resource domain on the same verified connection used by Pi config and model listing.
 *
 * Two layers are served: the host's global user resources (a host-level session) and one registered
 * project's own resources (a session confined to that project's root). The project layer never accepts a
 * path from the renderer — only a registered project id, resolved here through the project catalog — so a
 * page can neither address a sibling project nor fall back to the local manager.
 */
export function registerRemotePiResourcesIpc(deps: {
	enabled: boolean;
	service: () => Promise<RemoteHostConnectionService> | undefined;
	run: (input: { hostId: string; remoteCommand: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;
	/** Registered project id → its SSH locator; `undefined` means "not an enrolled remote project". */
	locator?: (projectId: string) => SshProjectLocator | undefined;
}): void {
	const backend = createRemotePiResourceBackend({
		request: async (hostId, method, params) => {
			const service = await deps.service();
			if (!deps.enabled || !service) throw new Error(REMOTE_RESOURCE_CODES.unavailable);
			return service.request(hostId, method, params, { timeoutMs: 30000 });
		},
		requestProject: async (hostId, root, method, params) => {
			const service = await deps.service();
			if (!deps.enabled || !service) throw new Error(REMOTE_RESOURCE_CODES.unavailable);
			// The host lock is held for the whole frame, so a sibling project's root switch cannot land
			// between two frames of this operation.
			const outcome = await service.withProjectSession(hostId, root, (session) => session.request(method, params));
			if (!outcome.ok) throw new Error(outcome.code);
			return outcome.value;
		},
		resolveProject: async (projectId) => {
			if (!deps.enabled) throw new Error(REMOTE_RESOURCE_CODES.unavailable);
			const locator = deps.locator?.(projectId);
			if (locator === undefined || locator.kind !== "ssh") return { code: REMOTE_RESOURCE_CODES.invalid };
			return { hostId: locator.hostId, root: locator.remotePath };
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
