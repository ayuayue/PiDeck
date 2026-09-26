import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES, type VoiceTranscriptionCloudProvider } from "../../../shared/voiceTranscriptionConfig";
import type { VoiceTranscriptionErrorCode, VoiceTranscriptionPublicConfig } from "../../../shared/types/voiceTranscription";
import { currentSessionIdAtom, voiceConfigRevisionAtom } from "../atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { createVoiceLevelMeter, type VoiceLevelMeter } from "../utils/voiceLevelMeter";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../utils/chatSessionBootstrap";
import { ownsQuickMessageShortcut } from "../utils/quickMessageShortcut";
import { encodeRecordingToWav, encodeWavPcm, VOICE_WAV_SAMPLE_RATE } from "../utils/voiceWavEncoder";
import { createVoicePcmProcessorModuleUrl } from "../utils/voicePcmProcessor";
import type { VoiceTranscriptionTarget } from "../utils/voiceTranscriptionInsert";
import { canCancelVoiceRecording, canStartVoiceRecording, hasSpeakableAudio, isVoiceTranscriptionConfigured, releaseVoiceRecordingResources, resolveVoiceStartBlockedReason, segmentHasSpeakableAudio, shouldRequestVoiceMicrophone, type VoiceTranscriptionState } from "../utils/voiceRecorderLifecycle";

export type { VoiceTranscriptionState } from "../utils/voiceRecorderLifecycle";

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

type VoiceEngine = VoiceTranscriptionPublicConfig["engine"];

