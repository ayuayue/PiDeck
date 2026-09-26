import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 云端第二家服务商：火山引擎「豆包录音文件识别极速版」。
 *
 * 契约要点（官方文档，非推测）：端点固定、鉴权全在 X-Api-* 请求头、音频以 base64 直传
 * （不接受本地文件以外的容器，也不走公网 URL 轮询那条标准版路径）、**业务状态码在响应头**
 * 而不是 HTTP 状态码里。这几条每条都曾被「顺手写成 OpenAI 兼容那套」破坏过，所以逐条钉住。
 */
const load = createTsSandbox({ globals: { Blob, FormData, Response, fetch, URL } });
const shared = load("src/shared/voiceTranscriptionConfig.ts");
const { VoiceTranscriptionConfigStore } = load("src/main/voice/VoiceTranscriptionConfigStore.ts");
const { transcribeWithVolcengine } = load("src/main/voice/VolcengineSpeechClient.ts");
const { VoiceTranscriptionService } = load("src/main/voice/VoiceTranscriptionService.ts");

const FLASH_ENDPOINT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";

function newSignal() {
	return new AbortController().signal;
}

/** 豆包路径的公共入参：音频恒为 WAV 字节。 */
function volcInput(overrides = {}) {
	return { audio: new Uint8Array([1, 2, 3, 4]).buffer, appId: "app-1", accessToken: "tok-1", resourceId: shared.VOLC_ENGINE_DEFAULT_RESOURCE_ID, language: "zh", signal: newSignal(), ...overrides };
}

test("服务商为豆包时不要求 baseUrl/model，资源 ID 只认客户端已实现的那一个", () => {
	const volc = shared.sanitizeVoiceTranscriptionConfig({ engine: "cloud", cloudProvider: "volcengine", baseUrl: "", model: "" });
	assert.equal(volc.cloudProvider, "volcengine");
	assert.equal(volc.baseUrl, "", "豆包没有自建端点概念，清空不该判为非法配置");
	assert.equal(volc.cloudResourceId, shared.VOLC_ENGINE_DEFAULT_RESOURCE_ID, "留空回落默认资源 ID");
	// 资源 ID 直接进请求头：脏值（空格/换行这类注入尝试）与客户端没实现的协议一律整体作废并回落默认，
	// 而不是只裁空白——判据是「在不在已实现清单里」，所以只收公网 URL 的标准版协议也不会被误发。
	// 这里是「回落」而不是「判非法」：读盘路径上 sanitize 失败会清空整个配置，
	// 一个来自未来版本的资源 ID 不该让用户丢掉全部语音设置。
	for (const dirty of ["ok id", "x\nX-Api-Sequence: 0", "volc.bigasr.auc", "volc.bigasr.auc_turbo;"]) {
		assert.equal(shared.sanitizeVoiceTranscriptionConfig({ engine: "cloud", cloudProvider: "volcengine", cloudResourceId: dirty }).cloudResourceId, shared.VOLC_ENGINE_DEFAULT_RESOURCE_ID, dirty);
	}
	assert.deepEqual([...shared.VOLC_SUPPORTED_RESOURCE_IDS], [shared.VOLC_ENGINE_DEFAULT_RESOURCE_ID]);
	// OpenAI 兼容那侧的必填项不受影响。
	assert.equal(shared.sanitizeVoiceTranscriptionConfig({ engine: "cloud", cloudProvider: "openai", baseUrl: "", model: "" }), null);
});

test("whisper 语言代码映射为豆包的 BCP-47，认不出的原样透传", () => {
	assert.equal(shared.normalizeVolcLanguageTag("zh"), "zh-CN");
	assert.equal(shared.normalizeVolcLanguageTag("en"), "en-US");
	assert.equal(shared.normalizeVolcLanguageTag("yue"), "yue-CN");
	assert.equal(shared.normalizeVolcLanguageTag("  "), "", "留空 = 不送该字段，由服务端判语种");
	assert.equal(shared.normalizeVolcLanguageTag("zh-TW"), "zh-TW", "已经是区域格式的原样透传");
	assert.equal(shared.normalizeVolcLanguageTag("klingon"), "klingon", "未知代码让服务端报错，比客户端静默改语言可诊断");
});

