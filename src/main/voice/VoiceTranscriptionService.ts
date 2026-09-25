import { normalizeVoiceTranscriptionUrl, VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES, VOICE_TRANSCRIPTION_TIMEOUT_MS } from "../../shared/voiceTranscriptionConfig";
import type { WhisperModelId } from "../../shared/types/whisperRuntime";
import type { VoiceTranscriptionPublicConfig, VoiceTranscriptionRequest, VoiceTranscriptionResult } from "../../shared/types/voiceTranscription";
import type { VoiceTranscriptionCredentials } from "./VoiceTranscriptionConfigStore";

const MAX_RESPONSE_BYTES = 128 * 1024;
const AUDIO_EXTENSIONS = new Map([
	["audio/webm", "webm"],
	["audio/ogg", "ogg"],
	["audio/mp4", "m4a"],
	["audio/mpeg", "mp3"],
	["audio/mp3", "mp3"],
	["audio/wav", "wav"],
	["audio/wave", "wav"],
	["audio/x-wav", "wav"],
]);

/**
 * ASR 的「非语音占位词」：whisper 系（本地 whisper.cpp 与云端 whisper-1）判定音频里
 * 「没有语音」时不返回空串，而是吐词表里的特殊标记 —— 用户看到的 `[BLANK_AUDIO]`
 * 就是它被当成正文插进了输入框。
 *
 * 标记随语言与音频内容而变（静音 [BLANK_AUDIO]、有音乐 [MUSIC]、键盘声 [KLICKGERÄUSCH]），
 * 逐个枚举追不完，所以方括号形式按「全大写 token」整类识别：whisper 的非语音标记
 * 清一色是大写字母 + 下划线，而口述正文里的方括号内容几乎不会是全大写。
 */
const NON_SPEECH_BRACKET_TOKEN = /\[[\p{Lu}][\p{Lu}_ ]{1,30}\]/gu;
const NON_SPEECH_WORDS = ["BLANK", "BLANK_AUDIO", "BLANK AUDIO", "SILENCE", "SILIENCE", "NOISE", "MUSIC", "LAUGHTER", "UNKNOWN"];

/**
 * 去掉非语音占位词：方括号按全大写整类处理；圆括号/尖括号只认清单内的词，
 * 避免把口述正文里的括号内容（「……（原文如此）」）一并吃掉。
 */
export function stripNonSpeechPlaceholders(text: string): string {
	const boundary = NON_SPEECH_WORDS.join("|");
	const paired = new RegExp(`(?:<\\s*(?:${boundary})\\s*>|\\(\\s*(?:${boundary})\\s*\\))`, "gi");
	return text.replace(NON_SPEECH_BRACKET_TOKEN, " ").replace(paired, " ").replace(/\s+/g, " ").trim();
}

/** 两个引擎共用的结果收口：过滤后仍有正文才算成功，否则按 empty 返回。 */
function toSpeechResult(raw: string): VoiceTranscriptionResult {
	const speech = stripNonSpeechPlaceholders(raw);
	return speech ? { ok: true, text: speech } : { ok: false, error: "empty" };
}

/** Transcription boundary: routes to the cloud endpoint or the local whisper-cli engine. */
export class VoiceTranscriptionService {
	private readonly inFlight = new Map<string, AbortController>();

	constructor(
		private readonly deps: {
			getPublicConfig: () => Promise<VoiceTranscriptionPublicConfig>;
			getCredentials: () => Promise<VoiceTranscriptionCredentials | null>;
			/** 本地引擎入口（WhisperTranscriber.transcribe）；引擎为 local 但未注入时视为不可用。 */
			transcribeLocal?: (input: { requestId: string; audio: ArrayBuffer; mimeType: string; cliPath: string; modelId: WhisperModelId; language: string }) => Promise<VoiceTranscriptionResult>;
			cancelLocal?: (requestId: string) => void;
			fetch?: typeof fetch;
			timeoutMs?: number;
			log: (message: string, details?: Record<string, unknown>) => void;
		},
	) {}

	async transcribe(input: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
		const mimeType = input.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		const extension = AUDIO_EXTENSIONS.get(mimeType);
		if (!extension || input.audio.byteLength === 0 || input.audio.byteLength > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
			return { ok: false, error: "invalidRequest" };
		}
		const config = await this.deps.getPublicConfig();
		if (config.engine === "local") {
			if (!this.deps.transcribeLocal) return { ok: false, error: "engineUnavailable" };
			const local = await this.deps.transcribeLocal({
				requestId: input.requestId,
				audio: input.audio,
				mimeType,
				cliPath: config.cliPath,
				modelId: config.localModelId,
				language: config.language,
			});
			return local.ok ? toSpeechResult(local.text) : local;
		}
		const previous = this.inFlight.get(input.requestId);
		if (previous) previous.abort();
		const controller = new AbortController();
		this.inFlight.set(input.requestId, controller);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		try {
			const credentials = await this.deps.getCredentials();
			if (controller.signal.aborted) return { ok: false, error: "cancelled" };
			if (!credentials) return { ok: false, error: "notConfigured" };
			const endpoint = normalizeVoiceTranscriptionUrl(credentials.baseUrl);
			if (!endpoint || !credentials.model.trim()) return { ok: false, error: "notConfigured" };

			const body = new FormData();
			body.append("file", new Blob([input.audio], { type: mimeType }), `recording.${extension}`);
			body.append("model", credentials.model.trim());
			if (credentials.language.trim()) body.append("language", credentials.language.trim());
			timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, this.deps.timeoutMs ?? VOICE_TRANSCRIPTION_TIMEOUT_MS);
			const response = await (this.deps.fetch ?? fetch)(endpoint, {
				method: "POST",
				headers: { Authorization: `Bearer ${credentials.apiKey}` },
				body,
				signal: controller.signal,
			});
			if (!response.ok) {
				const error = response.status === 401 || response.status === 403 ? "invalidKey" : response.status === 404 || response.status === 405 ? "badBaseUrl" : "http";
				this.deps.log("request rejected", { status: response.status, error });
				return { ok: false, error };
			}
			const textBody = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
			if (textBody === null) return { ok: false, error: "http" };
			const text = parseTranscriptionText(textBody);
			return toSpeechResult(text);
		} catch {
			const error = controller.signal.aborted ? (timedOut ? "timeout" : "cancelled") : "network";
			this.deps.log("request failed", { error });
			return { ok: false, error };
		} finally {
			if (timeout) clearTimeout(timeout);
			if (this.inFlight.get(input.requestId) === controller) {
				this.inFlight.delete(input.requestId);
			}
		}
	}

	cancel(requestId: string): void {
		this.inFlight.get(requestId)?.abort();
		this.deps.cancelLocal?.(requestId);
	}
}

async function readBoundedResponseText(response: Response, limit: number): Promise<string | null> {
	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > limit) return null;
	if (!response.body) {
		const text = await response.text();
		return new TextEncoder().encode(text).byteLength <= limit ? text : null;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		total += chunk.value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return null;
		}
		text += decoder.decode(chunk.value, { stream: true });
	}
	return text + decoder.decode();
}

function parseTranscriptionText(raw: string): string {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || !("text" in parsed)) return "";
		const text = Reflect.get(parsed, "text");
		return typeof text === "string" && text.length <= 100_000 ? text.trim() : "";
	} catch {
		return "";
	}
}
