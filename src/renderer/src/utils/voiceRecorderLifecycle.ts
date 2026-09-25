import { measureWavPeakLevel, VOICE_MIN_SPEAKING_PEAK, VOICE_MIN_SPEAKING_SECONDS, wavDurationSeconds } from "./voiceWavEncoder";

export type VoiceTranscriptionState = "idle" | "requesting" | "recording" | "transcribing";
/** 录音按钮可见/可用判据（与主进程 runtimeReady 同源）。 */
export type VoiceConfigGate = { enabled: boolean; runtimeReady: boolean };

export function canStartVoiceRecording(state: VoiceTranscriptionState): boolean {
	return state === "idle";
}

export function canCancelVoiceRecording(state: VoiceTranscriptionState): boolean {
	return state === "recording";
}

/** 录音按钮可见判据：只看总开关（设置里「开启才显示」即指此）。 */
export function isVoiceTranscriptionConfigured(config: VoiceConfigGate): boolean {
	return config.enabled;
}

/**
 * 申请麦克风前的前置检查：总开关开启 **且** 当前引擎就绪，否则点了也只能报错，
 * 因此在真正录音前先挡下并提示去设置里补全：
 * - cloud：runtimeReady = baseUrl + model + 加密存储的 apiKey 齐备；
 * - local：runtimeReady = whisper-cli 就位且所选模型已装（主进程 stat 得出）。
 */
export function shouldRequestVoiceMicrophone(config: VoiceConfigGate): boolean {
	return config.enabled && config.runtimeReady;
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
