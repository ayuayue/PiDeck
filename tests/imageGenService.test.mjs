import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

/**
 * ImageGenService 单测：验证供应商凭据校验、请求体、错误码映射、b64_json/url 回退。
 * 用 vm 沙箱加载 transpile 后的 TS 类（模块仅 type import，无运行时依赖）；
 * fetch/AbortSignal/Buffer 显式注入沙箱（vm 上下文隔离宿主全局）。
 */

const source = readFileSync("src/main/imagegen/ImageGenService.ts", "utf8");

/** 用 TypeScript transpile 剥掉类型与参数属性语法，得到纯 JS 类定义 */
function transpile(ts) {
	const { ts: tsApi } = loadTypescript();
	const out = tsApi.transpileModule(ts, {
		compilerOptions: { module: tsApi.ModuleKind.CommonJS, target: tsApi.ScriptTarget.ES2022 },
		fileName: "ImageGenService.ts",
	});
	return out.outputText;
}

function loadTypescript() {
	// 项目依赖 typescript（ESM 测试里用 createRequire 解析）
	const require = createRequire(import.meta.url);
	return { ts: require("typescript") };
}

/** 当前测试的 fetch stub（vm 沙箱经引用间接调用，隔离宿主全局） */
let fetchStubRef = null;

/** 加载 ImageGenService 类（运行时依赖 shared/imageGenParams，需注入 require） */
function loadServiceClass() {
	const configModule = { exports: {} };
	vm.runInNewContext(transpile(readFileSync("src/shared/imageGenConfig.ts", "utf8")), { module: configModule, exports: configModule.exports }, { filename: "imageGenConfig.ts" });
	const paramsModule = { exports: {} };
	vm.runInNewContext(
		transpile(readFileSync("src/shared/imageGenParams.ts", "utf8")),
		{
			module: paramsModule,
			exports: paramsModule.exports,
			// edits 模式的 multipart 构造需要宿主全局；vm 上下文看不到
			FormData,
			Blob,
			File,
			atob,
			require: (id) => {
				if (id === "./imageGenConfig") return configModule.exports;
				throw new Error(`unexpected require ${id}`);
			},
		},
		{ filename: "imageGenParams.ts" },
	);
	const exported = {};
	const sandbox = {
		exports: exported,
		module: { exports: exported },
		Buffer,
		AbortSignal,
		require: (id) => {
			if (id === "../../shared/imageGenParams") return paramsModule.exports;
			if (id === "../../shared/imageGenConfig") return configModule.exports;
			throw new Error(`unexpected require ${id}`);
		},
		// vm 上下文看不到宿主全局，fetch 必须显式注入；经可变引用转发到当前测试的 stub
		fetch: (input, init) => fetchStubRef(input, init),
	};
	vm.runInNewContext(transpile(source), sandbox, { filename: "ImageGenService.ts" });
	return sandbox.module.exports.ImageGenService;
}

/** 构造服务实例：fetchStub 为 (input, init?) => Response 替身 */
function createService({ credentials, fetchStub, log = () => {} }) {
	fetchStubRef = fetchStub;
	const ImageGenService = loadServiceClass();
	const service = new ImageGenService({
		getProviderCredentials: async () => credentials,
		log,
	});
	return {
		service,
		restore() {
			fetchStubRef = null;
		},
	};
}

/** 极简 Response 替身（只实现 service 用到的字段） */
function fakeResponse({ ok, status = 200, json, text, arrayBuffer, headers = new Map() }) {
	const jsonFn = json ?? (async () => ({}));
	return {
		ok,
		status,
		json: jsonFn,
		text: text ?? (async () => JSON.stringify(await jsonFn())),
		arrayBuffer: arrayBuffer ?? (async () => new Uint8Array(0)),
		headers: { get: (name) => headers.get(name) ?? null },
	};
}

