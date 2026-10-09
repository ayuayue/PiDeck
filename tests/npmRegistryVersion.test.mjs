import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * npmRegistryVersion 单测：扩展列表 forceRefresh 时的 registry HTTP 快路。
 *
 * 覆盖计划「任务 3」列出的 8 组用例：scoped URL 编码、corgi Accept 头、
 * dist-tags 解析、四类失败逐包回退、同包去重、并发上限、基址解析成败、maxBytes 中止。
 * 沙箱只提供全局底座，fetch 全部经 options.fetchImpl 注入（生产默认 globalThis.fetch）。
 */

const loadProductionTs = createTsSandbox({});

function loadResolverModule() {
	return loadProductionTs("src/main/extensions/npmRegistryVersion.ts");
}

const REGISTRY_BASE = "https://registry.npmjs.org/";

/** 带流式 body 的假响应：chunkSize 控制分块，用于触发 maxBytes 中止路径。 */
function streamResponse(payload, { status = 200, chunkSize } = {}) {
	const text = typeof payload === "string" ? payload : JSON.stringify(payload);
	const buffer = Buffer.from(text, "utf8");
	const size = chunkSize ?? buffer.byteLength;
	return {
		ok: status >= 200 && status < 300,
		status,
		body: {
			getReader() {
				let offset = 0;
				return {
					async read() {
						if (offset >= buffer.byteLength) return { done: true, value: undefined };
						const slice = buffer.subarray(offset, offset + size);
						offset += size;
						return { done: false, value: slice };
					},
					async cancel() {},
				};
			},
		},
	};
}

/** 无 body、只有 arrayBuffer 的假响应：测试替身 / 受限运行时的回落路径。 */
function bufferResponse(payload, { status = 200 } = {}) {
	const text = typeof payload === "string" ? payload : JSON.stringify(payload);
	const buffer = Buffer.from(text, "utf8");
	return {
		ok: status >= 200 && status < 300,
		status,
		async arrayBuffer() {
			return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
		},
	};
}

/** 记录请求并按表返回响应的 fetch 替身；表未命中时返回 404（触发回退）。 */
function recordingFetch(table) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		const entry = table[url];
		if (entry === undefined) return streamResponse("not found", { status: 404 });
		if (typeof entry === "function") return entry(url, init);
		return entry;
	};
	return { fetchImpl, calls };
}

test("scoped 包名经 encodeURIComponent 编码，非 scoped 包原样拼接", async () => {
	const { createNpmRegistryVersionResolver } = loadResolverModule();
	const { fetchImpl, calls } = recordingFetch({});
	const resolver = createNpmRegistryVersionResolver({
		resolveRegistryBase: async () => REGISTRY_BASE,
		npmViewFallback: async () => "9.9.9",
		fetchImpl,
	});

	assert.equal(await resolver.resolveLatestVersion("@scope/name"), "9.9.9");
	assert.equal(await resolver.resolveLatestVersion("plain-pkg"), "9.9.9");
	// scoped 包的斜杠与 @ 都必须编码，否则 registry 会当成路径层级
	assert.deepEqual(
		calls.map((call) => call.url),
		["https://registry.npmjs.org/%40scope%2Fname", `${REGISTRY_BASE}plain-pkg`],
	);
});

test("请求带 corgi Accept 头与超时信号", async () => {
	const { createNpmRegistryVersionResolver } = loadResolverModule();
	const { fetchImpl, calls } = recordingFetch({});
	const resolver = createNpmRegistryVersionResolver({
		resolveRegistryBase: async () => REGISTRY_BASE,
		npmViewFallback: async () => null,
		fetchImpl,
	});

	await resolver.resolveLatestVersion("context-mode");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].init.headers.Accept, "application/vnd.npm.install-v1+json");
	assert.ok(calls[0].init.signal, "必须挂 AbortSignal，超时才能中断挂起的请求");
});

