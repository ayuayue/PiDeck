/**
 * mirrorHealth 更新镜像体检纯逻辑单测。
 * 守护：探测协议（latest.yml 检测 + Range 206 下载预检）、速度分级（ok/slow 阈值 300KB/s）、
 * 各类失败收成 broken 且不抛异常。全部用 fake fetch，不依赖真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import vm from "node:vm";

/** 用 TypeScript transpileModule 加载 TS 源码（项目测试惯例，见 updateSources.test.mjs）。 */
function loadTsModule(filePath, deps) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (name) => deps[name] ?? (() => { throw new Error(`unexpected require: ${name}`); })(),
			console,
			AbortSignal, // vm 沙箱默认无 AbortSignal，probeMirrorHealth 用 AbortSignal.timeout
		},
		{ filename: filePath },
	);
	return module.exports;
}

const shared = loadTsModule("src/shared/updateSources.ts", {});
const mirrorHealth = loadTsModule("src/main/update/mirrorHealth.ts", {
	"../../shared/updateSources": shared,
});
const { probeMirrorHealth, probeAllMirrors, SLOW_THRESHOLD_KBPS, PROBE_RANGE_BYTES, PROBE_TIMEOUT_MS } =
	mirrorHealth;

const MIRROR = { id: "ghfast", host: "https://ghfast.top" };

/**
 * 构造 fake fetch：按 URL 尾部分发 yml / 分片请求，用可控延时推进模拟时钟。
 * 返回 { fetchImpl, clock }；clock.now 记录「当前时刻」，测速 = 分片字节数 / 分片耗时。
 */
function makeFetch(options = {}) {
	const {
		ymlStatus = 200,
		ymlBody = "version: 0.7.3\nreleaseDate: 2026-09-03T16:04:00.000Z\n",
		dlStatus = 206,
		dlBytes = PROBE_RANGE_BYTES,
		ymlDelay = 100,
		dlDelay = 500,
		throwError = null,
	} = options;
	const clock = { now: 0 };
	const fetchImpl = async (url, _opts) => {
		if (throwError) {
			clock.now += ymlDelay;
			throw throwError;
		}
		if (url.endsWith("/latest.yml")) {
			clock.now += ymlDelay;
			return new Response(ymlBody, { status: ymlStatus });
		}
		clock.now += dlDelay;
		return new Response(new Uint8Array(dlBytes), { status: dlStatus });
	};
	return { fetchImpl, clock };
}

test("探测协议：latest.yml 200 + Range 206 且速度达标 → ok，速度取分片字节/耗时", async () => {
	const { fetchImpl, clock } = makeFetch({ dlDelay: 500 }); // 256KB/500ms = 524KB/s > 阈值
	const result = await probeMirrorHealth(fetchImpl, MIRROR, () => clock.now);
	assert.equal(result.status, "ok");
	assert.equal(result.speedKBps, 524);
	assert.equal(result.latencyMs, 100);
	assert.equal(result.id, "ghfast");
	assert.equal(result.error, undefined);
});

test("速度低于阈值 → slow（模拟 ghproxy.net 分片段 ~230KB/s）", async () => {
	const { fetchImpl, clock } = makeFetch({ dlDelay: 1000 }); // 256KB/1000ms = 262KB/s < 300
	const result = await probeMirrorHealth(fetchImpl, MIRROR, () => clock.now);
	assert.equal(result.status, "slow");
	assert.equal(result.speedKBps, 262);
	assert.ok(SLOW_THRESHOLD_KBPS > 262 && SLOW_THRESHOLD_KBPS <= 524, "阈值应落在 ok/slow 两用例之间");
});

test("latest.yml 非 200 → broken，保留响应码原因", async () => {
	const { fetchImpl, clock } = makeFetch({ ymlStatus: 404 });
	const result = await probeMirrorHealth(fetchImpl, MIRROR, () => clock.now);
	assert.equal(result.status, "broken");
	assert.match(result.error, /HTTP 404/);
	assert.equal(result.speedKBps, 0);
	// 检测失败不应继续下载预检（时钟只推进了 yml 延时）
	assert.equal(clock.now, 100);
});