test("三家密钥各占一槽：切换服务商不覆盖另一家，清除只清当前家", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-voice-volc-"));
	const configPath = join(directory, "voice-transcription.json");
	try {
		const store = new VoiceTranscriptionConfigStore({
			getConfigPath: () => configPath,
			isEncryptionAvailable: () => true,
			protect: (value) => Buffer.from(`protected:${value}`, "utf8"),
			unprotect: (value) =>
				Buffer.from(value)
					.toString("utf8")
					.replace(/^protected:/, ""),
			log: () => undefined,
			isLocalReady: () => true,
		});
		const base = { enabled: true, engine: "cloud", cloudProvider: "openai", baseUrl: "https://api.example.com/v1", model: "whisper-1", language: "zh", inputDeviceId: "", localModelId: "small-q5_1", cliPath: "", cloudResourceId: "" };

		const openai = await store.saveConfig({ ...base, apiKey: "sk-a" });
		assert.equal(openai.ok, true);
		assert.equal(openai.config.hasApiKey, true);
		assert.equal(openai.config.hasVolcAppId, false);

		const volc = await store.saveConfig({ ...base, cloudProvider: "volcengine", volcAppId: "app-1", volcAccessToken: "tok-1" });
		assert.equal(volc.config.hasApiKey, true, "切到豆包不得把 OpenAI 的 key 挤掉");
		assert.equal(volc.config.hasVolcAppId, true);
		assert.equal(volc.config.hasVolcAccessToken, true);
		assert.equal(volc.config.runtimeReady, true);

		const volcCredentials = await store.getCredentials();
		assert.equal(volcCredentials.provider, "volcengine");
		assert.equal(volcCredentials.appId, "app-1");
		assert.equal(volcCredentials.accessToken, "tok-1");
		assert.equal(volcCredentials.resourceId, shared.VOLC_ENGINE_DEFAULT_RESOURCE_ID);

		// 清除：同批带来的新密钥必须输，否则「点清除时输入框里还有半截字」会把密钥又写回去。
		const cleared = await store.saveConfig({ ...base, cloudProvider: "volcengine", clearApiKey: true, volcAppId: "must-not-win" });
		assert.equal(cleared.config.hasVolcAppId, false);
		assert.equal(cleared.config.hasVolcAccessToken, false);
		assert.equal(cleared.config.hasApiKey, true, "清除只针对豆包");

		const back = await store.saveConfig({ ...base });
		assert.equal(back.config.hasApiKey, true);
		const openaiCredentials = await store.getCredentials();
		assert.equal(openaiCredentials.provider, "openai");
		assert.equal(openaiCredentials.apiKey, "sk-a");

		const onDisk = await readFile(configPath, "utf8");
		assert.equal(onDisk.includes("sk-a"), false);
		assert.equal(onDisk.includes("must-not-win"), false);
		assert.equal(onDisk.includes("app-1"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("豆包请求按极速版契约发出：X-Api-* 头 + base64 WAV + 标点/数规开启", async () => {
	let captured;
	const result = await transcribeWithVolcengine(
		{
			fetchImpl: async (url, init) => {
				captured = { url: String(url), init };
				return new Response(JSON.stringify({ result: { text: " 你好，世界。 " } }), { status: 200 });
			},
			log: () => undefined,
		},
		volcInput(),
	);
	assert.equal(result.ok, true);
	assert.equal(result.text, "你好，世界。", "首尾空白要收掉，插进输入框才不脏");
	assert.equal(captured.url, FLASH_ENDPOINT);
	assert.equal(captured.init.method, "POST");
	assert.equal(captured.init.headers["X-Api-App-Key"], "app-1");
	assert.equal(captured.init.headers["X-Api-Access-Key"], "tok-1");
	assert.equal(captured.init.headers["X-Api-Resource-Id"], shared.VOLC_ENGINE_DEFAULT_RESOURCE_ID);
	assert.equal(captured.init.headers["X-Api-Sequence"], "-1", "极速版单次请求必须是 -1，否则服务端按流式分帧等后续包");
	assert.match(captured.init.headers["X-Api-Request-Id"], /^[0-9a-f-]{36}$/);
	const payload = JSON.parse(captured.init.body);
	assert.equal(payload.audio.format, "wav");
	assert.equal(payload.audio.language, "zh-CN", "语言代码要映射成 BCP-47 才认");
	assert.equal(Buffer.from(payload.audio.data, "base64").toString("hex"), "01020304");
	assert.equal(payload.request.model_name, "bigmodel");
	assert.equal(payload.request.enable_punc, true, "标点默认关，口述场景不打开就没有标点");
	assert.equal(payload.request.enable_itn, true);
});

test("无 Access Token 走新版控制台单密钥头；语言留空则不带该字段", async () => {
	let captured;
	const result = await transcribeWithVolcengine(
		{
			fetchImpl: async (_url, init) => {
				captured = init;
				return new Response(JSON.stringify({ result: { text: "ok" } }), { status: 200 });
			},
			log: () => undefined,
		},
		volcInput({ accessToken: "", language: "  " }),
	);
	assert.equal(result.ok, true);
	assert.equal(captured.headers["X-Api-Key"], "app-1");
	assert.equal("X-Api-App-Key" in captured.headers, false);
	assert.equal("X-Api-Access-Key" in captured.headers, false);
	assert.equal("language" in JSON.parse(captured.body).audio, false);
});

test("业务码在响应头里：静音/参数错/服务端忙各自映射，且不带回上游正文", async () => {
	for (const [code, expected] of [
		["20000003", "empty"],
		["45000002", "empty"],
		["45000001", "invalidRequest"],
		["45000151", "invalidRequest"],
		["55000031", "http"],
	]) {
		const result = await transcribeWithVolcengine(
			{
				fetchImpl: async () =>
					new Response(JSON.stringify({ result: { text: "不该被采用" } }), {
						status: 200,
						headers: { "X-Api-Status-Code": code },
					}),
				log: () => undefined,
			},
			volcInput(),
		);
		assert.equal(result.ok, false);
		assert.equal(result.error, expected, `${code} 应映射为 ${expected}`);
		assert.equal("text" in result, false);
		// 原始码要随结果带出：设置页的检测按钮靠它把「未开通极速版 / 额度用尽」与网络抖动分开。
		assert.equal(result.detail.statusCode, code, `${code} 应带出原始业务码`);
	}
	const unauthorized = await transcribeWithVolcengine({ fetchImpl: async () => new Response(`bad key app-1`, { status: 401 }), log: () => undefined }, volcInput());
	assert.equal(unauthorized.error, "invalidKey");
	assert.equal("text" in unauthorized, false, "上游正文不得回流到渲染层");
	// X-Tt-Logid 与 X-Api-Message 是官方工单要的东西，透出去才可能让用户自查。
	const withLog = await transcribeWithVolcengine({ fetchImpl: async () => new Response("{}", { status: 200, headers: { "X-Api-Status-Code": "45000088", "X-Api-Message": "no permission", "X-Tt-Logid": "log-1" } }), log: () => undefined }, volcInput());
	assert.equal(withLog.error, "http", "未文档化的失败码按服务错误处理，但原始线索不得丢");
	assert.equal(withLog.detail.statusCode, "45000088");
	assert.equal(withLog.detail.message, "no permission");
	assert.equal(withLog.detail.logId, "log-1");
	const successButNoText = await transcribeWithVolcengine({ fetchImpl: async () => new Response(JSON.stringify({ result: { text: "   " } }), { status: 200 }), log: () => undefined }, volcInput());
	assert.equal(successButNoText.error, "empty");
});

test("服务层按服务商分派：豆包走 JSON+WAV，非 WAV 录音在本地就拒", async () => {
	const config = {
		enabled: true,
		engine: "cloud",
		cloudProvider: "volcengine",
		baseUrl: "",
		model: "",
		language: "zh",
		inputDeviceId: "",
		localModelId: "small-q5_1",
		cliPath: "",
		cloudResourceId: shared.VOLC_ENGINE_DEFAULT_RESOURCE_ID,
		hasApiKey: false,
		hasVolcAppId: true,
		runtimeReady: true,
	};
	const credentials = { provider: "volcengine", appId: "app-1", accessToken: "tok-1", resourceId: shared.VOLC_ENGINE_DEFAULT_RESOURCE_ID, language: "zh" };
	let calls = 0;
	const service = new VoiceTranscriptionService({
		getPublicConfig: async () => config,
		getCredentials: async () => credentials,
		fetch: async (url, init) => {
			calls += 1;
			assert.equal(String(url), FLASH_ENDPOINT);
			assert.equal(init.headers["X-Api-App-Key"], "app-1");
			return new Response(JSON.stringify({ result: { text: "開發完成了。" } }), { status: 200 });
		},
		log: () => undefined,
	});
	const wav = new Uint8Array([82, 73, 70, 70]).buffer;
	const result = await service.transcribe({ requestId: "volc-1", audio: wav, mimeType: "audio/wav" });
	assert.equal(result.ok, true);
	assert.equal(result.text, "开发完成了。", "繁简收口与 OpenAI 路径同源，不能各家一套");
	assert.equal(calls, 1);

	// 渲染层在 provider=volcengine 时已转码为 WAV；webm 送过去只会换来服务端 45000151，
	// 在本地判掉才能给出「未录到声音/格式不支持」这类对得上的提示。
	const webm = await service.transcribe({ requestId: "volc-2", audio: wav, mimeType: "audio/webm" });
	assert.equal(webm.error, "invalidRequest");
	assert.equal(calls, 1, "拒收不得发出请求");
});
