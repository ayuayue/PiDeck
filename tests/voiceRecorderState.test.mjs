import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(
	readFileSync("src/renderer/src/utils/voiceRecorderLifecycle.ts", "utf8"),
	{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, { module, exports: module.exports });
const {
	canCancelVoiceRecording,
	canStartVoiceRecording,
	isVoiceTranscriptionConfigured,
	releaseVoiceRecordingResources,
	shouldRequestVoiceMicrophone,
} = module.exports;

test("only idle can start and only recording can cancel", () => {
	assert.equal(canStartVoiceRecording("idle"), true);
	assert.equal(canStartVoiceRecording("requesting"), false);
	assert.equal(canStartVoiceRecording("recording"), false);
	assert.equal(canStartVoiceRecording("transcribing"), false);
	assert.equal(canCancelVoiceRecording("recording"), true);
	assert.equal(canCancelVoiceRecording("requesting"), false);
	assert.equal(canCancelVoiceRecording("transcribing"), false);
});

test("microphone permission is gated by the redacted hasApiKey preflight", () => {
	// 必需参数三件套：apiKey + baseUrl + model，缺一不可（未配置时按钮隐藏）
	assert.equal(isVoiceTranscriptionConfigured({ hasApiKey: true, baseUrl: "https://api.openai.com/v1", model: "whisper-1" }), true);
	assert.equal(isVoiceTranscriptionConfigured({ hasApiKey: false, baseUrl: "https://api.openai.com/v1", model: "whisper-1" }), false);
	assert.equal(isVoiceTranscriptionConfigured({ hasApiKey: true, baseUrl: "  ", model: "whisper-1" }), false);
	assert.equal(isVoiceTranscriptionConfigured({ hasApiKey: true, baseUrl: "https://api.openai.com/v1", model: "" }), false);
	assert.equal(shouldRequestVoiceMicrophone({ hasApiKey: false, baseUrl: "", model: "" }), false);
	assert.equal(shouldRequestVoiceMicrophone({ hasApiKey: true, baseUrl: "https://api.openai.com/v1", model: "whisper-1" }), true);
	const hookSource = readFileSync("src/renderer/src/hooks/useVoiceTranscription.ts", "utf8");
	assert.ok(hookSource.indexOf("voiceTranscription.getConfig()") < hookSource.indexOf("getUserMedia({ audio: true })"));
	assert.ok(hookSource.indexOf("streamRef.current = stream") < hookSource.indexOf("new MediaRecorder(stream"));
	// 渲染层入口由配置完整性控制：ComposerArea 在未配置时不渲染录音控件
	const composerSource = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	assert.match(composerSource, /composer\.voice\.configured \? \(/);
});

test("cleanup detaches recorder handlers and stops every microphone track", () => {
	let stopped = 0;
	const recorder = {
		ondataavailable: () => {},
		onerror: () => {},
		onstop: () => {},
	};
	const stream = {
		getTracks: () => [{ stop: () => { stopped += 1; } }, { stop: () => { stopped += 1; } }],
	};
	releaseVoiceRecordingResources({ recorder, stream });
	assert.equal(recorder.ondataavailable, null);
	assert.equal(recorder.onerror, null);
	assert.equal(recorder.onstop, null);
	assert.equal(stopped, 2);
});
