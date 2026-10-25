import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 云端第二家服务商：火山引擎「豆包语音」，两条通路都在这里。
 *
 * 契约要点（官方文档 + 2026-09-27 真机探测，非推测）：端点固定、鉴权全在 X-Api-* 请求头、
 * 音频以 base64 直传（极速版不接受本地文件以外的容器，也不走公网 URL 轮询那条标准版路径）、
 * **业务状态码在响应头**而不是 HTTP 状态码里；流式 2.0 则是 WebSocket + 自定义二进制帧，
 * 上行 16bit 裸 PCM。这几条每条都曾被「顺手写成 OpenAI 兼容那套」破坏过，所以逐条钉住。
 */
const load = createTsSandbox({ globals: { Blob, FormData, Response, fetch, URL } });
const shared = load("src/shared/voiceTranscriptionConfig.ts");
const { VoiceTranscriptionConfigStore } = load("src/main/voice/VoiceTranscriptionConfigStore.ts");
const { transcribeWithVolcengine } = load("src/main/voice/VolcengineSpeechClient.ts");
const { VoiceTranscriptionService } = load("src/main/voice/VoiceTranscriptionService.ts");

const FLASH_ENDPOINT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
/** 清单首位即默认资源（流式 2.0），测试用它而不是写死字符串，免得改名时测试悄悄失真。 */
const DEFAULT_RESOURCE_ID = shared.VOLC_SUPPORTED_RESOURCE_IDS[0];

function newSignal() {
	return new AbortController().signal;
}

/** 豆包路径的公共入参：音频恒为 WAV 字节。 */
function volcInput(overrides = {}) {
	return { audio: new Uint8Array([1, 2, 3, 4]).buffer, appId: "app-1", accessToken: "tok-1", resourceId: shared.VOLC_FLASH_RESOURCE_ID, language: "zh", signal: newSignal(), ...overrides };
}

