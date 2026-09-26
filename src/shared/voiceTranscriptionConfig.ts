import { DEFAULT_WHISPER_MODEL_ID, getWhisperModelDef, type WhisperModelId } from "./types/whisperRuntime";

export type VoiceTranscriptionEngine = "cloud" | "local";

/**
 * 云端转写的两家协议：
 * - openai：OpenAI 兼容 `/audio/transcriptions`（multipart + Bearer），也覆盖一切兼容实现；
 * - volcengine：火山引擎「豆包语音 · 大模型录音文件识别极速版」单次 HTTP 请求（JSON +
 *   base64 音频 + X-Api-* 鉴权头），无需自己搭音频托管。凭据按控制台版本分两种形态：
 *   旧版是 App ID + Access Token 成对，新版只有一个 API Key（详见 VolcengineSpeechClient）。
 */
export type VoiceTranscriptionCloudProvider = "openai" | "volcengine";

/**
 * 极速版固定资源 ID（官方文档：X-Api-Resource-Id 为固定值）。
 * 标准版走 submit/query 且只接受公网音频 URL，桌面端本地录音不适用，所以不开放。
 */
export const VOLC_ENGINE_DEFAULT_RESOURCE_ID = "volc.bigasr.auc_turbo";

/**
 * 客户端只实现了极速版（单次 HTTP + base64 音频）这一条协议，因此官方在这里也只登记这一个值。
 * 资源 ID 直接决定服务端按哪套协议解析请求，填成标准版的 `volc.bigasr.auc` 只会得到 45000001，
 * 所以设置页把它收成下拉而不是自由文本；将来接入别的资源时往这个清单里加。
 */
export const VOLC_SUPPORTED_RESOURCE_IDS = [VOLC_ENGINE_DEFAULT_RESOURCE_ID] as const;

export const DEFAULT_VOICE_TRANSCRIPTION_CONFIG = {
	enabled: false,
	engine: "cloud",
	cloudProvider: "openai",
	baseUrl: "https://api.openai.com/v1",
	model: "whisper-1",
	language: "",
	inputDeviceId: "",
	localModelId: DEFAULT_WHISPER_MODEL_ID,
	cliPath: "",
	cloudResourceId: VOLC_ENGINE_DEFAULT_RESOURCE_ID,
} as const;

export const VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const VOICE_TRANSCRIPTION_TIMEOUT_MS = 60_000;
/** 本地 CPU 转写长录音（10 分钟 WAV）远慢于网络请求，给独立超时。 */
export const VOICE_TRANSCRIPTION_LOCAL_TIMEOUT_MS = 300_000;

const MAX_BASE_URL_LENGTH = 2048;
const MAX_MODEL_LENGTH = 200;
const MAX_LANGUAGE_LENGTH = 35;
const MAX_API_KEY_LENGTH = 4096;
const MAX_DEVICE_ID_LENGTH = 512;
const MAX_CLI_PATH_LENGTH = 1024;
const MAX_RESOURCE_ID_LENGTH = 100;

export type SanitizedVoiceTranscriptionConfig = {
	enabled: boolean;
	engine: VoiceTranscriptionEngine;
	cloudProvider: VoiceTranscriptionCloudProvider;
	baseUrl: string;
	model: string;
	language: string;
	inputDeviceId: string;
	localModelId: WhisperModelId;
	cliPath: string;
	/** 火山豆包语音的资源 ID（仅 cloudProvider=volcengine 时使用）。 */
	cloudResourceId: string;
};

/**
 * Validate the renderer-owned, non-secret part of the transcription config.
 * 按引擎分支校验：cloud 保持旧契约（baseUrl+model 必须有效）；local 只要求
 * 目录内的模型 id 与合法的自定义路径，不强制 baseUrl/model。
 *
 * cloud=volcengine 是例外：它没有 baseUrl/model 概念（端点与模型名由官方固定），
 * 资源 ID 只接受客户端已实现的那一个，其余（手改配置文件、旧版本残留）一律回落默认值——
 * 让它归零到可用默认，比整次保存被判 invalidConfig 更好排查。凭据是否齐全在运行时按 notConfigured 处理。
 */
