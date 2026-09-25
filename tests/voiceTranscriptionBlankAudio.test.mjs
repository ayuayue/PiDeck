import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 静音录音被当成正文的回归：用户报「空的时候输入框里出现 [BLANK_AUDIO]」。
 * whisper.cpp 与 OpenAI 兼容云端在静音时都吐这个占位词而不是空串，
 * 所以过滤必须在 VoiceTranscriptionService 这个「两引擎共用出口」收口。
 */
const load = createTsSandbox();
const service = load("src/main/voice/VoiceTranscriptionService.ts");

const LOCAL_CONFIG = { enabled: true, engine: "local", language: "", cliPath: "", localModelId: "base-q5_1", baseUrl: "", model: "", hasApiKey: false, runtimeReady: true, inputDeviceId: "" };

function serviceWithLocalResult(text) {
	return new service.VoiceTranscriptionService({
		getPublicConfig: async () => LOCAL_CONFIG,
		getCredentials: async () => null,
		transcribeLocal: async () => ({ ok: true, text }),
		log: () => undefined,
	});
}

async function transcribeLocalResult(text) {
	const wav = new ArrayBuffer(64);
	return serviceWithLocalResult(text).transcribe({ requestId: "req-1", audio: wav, mimeType: "audio/wav" });
}

test("本地引擎只吐出占位词时按 empty 返回，不插进输入框", async () => {
	for (const raw of ["[BLANK_AUDIO]", "\r\n[BLANK_AUDIO]\r\n", "[MUSIC]", "[LAUGHTER]", "[KLICKGERÄUSCH]", "<unknown>", "( noise )"]) {
		const result = await transcribeLocalResult(raw);
		assert.equal(result.ok, false, `${JSON.stringify(raw)} 应判为未识别到语音`);
		assert.equal(result.error, "empty");
	}
});

test("占位词混在真实口述里时只删占位词", async () => {
	const result = await transcribeLocalResult("帮我看 [BLANK_AUDIO] 这个函数");
	assert.equal(result.ok, true);
	assert.equal(result.text, "帮我看 这个函数");
});

test("正常文本原样返回（含括号正文不被误删）", async () => {
	const result = await transcribeLocalResult("数组下标从 0 开始（原文如此）");
	assert.equal(result.ok, true);
	assert.equal(result.text, "数组下标从 0 开始（原文如此）");
});

test("云端引擎同样经过收口：过滤不是本地引擎专属", () => {
	const source = readFileSync("src/main/voice/VoiceTranscriptionService.ts", "utf8");
	// 两条分支都必须落到 toSpeechResult（空白容忍，biome 可能重排缩进）。
	assert.match(source, /return\s+local\.ok\s+\?\s+toSpeechResult\(local\.text\)\s*:\s+local\s*;/);
	assert.match(source, /const\s+text\s*=\s*parseTranscriptionText\(textBody\);[\s\S]{0,80}return\s+toSpeechResult\(text\);/);
});

test("过滤边界：半截括号不吃，全大写方括号按整类吃掉", () => {
	// 必须有闭合方括号才认为是特殊标记。
	assert.equal(service.stripNonSpeechPlaceholders("[BLANK_AUDIO"), "[BLANK_AUDIO");
	// 刻意取舍：whisper 的非语音标记全是「方括号 + 全大写」，口述里几乎不会出现这种形态，
	// 因此按整类识别（[MUSIC] / [KLICKGERÄUSCH] 等不必再逐个补清单）。
	assert.equal(service.stripNonSpeechPlaceholders("[IMPORTANT] note"), "note");
	// 中文圆括号正文不动。
	assert.equal(service.stripNonSpeechPlaceholders("这里有个数组（从 0 开始）"), "这里有个数组（从 0 开始）");
});
