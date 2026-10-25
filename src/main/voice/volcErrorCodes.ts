import type { VoiceTranscriptionErrorCode, VoiceTranscriptionFailureDetail } from "../../shared/types/voiceTranscription";

/**
 * 豆包语音（火山引擎）的业务码在两条通路上是**同一张表**：
 * - 极速版 HTTP：码在响应头 `X-Api-Status-Code`；
 * - 流式 2.0 WebSocket：码在 `SERVER_ERROR_RESPONSE` 帧的 4 字节整型字段里。
 * 两条通路必须共用这张表，否则同一件事（例如「资源没开通」）会在一处说成「Key 无效」、
 * 在另一处说成别的——2026-09-26 就是被 45000030 误报成 API Key 无效，用户反复改密钥而没人提示去开通。
 */
export const VOLC_CODE_SUCCESS = "20000000";
/** 「音频里没有有效语音」：静音探针拿它是**好结果**（说明服务端已经解开音频，链路通）。 */
export const VOLC_CODE_SILENT_AUDIO = "20000003";
/** 流式协议帧解不开（实测：收尾包序号没取负时回这个码）。 */
const VOLC_CODE_DECODE_FAILED = "45000000";
const VOLC_CODE_INVALID_PARAMS = "45000001";
const VOLC_CODE_EMPTY_AUDIO = "45000002";
/** App ID 与 Access Token 不配对：`request and grant appid mismatch`。 */
const VOLC_CODE_APP_ID_MISMATCH = "45000010";
/** `X-Api-Resource-Id` 对应的资源没在该应用下开通：`requested resource not granted`。 */
const VOLC_CODE_RESOURCE_NOT_GRANTED = "45000030";
/** 音频格式不被接受（例如把 webm/opus 当 wav 送）。 */
const VOLC_CODE_BAD_FORMAT = "45000151";

const ERROR_BY_BUSINESS_CODE: Record<string, VoiceTranscriptionErrorCode> = {
	[VOLC_CODE_DECODE_FAILED]: "invalidRequest",
	[VOLC_CODE_INVALID_PARAMS]: "invalidRequest",
	[VOLC_CODE_EMPTY_AUDIO]: "empty",
	[VOLC_CODE_BAD_FORMAT]: "invalidRequest",
	[VOLC_CODE_APP_ID_MISMATCH]: "invalidKey",
	[VOLC_CODE_RESOURCE_NOT_GRANTED]: "notGranted",
};

/**
 * 业务码 → 错误语义；HTTP 状态码只在没有业务码时兜底（401/403 既可能是鉴权失败也可能是没开通权限，
 * 单看状态码分不开，这正是必须带出业务码的原因）。
 */
export function classifyVolcFailure(businessCode: string, httpStatus?: number): VoiceTranscriptionErrorCode {
	const known = ERROR_BY_BUSINESS_CODE[businessCode];
	if (known) return known;
	if (httpStatus === 401 || httpStatus === 403) return "invalidKey";
	if (httpStatus === 404 || httpStatus === 405) return "badBaseUrl";
	return "http";
}

/** 服务端文案是外部数据：进 UI/日志前限行（正常几十字符，超长即异常或注入尝试）。 */
const MAX_MESSAGE_LENGTH = 200;

export function boundVolcMessage(raw: string | undefined | null): string {
	return (raw ?? "").slice(0, MAX_MESSAGE_LENGTH);
}

/** 组装失败线索：码与文案原样带出，供设置页按码给差异化文案、提工单时定位。 */
export function volcFailureDetail(businessCode: string, message: string | undefined | null, logId: string): VoiceTranscriptionFailureDetail {
	return { statusCode: businessCode, message: boundVolcMessage(message), logId };
}