export function sanitizeVoiceTranscriptionConfig(input: unknown): SanitizedVoiceTranscriptionConfig | null {
	if (!isRecord(input)) return null;
	const engine = normalizeEngine(Reflect.get(input, "engine"));
	const cloudProvider = normalizeCloudProvider(Reflect.get(input, "cloudProvider"));
	const enabled = Reflect.get(input, "enabled") === true;
	const baseUrl = readBoundedString(Reflect.get(input, "baseUrl"), MAX_BASE_URL_LENGTH);
	const model = readBoundedString(Reflect.get(input, "model"), MAX_MODEL_LENGTH);
	const language = readBoundedString(Reflect.get(input, "language"), MAX_LANGUAGE_LENGTH);
	const inputDeviceId = readBoundedString(Reflect.get(input, "inputDeviceId"), MAX_DEVICE_ID_LENGTH);
	const cliPath = readBoundedString(Reflect.get(input, "cliPath"), MAX_CLI_PATH_LENGTH);
	const rawResourceId = readBoundedString(Reflect.get(input, "cloudResourceId"), MAX_RESOURCE_ID_LENGTH);
	const cloudResourceId = (VOLC_SUPPORTED_RESOURCE_IDS as readonly string[]).includes(rawResourceId) ? rawResourceId : VOLC_ENGINE_DEFAULT_RESOURCE_ID;
	const localModel = getWhisperModelDef(Reflect.get(input, "localModelId"));
	const localModelId = localModel ? localModel.id : DEFAULT_WHISPER_MODEL_ID;
	if (engine === "cloud" && cloudProvider === "openai") {
		if (!baseUrl || !model || !normalizeVoiceTranscriptionUrl(baseUrl)) return null;
	}
	if (cliPath && (!isAbsoluteLikePath(cliPath) || containsControlChars(cliPath))) return null;
	return { enabled, engine, cloudProvider, baseUrl, model, language, inputDeviceId, localModelId, cliPath, cloudResourceId };
}

function normalizeEngine(raw: unknown): VoiceTranscriptionEngine {
	return raw === "local" ? "local" : "cloud";
}

function normalizeCloudProvider(raw: unknown): VoiceTranscriptionCloudProvider {
	return raw === "volcengine" ? "volcengine" : "openai";
}

/** 超长或非字符串一律视为未填：宁可回落到默认值，也不让脏字段进请求。 */
function readBoundedString(raw: unknown, max: number): string {
	const value = typeof raw === "string" ? raw.trim() : "";
	return value.length <= max ? value : "";
}

function containsControlChars(value: string): boolean {
	// eslint-disable-next-line no-control-regex
	return /[\u0000-\u001f]/.test(value);
}

/** 路径合法性只挡住明显的垃圾输入（控制字符/空）；文件存在性与可执行性由主进程边界校验。 */
function isAbsoluteLikePath(value: string): boolean {
	if (value.startsWith("\\\\")) return true;
	if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
	return value.startsWith("/");
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return Boolean(input) && typeof input === "object";
}

export function sanitizeVoiceTranscriptionApiKey(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const apiKey = input.trim();
	return apiKey && apiKey.length <= MAX_API_KEY_LENGTH ? apiKey : null;
}

/** Accept either an API base URL or the complete OpenAI-compatible endpoint. */
export function normalizeVoiceTranscriptionUrl(input: string): string | null {
	if (!input || input.length > MAX_BASE_URL_LENGTH) return null;
	try {
		const url = new URL(input.trim());
		if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
			return null;
		}
		if (url.search || url.hash) return null;
		const path = url.pathname.replace(/\/+$/, "");
		if (path.endsWith("/audio/transcriptions")) {
			url.pathname = path;
		} else if (!path) {
			url.pathname = "/v1/audio/transcriptions";
		} else {
			url.pathname = `${path}/audio/transcriptions`;
		}
		return url.toString();
	} catch {
		return null;
	}
}

/**
 * 语音设置里的「语言」是 whisper 习惯的 ISO-639-1（`zh` / `en`），而豆包语音的
 * `audio.language` 只认 BCP-47（`zh-CN` / `en-US`）。同一份配置要在两个引擎里都能用，
 * 所以转换放在共享层做纯函数映射：已经是区域格式的原样透传，未知代码也透传（让服务端报错，
 * 比在客户端静默改成别的语言更可诊断）。留空 = 不传该字段，交给模型自己判语种。
 */
const VOLC_LANGUAGE_TAGS: Record<string, string> = {
	zh: "zh-CN",
	cy: "zh-CN",
	cmn: "zh-CN",
	mandarin: "zh-CN",
	yue: "yue-CN",
	"zh-tw": "zh-TW",
	en: "en-US",
	ja: "ja-JP",
	ko: "ko-KR",
	fr: "fr-FR",
	de: "de-DE",
	es: "es-MX",
	pt: "pt-BR",
	it: "it-IT",
	nl: "nl-NL",
	ru: "ru-RU",
	tr: "tr-TR",
	th: "th-TH",
	vi: "vi-VN",
	id: "id-ID",
	ms: "ms-MY",
	fil: "fil-PH",
	ar: "ar-SA",
	bn: "bn-BD",
	ne: "ne-NP",
	uk: "uk-UA",
	pl: "pl-PL",
	ro: "ro-RO",
	el: "el-GR",
};

export function normalizeVolcLanguageTag(language: string): string {
	const value = language.trim().toLowerCase();
	if (!value) return "";
	return VOLC_LANGUAGE_TAGS[value] ?? (value.includes("-") ? language.trim() : value);
}