const NO_EXTRA = { size: false, output_format: false, watermark: false };
const ALL_EXTRA = { size: true, output_format: true, watermark: true };
const CREDENTIALS = { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", extraParams: NO_EXTRA };

test("notConfigured：凭据缺失时不发网络请求", async () => {
	let called = false;
	const { service, restore } = createService({
		credentials: null,
		fetchStub: () => {
			called = true;
			return fakeResponse({ ok: true, json: async () => ({ data: [] }) });
		},
	});
	const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(result.ok, false);
	assert.equal(result.error, "notConfigured");
	assert.equal(called, false);
	restore();
});

test("请求体与请求头正确（b64_json 优先，Bearer 认证）", async () => {
	let captured;
	const { service, restore } = createService({
		credentials: CREDENTIALS,
		fetchStub: (input, init) => {
			captured = { input, init };
			return fakeResponse({ ok: true, json: async () => ({ data: [{ b64_json: "QUJD" }] }) });
		},
	});
	const result = await service.generate({ provider: "p", model: "gpt-image-1", prompt: "一只猫" });
	assert.equal(result.ok, true);
	assert.equal(result.image.data, "QUJD");
	assert.equal(captured.input, "https://api.example.com/v1/images/generations");
	assert.equal(captured.init.method, "POST");
	assert.equal(captured.init.headers.Authorization, "Bearer sk-test");
	const body = JSON.parse(captured.init.body);
	assert.equal(body.model, "gpt-image-1");
	assert.equal(body.prompt, "一只猫");
	assert.equal(body.response_format, "b64_json");
	assert.equal(body.n, 1);
	assert.equal(body.size, undefined);
	assert.equal(body.watermark, undefined);
	restore();
});

test("extraParams.size 开启才发送 size，未勾选的 watermark 不发", async () => {
	let captured;
	const { service, restore } = createService({
		credentials: { ...CREDENTIALS, extraParams: { size: true, output_format: false, watermark: false } },
		fetchStub: (_input, init) => {
			captured = init;
			return fakeResponse({ ok: true, json: async () => ({ data: [{ b64_json: "QQ==" }] }) });
		},
	});
	await service.generate({
		provider: "p",
		model: "gpt-image-1",
		prompt: "x",
		size: "1024x1536",
		watermark: true,
	});
	const body = JSON.parse(captured.body);
	assert.equal(body.size, "1024x1536");
	assert.equal(body.watermark, undefined);
	restore();
});

test("extraParams 全开时发送 size / watermark / output_format", async () => {
	let captured;
	const { service, restore } = createService({
		credentials: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "k", extraParams: ALL_EXTRA },
		fetchStub: (_input, init) => {
			captured = init;
			return fakeResponse({ ok: true, json: async () => ({ data: [{ b64_json: "QQ==" }] }) });
		},
	});
	await service.generate({
		provider: "p",
		model: "doubao-seedream",
		prompt: "x",
		size: "2K",
		watermark: false,
	});
	const body = JSON.parse(captured.body);
	assert.equal(body.size, "2K");
	assert.equal(body.watermark, false);
	restore();
});

test("勾选 output_format 时 jpeg 写入请求体并回填 image/jpeg mime", async () => {
	let captured;
	const { service, restore } = createService({
		credentials: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "k", extraParams: ALL_EXTRA },
		fetchStub: (_input, init) => {
			captured = init;
			return fakeResponse({ ok: true, json: async () => ({ data: [{ b64_json: "QQ==" }] }) });
		},
	});
	const result = await service.generate({
		provider: "p",
		model: "doubao-seedream",
		prompt: "x",
		outputFormat: "jpeg",
	});
	const body = JSON.parse(captured.body);
	assert.equal(body.output_format, "jpeg");
	assert.equal(result.ok, true);
	assert.equal(result.image.mimeType, "image/jpeg");
	restore();
});

test("未勾选 output_format 时不发送该字段，b64 mime 保持 image/png", async () => {
	let captured;
	const { service, restore } = createService({
		credentials: CREDENTIALS,
		fetchStub: (_input, init) => {
			captured = init;
			return fakeResponse({ ok: true, json: async () => ({ data: [{ b64_json: "QQ==" }] }) });
		},
	});
	const result = await service.generate({
		provider: "p",
		model: "gpt-image-1",
		prompt: "x",
		outputFormat: "jpeg",
	});
	const body = JSON.parse(captured.body);
	assert.equal(body.output_format, undefined);
	assert.equal(result.image.mimeType, "image/png");
	restore();
});

