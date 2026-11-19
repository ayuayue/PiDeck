import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { REMOTE_MCP_CODES } from "../../shared/types/remotePiManagement";
import { createRemotePiMcpService } from "../config/RemotePiMcpService";
import type { RemotePiConfigBackend } from "../config/RemotePiConfigBackend";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";

/** 远端 MCP 面：配置快照/保存 + 主机上的 `pi mcp list` / `pi mcp logout`，全部走已验证的那台主机。 */
export function registerRemotePiMcpIpc(deps: {
	enabled: boolean;
	config: RemotePiConfigBackend | undefined;
	service: () => Promise<RemoteHostConnectionService> | undefined;
	run: (input: { hostId: string; remoteCommand: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;
}): void {
	const mcp = createRemotePiMcpService({
		config: () => (deps.enabled ? deps.config : undefined),
		resolveFacts: async (hostId) => {
			const service = await deps.service();
			if (!deps.enabled || !service) throw new Error(REMOTE_MCP_CODES.unavailable);
			const facts = await service.remotePiRuntimeFacts(hostId);
			const home = await service.remoteHome(hostId);
			if (!home) throw new Error(REMOTE_MCP_CODES.unavailable);
			return { ...facts, home };
		},
		run: deps.run,
	});
	ipcMain.handle(ipcChannels.remotePiMcp, (_event, hostId: unknown, input: unknown) => {
		if (!deps.enabled) throw new Error(REMOTE_MCP_CODES.unavailable);
		return mcp.execute(hostId, input);
	});
}
