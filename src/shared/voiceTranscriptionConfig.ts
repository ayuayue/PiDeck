export const DEFAULT_VOICE_TRANSCRIPTION_CONFIG = {
	baseUrl: "https://api.openai.com/v1",
	model: "whisper-1",
	language: "",
} as const;

export const VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const VOICE_TRANSCRIPTION_TIMEOUT_MS = 60_000;

const MAX_BASE_URL_LENGTH = 2048;
const MAX_MODEL_LENGTH = 200;
const MAX_LANGUAGE_LENGTH = 35;
const MAX_API_KEY_LENGTH = 4096;

export type SanitizedVoiceTranscriptionConfig = {
	baseUrl: string;
	model: string;
	language: string;
};

/** Validate the renderer-owned, non-secret part of the transcription config. */
export function sanitizeVoiceTranscriptionConfig(
	input: unknown,
): SanitizedVoiceTranscriptionConfig | null {
	if (!isRecord(input)) return null;
	const rawBaseUrl = Reflect.get(input, "baseUrl");
	const rawModel = Reflect.get(input, "model");
	const rawLanguage = Reflect.get(input, "language");
	const baseUrl = typeof rawBaseUrl === "string" ? rawBaseUrl.trim() : "";
	const model = typeof rawModel === "string" ? rawModel.trim() : "";
	const language = typeof rawLanguage === "string" ? rawLanguage.trim() : "";
	if (
		!baseUrl ||
		baseUrl.length > MAX_BASE_URL_LENGTH ||
		!model ||
		model.length > MAX_MODEL_LENGTH ||
		language.length > MAX_LANGUAGE_LENGTH ||
		!normalizeVoiceTranscriptionUrl(baseUrl)
	) {
		return null;
	}
	return { baseUrl, model, language };
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