/**
 * Owns the microphone and recorder lifecycle; audio is never persisted.
 * 本地 whisper 在录音期间用 AudioWorklet 对 PCM 按静音边界切段并串行转写；云端保持停止后整段发送，
 * 避免把不自包含的 MediaRecorder WebM 分片当成独立文件解码，也避免将云端请求量按段放大。
 */
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
	const audioContextRef = useRef<AudioContext | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const pcmCaptureRef = useRef<PcmCaptureHandle | null>(null);
	// 电平表：录音动效的唯一数据源，两条引擎共用（本地另有一条 AudioWorklet 切段图）。
	const levelMeterRef = useRef<VoiceLevelMeter | null>(null);
	const transcriptionTailRef = useRef<Promise<void>>(Promise.resolve());
	// insertionCaretRef：本次录音从哪个光标位开始插入；每段插入成功后向前推进，
	// 保证多段结果按顺序拼接，而不会互相覆盖用户后来打的字（仍走 applyText 的 stale 保护）。
	const insertionCaretRef = useRef<number | null>(null);
	// segmentIndexRef：单调递增的段序号，给每段一个稳定 requestId 前缀，避免取消错段。
	const segmentIndexRef = useRef(0);
	const activeRequestCountRef = useRef(0);
	// 转写请求是否真的在跑（而不是「已停止录音、队列已排空」的空转态）。
	// UI 用它决定该不该展示动效：没请求在飞时转圈等于骗人。
	const [transcribingBusy, setTranscribingBusy] = useState(false);
	const syncTranscribingBusy = useCallback(() => {
		if (mountedRef.current) setTranscribingBusy(activeRequestCountRef.current > 0);
	}, []);
	// inFlightSegmentsRef：进行中的转写请求（segmentIndex -> requestId），停止/取消时统一 abort。
	const inFlightSegmentsRef = useRef<Map<number, string>>(new Map());
	// segmentChainRef：串行化「PCM 段 -> 转写 -> 插入」的 promise 链，保证按段序上屏。
	const segmentChainRef = useRef<Promise<void>>(Promise.resolve());
	// firstInsertRef：录音开始时尚未插入过任何段；首段上屏前不插空白，避免纯静音录音留痕迹。
	const firstInsertRef = useRef(true);
	// hadAnySpeechRef：本次录音是否已有任一段识别出正文（用于「完全没说话」的统一提示去重）。
	const hadAnySpeechRef = useRef(false);
	const targetRef = useRef<VoiceTranscriptionTarget | null>(null);
	const engineRef = useRef<VoiceEngine>("cloud");
	// 云端服务商决定送哪种音频容器（豆包只收 WAV）；与引擎一样在本次录音内固定，不随设置中途变化。
	const cloudProviderRef = useRef<VoiceTranscriptionCloudProvider>("openai");
	const operationRef = useRef(0);
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
		levelMeterRef.current?.close();
		levelMeterRef.current = null;
		pcmCaptureRef.current?.stop();
		pcmCaptureRef.current = null;
		workletRef.current?.port.close();
		workletRef.current?.disconnect();
		audioSourceRef.current?.disconnect();
		if (audioContextRef.current && audioContextRef.current.state !== "closed") void audioContextRef.current.close().catch(() => undefined);
		workletRef.current = null;
		audioSourceRef.current = null;
		audioContextRef.current = null;
		releaseVoiceRecordingResources({ recorder: recorderRef.current, stream: streamRef.current });
		recorderRef.current = null;
		streamRef.current = null;
		chunksRef.current = [];
		targetRef.current = null;
		insertionCaretRef.current = null;
	}, []);

	/** 中止所有进行中的分段转写请求（停止后整段取消 / 组件卸载 / 新一次录音前）。 */
	const cancelInFlight = useCallback(() => {
		for (const requestId of inFlightSegmentsRef.current.values()) {
			void desktopApi.voiceTranscription.cancel(requestId).catch(() => undefined);
		}
		inFlightSegmentsRef.current.clear();
		// 丢弃尚未跑完的分段链，防止链上排队段在取消后继续插入。
		segmentChainRef.current = Promise.resolve();
		transcriptionTailRef.current = Promise.resolve();
	}, []);

	/** 以有界串行队列转写 PCM 段，保证结果按录音顺序插入且不积压无界内存。 */
	const transcribeCloudAudio = useCallback(
		async (audio: Blob, target: VoiceTranscriptionTarget | null, operation: number): Promise<void> => {
			if (!target || audio.size === 0 || audio.size > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
				updateState("idle");
				showNotice(t("voice.error.invalidRequest"), 4000);
				return;
			}
			// 送哪种容器由服务商决定：豆包极速版按 audio.format 声称的编码解码，只收 WAV/MP3/OGG，
			// 浏览器录出来的 webm/opus 会被判「格式不正确」，所以这里先解码再重采样成 16kHz 单声道 WAV；
			// OpenAI 兼容服务自己会解码 webm/ogg/mp4，保持原始编码可省一次转码。
			let payload: { audio: ArrayBuffer; mimeType: string };
			if (cloudProviderRef.current === "volcengine") {
				try {
					payload = { audio: await encodeRecordingToWav(audio), mimeType: "audio/wav" };
				} catch {
					if (mountedRef.current && operationRef.current === operation) {
						updateState("idle");
						showNotice(t("voice.error.recording"), 4000);
					}
					return;
				}
				if (!mountedRef.current || operationRef.current !== operation) return;
			} else {
				payload = { audio: await audio.arrayBuffer(), mimeType: audio.type || "audio/webm" };
			}
			const requestId = crypto.randomUUID();
			inFlightSegmentsRef.current.set(-1, requestId);
			activeRequestCountRef.current += 1;
			syncTranscribingBusy();
			try {
				const result = await desktopApi.voiceTranscription.transcribe({ requestId, audio: payload.audio, mimeType: payload.mimeType });
				if (!mountedRef.current || operationRef.current !== operation) return;
				if (!result.ok) {
					showNotice(voiceErrorMessage(result.error), 4000);
					return;
				}
				if (!applyTextRef.current(target, result.text)) showNotice(t("voice.error.staleTarget"), 4000);
			} catch {
				if (mountedRef.current && operationRef.current === operation) showNotice(t("voice.error.network"), 4000);
			} finally {
				inFlightSegmentsRef.current.delete(-1);
				activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
				syncTranscribingBusy();
				if (mountedRef.current && operationRef.current === operation) updateState("idle");
			}
		},
		[updateState],
	);

	const transcribePcmSegment = useCallback((samples: Float32Array, operation: number): void => {
		if (samples.length === 0 || !mountedRef.current || operationRef.current !== operation) return;
		const index = segmentIndexRef.current++;
		const previous = transcriptionTailRef.current;
		// 本地引擎分段：先过静音/时长预检，避免把没说话的空段送进 whisper-cli（会幻觉出正文）。
		if (!segmentHasSpeakableAudio(samples, VOICE_WAV_SAMPLE_RATE)) return;
		const run = async (): Promise<void> => {
			if (!mountedRef.current || operationRef.current !== operation) return;
			const wav = encodeWavPcm(samples, VOICE_WAV_SAMPLE_RATE);
			if (wav.byteLength > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) return;
			const requestId = `${crypto.randomUUID()}-seg${index}`;
			inFlightSegmentsRef.current.set(index, requestId);
			activeRequestCountRef.current += 1;
			syncTranscribingBusy();
			// 录音中不要切成 transcribing：分段转写是在后台与录音并行跑的，改状态会让按钮
			// 提前变成「转写中」，用户以为录音已经结束。只有停止录音（stop() 置 transcribing）后
			// 才展示转写态。
			try {
				const result = await desktopApi.voiceTranscription.transcribe({ requestId, audio: wav, mimeType: "audio/wav" });
				if (!mountedRef.current || operationRef.current !== operation) return;
				if (!result.ok) {
					if (result.error !== "empty" && !hadAnySpeechRef.current) showNotice(voiceErrorMessage(result.error), 4000);
					return;
				}
				const text = result.text;
				if (!text.trim()) return;
				const base = targetRef.current;
				if (!base) return;
				const from = insertionCaretRef.current ?? base.from;
				const to = firstInsertRef.current ? base.to : from;
				const insertText = firstInsertRef.current ? text : ` ${text}`;
				if (applyTextRef.current({ ...base, from, to }, insertText)) {
					insertionCaretRef.current = from + insertText.length;
					firstInsertRef.current = false;
					hadAnySpeechRef.current = true;
				} else if (!hadAnySpeechRef.current) showNotice(t("voice.error.staleTarget"), 4000);
			} catch {
				if (mountedRef.current && operationRef.current === operation && !hadAnySpeechRef.current) showNotice(t("voice.error.network"), 4000);
			} finally {
				inFlightSegmentsRef.current.delete(index);
				activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
				syncTranscribingBusy();
				// 不要在这里回退到 recording：录音一旦已经进入 transcribing，就表明用户已停止录音
				// （stop() 先置 transcribing 再 flush），回退会让状态在录音/转写之间反复横跳，
				// 并让随后点击的 stop() 因为「不是 recording」而被吞掉。队列排空后的收尾统一交给
				// onFlush 处理。
			}
		};
		const next = previous.then(run, run);
		segmentChainRef.current = next;
		transcriptionTailRef.current = next.catch(() => undefined);
	}, []);

	const cancel = useCallback(() => {
		if (!canCancelVoiceRecording(stateRef.current)) return;
		// 递增 operation 会让所有在途分段转写与 onFlush 回调自然失效（它们都比对 operation），
		// 因此转写中点取消能真正打断：不再插入文本，也不会把状态拖回 idle 后被迟到的
		// flush 重新覆盖。
		operationRef.current += 1;
		cancelInFlight();
		const recorder = recorderRef.current;
		if (recorder?.state === "recording") {
			recorder.onstop = null;
			recorder.stop();
		}
		releaseMedia();
		updateState("idle");
	}, [cancelInFlight, releaseMedia, updateState]);

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
				// 按真实缺失项报错：总开关已开时再说「未配置」会让用户在设置页找不到问题。
				showNotice(t(`voice.error.blocked.${resolveVoiceStartBlockedReason(config)}`), 4000);
				return;
			}
			// 记住引擎：停止转写时不再回读配置，保证本次录音始终使用同一引擎。
			engineRef.current = config.engine;
			cloudProviderRef.current = config.cloudProvider;
			deviceId = config.inputDeviceId;
		} catch {
			if (!mountedRef.current || operationRef.current !== operation) return;
			updateState("idle");
			// 读取配置失败与「用户没配置」是两回事，不要混用同一条文案。
			showNotice(t("voice.error.configReadFailed"), 4000);
			return;
		}
		if (!navigator.mediaDevices?.getUserMedia) {
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
			streamRef.current = stream;
			chunksRef.current = [];
			targetRef.current = target;
			insertionCaretRef.current = target.from;
			segmentIndexRef.current = 0;
			activeRequestCountRef.current = 0;
			syncTranscribingBusy();
			firstInsertRef.current = true;
			hadAnySpeechRef.current = false;
			segmentChainRef.current = Promise.resolve();
			transcriptionTailRef.current = Promise.resolve();

			// 电平表在两条引擎分支之前建好：它只服务动效，建不起来（AudioContext 被禁等）时
			// readLevel 恒为 0、波纹停在静止位，不影响录音本身。
			const meter = await createVoiceLevelMeter(stream);
			if (!mountedRef.current || operationRef.current !== operation) {
				meter?.close();
				return;
			}
			levelMeterRef.current = meter;

			if (engineRef.current === "local") {
				const capture = await startLocalPcmCapture(stream, {
					onSegment: (samples) => transcribePcmSegment(samples, operation),
					onFlush: () => {
						void transcriptionTailRef.current.then(() => {
							// operation 已变（用户取消/切换会话）时不得再改状态，否则取消后按钮会回弹。
							if (mountedRef.current && operationRef.current === operation) {
								releaseMedia();
								updateState("idle");
							}
						});
					},
				});
				pcmCaptureRef.current = capture;
				audioContextRef.current = capture.context;
				audioSourceRef.current = capture.source;
				workletRef.current = capture.worklet;
				if (!mountedRef.current || operationRef.current !== operation) {
					releaseMedia();
					return;
				}
				updateState("recording");
				return;
			}

			if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder unavailable");
			const mimeType = MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
			const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
			recorderRef.current = recorder;
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
				void transcribeCloudAudio(audio, capturedTarget, operation);
			};
			recorder.start();
			updateState("recording");
		} catch {
			// A permission request can settle after a session switch. Never let that
			// stale completion release a newer session's recorder or show a false error.
			if (!mountedRef.current || operationRef.current !== operation) return;
			releaseMedia();
			updateState("idle");
			showNotice(t("voice.error.recording"), 4000);
		}
	}, [cancelInFlight, releaseMedia, transcribePcmSegment, transcribeCloudAudio, updateState]);

	/**
	 * 录音动效的数据源：稳定标识，供 rAF 循环每帧读取当前电平（不经 React state，
	 * 否则约 25fps 的重渲染会拖垮输入框）。没有电平表时返回 0，波纹停在静止位。
	 */
	const readLevel = useCallback(() => levelMeterRef.current?.read() ?? 0, []);

	const stop = useCallback(() => {
		if (stateRef.current !== "recording") return;
		updateState("transcribing");
		if (engineRef.current === "local") {
			workletRef.current?.port.postMessage("flush");
			return;
		}
		const recorder = recorderRef.current;
		if (!recorder || recorder.state !== "recording") return;
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

	return { state, start, stop, cancel, toggle, configured, transcribingBusy, readLevel };
}

/** Connects a mono AudioWorklet capture path for local rolling transcription. */
type PcmCaptureHandle = { context: AudioContext; source: MediaStreamAudioSourceNode; worklet: AudioWorkletNode; stop: () => void };

async function startLocalPcmCapture(stream: MediaStream, callbacks: { onSegment: (samples: Float32Array) => void; onFlush: () => void }): Promise<PcmCaptureHandle> {
	const context = new AudioContext({ latencyHint: "interactive" });
	let source: MediaStreamAudioSourceNode | null = null;
	let worklet: AudioWorkletNode | null = null;
	let moduleUrl: string | null = null;
	try {
		if (!context.audioWorklet) throw new Error("AudioWorklet unavailable");
		moduleUrl = createVoicePcmProcessorModuleUrl();
		await context.audioWorklet.addModule(moduleUrl);
		source = context.createMediaStreamSource(stream);
		worklet = new AudioWorkletNode(context, "pideck-voice-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
		worklet.port.onmessage = (event: MessageEvent<{ type: "segment"; audio: ArrayBuffer } | { type: "flushed" }>) => {
			if (event.data.type === "flushed") {
				callbacks.onFlush();
				return;
			}
			callbacks.onSegment(new Float32Array(event.data.audio));
		};
		const mute = context.createGain();
		mute.gain.value = 0;
		source.connect(worklet);
		worklet.connect(mute);
		mute.connect(context.destination);
		if (context.state === "suspended") await context.resume();
		const activeSource = source;
		const activeWorklet = worklet;
		return {
			context,
			source: activeSource,
			worklet: activeWorklet,
			stop: () => {
				activeWorklet.port.postMessage("reset");
				activeWorklet.port.close();
				activeWorklet.disconnect();
				activeSource.disconnect();
				if (moduleUrl) URL.revokeObjectURL(moduleUrl);
				if (context.state !== "closed") void context.close().catch(() => undefined);
				for (const track of stream.getTracks()) track.stop();
			},
		};
	} catch (error) {
		worklet?.port.close();
		worklet?.disconnect();
		source?.disconnect();
		if (moduleUrl) URL.revokeObjectURL(moduleUrl);
		if (context.state !== "closed") await context.close().catch(() => undefined);
		throw error;
	}
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
