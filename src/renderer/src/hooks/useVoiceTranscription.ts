import { useCallback, useEffect, useRef, useState } from "react";
import { VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "../../../shared/voiceTranscriptionConfig";
import type { VoiceTranscriptionErrorCode } from "../../../shared/types/voiceTranscription";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import type { VoiceTranscriptionTarget } from "../utils/voiceTranscriptionInsert";
import {
	canCancelVoiceRecording,
	canStartVoiceRecording,
	isVoiceTranscriptionConfigured,
	releaseVoiceRecordingResources,
	shouldRequestVoiceMicrophone,
	type VoiceTranscriptionState,
} from "../utils/voiceRecorderLifecycle";

export type { VoiceTranscriptionState } from "../utils/voiceRecorderLifecycle";

const MIME_CANDIDATES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/ogg;codecs=opus",
	"audio/mp4",
];

/** Owns the microphone and recorder lifecycle; audio is never persisted. */
export function useVoiceTranscription(input: {
	scopeKey: string;
	captureTarget: () => VoiceTranscriptionTarget;
	applyText: (target: VoiceTranscriptionTarget, text: string) => boolean;
}) {
	const [state, setState] = useState<VoiceTranscriptionState>("idle");
	// 配置完整性（baseUrl+model+apiKey 齐备）决定录音按钮是否显示：
	// 未配置时整个入口隐藏，而不是点了才提示 notConfigured。
	const [configured, setConfigured] = useState(false);
	const stateRef = useRef<VoiceTranscriptionState>("idle");
	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const targetRef = useRef<VoiceTranscriptionTarget | null>(null);
	const operationRef = useRef(0);
	const inFlightRequestIdRef = useRef<string | null>(null);
	const mountedRef = useRef(true);
	const captureTargetRef = useRef(input.captureTarget);
	const applyTextRef = useRef(input.applyText);
	const scopeKey = input.scopeKey;
	captureTargetRef.current = input.captureTarget;
	applyTextRef.current = input.applyText;

	const updateState = useCallback((next: VoiceTranscriptionState) => {
		stateRef.current = next;
		if (mountedRef.current) setState(next);
	}, []);

	const releaseMedia = useCallback(() => {
		releaseVoiceRecordingResources({
			recorder: recorderRef.current,
			stream: streamRef.current,
		});
		recorderRef.current = null;
		streamRef.current = null;
		chunksRef.current = [];
		targetRef.current = null;
	}, []);

	const cancelInFlight = useCallback(() => {
		const requestId = inFlightRequestIdRef.current;
		if (!requestId) return;
		inFlightRequestIdRef.current = null;
		void desktopApi.voiceTranscription.cancel(requestId).catch(() => undefined);
	}, []);

	const transcribeAudio = useCallback(async (
		audio: Blob,
		target: VoiceTranscriptionTarget | null,
		operation: number,
	) => {
		if (!target || audio.size === 0 || audio.size > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
			updateState("idle");
			showNotice(t("voice.error.invalidRequest"), 4000);
			return;
		}
		let dispatchedRequestId: string | null = null;
		try {
			const audioBuffer = await audio.arrayBuffer();
			if (!mountedRef.current || operationRef.current !== operation) return;
			const requestId = crypto.randomUUID();
			dispatchedRequestId = requestId;
			inFlightRequestIdRef.current = requestId;
			const result = await desktopApi.voiceTranscription.transcribe({
				requestId,
				audio: audioBuffer,
				mimeType: audio.type,
			});
			if (!mountedRef.current || operationRef.current !== operation) return;
			if (!result.ok) {
				showNotice(voiceErrorMessage(result.error), 4000);
				return;
			}
			if (!applyTextRef.current(target, result.text)) {
				showNotice(t("voice.error.staleTarget"), 4000);
			}
		} catch {
			if (mountedRef.current && operationRef.current === operation) {
				showNotice(t("voice.error.network"), 4000);
			}
		} finally {
			if (inFlightRequestIdRef.current === dispatchedRequestId) {
				inFlightRequestIdRef.current = null;
			}
			if (mountedRef.current && operationRef.current === operation) updateState("idle");
		}
	}, [updateState]);

	const cancel = useCallback(() => {
		if (!canCancelVoiceRecording(stateRef.current)) return;
		operationRef.current += 1;
		const recorder = recorderRef.current;
		if (recorder?.state === "recording") {
			recorder.onstop = null;
			recorder.stop();
		}
		releaseMedia();
		updateState("idle");
	}, [releaseMedia, updateState]);

	const start = useCallback(async () => {
		if (!canStartVoiceRecording(stateRef.current)) return;
		const operation = operationRef.current + 1;
		operationRef.current = operation;
		cancelInFlight();
		updateState("requesting");
		try {
			const config = await desktopApi.voiceTranscription.getConfig();
			if (!mountedRef.current || operationRef.current !== operation) return;
			if (!shouldRequestVoiceMicrophone(config)) {
				updateState("idle");
				showNotice(t("voice.error.notConfigured"), 4000);
				return;
			}
		} catch {
			if (!mountedRef.current || operationRef.current !== operation) return;
			updateState("idle");
			showNotice(t("voice.error.notConfigured"), 4000);
			return;
		}
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
			updateState("idle");
			showNotice(t("voice.error.unsupported"), 4000);
			return;
		}
		const target = captureTargetRef.current();
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (!mountedRef.current || operationRef.current !== operation) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			// Register the stream before MediaRecorder construction because the
			// constructor itself can throw; the shared catch must still stop tracks.
			streamRef.current = stream;
			const mimeType = MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
			const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
			recorderRef.current = recorder;
			targetRef.current = target;
			chunksRef.current = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunksRef.current.push(event.data);
			};
			recorder.onerror = () => {
				if (operationRef.current !== operation) return;
				releaseMedia();
				updateState("idle");
				showNotice(t("voice.error.recording"), 4000);
			};
			recorder.onstop = () => {
				if (operationRef.current !== operation) return;
				const chunks = chunksRef.current;
				const capturedTarget = targetRef.current;
				const recordedMimeType = recorder.mimeType || chunks[0]?.type || "audio/webm";
				const audio = new Blob(chunks, { type: recordedMimeType });
				releaseMedia();
				void transcribeAudio(audio, capturedTarget, operation);
			};
			recorder.start();
			updateState("recording");
		} catch {
			// A permission request can settle after a session switch. Never let that
			// stale completion release a newer session's recorder or show a false error.
			if (!mountedRef.current || operationRef.current !== operation) return;
			releaseMedia();
			updateState("idle");
			showNotice(t("voice.error.permission"), 4000);
		}
	}, [cancelInFlight, releaseMedia, transcribeAudio, updateState]);

	const stop = useCallback(() => {
		if (stateRef.current !== "recording") return;
		const recorder = recorderRef.current;
		if (!recorder || recorder.state !== "recording") return;
		updateState("transcribing");
		recorder.stop();
	}, [updateState]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			operationRef.current += 1;
			cancelInFlight();
			const recorder = recorderRef.current;
			if (recorder?.state === "recording") {
				recorder.onstop = null;
				recorder.stop();
			}
			releaseMedia();
		};
	}, [cancelInFlight, releaseMedia]);

	useEffect(() => () => {
		operationRef.current += 1;
		cancelInFlight();
		const recorder = recorderRef.current;
		if (recorder?.state === "recording") {
			recorder.onstop = null;
			recorder.stop();
		}
		releaseMedia();
		updateState("idle");
	}, [cancelInFlight, releaseMedia, scopeKey, updateState]);

	// 配置在 scope（会话/面板）切换时重新探测；getConfig 只返回脱敏字段，无泄漏风险。
	useEffect(() => {
		let active = true;
		void desktopApi.voiceTranscription.getConfig().then((config) => {
			if (active) setConfigured(isVoiceTranscriptionConfigured(config));
		}).catch(() => {
			if (active) setConfigured(false);
		});
		return () => {
			active = false;
		};
	}, [scopeKey]);

	return { state, start, stop, cancel, configured };
}

function voiceErrorMessage(error: VoiceTranscriptionErrorCode): string {
	return t(`voice.error.${error}`);
}
