import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// 该模块 import 了 voiceWavEncoder（静音预检用），必须按源文件目录解析相对依赖，
// 所以用统一沙箱加载器而不是手写 vm 片段。
const load = createTsSandbox();
const lifecycle = load("src/renderer/src/utils/voiceRecorderLifecycle.ts");
const { canCancelVoiceRecording, canStartVoiceRecording, hasSpeakableAudio, isVoiceTranscriptionConfigured, releaseVoiceRecordingResources, shouldRequestVoiceMicrophone } = lifecycle;

test("only idle can start and only recording can cancel", () => {
	assert.equal(canStartVoiceRecording("idle"), true);
	assert.equal(canStartVoiceRecording("requesting"), false);
	assert.equal(canStartVoiceRecording("recording"), false);
	assert.equal(canStartVoiceRecording("transcribing"), false);
	assert.equal(canCancelVoiceRecording("recording"), true);
	assert.equal(canCancelVoiceRecording("requesting"), false);
	assert.equal(canCancelVoiceRecording("transcribing"), false);
});

test("按钮可见只看总开关；申请麦克风才叠加「引擎就绪」判据", () => {
	// 可见性：enabled 决定（设置里「开启才显示」）。引擎未就绪也先显示按钮，点了再提示补全。
	assert.equal(isVoiceTranscriptionConfigured({ enabled: true, runtimeReady: true }), true);
	assert.equal(isVoiceTranscriptionConfigured({ enabled: true, runtimeReady: false }), true);
	assert.equal(isVoiceTranscriptionConfigured({ enabled: false, runtimeReady: true }), false);
	assert.equal(isVoiceTranscriptionConfigured({ enabled: false, runtimeReady: false }), false);
	// 录音前置：必须 enabled 且 runtimeReady，避免开了开关但引擎没装好就弹权限/录音。
	assert.equal(shouldRequestVoiceMicrophone({ enabled: true, runtimeReady: true }), true);
	assert.equal(shouldRequestVoiceMicrophone({ enabled: true, runtimeReady: false }), false);
	assert.equal(shouldRequestVoiceMicrophone({ enabled: false, runtimeReady: false }), false);
	const hookSource = readFileSync("src/renderer/src/hooks/useVoiceTranscription.ts", "utf8");
	// 配置探测随「设置页版本号」重跑：开启/关闭开关即时刷新按钮，无需切会话或重启。
	assert.match(hookSource, /\[scopeKey,\s*voiceConfigRevision\]/);
	// 先读脱敏配置判就绪，再申请麦克风（未就绪应提前返回，不弹权限）。
	assert.ok(hookSource.indexOf("voiceTranscription.getConfig()") < hookSource.indexOf("requestMicrophone(navigator.mediaDevices"));
	assert.ok(hookSource.indexOf("streamRef.current = stream") < hookSource.indexOf("new MediaRecorder(stream"));
	// 渲染层入口由配置就绪控制：ComposerArea 在未配置时不渲染录音控件
	const composerSource = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	// formatter 会去掉单元素三元的包裹括号：用 \(? 容忍。
	assert.match(composerSource, /composer\.voice\.configured \? \(?/);
});

test("cleanup detaches recorder handlers and stops every microphone track", () => {
	let stopped = 0;
	const recorder = {
		ondataavailable: () => {},
		onerror: () => {},
		onstop: () => {},
	};
	const stream = {
		getTracks: () => [
			{
				stop: () => {
					stopped += 1;
				},
			},
			{
				stop: () => {
					stopped += 1;
				},
			},
		],
	};
	releaseVoiceRecordingResources({ recorder, stream });
	assert.equal(recorder.ondataavailable, null);
	assert.equal(recorder.onerror, null);
	assert.equal(recorder.onstop, null);
	assert.equal(stopped, 2);
});

test("hasSpeakableAudio 挡掉静音与过短录音，放行正常口述", () => {
	const encoder = load("src/renderer/src/utils/voiceWavEncoder.ts");
	const rate = encoder.VOICE_WAV_SAMPLE_RATE;
	const tone = (seconds, amplitude) =>
		encoder.encodeWavPcm(
			Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin(i * 0.1)),
			rate,
		);
	assert.equal(hasSpeakableAudio(tone(1, 0.2)), true, "1 秒、正常音量的语音应放行");
	assert.equal(hasSpeakableAudio(tone(1, 0.0005)), false, "房间噪声 floor 不能当成说话");
	assert.equal(hasSpeakableAudio(tone(0.1, 0.4)), false, "过短录音交给 whisper 只会产生幻觉文本");
});
