import { measureWavPeakLevel, VOICE_MIN_SPEAKING_PEAK, VOICE_MIN_SPEAKING_SECONDS, wavDurationSeconds } from "./voiceWavEncoder";
import type { VoiceTranscriptionCloudProvider, VoiceTranscriptionEngine } from "../../../shared/voiceTranscriptionConfig";

/** 本地引擎分段流式识别的窗口：与 worklet 里的 VoicePcmSegmenter 保持一致。 */
export function segmentHasSpeakableAudio(samples: Float32Array, sampleRate: number): boolean {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) return false;
	if (samples.length / sampleRate < VOICE_MIN_SPEAKING_SECONDS) return false;
	let peak = 0;
	for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
	return peak >= VOICE_MIN_SPEAKING_PEAK;
}

export type VoiceTranscriptionState = "idle" | "requesting" | "recording" | "transcribing";
/** 录音按钮可见/可用判据（与主进程 runtimeReady 同源）。 */
export type VoiceConfigGate = { enabled: boolean; runtimeReady: boolean };

/** 启动受阻原因需要判断具体缺项，因此比 VoiceConfigGate 多带引擎与云端字段。 */
export type VoiceStartConfig = VoiceConfigGate & {
	engine: VoiceTranscriptionEngine;
	cloudProvider: VoiceTranscriptionCloudProvider;
	baseUrl: string;
	model: string;
	hasApiKey: boolean;
	hasVolcAppId: boolean;
};

export function canStartVoiceRecording(state: VoiceTranscriptionState): boolean {
	return state === "idle";
}

/**
 * 取消可用判据：录音中与转写中都允许。
 *
 * 为什么包含 transcribing：本地 whisper 转写可能持续数秒，且队列里还有待处理分段；
 * 早前只允许 recording，导致转写期点取消完全没反应（录音已停、请求还在跑，最后仍会
 * 把文字插进输入框）。
 */
export function canCancelVoiceRecording(state: VoiceTranscriptionState): boolean {
	return state === "recording" || state === "transcribing";
}

/** 录音按钮可见判据：只看总开关（设置里「开启才显示」即指此）。 */
export function isVoiceTranscriptionConfigured(config: VoiceConfigGate): boolean {
	return config.enabled;
}

/**
 * 申请麦克风前的前置检查：总开关开启 **且** 当前引擎就绪，否则点了也只能报错，
 * 因此在真正录音前先挡下并提示去设置里补全：
 * - cloud：runtimeReady 由服务商各自的必填项决定（OpenAI 兼容 = baseUrl + model + apiKey；豆包 = App ID）；
 * - local：runtimeReady = whisper-cli 就位且所选模型已装（主进程 stat 得出）。
 */
export function shouldRequestVoiceMicrophone(config: VoiceConfigGate): boolean {
	return config.enabled && config.runtimeReady;
}

/**
 * 点击麦克风却没能开始时的具体原因，用于给出**对得上**的提示。
 *
 * 为什么不能统一报「未配置」：总开关已开、只是某个引擎依赖缺失时，说「请先去配置」
 * 会让用户在设置页里找不到问题（开关明明是开的）——必须指出缺的是哪一项。
 */
export type VoiceStartBlockedReason = "disabled" | "cloudMissingKey" | "cloudMissingEndpoint" | "cloudMissingVolcAppId" | "localRuntime" | "unknown";

export function resolveVoiceStartBlockedReason(config: VoiceStartConfig): VoiceStartBlockedReason {
	if (!config.enabled) return "disabled";
	if (config.runtimeReady) return "unknown";
	if (config.engine === "local") return "localRuntime";
	// 豆包语音没有 baseUrl/model 概念，必填项只有 App ID（Access Token 视控制台版本可选）。
	if (config.cloudProvider === "volcengine") return config.hasVolcAppId ? "unknown" : "cloudMissingVolcAppId";
	// OpenAI 兼容：runtimeReady 由 baseUrl + model + apiKey 三者决定，拆开报以指向具体输入框。
	if (!config.hasApiKey) return "cloudMissingKey";
	return "cloudMissingEndpoint";
}

/** Detaches event closures and stops every microphone track. */
export function releaseVoiceRecordingResources(input: { recorder: MediaRecorder | null; stream: MediaStream | null }): void {
	if (input.recorder) {
		input.recorder.ondataavailable = null;
		input.recorder.onerror = null;
		input.recorder.onstop = null;
	}
	for (const track of input.stream?.getTracks() ?? []) track.stop();
}

/**
 * 本地引擎送音频前的静音预检：时长过短或峰值低于门限都判为「没说话」。
 *
 * 为什么必须在送进 whisper-cli 之前判：whisper 对静音不返回空串，而是幻觉出
 * " you"、"我不想要我" 这类文本（实测 2 秒静音稳定输出 " you"），
 * 到了主进程已经无法与真实口述区分。
 */
export function hasSpeakableAudio(wav: ArrayBuffer): boolean {
	return wavDurationSeconds(wav) >= VOICE_MIN_SPEAKING_SECONDS && measureWavPeakLevel(wav) >= VOICE_MIN_SPEAKING_PEAK;
}
