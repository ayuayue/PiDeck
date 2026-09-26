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
	/** 豆包语音的资源 ID（仅 cloudProvider=volcengine 使用）。 */
	cloudResourceId: string;
	hasApiKey: boolean;
	/** 豆包语音的 App ID / Access Token 是否已配置（Access Token 仅旧版控制台需要）。 */
	hasVolcAppId: boolean;
	hasVolcAccessToken: boolean;
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

export type VoiceTranscriptionConfigErrorCode = "invalidConfig" | "secureStorageUnavailable" | "saveFailed";

export type VoiceTranscriptionSaveResult = { ok: true; config: VoiceTranscriptionPublicConfig } | { ok: false; error: VoiceTranscriptionConfigErrorCode };

export type VoiceTranscriptionRequest = {
	requestId: string;
	audio: ArrayBuffer;
	mimeType: string;
};

export type VoiceTranscriptionErrorCode = "invalidRequest" | "notConfigured" | "engineUnavailable" | "invalidKey" | "badBaseUrl" | "network" | "timeout" | "cancelled" | "http" | "empty";

/**
 * 失败时的服务端原始线索：豆包语音的业务码在**响应头**里（X-Api-Status-Code），
 * HTTP 状态码只表示传输层结果，未开通权限/参数错误这类问题只有原始码能区分。
 * logId（X-Tt-Logid）是官方工单要求的定位字段，检测失败时直接带给用户。
 */
export type VoiceTranscriptionFailureDetail = { statusCode?: string; message?: string; logId?: string };

export type VoiceTranscriptionResult = { ok: true; text: string } | { ok: false; error: VoiceTranscriptionErrorCode; detail?: VoiceTranscriptionFailureDetail };

/** 「检测连通性」的结果：探针是一小段静音，因此 ok 表示「凭据/权限/链路可用」而非识别出了字。 */
export type VoiceTranscriptionTestResult = { ok: true } | { ok: false; error: VoiceTranscriptionErrorCode; detail?: VoiceTranscriptionFailureDetail };
