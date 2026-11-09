import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteHostPiProbeResult } from "../../shared/types/remoteHost";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { normalizeRemotePiPath } from "../remote/RemotePiDiscovery";
import { codeOf, HOST_ID } from "./remoteHostInputValidation";

/**
 * 远端 pi 环境域：在「添加/编辑连接」的同一张表单里检测远端 pi，不再另开进度弹窗。
 *
 * 两条通道职责分开：
 * - `remote:pi-probe` 只读：按主机档案探测（必要时建立受管会话、读一次登录 shell 的 PATH）；
 * - `remote:pi-path` 先写一个字段（手填的 pi 绝对路径，null = 清回自动探测），再探测一次。
 *
 * 写路径必须走这里而不是通用编辑通道：它只改 pi 路径，不影响端点与 pin；并且主进程要在同一次
 * 操作里作废该主机缓存的探测结果（缓存键是 held session 的代数，写库不会自动让它失效）。
 *
 * 从 `remoteHostIpc` 拆出来的理由与编辑域/扫描域相同：那个文件已接近体量红线，这两条 handler 与
 * 列表/连接开关/修复无关。依赖全部由调用方注入，共用同一份 service 实例。
 */
export function registerRemoteHostPiIpc(input: { enabled: boolean; resolveService: () => Promise<{ service: RemoteHostConnectionService } | { code: string }> }): void {
	/** 探测一次并折叠成脱敏结果：所有失败都塌缩到稳定码，不回传异常消息与命令。 */
	const probe = async (service: RemoteHostConnectionService, hostId: string): Promise<RemoteHostPiProbeResult> => {
		try {
			const facts = await service.remotePiRuntimeFacts(hostId);
			return { ok: true, hostId, piPath: facts.piPath, version: facts.version, ...(facts.warning === undefined ? {} : { warning: facts.warning }) };
		} catch (error) {
			return { ok: false, hostId, code: codeOf(error, "REMOTE_PI_PROBE_FAILED") };
		}
	};

	ipcMain.handle(ipcChannels.remoteHostPiProbe, async (_event, rawHostId: unknown): Promise<RemoteHostPiProbeResult> => {
		const hostId = typeof rawHostId === "string" ? rawHostId : "";
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		if (!HOST_ID.test(hostId)) return { ok: false, hostId, code: "REMOTE_HOST_ID_INVALID" };
		const resolved = await input.resolveService();
		if (!("service" in resolved)) return { ok: false, hostId, code: resolved.code };
		return probe(resolved.service, hostId);
	});

	ipcMain.handle(ipcChannels.remoteHostPiPath, async (_event, rawHostId: unknown, rawPath: unknown): Promise<RemoteHostPiProbeResult> => {
		const hostId = typeof rawHostId === "string" ? rawHostId : "";
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		if (!HOST_ID.test(hostId)) return { ok: false, hostId, code: "REMOTE_HOST_ID_INVALID" };
		// null（以及空串）表示「回到自动探测」；其余必须是远端绝对路径的可执行文件。
		// 形状校验与探测共用一份（normalizeRemotePiPath），否则会出现「存得进、探测说非法」。
		let command: string | undefined;
		if (rawPath !== null && rawPath !== undefined && rawPath !== "") {
			try {
				command = normalizeRemotePiPath(typeof rawPath === "string" ? rawPath.trim() : rawPath);
			} catch {
				return { ok: false, hostId, code: "REMOTE_PI_PATH_INVALID" };
			}
		}
		const resolved = await input.resolveService();
		if (!("service" in resolved)) return { ok: false, hostId, code: resolved.code };
		try {
			await resolved.service.setRemotePiCommand(hostId, command);
		} catch (error) {
			return { ok: false, hostId, code: codeOf(error, "REMOTE_HOST_EDIT_INVALID") };
		}
		return probe(resolved.service, hostId);
	});
}
