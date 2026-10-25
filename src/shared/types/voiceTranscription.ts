import type { VoiceTranscriptionCloudProvider, VoiceTranscriptionEngine } from "../voiceTranscriptionConfig";
import type { WhisperModelId } from "./whisperRuntime";

export type VoiceTranscriptionPublicConfig = {
	/** 语音输入总开关：关闭时渲染层隐藏录音按钮。 */
	enabled: boolean;
	engine: VoiceTranscriptionEngine;
	/** 云端引擎走哪家的协议（engine=cloud 时生效）。 */
	cloudProvider: VoiceTranscriptionCloudProvider;
	baseUrl: string;
	model: string;
	language: string;
	inputDeviceId: string;
	localModelId: WhisperModelId;
	cliPath: string;
	/** 豆包语音的资源 ID（仅 cloudProvider=volcengine 使用）：同时决定走流式 2.0 还是极速版。 */
	cloudResourceId: string;
	hasApiKey: boolean;
	/** 豆包语音的 App ID / Access Token 是否已配置（Access Token 仅旧版控制台需要）。 */
	hasVolcAppId: boolean;
	hasVolcAccessToken: boolean;
	/** 三格已保存密钥的核对摘要（未配置为 null）；明文只在用户点「显示」时按需取回。 */
	apiKeyHint: VoiceTranscriptionSecretHint | null;
	volcAppIdHint: VoiceTranscriptionSecretHint | null;
	volcAccessTokenHint: VoiceTranscriptionSecretHint | null;
	/**
	 * 当前引擎的「转写能力就绪」判定（主进程计算）：
	 * cloud = 凭据与端点是否配齐（按 provider 各自的必填项）；
	 * local = whisper-cli 可解析且所选模型已安装。
	 */
	runtimeReady: boolean;
};

export type VoiceTranscriptionSaveInput = {
	enabled: boolean;
	engine: VoiceTranscriptionEngine;
	cloudProvider: VoiceTranscriptionCloudProvider;
	baseUrl: string;
	model: string;
	language: string;
	inputDeviceId: string;
	localModelId: WhisperModelId;
	cliPath: string;
	cloudResourceId: string;
	/** OpenAI 兼容服务的 API Key。仅在非空时更新。 */
	apiKey?: string;
	/** 豆包语音的 App ID（新版控制台下这一格就是 API Key）。仅在非空时更新。 */
	volcAppId?: string;
	/** 豆包语音的 Access Token（旧版控制台必填）。仅在非空时更新。 */
	volcAccessToken?: string;
	/** 清空当前 cloudProvider 那一家的全部密钥。 */
	clearApiKey?: boolean;
};

/** saveConfig 里的密钥字段名：设置页与主进程密钥表共用，避免两处拼写漂移。 */
export type VoiceTranscriptionSecretField = "apiKey" | "volcAppId" | "volcAccessToken";

/**
 * 已保存密钥的核对摘要：主进程只给「末若干位 + 总长」，明文仍不出主进程。
 * 存在的理由是「留空则保留」的输入框看不见存了什么，用户无法判断填反了、截断了还是配了另一家。
 */
export type VoiceTranscriptionSecretHint = { tail: string; length: number };

export type VoiceTranscriptionConfigErrorCode = "invalidConfig" | "secureStorageUnavailable" | "saveFailed";

export type VoiceTranscriptionSaveResult = { ok: true; config: VoiceTranscriptionPublicConfig } | { ok: false; error: VoiceTranscriptionConfigErrorCode };

export type VoiceTranscriptionRequest = {
	requestId: string;
	audio: ArrayBuffer;
	mimeType: string;
};

/**
 * `invalidKey` 与 `notGranted` 必须分开：豆包语音对「凭据不配对」和「应用没开通该资源」
 * 都回 HTTP 401/403，只按状态码分类会把后者也说成「API Key 无效」，用户于是反复改密钥、
 * 而真正该做的（控制台「开通管理」里勾选资源）永远没人提示。
 */
export type VoiceTranscriptionErrorCode = "invalidRequest" | "notConfigured" | "engineUnavailable" | "invalidKey" | "notGranted" | "badBaseUrl" | "network" | "timeout" | "cancelled" | "http" | "empty" | "sessionTooLong";

/**
 * 失败时的服务端原始线索：豆包语音的业务码在**响应头**里（X-Api-Status-Code），
 * HTTP 状态码只表示传输层结果，未开通权限/参数错误这类问题只有原始码能区分。
 * logId（X-Tt-Logid）是官方工单要求的定位字段，检测失败时直接带给用户。
 */
export type VoiceTranscriptionFailureDetail = { statusCode?: string; message?: string; logId?: string };

export type VoiceTranscriptionResult = { ok: true; text: string } | { ok: false; error: VoiceTranscriptionErrorCode; detail?: VoiceTranscriptionFailureDetail };

/** 「检测连通性」的结果：探针是一小段静音，因此 ok 表示「凭据/权限/链路可用」而非识别出了字。 */
export type VoiceTranscriptionTestResult = { ok: true } | { ok: false; error: VoiceTranscriptionErrorCode; detail?: VoiceTranscriptionFailureDetail };

/**
 * 流式识别（豆包流式语音识别模型 2.0）的会话契约：渲染层按定长帧上推 PCM，主进程持有
 * 唯一的 WebSocket 并回推中间结果。三条上行都用 requestId 关联，取消仍走 `voice-transcription:cancel`
 * （与整段转写共用同一张在飞表，避免两套取消语义）。
 */
export type VoiceTranscriptionStreamStartInput = {
	requestId: string;
	/** 上行 PCM 的采样率；目前只接受 {@link VOICE_STREAM_SAMPLE_RATE}，其余按 invalidRequest 拒掉。 */
	sampleRate: number;
};

/** 一帧音频：16bit 小端单声道 PCM，不含 WAV 头。 */
export type VoiceTranscriptionStreamFrame = { requestId: string; pcm: ArrayBuffer };

/** 开流结果：握手与 init ACK 都过了才 ok，失败时把服务端原始码带回给设置页。 */
export type VoiceTranscriptionStreamStartResult = { ok: true } | { ok: false; error: VoiceTranscriptionErrorCode; detail?: VoiceTranscriptionFailureDetail };

/**
 * 中间结果推送。`text` 是**整段会话的累积文本**而不是增量——实测豆包流式每帧都回全量
 * （且会回头修改已出片的标点），所以渲染层要「整段替换」而不是逐次追字。
 */
export type VoiceTranscriptionStreamPartial = { requestId: string; text: string; final: boolean };
