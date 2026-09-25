import { DEFAULT_WHISPER_MODEL_ID, getWhisperModelDef, type WhisperModelId } from "./types/whisperRuntime";

export type VoiceTranscriptionEngine = "cloud" | "local";

export const DEFAULT_VOICE_TRANSCRIPTION_CONFIG = {
	enabled: false,
	engine: "cloud",
	baseUrl: "https://api.openai.com/v1",
	model: "whisper-1",
	language: "",
	inputDeviceId: "",
	localModelId: DEFAULT_WHISPER_MODEL_ID,
	cliPath: "",
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

export type SanitizedVoiceTranscriptionConfig = {
	enabled: boolean;
	engine: VoiceTranscriptionEngine;
	baseUrl: string;
	model: string;
	language: string;
	inputDeviceId: string;
	localModelId: WhisperModelId;
	cliPath: string;
};

/**
 * Validate the renderer-owned, non-secret part of the transcription config.
 * 按引擎分支校验：cloud 保持旧契约（baseUrl+model 必须有效）；local 只要求
 * 目录内的模型 id 与合法的可选自定义路径，不强制 baseUrl/model。
 */
export function sanitizeVoiceTranscriptionConfig(input: unknown): SanitizedVoiceTranscriptionConfig | null {
	if (!isRecord(input)) return null;
	const engine = normalizeEngine(Reflect.get(input, "engine"));
	const enabled = Reflect.get(input, "enabled") === true;
	const baseUrl = readBoundedString(Reflect.get(input, "baseUrl"), MAX_BASE_URL_LENGTH);
	const model = readBoundedString(Reflect.get(input, "model"), MAX_MODEL_LENGTH);
	const language = readBoundedString(Reflect.get(input, "language"), MAX_LANGUAGE_LENGTH);
	const inputDeviceId = readBoundedString(Reflect.get(input, "inputDeviceId"), MAX_DEVICE_ID_LENGTH);
	const cliPath = readBoundedString(Reflect.get(input, "cliPath"), MAX_CLI_PATH_LENGTH);
	const localModel = getWhisperModelDef(Reflect.get(input, "localModelId"));
	const localModelId = localModel ? localModel.id : DEFAULT_WHISPER_MODEL_ID;
	if (engine === "cloud") {
		if (!baseUrl || !model || !normalizeVoiceTranscriptionUrl(baseUrl)) return null;
	}
	if (cliPath && (!isAbsoluteLikePath(cliPath) || containsControlChars(cliPath))) return null;
	return { enabled, engine, baseUrl, model, language, inputDeviceId, localModelId, cliPath };
}

function normalizeEngine(raw: unknown): VoiceTranscriptionEngine {
	return raw === "local" ? "local" : "cloud";
}

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