test("401/403 → invalidKey", async () => {
	const { service, restore } = createService({
		credentials: CREDENTIALS,
		fetchStub: () => fakeResponse({ ok: false, status: 401 }),
	});
	const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(result.error, "invalidKey");
	restore();
});

test("404/405 → badBaseUrl", async () => {
	for (const status of [404, 405]) {
		const { service, restore } = createService({
			credentials: CREDENTIALS,
			fetchStub: () => fakeResponse({ ok: false, status }),
		});
		const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
		assert.equal(result.error, "badBaseUrl");
		restore();
	}
});

test("其他非 2xx → http（detail 带状态码）", async () => {
	const { service, restore } = createService({
		credentials: CREDENTIALS,
		fetchStub: () => fakeResponse({ ok: false, status: 500 }),
	});
	const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(result.error, "http");
	assert.equal(result.detail, "500");
	restore();
});

test("非 2xx 时 detail 带厂商错误正文，并脱敏 key", async () => {
	const { service, restore } = createService({
		credentials: CREDENTIALS,
		fetchStub: () =>
			fakeResponse({
				ok: false,
				status: 400,
				json: async () => ({
					error: {
						message: "Your prompt was rejected. Use sk-abcdefghijklmnopqrstuvwxyz instead.",
						code: "content_policy",
					},
				}),
			}),
	});
	const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(result.error, "http");
	assert.match(result.detail, /^400: /);
	assert.match(result.detail, /Your prompt was rejected/);
	assert.match(result.detail, /content_policy/);
	assert.doesNotMatch(result.detail, /sk-abcdefghijklmnopqrstuvwxyz/);
	assert.match(result.detail, /sk-\*\*\*/);
	restore();
});

test("b64_json 优先返回 base64 图片", async () => {
	const { service, restore } = createService({
		credentials: CREDENTIALS,
		fetchStub: () =>
			fakeResponse({
				ok: true,
				json: async () => ({ data: [{ b64_json: "iVBORw0KGgo=", url: "https://x/y.png" }] }),
			}),
	});
	const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(result.image.type, "image");
	assert.equal(result.image.data, "iVBORw0KGgo=");
	assert.equal(result.image.mimeType, "image/png");
	restore();
});

test("仅 url 时回退下载并转 base64", async () => {
	const { service, restore } = createService({
		credentials: CREDENTIALS,
		fetchStub: (input) => {
			// 第一次调用是生成接口，第二次是图片下载
			if (String(input).endsWith("/images/generations")) {
				return fakeResponse({ ok: true, json: async () => ({ data: [{ url: "https://x/img.png" }] }) });
			}
			return fakeResponse({
				ok: true,
				arrayBuffer: async () => new TextEncoder().encode("PNGDATA").buffer,
				headers: new Map([["content-type", "image/png"]]),
			});
		},
	});
	const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(result.ok, true);
	assert.equal(result.image.data, Buffer.from("PNGDATA").toString("base64"));
	assert.equal(result.image.mimeType, "image/png");
	restore();
});

test("响应无图片数据 → empty", async () => {
	const { service, restore } = createService({
		credentials: CREDENTIALS,
		fetchStub: () => fakeResponse({ ok: true, json: async () => ({ data: [] }) }),
	});
	const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(result.error, "empty");
	restore();
});

test("网络异常 → network（不泄露敏感信息）", async () => {
	const { service, restore } = createService({
		credentials: CREDENTIALS,
		fetchStub: () => {
			throw new Error("ECONNREFUSED 127.0.0.1:7890");
		},
	});
	const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(result.ok, false);
	assert.equal(result.error, "network");
	restore();
});

test("normalizeImagesUrl：无 /v1 时补全，尾斜杠归一", async () => {
	// 通过请求体断言端点归一化结果（正常化逻辑在 service 内部）
	const cases = [
		["https://api.example.com/v1", "https://api.example.com/v1/images/generations"],
		["https://api.example.com/v1/", "https://api.example.com/v1/images/generations"],
		["https://api.example.com", "https://api.example.com/v1/images/generations"],
		["https://api.example.com/", "https://api.example.com/v1/images/generations"],
	];
	for (const [baseUrl, expected] of cases) {
		let captured;
		const { service, restore } = createService({
			credentials: { baseUrl, apiKey: "k" },
			fetchStub: (input) => {
				captured = String(input);
				return fakeResponse({ ok: true, json: async () => ({ data: [{ b64_json: "QQ==" }] }) });
			},
		});
		await service.generate({ provider: "p", model: "m", prompt: "x" });
		assert.equal(captured, expected);
		restore();
	}
});

