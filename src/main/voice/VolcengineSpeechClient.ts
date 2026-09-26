import { randomUUID } from "node:crypto";
import { normalizeVolcLanguageTag } from "../../shared/voiceTranscriptionConfig";
import type { VoiceTranscriptionErrorCode, VoiceTranscriptionFailureDetail, VoiceTranscriptionResult } from "../../shared/types/voiceTranscription";
import { readBoundedResponseText } from "./responseText";

/**
 * 火山引擎「豆包语音 · 录音文件识别极速版」客户端。
 *
 * 为什么选这一条接口而不是同族的另外两条（官方文档 docs/6561/1631584 与 1354868）：
 * - 极速版 `recognize/flash`：**一次请求即返回**，音频走 `audio.data` base64 直传，
 *   与本地录音分段（≤10 秒 WAV、≤100MB）的限制天然吻合；
 * - 标准版 `auc/bigmodel/submit` + `query`：只接受**公网可访问的音频 URL**，
 *   桌面端要把用户语音传去某个对象存储——既多一条外部依赖，也和「音频只在本地短暂存在」
 *   的边界冲突；
 * - 流式版：WebSocket 自定义二进制帧协议，为「边说边出字」设计，而渲染层已经按 VAD
 *   分段并逐段插字，收益不抵复杂度。
 *
 * 鉴权按控制台版本分两种，官方文档在同一个表里给出：
 * - 旧版控制台：`X-Api-App-Key`(App ID) + `X-Api-Access-Key`(Access Token)，**两者都是必选**，
 *   只给 App ID 会被判参数无效；
 * - 新版控制台：只需 `X-Api-Key`（值就是控制台里的 API Key，与 App ID 不是同一个东西）。
 * 所以 Access Token 留空 = 明确走新版单密钥形态，用户不必关心 header 名字；
 * 反过来说，「填了 App ID、留空 Token」对旧版应用必然失败，这正是要靠设置页检测按钮暴露的坑。
 */
const VOLC_RECOGNIZE_ENDPOINT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
/** 业务状态码在**响应头**里（X-Api-Status-Code），HTTP 状态码只表示传输层结果。 */
const CODE_SUCCESS = "20000000";
const CODE_SILENT_AUDIO = "20000003";
const CODE_INVALID_PARAMS = "45000001";
const CODE_EMPTY_AUDIO = "45000002";
const CODE_BAD_FORMAT = "45000151";
/** 转写输出上限：10 分钟语音的正常输出远小于此，超出视为异常响应。 */
const MAX_RESPONSE_BYTES = 256 * 1024;

export type VolcengineSpeechDeps = {
	fetchImpl?: typeof fetch;
	log: (message: string, details?: Record<string, unknown>) => void;
};

export type VolcengineTranscribeInput = {
	/** 16kHz 单声道 WAV 的完整字节（含头），与本地引擎共用渲染层的同一份编码器。 */
	audio: ArrayBuffer;
	/** App ID（旧版控制台）或 API Key（新版控制台）。 */
	appId: string;
	/** Access Token；留空即按新版控制台只发 X-Api-Key。 */
	accessToken: string;
	resourceId: string;
	/** 用户在设置里填的语言（whisper 习惯的 ISO-639-1）；空 = 不指定，由服务端判语种。 */
	language: string;
	/** 超时由调用方（VoiceTranscriptionService）统一计时并 abort——它才分得清「用户取消」与「等超时」。 */
	signal: AbortSignal;
};

/**
 * 极速版的业务码只出现在响应头，泛泛的 `http` 无法区分「凭据错」「未开通极速版」「额度用尽」，
 * 所以这里在共享错误形态之上再带一层原始线索，由服务层按需透传（OpenAI 兼容路径不需要）。
 */
export type VolcengineTranscribeResult = VoiceTranscriptionResult | { ok: false; error: VoiceTranscriptionErrorCode; detail: VoiceTranscriptionFailureDetail };

