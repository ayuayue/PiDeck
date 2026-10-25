import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { getWhisperModelDef, type WhisperInstallProgress, type WhisperModelId } from "../../shared/types/whisperRuntime";
import type { VoiceTranscriptionSecretField } from "../../shared/types/voiceTranscription";
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

	// ===== 流式识别（豆包流式 2.0）=====
	ipcMain.handle(ipcChannels.voiceTranscriptionStreamStart, (_event, input: unknown) => {
		if (!isRecord(input)) return { ok: false, error: "invalidRequest" } as const;
		const requestId = input.requestId;
		const sampleRate = input.sampleRate;
		if (!isRequestId(requestId) || typeof sampleRate !== "number" || !Number.isInteger(sampleRate)) return { ok: false, error: "invalidRequest" } as const;
		return deps.service.startStream({ requestId, sampleRate });
	});
	// 音频帧是单向流水：用 on 而不是 handle，省掉每帧一次 promise 往返。
	ipcMain.on(ipcChannels.voiceTranscriptionStreamFrame, (_event, input: unknown) => {
		if (!isRecord(input)) return;
		const requestId = input.requestId;
		const pcm = input.pcm;
		if (isRequestId(requestId) && pcm instanceof ArrayBuffer) deps.service.pushStreamFrame({ requestId, pcm });
	});
	ipcMain.handle(ipcChannels.voiceTranscriptionStreamFinish, (_event, requestId: unknown) => (isRequestId(requestId) ? deps.service.finishStream(requestId) : Promise.resolve({ ok: false, error: "invalidRequest" } as const)));
	// 检测连通性：无入参（配置以磁盘上的为准），探针音频由主进程自带，渲染层拿不到密钥。
	ipcMain.handle(ipcChannels.voiceTranscriptionTest, () => deps.service.testConnection());
	// 设置页点「显示」时按需取回某一格明文：入参只认三个字段名，其余一律 null。
	ipcMain.handle(ipcChannels.voiceTranscriptionRevealSecret, (_event, field: unknown) => (isSecretField(field) ? deps.configStore.revealSecret(field) : Promise.resolve(null)));

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

/** 渲染层来的字段名一律不可信：只有这三格可以要求主进程解密。 */
function isSecretField(input: unknown): input is VoiceTranscriptionSecretField {
	return input === "apiKey" || input === "volcAppId" || input === "volcAccessToken";
}