test("normalizeImagesUrl：非 OpenAI 风格版本段不再强行补 /v1（火山方舟 /api/v3）", async () => {
	const cases = [
		["https://ark.cn-beijing.volces.com/api/v3", "https://ark.cn-beijing.volces.com/api/v3/images/generations"],
		["https://ark.cn-beijing.volces.com/api/v3/", "https://ark.cn-beijing.volces.com/api/v3/images/generations"],
		["https://generativelanguage.googleapis.com/v1beta", "https://generativelanguage.googleapis.com/v1beta/images/generations"],
		["http://localhost:11434/api", "http://localhost:11434/api/images/generations"],
		["https://proxy.example.com/custom/v2", "https://proxy.example.com/custom/v2/images/generations"],
	];
	for (const [baseUrl, expected] of cases) {
		let captured;
		const { service, restore } = createService({
			credentials: { baseUrl, apiKey: "k" },
			fetchStub: (input) => {
				captured = String(input);
				return fakeResponse({ ok: true, json: async () => ({ data: [{ b64_json: "QQ==" }] }) });
			},
		});
		await service.generate({ provider: "p", model: "m", prompt: "x" });
		assert.equal(captured, expected, `baseUrl=${baseUrl}`);
		restore();
	}
});

test("normalizeImagesUrl：已配置完整 images/generations 端点原样使用", async () => {
	let captured;
	const { service, restore } = createService({
		credentials: { baseUrl: "https://proxy.example.com/v1/images/generations", apiKey: "k" },
		fetchStub: (input) => {
			captured = String(input);
			return fakeResponse({ ok: true, json: async () => ({ data: [{ b64_json: "QQ==" }] }) });
		},
	});
	await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(captured, "https://proxy.example.com/v1/images/generations");
	restore();
});

test("referenceUnsupported：referenceMode=none 时带参考图直接拒绝", async () => {
	let called = false;
	const { service, restore } = createService({
		credentials: { ...CREDENTIALS, referenceMode: "none" },
		fetchStub: () => {
			called = true;
			return fakeResponse({ ok: true, json: async () => ({ data: [] }) });
		},
	});
	const result = await service.generate({
		provider: "p",
		model: "m",
		prompt: "x",
		referenceImages: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
	});
	assert.equal(result.ok, false);
	assert.equal(result.error, "referenceUnsupported");
	assert.equal(called, false);
	restore();
});

test("referenceMode=image-field：参考图并入 JSON 请求体（dataURI）", async () => {
	let body;
	const { service, restore } = createService({
		credentials: { ...CREDENTIALS, referenceMode: "image-field" },
		fetchStub: (input, init) => {
			body = JSON.parse(String(init.body));
			return fakeResponse({ ok: true, json: async () => ({ data: [{ b64_json: "QUJD" }] }) });
		},
	});
	await service.generate({
		provider: "p",
		model: "seedream",
		prompt: "x",
		referenceImages: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
	});
	assert.deepEqual(body.image, ["data:image/png;base64,QUJD"]);
	restore();
});