test("dist-tags.latest 存在时返回该版本", async () => {
	const { createNpmRegistryVersionResolver } = loadResolverModule();
	const { fetchImpl } = recordingFetch({
		[`${REGISTRY_BASE}context-mode`]: streamResponse({ "dist-tags": { latest: "1.4.2", next: "2.0.0-beta.1" }, versions: {} }),
	});
	let fallbackCalls = 0;
	const resolver = createNpmRegistryVersionResolver({
		resolveRegistryBase: async () => REGISTRY_BASE,
		npmViewFallback: async () => {
			fallbackCalls += 1;
			return "0.0.1";
		},
		fetchImpl,
	});

	assert.equal(await resolver.resolveLatestVersion("context-mode"), "1.4.2");
	assert.equal(fallbackCalls, 0, "快路成功不得触发 npm view 回退");
});

test("无 body 的替身响应回落 arrayBuffer 后同样解析成功", async () => {
	const { createNpmRegistryVersionResolver } = loadResolverModule();
	const { fetchImpl } = recordingFetch({
		[`${REGISTRY_BASE}context-mode`]: bufferResponse({ "dist-tags": { latest: "3.2.1" } }),
	});
	const resolver = createNpmRegistryVersionResolver({
		resolveRegistryBase: async () => REGISTRY_BASE,
		npmViewFallback: async () => null,
		fetchImpl,
	});

	assert.equal(await resolver.resolveLatestVersion("context-mode"), "3.2.1");
});

test("非 2xx / 坏 JSON / fetch  reject / 超时中止逐包回退 npm view", async () => {
	const { createNpmRegistryVersionResolver } = loadResolverModule();
	const fallbackCalls = [];
	const fallback = async (packageName) => {
		fallbackCalls.push(packageName);
		return `fallback-${packageName}`;
	};

	// 非 2xx（私有 registry 认证失败形态）
	const non2xx = recordingFetch({ [`${REGISTRY_BASE}pkg-a`]: streamResponse("unauthorized", { status: 401 }) });
	const resolverA = createNpmRegistryVersionResolver({ resolveRegistryBase: async () => REGISTRY_BASE, npmViewFallback: fallback, fetchImpl: non2xx.fetchImpl });
	assert.equal(await resolverA.resolveLatestVersion("pkg-a"), "fallback-pkg-a");

	// 坏 JSON
	const badJson = recordingFetch({ [`${REGISTRY_BASE}pkg-b`]: streamResponse("<html>not json</html>") });
	const resolverB = createNpmRegistryVersionResolver({ resolveRegistryBase: async () => REGISTRY_BASE, npmViewFallback: fallback, fetchImpl: badJson.fetchImpl });
	assert.equal(await resolverB.resolveLatestVersion("pkg-b"), "fallback-pkg-b");

	// 缺 dist-tags.latest 同样视为失败
	const noDistTags = recordingFetch({ [`${REGISTRY_BASE}pkg-c`]: streamResponse({ "dist-tags": {} }) });
	const resolverC = createNpmRegistryVersionResolver({ resolveRegistryBase: async () => REGISTRY_BASE, npmViewFallback: fallback, fetchImpl: noDistTags.fetchImpl });
	assert.equal(await resolverC.resolveLatestVersion("pkg-c"), "fallback-pkg-c");

	// fetch 网络错误
	const networkError = recordingFetch({
		[`${REGISTRY_BASE}pkg-d`]: () => {
			throw new Error("ECONNREFUSED");
		},
	});
	const resolverD = createNpmRegistryVersionResolver({ resolveRegistryBase: async () => REGISTRY_BASE, npmViewFallback: fallback, fetchImpl: networkError.fetchImpl });
	assert.equal(await resolverD.resolveLatestVersion("pkg-d"), "fallback-pkg-d");

	// 超时：替身尊重 AbortSignal（真实 fetch 语义），超时后 reject
	const hangFetch = async (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new Error("aborted by timeout")));
		});
	const resolverE = createNpmRegistryVersionResolver({ resolveRegistryBase: async () => REGISTRY_BASE, npmViewFallback: fallback, fetchImpl: hangFetch, timeoutMs: 30 });
	assert.equal(await resolverE.resolveLatestVersion("pkg-e"), "fallback-pkg-e");

	assert.deepEqual(fallbackCalls, ["pkg-a", "pkg-b", "pkg-c", "pkg-d", "pkg-e"]);
});

