import { randomUUID } from "node:crypto";
import { normalizeVoiceTranscriptionUrl, VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES, VOICE_TRANSCRIPTION_TIMEOUT_MS } from "../../shared/voiceTranscriptionConfig";
import { toSimplifiedChinese } from "./simplifiedChinese";
import { createSilentWav } from "./silentWav";
import { readBoundedResponseText } from "./responseText";
import { transcribeWithVolcengine } from "./VolcengineSpeechClient";
import type { WhisperModelId } from "../../shared/types/whisperRuntime";
import type { VoiceTranscriptionPublicConfig, VoiceTranscriptionRequest, VoiceTranscriptionResult, VoiceTranscriptionTestResult } from "../../shared/types/voiceTranscription";
import type { VoiceTranscriptionCredentials } from "./VoiceTranscriptionConfigStore";

const MAX_RESPONSE_BYTES = 128 * 1024;
/** 检测探针的静音时长：够服务端解出一帧音频并回业务码，又不至于真占用多少转写额度。 */
const PROBE_SILENCE_MS = 400;
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

/**
 * 两个引擎共用的结果收口：过滤占位词 → 繁体落回简体 → 仍有正文才算成功。
 * 繁简转换放这里而不是各自引擎里，因为云端 whisper 系模型同样会吐繁体，
 * 而「口述结果是简体」是用户对整个语音输入的期待。
 */
function toSpeechResult(raw: string): VoiceTranscriptionResult {
	const speech = toSimplifiedChinese(stripNonSpeechPlaceholders(raw));
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
			const startTimeout = () => {
				timeout = setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, this.deps.timeoutMs ?? VOICE_TRANSCRIPTION_TIMEOUT_MS);
			};

			if (credentials.provider === "volcengine") {
				// 豆包极速版按 audio.format 声称的编码解码，这里只接受渲染层已转码的 WAV
				// （provider=volcengine 时录音用 encodeRecordingToWav 送出，webm 会被服务端判 45000151）。
				if (mimeType !== "audio/wav" && mimeType !== "audio/x-wav") return { ok: false, error: "invalidRequest" };
				startTimeout();
				const result = await transcribeWithVolcengine({ fetchImpl: this.deps.fetch, log: this.deps.log }, { audio: input.audio, appId: credentials.appId, accessToken: credentials.accessToken, resourceId: credentials.resourceId, language: credentials.language, signal: controller.signal });
				// 失败时豆包的业务码/ logId 随 result.detail 原样透出（检测按钮要靠它给差异化文案）。
				return result.ok ? toSpeechResult(result.text) : result;
			}

			const endpoint = normalizeVoiceTranscriptionUrl(credentials.baseUrl);
			if (!endpoint || !credentials.model.trim()) return { ok: false, error: "notConfigured" };

			const body = new FormData();
			body.append("file", new Blob([input.audio], { type: mimeType }), `recording.${extension}`);
			body.append("model", credentials.model.trim());
			if (credentials.language.trim()) body.append("language", credentials.language.trim());
			startTimeout();
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

	/**
	 * 「检测连通性」：拿一小段静音把当前配置走一遍真实转写链路（凭据 → 权限 → 服务端解码音频）。
	 *
	 * 判据是「服务受理了这段音频」而不是「识别出了字」：静音必然空手而归，
	 * 所以 ok 与 empty 都算通过；只有 notConfigured / invalidKey / invalidRequest（参数或
	 * base64 形态不被接受）/ http（未开通极速版、额度用尽）/ network 这类码才是真问题。
	 * 未开通与额度类失败官方没有单独码，失败文案会把 statusCode / logId 一并带出便于查工单。
	 */
	async testConnection(): Promise<VoiceTranscriptionTestResult> {
		const result = await this.transcribe({ requestId: `probe-${randomUUID()}`, audio: createSilentWav(PROBE_SILENCE_MS), mimeType: "audio/wav" });
		if (result.ok || result.error === "empty") return { ok: true };
		return "detail" in result ? { ok: false, error: result.error, detail: result.detail } : { ok: false, error: result.error };
	}

	cancel(requestId: string): void {
		this.inFlight.get(requestId)?.abort();
		this.deps.cancelLocal?.(requestId);
	}
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
