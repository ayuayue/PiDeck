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

	ipcMain.handle(ipcChannels.voiceTranscriptionRuntimeStatus, async () => {
		const config = await deps.configStore.getPublicConfig();
		return deps.runtimeManager.getStatus({ cliPath: config.cliPath, localModelId: config.localModelId });
	});
	ipcMain.handle(ipcChannels.voiceTranscriptionRuntimeInstall, () => deps.runtimeManager.installRuntime(deps.emitRuntimeProgress));
	ipcMain.handle(ipcChannels.voiceTranscriptionModelInstall, (_event, modelId: unknown) => {
		const def = getWhisperModelDef(modelId);
		if (!def) return Promise.resolve({ ok: false, error: "unknown-model" } as const);
		return deps.runtimeManager.installModel(def.id, deps.emitRuntimeProgress);
	});
	ipcMain.handle(ipcChannels.voiceTranscriptionModelDelete, (_event, modelId: unknown) => {
		const def = getWhisperModelDef(modelId);
		if (!def) return { ok: false, error: "unknown-model" } as const;
		return deps.runtimeManager.deleteModel(def.id as WhisperModelId);
	});
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return Boolean(input) && typeof input === "object";
}

function isRequestId(input: unknown): input is string {
	return typeof input === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(input);
}
