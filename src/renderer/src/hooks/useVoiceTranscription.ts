import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "../../../shared/voiceTranscriptionConfig";
import type { VoiceTranscriptionErrorCode, VoiceTranscriptionPublicConfig } from "../../../shared/types/voiceTranscription";
import { currentSessionIdAtom, voiceConfigRevisionAtom } from "../atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../utils/chatSessionBootstrap";
import { ownsQuickMessageShortcut } from "../utils/quickMessageShortcut";
import { encodeRecordingToWav } from "../utils/voiceWavEncoder";
import type { VoiceTranscriptionTarget } from "../utils/voiceTranscriptionInsert";
import { canCancelVoiceRecording, canStartVoiceRecording, hasSpeakableAudio, isVoiceTranscriptionConfigured, releaseVoiceRecordingResources, shouldRequestVoiceMicrophone, type VoiceTranscriptionState } from "../utils/voiceRecorderLifecycle";

export type { VoiceTranscriptionState } from "../utils/voiceRecorderLifecycle";

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

/** Owns the microphone and recorder lifecycle; audio is never persisted. */
export function useVoiceTranscription(input: { scopeKey: string; captureTarget: () => VoiceTranscriptionTarget; applyText: (target: VoiceTranscriptionTarget, text: string) => boolean }) {
	const store = useStore();
	const [state, setState] = useState<VoiceTranscriptionState>("idle");
	const [configured, setConfigured] = useState(false);
	// 设置页保存/安装后的改动经此版本号推给已挂载的输入框，即时刷新按钮可见性。
	const voiceConfigRevision = useAtomValue(voiceConfigRevisionAtom);
	const stateRef = useRef<VoiceTranscriptionState>("idle");
	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const targetRef = useRef<VoiceTranscriptionTarget | null>(null);
	const engineRef = useRef<VoiceTranscriptionPublicConfig["engine"]>("cloud");
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

	const transcribeAudio = useCallback(
		async (audio: Blob, target: VoiceTranscriptionTarget | null, operation: number) => {
			if (!target || audio.size === 0 || audio.size > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
				updateState("idle");
				showNotice(t("voice.error.invalidRequest"), 4000);
				return;
			}
			let dispatchedRequestId: string | null = null;
			try {
				// 本地 whisper-cli 只吃 wav：在渲染层解码重采样为 16kHz mono（webm 主进程解不了）。
				const local = engineRef.current === "local";
				const payload: ArrayBuffer = local ? await encodeRecordingToWav(audio) : await audio.arrayBuffer();
				const mimeType = local ? "audio/wav" : audio.type;
				if (!mountedRef.current || operationRef.current !== operation) return;
				if (payload.byteLength === 0 || payload.byteLength > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
					updateState("idle");
					showNotice(t("voice.error.invalidRequest"), 4000);
					return;
				}
				// 静音预检：whisper 对「没说话」不会返回空，而是幻觉出 " you"、"我不想要我"
				// 这类文本。在本地引擎落锤前先用峰值/时长挡掉，脏文本就不会进输入框。
				if (local && !hasSpeakableAudio(payload)) {
					updateState("idle");
					showNotice(t("voice.error.noSpeech"), 4000);
					return;
				}
				const requestId = crypto.randomUUID();
				dispatchedRequestId = requestId;
				inFlightRequestIdRef.current = requestId;
				const result = await desktopApi.voiceTranscription.transcribe({
					requestId,
					audio: payload,
					mimeType,
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
		},
		[updateState],
	);

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
		let deviceId = "";
		try {
			const config = await desktopApi.voiceTranscription.getConfig();
			if (!mountedRef.current || operationRef.current !== operation) return;
			if (!shouldRequestVoiceMicrophone(config)) {
				updateState("idle");
				showNotice(t("voice.error.notConfigured"), 4000);
				return;
			}
			// 记住引擎：transcribeAudio 在 onstop 里执行，届时无法再回读配置。
			engineRef.current = config.engine;
			deviceId = config.inputDeviceId;
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
			// 选定设备优先；设备临时拔出/占用导致 exact 失败时回落系统默认，
			// 避免「设置里选了设备 → 设备暂时不在 → 完全不能录音」。
			const stream = await requestMicrophone(navigator.mediaDevices, deviceId);
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

	// 快捷键/按钮共用的「切换式」录音开关：空闲→开始，录音中→停止并转写。
	// 用 ref 读同步状态，避免把 start/stop 的最新闭包塞进订阅依赖导致每次重订。
	const startRef = useRef(start);
	startRef.current = start;
	const stopRef = useRef(stop);
	stopRef.current = stop;
	const configuredRef = useRef(false);
	const toggle = useCallback(() => {
		if (stateRef.current === "recording") {
			stopRef.current();
			return;
		}
		if (stateRef.current === "idle" && configuredRef.current) void startRef.current();
	}, []);

	// 全局快捷键呼出录音：与快捷消息同理，须自证「本栏是聚焦栏」，否则分屏下按一次
	// 会同时触发多栏录音。输入框聚焦时仍生效（语音正是打字现场）。
	useEffect(() => {
		return desktopApi.app.onShortcutTriggered((triggered) => {
			if (triggered !== "toggleVoiceRecording") return;
			if (!ownsQuickMessageShortcut({ focusedSessionId: store.get(currentSessionIdAtom), sessionId: scopeKey, guideSessionId: GUIDE_BOOTSTRAP_SESSION_ID })) return;
			toggle();
		});
	}, [scopeKey, store, toggle]);

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

	useEffect(
		() => () => {
			operationRef.current += 1;
			cancelInFlight();
			const recorder = recorderRef.current;
			if (recorder?.state === "recording") {
				recorder.onstop = null;
				recorder.stop();
			}
			releaseMedia();
			updateState("idle");
		},
		[cancelInFlight, releaseMedia, scopeKey, updateState],
	);

	// 配置在 scope（会话/面板）切换或设置页改动（版本号变化）时重新探测；
	// getConfig 只返回脱敏字段，无泄漏风险。
	useEffect(() => {
		let active = true;
		void desktopApi.voiceTranscription
			.getConfig()
			.then((config) => {
				if (!active) return;
				const ready = isVoiceTranscriptionConfigured(config);
				configuredRef.current = ready;
				setConfigured(ready);
			})
			.catch(() => {
				if (!active) return;
				configuredRef.current = false;
				setConfigured(false);
			});
		return () => {
			active = false;
		};
	}, [scopeKey, voiceConfigRevision]);

	return { state, start, stop, cancel, toggle, configured };
}

/** 按选定设备请求麦克风；无设备或 exact 失败时回落系统默认设备。 */
async function requestMicrophone(mediaDevices: MediaDevices, deviceId: string): Promise<MediaStream> {
	if (deviceId) {
		try {
			return await mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
		} catch (error) {
			if (!(error instanceof DOMException) || (error.name !== "OverconstrainedError" && error.name !== "NotFoundError")) throw error;
		}
	}
	return mediaDevices.getUserMedia({ audio: true });
}

function voiceErrorMessage(error: VoiceTranscriptionErrorCode): string {
	return t(`voice.error.${error}`);
}
