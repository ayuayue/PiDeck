/**
 * 远端 Pi 模型目录 IPC（Phase 5 row 819）。单条通道：`remote:pi-models`。
 *
 * 边界：
 * - 渲染层只能传 hostId；服务内部校验 host 形状并在非法时零依赖调用返回稳定码；
 * - 功能门禁与其它 remote 域一致（正式包/未开启实验时连「有这条路」都不暴露），门禁关闭返回 UNAVAILABLE；
 * - handler 只做门禁与转发，不做 project/agent 解析，也不把自由文本错误跨边界。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { REMOTE_MODEL_PROBE_CODES, type RemoteModelProbeResult } from "../../shared/types/remoteModel";
import { maskRemoteModelCatalog, type RemotePiModelProbe } from "../pi/RemotePiModelProbe";
import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";
import { REMOTE_MODEL_CATALOG_CODES, type RemoteModelCatalog } from "../remote/RemotePiModelCatalog";

export function registerRemotePiModelIpc(input: { enabled: boolean; probe?: RemotePiModelProbe; catalog?: RemoteModelCatalog }): void {
	ipcMain.handle(ipcChannels.remotePiModels, async (_event, hostId: unknown, force: unknown = false): Promise<RemoteModelProbeResult> => {
		if (!input.enabled) return { ok: false, code: REMOTE_MODEL_PROBE_CODES.unavailable };
		if (typeof hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(hostId) || typeof force !== "boolean") return { ok: false, code: REMOTE_MODEL_PROBE_CODES.targetInvalid };
		try {
			if (input.catalog) {
				const result = await input.catalog.load({ hostId, force });
				return result.ok ? maskRemoteModelCatalog(hostId, result.models) : { ok: false, code: result.code === REMOTE_MODEL_CATALOG_CODES.empty ? REMOTE_MODEL_PROBE_CODES.empty : REMOTE_MODEL_PROBE_CODES.failed };
			}
			return input.probe ? await input.probe.probe(hostId) : { ok: false, code: REMOTE_MODEL_PROBE_CODES.unavailable };
		} catch {
			// Last-resort boundary: even an unexpected service throw must be one of the closed codes, never a raw IPC rejection.
			return { ok: false, code: REMOTE_MODEL_PROBE_CODES.failed };
		}
	});
}