test("apiStyle=siliconflow：size→image_size、单图参考、images[].url 兜底下载", async () => {
	let capturedBody;
	let downloads = 0;
	const { service, restore } = createService({
		credentials: {
			...CREDENTIALS,
			// 硅基用户勾选了 size：image_size 才随请求发出（与 openai 分支的 size 同一开关）
			extraParams: { size: true, output_format: false, watermark: false },
			apiStyle: "siliconflow",
			referenceMode: "image-field",
		},
		fetchStub: (input, init) => {
			if (String(input).endsWith("/images/generations")) {
				capturedBody = JSON.parse(String(init.body));
				// 硅基响应：images[].url（无 data 数组、无 b64_json）
				return fakeResponse({
					ok: true,
					json: async () => ({ images: [{ url: "https://x/img.png" }], seed: 1 }),
				});
			}
			downloads += 1;
			return fakeResponse({
				ok: true,
				arrayBuffer: async () => new TextEncoder().encode("SFIMG").buffer,
				headers: new Map([["content-type", "image/png"]]),
			});
		},
	});
	const result = await service.generate({
		provider: "p",
		model: "Kwai-Kolors/Kolors",
		prompt: "x",
		size: "1024x1024",
		referenceImages: [{ type: "image", data: "QUJD=", mimeType: "image/png" }],
	});
	assert.equal(result.ok, true);
	// 方言字段差异：size 不发、改发 image_size；参考图取首张单 dataURI string
	assert.equal(capturedBody.size, undefined);
	assert.equal(capturedBody.image_size, "1024x1024");
	assert.equal(capturedBody.image, "data:image/png;base64,QUJD=");
	// 硅基无 watermark / output_format / response_format 概念，一律不发
	assert.equal(capturedBody.watermark, undefined);
	assert.equal(capturedBody.output_format, undefined);
	assert.equal(capturedBody.response_format, undefined);
	assert.equal(downloads, 1);
	assert.equal(result.image.data, Buffer.from("SFIMG").toString("base64"));
	assert.equal(result.image.mimeType, "image/png");
	restore();
});

test("openai 方言下响应 images[].url 同样兜底（通用解析，不依赖 apiStyle）", async () => {
	let downloads = 0;
	const { service, restore } = createService({
		credentials: CREDENTIALS,
		fetchStub: (input) => {
			if (String(input).endsWith("/images/generations")) {
				return fakeResponse({ ok: true, json: async () => ({ images: [{ url: "https://x/y.png" }] }) });
			}
			downloads += 1;
			return fakeResponse({
				ok: true,
				arrayBuffer: async () => new TextEncoder().encode("PNG2").buffer,
				headers: new Map([["content-type", "image/png"]]),
			});
		},
	});
	const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(result.ok, true);
	assert.equal(result.image.data, Buffer.from("PNG2").toString("base64"));
	assert.equal(downloads, 1);
	restore();
});

test("referenceMode=edits：走 /images/edits multipart 接口", async () => {
	let captured;
	const { service, restore } = createService({
		credentials: { ...CREDENTIALS, referenceMode: "edits" },
		fetchStub: (input, init) => {
			captured = { input, init };
			return fakeResponse({ ok: true, json: async () => ({ data: [{ b64_json: "QUJD" }] }) });
		},
	});
	const result = await service.generate({
		provider: "p",
		model: "gpt-image-1",
		prompt: "x",
		referenceImages: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
	});
	assert.equal(result.ok, true);
	// normalizeImagesUrl 追加了 /v1/images/generations，edits 需替换成 /images/edits
	assert.equal(captured.input, "https://api.example.com/v1/images/edits");
	assert.ok(captured.init.body instanceof FormData);
	restore();
});

test("JSON 响应体超限 → responseTooLarge（流式读取提前中止）", async () => {
	let cancelled = false;
	const response = {
		ok: true,
		status: 200,
		body: {
			getReader: () => ({
				async read() {
					return { done: false, value: new Uint8Array(33 * 1024 * 1024) };
				},
				async cancel() {
					cancelled = true;
				},
			}),
		},
	};
	const { service, restore } = createService({ credentials: CREDENTIALS, fetchStub: () => response });
	const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(result.ok, false);
	assert.equal(result.error, "responseTooLarge");
	assert.ok(cancelled, "超限后必须 cancel reader 断开连接");
	restore();
});

test("图片下载超限 → responseTooLarge", async () => {
	let call = 0;
	const { service, restore } = createService({
		credentials: CREDENTIALS,
		fetchStub: () => {
			call += 1;
			if (call === 1) {
				return fakeResponse({ ok: true, json: async () => ({ data: [{ url: "https://img.example.com/x.png" }] }) });
			}
			return {
				ok: true,
				status: 200,
				headers: { get: () => "image/png" },
				body: {
					getReader: () => ({
						async read() {
							return { done: false, value: new Uint8Array(33 * 1024 * 1024) };
						},
						cancel: async () => {},
					}),
				},
			};
		},
	});
	const result = await service.generate({ provider: "p", model: "m", prompt: "x" });
	assert.equal(result.ok, false);
	assert.equal(result.error, "responseTooLarge");
	restore();
});