test("服务商为豆包时不要求 baseUrl/model，资源 ID 只认客户端已实现的那一个", () => {
	const volc = shared.sanitizeVoiceTranscriptionConfig({ engine: "cloud", cloudProvider: "volcengine", baseUrl: "", model: "" });
	assert.equal(volc.cloudProvider, "volcengine");
	assert.equal(volc.baseUrl, "", "豆包没有自建端点概念，清空不该判为非法配置");
	assert.equal(volc.cloudResourceId, DEFAULT_RESOURCE_ID, "留空回落首位（流式）资源 ID");
	assert.equal(shared.resolveVolcProtocol(DEFAULT_RESOURCE_ID), "stream", "默认必须是流式 2.0，设置页首选项与运行时通路不能各说各话");
	// 资源 ID 直接进请求头：脏值（空格/换行这类注入尝试）与客户端没实现的协议一律整体作废并回落首位，
	// 而不是只裁空白——判据是「在不在已实现清单里」，所以只收公网 URL 的标准版协议也不会被误发。
	// 这里是「回落」而不是「判非法」：读盘路径上 sanitize 失败会清空整个配置，
	// 一个来自未来版本的资源 ID 不该让用户丢掉全部语音设置。
	for (const dirty of ["ok id", "x\nX-Api-Sequence: 0", "volc.bigasr.auc", "volc.bigasr.auc_turbo;"]) {
		assert.equal(shared.sanitizeVoiceTranscriptionConfig({ engine: "cloud", cloudProvider: "volcengine", cloudResourceId: dirty }).cloudResourceId, DEFAULT_RESOURCE_ID, dirty);
	}
	assert.equal(shared.sanitizeVoiceTranscriptionConfig({ engine: "cloud", cloudProvider: "volcengine", cloudResourceId: shared.VOLC_FLASH_RESOURCE_ID }).cloudResourceId, shared.VOLC_FLASH_RESOURCE_ID, "极速版仍在清单内，留在下拉备选");
	assert.equal(shared.resolveVolcProtocol(shared.VOLC_FLASH_RESOURCE_ID), "flash");
	assert.deepEqual([...shared.VOLC_SUPPORTED_RESOURCE_IDS], [shared.VOLC_STREAM_RESOURCE_ID, shared.VOLC_FLASH_RESOURCE_ID]);
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
		assert.equal(volcCredentials.resourceId, DEFAULT_RESOURCE_ID, "未写资源 ID 的配置应回落到清单首位（流式）");

		// 摘要 + 按需明文：设置页要靠这两件事回答「我到底存了什么」，否则看不见就只能靠检测猜。
		const long = await store.saveConfig({ ...base, cloudProvider: "volcengine", volcAppId: "app-9122285961", volcAccessToken: "token-abcdefghij" });
		assert.equal(long.config.volcAppIdHint.tail, "5961");
		assert.equal(long.config.volcAppIdHint.length, 14);
		assert.equal(long.config.volcAccessTokenHint.tail, "ghij", "长值只露末 4 位，够认出有没有被截断");
		// 短值只露一半，避免「4 位的密钥」被整格还原。
		assert.equal(long.config.apiKeyHint.tail, "-a", "另一家的槽位也要能摘要，切换服务商时才看得出没丢");
		assert.equal(long.config.apiKeyHint.length, 4);
		assert.equal(await store.revealSecret("volcAccessToken"), "token-abcdefghij");
		assert.equal(await store.revealSecret("apiKey"), "sk-a");

		// 清除：同批带来的新密钥必须输，否则「点清除时输入框里还有半截字」会把密钥又写回去。
		const cleared = await store.saveConfig({ ...base, cloudProvider: "volcengine", clearApiKey: true, volcAppId: "must-not-win" });
		assert.equal(cleared.config.hasVolcAppId, false);
		assert.equal(cleared.config.hasVolcAccessToken, false);
		assert.equal(cleared.config.hasApiKey, true, "清除只针对豆包");
		assert.equal(cleared.config.volcAppIdHint, null, "清除后摘要也得消失，否则设置页还显示着一串旧尾号");
		assert.equal(await store.revealSecret("volcAppId"), null);

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
	assert.equal(captured.init.headers["X-Api-Resource-Id"], shared.VOLC_FLASH_RESOURCE_ID);
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

test("401/403 也按业务码分类：资源没开通不能说成「Key 无效」", async () => {
	// 2026-09-26 真机实测的两种失败，HTTP 状态同类、语义完全不同：
	// 403 + 45000030 `requested resource not granted` = 应用没勾选极速版；
	// 401 + 45000010 `request and grant appid mismatch` = App ID 与 Access Token 不配对。
	// 只按状态码分类会把前者误报成凭据错误，用户于是反复改密钥，而该做的开通没人提示。
	for (const [status, code, message, expected] of [
		[403, "45000030", "[resource_id=volc.bigasr.auc_turbo] requested resource not granted", "notGranted"],
		[401, "45000010", "request and grant appid mismatch", "invalidKey"],
	]) {
		const result = await transcribeWithVolcengine({ fetchImpl: async () => new Response("", { status, headers: { "X-Api-Status-Code": code, "X-Api-Message": message } }), log: () => undefined }, volcInput());
		assert.equal(result.ok, false);
		assert.equal(result.error, expected, `${code} 应分类为 ${expected}`);
		assert.equal(result.detail.message, message, "服务端原文要透出：它比自造文案更具体");
	}
	// 响应头是外部数据，超长内容不得原样流进 UI 与日志。
	const huge = await transcribeWithVolcengine({ fetchImpl: async () => new Response("", { status: 403, headers: { "X-Api-Status-Code": "45000099", "X-Api-Message": "x".repeat(5000) } }), log: () => undefined }, volcInput());
	assert.equal(huge.error, "invalidKey", "码不在清单里时退回按状态码分类");
	assert.ok(huge.detail.message.length <= 200, `原文需限行，实际 ${huge.detail.message.length}`);
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
		cloudResourceId: shared.VOLC_FLASH_RESOURCE_ID,
		hasApiKey: false,
		hasVolcAppId: true,
		runtimeReady: true,
	};
	const credentials = { provider: "volcengine", appId: "app-1", accessToken: "tok-1", resourceId: shared.VOLC_FLASH_RESOURCE_ID, language: "zh" };
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
