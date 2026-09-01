import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { VoiceTranscriptionConfigStore } from "../voice/VoiceTranscriptionConfigStore";
import type { VoiceTranscriptionService } from "../voice/VoiceTranscriptionService";

/** Register the narrow renderer-to-main voice transcription boundary. */
export function registerVoiceTranscriptionIpc(deps: {
	configStore: VoiceTranscriptionConfigStore;
	service: VoiceTranscriptionService;
}) {
	ipcMain.handle(ipcChannels.voiceTranscriptionGetConfig, () => deps.configStore.getPublicConfig());
	ipcMain.handle(ipcChannels.voiceTranscriptionSaveConfig, (_event, input: unknown) =>
		deps.configStore.saveConfig(input));
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
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return Boolean(input) && typeof input === "object";
}

function isRequestId(input: unknown): input is string {
	return typeof input === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(input);
}
