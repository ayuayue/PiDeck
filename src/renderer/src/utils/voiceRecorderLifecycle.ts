export type VoiceTranscriptionState = "idle" | "requesting" | "recording" | "transcribing";

/** 录音按钮可见/可用判据（与主进程 runtimeReady 同源）。 */
export type VoiceConfigGate = { enabled: boolean; runtimeReady: boolean };

export function canStartVoiceRecording(state: VoiceTranscriptionState): boolean {
	return state === "idle";
}

export function canCancelVoiceRecording(state: VoiceTranscriptionState): boolean {
	return state === "recording";
}

/**
 * 语音转写入口是否显示：总开关开启 **且** 当前引擎就绪。
 * - cloud：runtimeReady = baseUrl + model + 加密存储的 apiKey 齐备；
 * - local：runtimeReady = whisper-cli 就位且所选模型已装（主进程 stat 得出）。
 * 未满足时隐藏按钮，而非点了才报错（避免不可达的错误提示）。
 */
export function isVoiceTranscriptionConfigured(config: VoiceConfigGate): boolean {
	return config.enabled && config.runtimeReady;
}

/** 请求麦克风前的前置检查（启动路径防御，与按钮显示条件同一套判定）。 */
export function shouldRequestVoiceMicrophone(config: VoiceConfigGate): boolean {
	return isVoiceTranscriptionConfigured(config);
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
