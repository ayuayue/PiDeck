import type { VoiceTranscriptionEngine } from "../voiceTranscriptionConfig";
import type { WhisperModelId } from "./whisperRuntime";

export type VoiceTranscriptionPublicConfig = {
	/** 语音输入总开关：关闭时渲染层隐藏录音按钮。 */
	enabled: boolean;
	engine: VoiceTranscriptionEngine;
	baseUrl: string;
	model: string;
	language: string;
	inputDeviceId: string;
	localModelId: WhisperModelId;
	cliPath: string;
	hasApiKey: boolean;
	/**
	 * 当前引擎的「转写能力就绪」判定（主进程计算）：
	 * cloud = true（是否配置完整由渲染层按 hasApiKey/baseUrl/model 判断）；
	 * local = whisper-cli 可解析且所选模型已安装。
	 */
	runtimeReady: boolean;
};

export type VoiceTranscriptionSaveInput = {
	enabled: boolean;
	engine: VoiceTranscriptionEngine;
	baseUrl: string;
	model: string;
	language: string;
	inputDeviceId: string;
	localModelId: WhisperModelId;
	cliPath: string;
	apiKey?: string;
	clearApiKey?: boolean;
};

export type VoiceTranscriptionConfigErrorCode = "invalidConfig" | "secureStorageUnavailable" | "saveFailed";

export type VoiceTranscriptionSaveResult = { ok: true; config: VoiceTranscriptionPublicConfig } | { ok: false; error: VoiceTranscriptionConfigErrorCode };

export type VoiceTranscriptionRequest = {
	requestId: string;
	audio: ArrayBuffer;
	mimeType: string;
};

export type VoiceTranscriptionErrorCode = "invalidRequest" | "notConfigured" | "engineUnavailable" | "invalidKey" | "badBaseUrl" | "network" | "timeout" | "cancelled" | "http" | "empty";

export type VoiceTranscriptionResult = { ok: true; text: string } | { ok: false; error: VoiceTranscriptionErrorCode };