/** 豆包语音转写：网络与中止交给调用方 catch（与 OpenAI 兼容路径同一套错误语义）。 */
export async function transcribeWithVolcengine(deps: VolcengineSpeechDeps, input: VolcengineTranscribeInput): Promise<VolcengineTranscribeResult> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Api-Resource-Id": input.resourceId,
		// 每次请求一个新 UUID：极速版无轮询，但它同时是服务端日志的关联键。
		"X-Api-Request-Id": randomUUID(),
		"X-Api-Sequence": "-1",
	};
	if (input.accessToken) {
		headers["X-Api-App-Key"] = input.appId;
		headers["X-Api-Access-Key"] = input.accessToken;
	} else {
		headers["X-Api-Key"] = input.appId;
	}

	const language = normalizeVolcLanguageTag(input.language);
	// `audio.data`（base64 直传）出自极速版文档的「audio.url 与 audio.data 二选一」；
	// 若服务端只认 url，会返回 45000001（参数无效），检测按钮能第一时间把这件事暴露出来。
	const payload = {
		user: { uid: input.appId },
		audio: {
			format: "wav",
			data: Buffer.from(input.audio).toString("base64"),
			...(language ? { language } : {}),
		},
		request: {
			model_name: "bigmodel",
			// 数字规范化默认开、标点默认关；口述输入两者都要，否则整段没有标点难以直接使用。
			enable_itn: true,
			enable_punc: true,
		},
	};

	const response = await (deps.fetchImpl ?? fetch)(VOLC_RECOGNIZE_ENDPOINT, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
		signal: input.signal,
	});
	const logId = response.headers.get("x-tt-logid") ?? "";
	const statusCode = response.headers.get("x-api-status-code") ?? "";
	const apiMessage = response.headers.get("x-api-message") ?? "";
	// 原始线索始终随错误返回：设置页的检测按钮要按码给差异化文案，工单也要 logId。
	const detail: VoiceTranscriptionFailureDetail = { statusCode, message: apiMessage, logId };
	if (!response.ok) {
		const error = response.status === 401 || response.status === 403 ? "invalidKey" : response.status === 404 || response.status === 405 ? "badBaseUrl" : "http";
		deps.log("volcengine request rejected", { status: response.status, ...detail, error });
		return { ok: false, error, detail };
	}
	const body = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
	if (body === null) return { ok: false, error: "http", detail };
	// 业务码不是 20000000 时正文里的 result 不可信，只按码映射错误语义。
	if (statusCode && statusCode !== CODE_SUCCESS) {
		deps.log("volcengine returned business error", { ...detail });
		if (statusCode === CODE_SILENT_AUDIO || statusCode === CODE_EMPTY_AUDIO) return { ok: false, error: "empty", detail };
		if (statusCode === CODE_INVALID_PARAMS || statusCode === CODE_BAD_FORMAT) return { ok: false, error: "invalidRequest", detail };
		// 「应用未开通极速版 / 免费额度用尽」官方没有给码，只能落到这一支，
		// 所以文案上要带上「多半是权限或额度」的提示，而不是空泛的一句服务错误。
		return { ok: false, error: "http", detail };
	}
	const text = parseVolcTranscript(body);
	if (!text) {
		deps.log("volcengine response has no transcript", { logId });
		return { ok: false, error: "empty", detail };
	}
	return { ok: true, text };
}

/**
 * 极速版的正文是 `{audio_info, result:{text, utterances}}`。
 * 容错：个别网关实现会把 result 再包一层或直接给字符串。
 */
function parseVolcTranscript(raw: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return "";
	}
	if (!parsed || typeof parsed !== "object") return "";
	const result = Reflect.get(parsed, "result");
	if (typeof result === "string") return result.trim();
	if (!result || typeof result !== "object") return "";
	const text = Reflect.get(result, "text");
	return typeof text === "string" && text.length <= 100_000 ? text.trim() : "";
}
