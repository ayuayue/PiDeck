export type VoiceTranscriptionState = "idle" | "requesting" | "recording" | "transcribing";

export function canStartVoiceRecording(state: VoiceTranscriptionState): boolean {
	return state === "idle";
}

export function canCancelVoiceRecording(state: VoiceTranscriptionState): boolean {
	return state === "recording";
}

export function shouldRequestVoiceMicrophone(config: { hasApiKey: boolean }): boolean {
	return config.hasApiKey;
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
