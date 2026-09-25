import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync("src/renderer/src/utils/voiceRecorderLifecycle.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
const { canCancelVoiceRecording, canStartVoiceRecording, isVoiceTranscriptionConfigured, releaseVoiceRecordingResources, shouldRequestVoiceMicrophone } = module.exports;

test("only idle can start and only recording can cancel", () => {
	assert.equal(canStartVoiceRecording("idle"), true);
	assert.equal(canStartVoiceRecording("requesting"), false);
	assert.equal(canStartVoiceRecording("recording"), false);
	assert.equal(canStartVoiceRecording("transcribing"), false);
	assert.equal(canCancelVoiceRecording("recording"), true);
	assert.equal(canCancelVoiceRecording("requesting"), false);
	assert.equal(canCancelVoiceRecording("transcribing"), false);
});

test("录音入口由「总开关开启 + 当前引擎就绪」把守，未就绪不请求麦克风", () => {
	// enabled && runtimeReady 双条件，缺一即隐藏按钮/不申请权限。
	assert.equal(isVoiceTranscriptionConfigured({ enabled: true, runtimeReady: true }), true);
	assert.equal(isVoiceTranscriptionConfigured({ enabled: false, runtimeReady: true }), false);
	assert.equal(isVoiceTranscriptionConfigured({ enabled: true, runtimeReady: false }), false);
	assert.equal(isVoiceTranscriptionConfigured({ enabled: false, runtimeReady: false }), false);
	// 请求麦克风走同一判据。
	assert.equal(shouldRequestVoiceMicrophone({ enabled: false, runtimeReady: false }), false);
	assert.equal(shouldRequestVoiceMicrophone({ enabled: true, runtimeReady: true }), true);
	const hookSource = readFileSync("src/renderer/src/hooks/useVoiceTranscription.ts", "utf8");
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
