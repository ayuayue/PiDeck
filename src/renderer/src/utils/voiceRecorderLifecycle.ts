export type VoiceTranscriptionState = "idle" | "requesting" | "recording" | "transcribing";

export function canStartVoiceRecording(state: VoiceTranscriptionState): boolean {
	return state === "idle";
}

export function canCancelVoiceRecording(state: VoiceTranscriptionState): boolean {
	return state === "recording";
}

/**
 * 语音转写是否已配置完整（baseUrl + model + 加密存储的 apiKey 三者齐备）。
 * 渲染层据此隐藏录音按钮：未配置必需参数时不显示入口，避免点了才报
 * notConfigured（用户不可达的提示）。baseUrl/model 传空串时视为未配置。
 */
export function isVoiceTranscriptionConfigured(config: {
	hasApiKey: boolean;
	baseUrl: string;
	model: string;
}): boolean {
	return config.hasApiKey && config.baseUrl.trim().length > 0 && config.model.trim().length > 0;
}

/** 请求麦克风前的前置检查（启动路径防御，与按钮显示条件同一套判定）。 */
export function shouldRequestVoiceMicrophone(config: {
	hasApiKey: boolean;
	baseUrl: string;
	model: string;
}): boolean {
	return isVoiceTranscriptionConfigured(config);
}

/** Detaches event closures and stops every microphone track. */
export function releaseVoiceRecordingResources(input: {
	recorder: MediaRecorder | null;
	stream: MediaStream | null;
}): void {
	if (input.recorder) {
		input.recorder.ondataavailable = null;
		input.recorder.onerror = null;
		input.recorder.onstop = null;
	}
	for (const track of input.stream?.getTracks() ?? []) track.stop();
}