test("同一轮内同名包去重：fetch 只发起一次", async () => {
	const { createNpmRegistryVersionResolver } = loadResolverModule();
	const { fetchImpl, calls } = recordingFetch({ [`${REGISTRY_BASE}context-mode`]: streamResponse({ "dist-tags": { latest: "1.0.0" } }) });
	const resolver = createNpmRegistryVersionResolver({
		resolveRegistryBase: async () => REGISTRY_BASE,
		npmViewFallback: async () => null,
		fetchImpl,
	});

	const [first, second, third] = await Promise.all([resolver.resolveLatestVersion("context-mode"), resolver.resolveLatestVersion("context-mode"), resolver.resolveLatestVersion("context-mode")]);
	assert.equal(calls.length, 1);
	assert.deepEqual([first, second, third], ["1.0.0", "1.0.0", "1.0.0"]);
});

test("并发上限默认 6：20 个包峰值在途请求不超过 6", async () => {
	const { createNpmRegistryVersionResolver } = loadResolverModule();
	let active = 0;
	let peak = 0;
	const fetchImpl = async () => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active -= 1;
		return streamResponse({ "dist-tags": { latest: "1.0.0" } });
	};
	const resolver = createNpmRegistryVersionResolver({
		resolveRegistryBase: async () => REGISTRY_BASE,
		npmViewFallback: async () => null,
		fetchImpl,
	});

	const versions = await Promise.all(Array.from({ length: 20 }, (_unused, index) => resolver.resolveLatestVersion(`pkg-${index}`)));
	assert.equal(versions.length, 20);
	assert.ok(versions.every((version) => version === "1.0.0"));
	// 20 个任务同步入队，闸门必须把在途数压在 6（少了说明闸门失效，多了说明没有限流）
	assert.equal(peak, 6, `峰值并发 ${peak} 与默认上限 6 不符`);
});

test("registry 基址解析成功时以其为前缀，解析失败整轮回退且不发 HTTP", async () => {
	const { createNpmRegistryVersionResolver } = loadResolverModule();

	const mirror = recordingFetch({});
	const mirrorResolver = createNpmRegistryVersionResolver({
		resolveRegistryBase: async () => "https://registry.npmmirror.com",
		npmViewFallback: async () => "mirror-fallback",
		fetchImpl: mirror.fetchImpl,
	});
	assert.equal(await mirrorResolver.resolveLatestVersion("pkg-a"), "mirror-fallback");
	assert.deepEqual(
		mirror.calls.map((call) => call.url),
		["https://registry.npmmirror.com/pkg-a"],
	);

	let baseResolveCount = 0;
	const nullBase = recordingFetch({});
	const nullResolver = createNpmRegistryVersionResolver({
		resolveRegistryBase: async () => {
			baseResolveCount += 1;
			return null;
		},
		npmViewFallback: async (packageName) => `npm-view-${packageName}`,
		fetchImpl: nullBase.fetchImpl,
	});
	assert.equal(await nullResolver.resolveLatestVersion("pkg-b"), "npm-view-pkg-b");
	assert.equal(await nullResolver.resolveLatestVersion("pkg-c"), "npm-view-pkg-c");
	assert.equal(nullBase.calls.length, 0, "基址为 null 时不得发起任何 HTTP 请求");
	assert.equal(baseResolveCount, 1, "基址解析必须 memo，多个包只解析一次");
});

test("响应体超过 maxBytes 时中止读取并回退", async () => {
	const { createNpmRegistryVersionResolver } = loadResolverModule();
	let cancelled = 0;
	const fetchImpl = async () => ({
		ok: true,
		status: 200,
		body: {
			getReader() {
				let sent = 0;
				return {
					async read() {
						// 每块 1KB，永不结束：必须由 maxBytes 闸门中止
						sent += 1;
						return { done: false, value: Buffer.alloc(1024, 0x61) };
					},
					async cancel() {
						cancelled += 1;
					},
				};
			},
		},
	});
	const resolver = createNpmRegistryVersionResolver({
		resolveRegistryBase: async () => REGISTRY_BASE,
		npmViewFallback: async () => "fallback-large",
		fetchImpl,
		maxBytes: 4096,
	});

	assert.equal(await resolver.resolveLatestVersion("huge-pkg"), "fallback-large");
	assert.ok(cancelled >= 1, "超限后必须 cancel reader 断开连接");
});
