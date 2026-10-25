import { randomUUID } from "node:crypto";
import { normalizeVoiceTranscriptionUrl, resolveVolcProtocol, VOICE_STREAM_FRAME_BYTES, VOICE_STREAM_FRAME_MS, VOLC_STREAM_ENDPOINT, VOICE_STREAM_SAMPLE_RATE, VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES, VOICE_TRANSCRIPTION_TIMEOUT_MS } from "../../shared/voiceTranscriptionConfig";
import { toSimplifiedChinese } from "./simplifiedChinese";
import { createSilentPcm, createSilentWav } from "./silentWav";
import { extractWavPcm } from "./wavPcm";
import { readBoundedResponseText } from "./responseText";
import { transcribeWithVolcengine } from "./VolcengineSpeechClient";
import { VolcengineStreamSession, type VolcStreamSocket } from "./VolcengineStreamSession";
import type { WhisperModelId } from "../../shared/types/whisperRuntime";
import type { VoiceTranscriptionPublicConfig, VoiceTranscriptionRequest, VoiceTranscriptionResult, VoiceTranscriptionStreamFrame, VoiceTranscriptionStreamPartial, VoiceTranscriptionStreamStartInput, VoiceTranscriptionStreamStartResult, VoiceTranscriptionTestResult } from "../../shared/types/voiceTranscription";
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
	/** 进行中的流式识别会话（豆包流式 2.0）；键与 inFlight 同为 requestId，两套取消语义在此收口。 */
	private readonly streams = new Map<string, VolcengineStreamSession>();

	constructor(
		private readonly deps: {
			getPublicConfig: () => Promise<VoiceTranscriptionPublicConfig>;
			getCredentials: () => Promise<VoiceTranscriptionCredentials | null>;
			/** 本地引擎入口（WhisperTranscriber.transcribe）；引擎为 local 但未注入时视为不可用。 */
			transcribeLocal?: (input: { requestId: string; audio: ArrayBuffer; mimeType: string; cliPath: string; modelId: WhisperModelId; language: string }) => Promise<VoiceTranscriptionResult>;
			cancelLocal?: (requestId: string) => void;
			/** 流式会话的 WebSocket 工厂（主进程注入 `createVolcStreamSocket`）；缺省即不支持流式。 */
			createStreamSocket?: (url: string, headers: Record<string, string>) => VolcStreamSocket;
			/** 中间结果广播（main/index 注入 webContents.send）；文本是整段累积值，渲染层整段替换。 */
			emitStreamPartial?: (partial: VoiceTranscriptionStreamPartial) => void;
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
				// 整段通路在流式配置下不能走 flash 端点：两个资源**分别开通**，把流式的资源 ID 发到
				// 极速版必然被判 45000030「未开通」，用户会以为密钥错了。这里改成把同一段 PCM
				// 灌进一条流式会话再立刻收尾——通路语义完全等价，只是没有中途上屏而已。
				if (resolveVolcProtocol(credentials.resourceId) === "stream") {
					const pcm = extractWavPcm(input.audio);
					if (!pcm) return { ok: false, error: "invalidRequest" };
					return await this.streamWholePcm(input.requestId, pcm);
				}
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
	 * 所以 ok 与 empty 都算通过；只有 notConfigured / invalidKey / notGranted / invalidRequest（参数或
	 * base64 形态不被接受）/ http（额度用尽）/ network 这类码才是真问题。
	 * 未开通与额度类失败官方没有单独码，失败文案会把 statusCode / logId 一并带出便于查工单。
	 *
	 * 流式 2.0 走的是另一条通路（WebSocket + 裸 PCM，且资源与极速版**分别开通**），
	 * 所以探针也必须按当前资源 ID 走对应通路——用 WAV 探流式等于永远探不到真实的权限状态。
	 */
	async testConnection(): Promise<VoiceTranscriptionTestResult> {
		const config = await this.deps.getPublicConfig();
		const usesStream = config.engine === "cloud" && config.cloudProvider === "volcengine" && resolveVolcProtocol(config.cloudResourceId) === "stream";
		const result = usesStream ? await this.probeStream(`probe-${randomUUID()}`) : await this.transcribe({ requestId: `probe-${randomUUID()}`, audio: createSilentWav(PROBE_SILENCE_MS), mimeType: "audio/wav" });
		if (result.ok || result.error === "empty") return { ok: true };
		return "detail" in result ? { ok: false, error: result.error, detail: result.detail } : { ok: false, error: result.error };
	}

	/** 流式探针：开流 → 推几帧静音 → 收尾。开流失败即凭据/权限问题，直接带回原始码。 */
	private async probeStream(requestId: string): Promise<VoiceTranscriptionResult> {
		return await this.streamWholePcm(requestId, createSilentPcm(PROBE_SILENCE_MS));
	}

	/**
	 * 用一条流式会话转写一整段 PCM：按协议帧长切开后逐帧灌入并立刻收尾。
	 * 存在的理由是「整段通路」与「流式通路」按资源 ID 二选一，缺了它，选了流式资源的用户
	 * 在粘贴音频文件、或渲染层没走到流式分支时就直接不可用。
	 */
	private async streamWholePcm(requestId: string, pcm: Uint8Array): Promise<VoiceTranscriptionResult> {
		const opened = await this.startStream({ requestId, sampleRate: VOICE_STREAM_SAMPLE_RATE });
		if (!opened.ok) return { ok: false, error: opened.error, detail: opened.detail };
		const session = this.streams.get(requestId);
		if (!session) return { ok: false, error: "engineUnavailable" };
		for (let offset = 0; offset < pcm.byteLength; offset += VOICE_STREAM_FRAME_BYTES) {
			session.push(pcm.subarray(offset, offset + VOICE_STREAM_FRAME_BYTES));
		}
		return await this.finishStream(requestId);
	}

	/**
	 * 开一路流式识别（渲染层边录边推 PCM 的唯一入口）。
	 * 配置判据在此集中：只有「云端 + 豆包 + 资源 ID 判为流式」且注入了 WebSocket 工厂才允许开流。
	 */
	async startStream(input: VoiceTranscriptionStreamStartInput): Promise<VoiceTranscriptionStreamStartResult> {
		if (input.sampleRate !== VOICE_STREAM_SAMPLE_RATE) return { ok: false, error: "invalidRequest" };
		const config = await this.deps.getPublicConfig();
		const createSocket = this.deps.createStreamSocket;
		if (config.engine !== "cloud" || config.cloudProvider !== "volcengine" || resolveVolcProtocol(config.cloudResourceId) !== "stream" || !createSocket) {
			return { ok: false, error: "engineUnavailable" };
		}
		const credentials = await this.deps.getCredentials();
		if (!credentials) return { ok: false, error: "notConfigured" };
		if (credentials.provider !== "volcengine") return { ok: false, error: "engineUnavailable" };
		this.streams.get(input.requestId)?.cancel();
		const session = new VolcengineStreamSession(
			{
				createSocket,
				log: this.deps.log,
				onPartial: (text, final) => this.deps.emitStreamPartial?.({ requestId: input.requestId, text, final }),
			},
			{ appId: credentials.appId, accessToken: credentials.accessToken, resourceId: credentials.resourceId, language: credentials.language },
			VOLC_STREAM_ENDPOINT,
		);
		this.streams.set(input.requestId, session);
		const opened = await session.open();
		// 开流失败必须把会话从表里摘掉，否则后续帧会往一条已死的连接上堆。
		if (!opened.ok && this.streams.get(input.requestId) === session) this.streams.delete(input.requestId);
		return opened;
	}

	/** 上行一帧 PCM：fire-and-forget，失败反映在稍后的 partial/finish 上。 */
	pushStreamFrame(input: VoiceTranscriptionStreamFrame): void {
		if (!(input.pcm instanceof ArrayBuffer)) return;
		this.streams.get(input.requestId)?.push(new Uint8Array(input.pcm));
	}

	/** 收尾：发负序号的结束包并等终值，拿到几算几。 */
	async finishStream(requestId: string): Promise<VoiceTranscriptionResult> {
		const session = this.streams.get(requestId);
		if (!session) return { ok: false, error: "cancelled" };
		if (this.streams.get(requestId) === session) this.streams.delete(requestId);
		const result = await session.finish();
		return result.ok ? toSpeechResult(result.text) : result;
	}

	cancel(requestId: string): void {
		this.inFlight.get(requestId)?.abort();
		this.streams.get(requestId)?.cancel();
		this.streams.delete(requestId);
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
