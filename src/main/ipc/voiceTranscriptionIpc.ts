import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { getWhisperModelDef, type WhisperInstallProgress, type WhisperModelId } from "../../shared/types/whisperRuntime";
import type { VoiceTranscriptionConfigStore } from "../voice/VoiceTranscriptionConfigStore";
import type { VoiceTranscriptionService } from "../voice/VoiceTranscriptionService";
import type { WhisperRuntimeManager } from "../voice/WhisperRuntimeManager";

/** Register the narrow renderer-to-main voice transcription boundary. */
export function registerVoiceTranscriptionIpc(deps: {
	configStore: VoiceTranscriptionConfigStore;
	service: VoiceTranscriptionService;
	runtimeManager: WhisperRuntimeManager;
	/** 安装进度广播（main/index 注入 webContents.send；同一次安装串行，target 足够路由）。 */
	emitRuntimeProgress: (progress: WhisperInstallProgress) => void;
	/**
	 * 改动运行时文件（删模型 / 覆盖二进制）之前必须停掉常驻 whisper-server：
	 * Windows 下进程持有 .bin 与 .exe 会让删除/替换直接失败，用户看到的是「删不掉模型」。
	 */
	beforeRuntimeMutation?: () => Promise<void> | void;
}) {
	ipcMain.handle(ipcChannels.voiceTranscriptionGetConfig, () => deps.configStore.getPublicConfig());
	ipcMain.handle(ipcChannels.voiceTranscriptionSaveConfig, (_event, input: unknown) => deps.configStore.saveConfig(input));
	ipcMain.handle(ipcChannels.voiceTranscriptionTranscribe, (_event, input: unknown) => {
		if (!isRecord(input)) return { ok: false, error: "invalidRequest" } as const;
		const audio = input.audio;
		const mimeType = input.mimeType;
		const requestId = input.requestId;
		if (!(audio instanceof ArrayBuffer) || typeof mimeType !== "string" || !isRequestId(requestId)) {
			return { ok: false, error: "invalidRequest" } as const;
		}
		return deps.service.transcribe({ requestId, audio, mimeType });
	});
	ipcMain.handle(ipcChannels.voiceTranscriptionCancel, (_event, requestId: unknown) => {
		if (isRequestId(requestId)) deps.service.cancel(requestId);
	});
	// 检测连通性：无入参（配置以磁盘上的为准），探针音频由主进程自带，渲染层拿不到密钥。
	ipcMain.handle(ipcChannels.voiceTranscriptionTest, () => deps.service.testConnection());

	ipcMain.handle(ipcChannels.voiceTranscriptionRuntimeStatus, async () => {
		const config = await deps.configStore.getPublicConfig();
		return deps.runtimeManager.getStatus({ cliPath: config.cliPath, localModelId: config.localModelId });
	});
	ipcMain.handle(ipcChannels.voiceTranscriptionRuntimeInstall, async () => {
		await deps.beforeRuntimeMutation?.();
		return deps.runtimeManager.installRuntime(deps.emitRuntimeProgress);
	});
	ipcMain.handle(ipcChannels.voiceTranscriptionModelInstall, async (_event, modelId: unknown) => {
		const def = getWhisperModelDef(modelId);
		if (!def) return { ok: false, error: "unknown-model" } as const;
		await deps.beforeRuntimeMutation?.();
		return deps.runtimeManager.installModel(def.id, deps.emitRuntimeProgress);
	});
	ipcMain.handle(ipcChannels.voiceTranscriptionModelDelete, async (_event, modelId: unknown) => {
		const def = getWhisperModelDef(modelId);
		if (!def) return { ok: false, error: "unknown-model" } as const;
		await deps.beforeRuntimeMutation?.();
		return deps.runtimeManager.deleteModel(def.id as WhisperModelId);
	});
	// 取消下载：AbortSignal 跨不过 IPC，所以由主进程侧的管理器自己持有并中止。
	ipcMain.handle(ipcChannels.voiceTranscriptionInstallCancel, () => deps.runtimeManager.abortInstall());
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return Boolean(input) && typeof input === "object";
}

function isRequestId(input: unknown): input is string {
	return typeof input === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(input);
}