test("latest.yml 内容解析不出版本号 → broken（镜像返回了页面而非 feed）", async () => {
	const { fetchImpl, clock } = makeFetch({ ymlBody: "<html>403 Forbidden</html>" });
	const result = await probeMirrorHealth(fetchImpl, MIRROR, () => clock.now);
	assert.equal(result.status, "broken");
	assert.match(result.error, /格式异常/);
});

test("下载预检非 206（镜像不支持 Range / 直接返回 200 全量）→ broken", async () => {
	const { fetchImpl, clock } = makeFetch({ dlStatus: 200 });
	const result = await probeMirrorHealth(fetchImpl, MIRROR, () => clock.now);
	assert.equal(result.status, "broken");
	assert.match(result.error, /HTTP 200/);
});

test("分片字节数过小（<1KB，疑似错误页）→ broken", async () => {
	const { fetchImpl, clock } = makeFetch({ dlBytes: 512, dlStatus: 206 });
	const result = await probeMirrorHealth(fetchImpl, MIRROR, () => clock.now);
	assert.equal(result.status, "broken");
});

test("fetch 超时（AbortError）→ broken，原因「连接超时」", async () => {
	const abortError = new Error("signal is aborted without reason");
	abortError.name = "TimeoutError"; // AbortSignal.timeout 在 Node 中 reject 的 name
	const { fetchImpl, clock } = makeFetch({ throwError: abortError });
	const result = await probeMirrorHealth(fetchImpl, MIRROR, () => clock.now);
	assert.equal(result.status, "broken");
	assert.equal(result.error, "连接超时");
});

test("fetch 网络错误 → broken，原因「连接失败」（不向外抛）", async () => {
	const { fetchImpl, clock } = makeFetch({ throwError: new TypeError("fetch failed") });
	const result = await probeMirrorHealth(fetchImpl, MIRROR, () => clock.now);
	assert.equal(result.status, "broken");
	assert.equal(result.error, "连接失败");
});

test("probeAllMirrors：并行探测全部内置镜像，失败互不影响", async () => {
	// 真实延迟 + 默认 Date.now：同步 fake fetch 会让测速在 0/1ms 间随机
	// （dlMs=0 → speed=0 → slow），偶发 flaky（2026-09 CI 实测）；
	// 注入共享 fake clock 也会被 Promise.all 并行交错污染，同样不可靠。
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	// 按 URL 中的镜像 host 分发：ghproxy-net 返回 500（broken），其余正常
	const fetchImpl = async (url, _opts) => {
		if (url.includes("ghproxy.net/")) {
			await sleep(5);
			return new Response("boom", { status: 500 });
		}
		if (url.endsWith("/latest.yml")) {
			await sleep(10);
			return new Response("version: 0.7.3\n", { status: 200 });
		}
		await sleep(200); // 256KB/200ms = 1310KB/s，稳定高于 300 阈值
		return new Response(new Uint8Array(PROBE_RANGE_BYTES), { status: 206 });
	};
	const results = await probeAllMirrors(fetchImpl);
	const byId = {};
	for (const r of results) byId[r.id] = r;
	assert.equal(Object.keys(byId).length, 3, "应涵盖全部内置镜像");
	assert.equal(byId.ghfast.status, "ok");
	assert.equal(byId["ghproxy-net"].status, "broken");
	assert.equal(byId["ghproxy-cxkpro"].status, "ok");
});

test("探测加超时保护：单请求最坏耗时不超过 PROBE_TIMEOUT_MS", () => {
	assert.equal(PROBE_TIMEOUT_MS, 10_000);
	assert.ok(PROBE_RANGE_BYTES >= 256 * 1024, "分片应至少 256KB 才有测速意义");
});