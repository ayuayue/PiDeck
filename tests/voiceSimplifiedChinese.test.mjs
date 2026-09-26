import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 繁简收口（用户报「有时转出来是繁体，能不能默认简体」）。
 *
 * 两层做法都要有：提示词在解码阶段把分布推向简体，映射表保证漏网的繁体字一定落回简体。
 * 这里测的是第二层的**行为**，第一层用源码断言守住（真实模型输出不可复现，测不了）。
 */
const load = createTsSandbox({ globals: { Blob, FormData, Response, fetch, URL } });
const { toSimplifiedChinese, VOICE_SIMPLIFIED_CHINESE_PROMPT } = load("src/main/voice/simplifiedChinese.ts");

test("繁体字按 OpenCC 字表落回简体", () => {
	assert.equal(toSimplifiedChinese("開發團隊與系統"), "开发团队与系统");
	assert.equal(toSimplifiedChinese("這個功能的驗證要先跑測試"), "这个功能的验证要先跑测试");
});

test("词表优先于字表：乾这样的多义字只在整词里保留", () => {
	// TSPhrases 里「乾隆」是保留词，字级直译会变成「干隆」。
	assert.equal(toSimplifiedChinese("乾隆皇帝"), "乾隆皇帝");
	assert.equal(toSimplifiedChinese("乾坤"), "乾坤");
	// 单独出现的「乾」按简体写为「干」。
	assert.equal(toSimplifiedChinese("乾"), "干");
});

test("非中文与表情符号原样返回（代理对不得被拆坏）", () => {
	assert.equal(toSimplifiedChinese("npm run typecheck 2>&1"), "npm run typecheck 2>&1");
	assert.equal(toSimplifiedChinese("好的 👍 我们继续"), "好的 👍 我们继续");
	assert.equal(toSimplifiedChinese("𠮷田"), "𠮷田");
	assert.equal(toSimplifiedChinese(""), "");
});

test("转换是幂等的：简体输入不会被二次改动", () => {
	const once = toSimplifiedChinese("數據庫連線已經重設");
	assert.equal(once, "数据库连线已经重设");
	assert.equal(toSimplifiedChinese(once), once);
});

test("提示词常量必须是简体、且明确点名简体中文", () => {
	assert.equal(VOICE_SIMPLIFIED_CHINESE_PROMPT, "以下是简体中文的普通话转录。");
	assert.equal(toSimplifiedChinese(VOICE_SIMPLIFIED_CHINESE_PROMPT), VOICE_SIMPLIFIED_CHINESE_PROMPT);
});

test("两条引擎的结果都经过同一收口（云端 whisper 同样会吐繁体）", async () => {
	const serviceModule = load("src/main/voice/VoiceTranscriptionService.ts");
	const localConfig = { enabled: true, engine: "local", language: "zh", cliPath: "", localModelId: "small-q5_1", baseUrl: "", model: "", hasApiKey: false, runtimeReady: true, inputDeviceId: "" };
	const local = new serviceModule.VoiceTranscriptionService({
		getPublicConfig: async () => localConfig,
		getCredentials: async () => null,
		transcribeLocal: async () => ({ ok: true, text: "開發完成了" }),
		log: () => undefined,
	});
	const localResult = await local.transcribe({ requestId: "req-t1", audio: new ArrayBuffer(64), mimeType: "audio/wav" });
	assert.equal(localResult.ok, true);
	assert.equal(localResult.text, "开发完成了");

	const cloudConfig = { ...localConfig, engine: "cloud", baseUrl: "https://api.example.com/v1", model: "whisper-1" };
	const cloud = new serviceModule.VoiceTranscriptionService({
		getPublicConfig: async () => cloudConfig,
		getCredentials: async () => ({ baseUrl: "https://api.example.com/v1", apiKey: "sk-x", model: "whisper-1", language: "zh" }),
		fetch: async () => new Response(JSON.stringify({ text: "開發完成了" }), { status: 200 }),
		log: () => undefined,
	});
	const cloudResult = await cloud.transcribe({ requestId: "req-t2", audio: new ArrayBuffer(64), mimeType: "audio/wav" });
	assert.equal(cloudResult.text, "开发完成了");
});

test("提示词真的送到了两个本地入口（CLI 参数与 server 请求字段）", () => {
	// 真实模型输出不可复现，这里守住「参数有传出去」这条链路不被改漏。
	const transcriber = readFileSync("src/main/voice/WhisperTranscriber.ts", "utf8");
	assert.match(transcriber, /"--prompt",\s*VOICE_SIMPLIFIED_CHINESE_PROMPT/);
	assert.match(transcriber, /"--carry-initial-prompt"/);
	const pool = readFileSync("src/main/voice/WhisperServerPool.ts", "utf8");
	assert.match(pool, /form\.append\(\s*"prompt",\s*VOICE_SIMPLIFIED_CHINESE_PROMPT\s*\)/);
	assert.match(pool, /form\.append\(\s*"carry_initial_prompt",\s*"true"\s*\)/);
});
