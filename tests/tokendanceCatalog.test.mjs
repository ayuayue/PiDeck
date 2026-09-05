/**
 * TokenDance 内置模型目录：解析 / 合并 / 缓存 TTL / 失败回退。
 * 全部走依赖注入（fetchFn / now / getCachePath），不触真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function loadModule() {
	const output = ts.transpileModule(
		readFileSync("src/main/config/tokendanceCatalog.ts", "utf8"),
		{
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
				esModuleInterop: true,
			},
			fileName: "tokendanceCatalog.ts",
		},
	).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: (specifier) => {
			// node: 内置模块透传给真实 require（fs/path 测试需要读写临时文件）；
			// 其余（electron 动态 import 等）不执行：默认 fetchFn 注入后不会走到。
			if (specifier.startsWith("node:")) return nodeRequire(specifier);
			return {};
		},
	});
	return module.exports;
}

const {
	parseTokenDanceCatalog,
	TokendanceCatalogStore,
	TOKENDANCE_CATALOG_TTL_MS,
	TOKENDANCE_PROVIDER,
} = loadModule();

const SAMPLE_PAYLOAD = {
	data: [
		{ id: "glm-4.7", name: "Z.ai: GLM 4.7", context_length: 262144 },
		{ id: "deepseek-v3.1", context_length: 163840 },
		{ id: 123, name: "非法条目（id 非字符串）" },
		{ id: "", name: "非法条目（id 为空）" },
	],
};

function makeStore({ now, cachePath, fetchFn, failFetch = false, fetchedPayload } = {}) {
	let fetchCount = 0;
	const logs = [];
	const store = new TokendanceCatalogStore({
		getCachePath: () => cachePath,
		log: (message, detail) => logs.push({ message, detail }),
		now: now ?? (() => 1_000_000),
		fetchFn:
			fetchFn ??
			(async () => {
				fetchCount += 1;
				if (failFetch) return { ok: false, json: async () => ({}) };
				return { ok: true, json: async () => fetchedPayload ?? SAMPLE_PAYLOAD };
			}),
	});
	return { store, fetchCount: () => fetchCount, logs };
}

test("parseTokenDanceCatalog 解析 OpenAI /v1/models 形状，坏条目丢弃", () => {
	const models = parseTokenDanceCatalog(SAMPLE_PAYLOAD);
	assert.equal(models.length, 2);
	assert.equal(models[0].id, "glm-4.7");
	assert.equal(models[0].provider, TOKENDANCE_PROVIDER);
	assert.equal(models[0].name, "Z.ai: GLM 4.7");
	assert.equal(models[0].contextWindow, 262144);
	// context_length 缺失不报错，contextWindow 留空
	assert.equal(models[1].contextWindow, 163840);
	assert.equal(models[1].name, undefined);
});

test("parseTokenDanceCatalog 非对象/无 data 数组返回空", () => {
	// 展开成测试上下文数组（vm 上下文数组原型不同）
	assert.deepEqual([...parseTokenDanceCatalog(null)], []);
	assert.deepEqual([...parseTokenDanceCatalog("x")], []);
	assert.deepEqual([...parseTokenDanceCatalog({})], []);
	assert.deepEqual([...parseTokenDanceCatalog({ data: "not-array" })], []);
});

test("parseTokenDanceCatalog context_length 为 0/负数/非整数时省略 contextWindow（pi 会拒绝整个 provider）", () => {
	const models = parseTokenDanceCatalog({
		data: [
			{ id: "seedream-5.0-lite", context_length: 0 },
			{ id: "video-edit", context_length: -1 },
			{ id: "fractional", context_length: 12.5 },
			{ id: "ok-model", context_length: 200000 },
		],
	});
	assert.equal(models.length, 4);
	assert.equal(models[0].contextWindow, undefined);
	assert.equal(models[1].contextWindow, undefined);
	assert.equal(models[2].contextWindow, undefined);
	assert.equal(models[3].contextWindow, 200000);
});


test("缓存新鲜时直接读缓存（TTL 内不再发请求）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tokendance-test-"));
	try {
		const cachePath = join(dir, "tokendance-models.json");
		const t0 = 1_000_000;
		const { store, fetchCount } = makeStore({ cachePath, now: () => t0 });
		const first = await store.getModels();
		assert.equal(fetchCount(), 1);
		assert.equal(first.fromCache, false);
		assert.equal(first.models.length, 2);
		// TTL 内（t0 + 5 分钟）：直接读缓存，不发请求
		const second = await store.getModels();
		assert.equal(fetchCount(), 1, "TTL 内不应重新拉取");
		assert.equal(second.fromCache, true);
		assert.equal(second.models.length, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("缓存过期后重新拉取并刷新落盘", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tokendance-test-"));
	try {
		const cachePath = join(dir, "tokendance-models.json");
		const t0 = 1_000_000;
		let currentTime = t0;
		const { store, fetchCount } = makeStore({ cachePath, now: () => currentTime });
		await store.getModels();
		// 超过 TTL 6h：时间推进 7 小时
		currentTime = t0 + TOKENDANCE_CATALOG_TTL_MS + 60 * 60 * 1000;
		const result = await store.getModels();
		assert.equal(fetchCount(), 2);
		assert.equal(result.fromCache, false);
		const disk = JSON.parse(await readFile(cachePath, "utf8"));
		assert.equal(disk.at, currentTime);
		assert.equal(disk.models.length, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("拉取失败回退旧缓存；无缓存返回 null", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tokendance-test-"));
	try {
		const cachePath = join(dir, "tokendance-models.json");
		const t0 = 1_000_000;
		// 先成功一次（写缓存），再让拉取失败
		const { store, fetchCount } = makeStore({ cachePath, now: () => t0 });
		await store.getModels();
		// 拉取失败 + 缓存过期 → 回退旧缓存（fromCache 标记仍为缓存）
		const t1 = t0 + TOKENDANCE_CATALOG_TTL_MS + 1;
		const failing = new TokendanceCatalogStore({
			getCachePath: () => cachePath,
			log: () => {},
			now: () => t1,
			fetchFn: async () => ({ ok: false, json: async () => ({}) }),
		});
		const fallback = await failing.getModels();
		assert.equal(fallback.fromCache, true);
		assert.equal(fallback.models.length, 2);
		assert.equal(fetchCount(), 1, "原 store 不应再发请求");
		// 无任何缓存 + 拉取失败 → null（列表保持 pi 目录原样）
		const empty = new TokendanceCatalogStore({
			getCachePath: () => join(dir, "none.json"),
			log: () => {},
			now: () => t1,
			fetchFn: async () => ({ ok: false, json: async () => ({}) }),
		});
		assert.equal(await empty.getModels(), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("force 刷新绕过 TTL 重新拉取；空列表视为异常走回退", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tokendance-test-"));
	try {
		const cachePath = join(dir, "tokendance-models.json");
		const t0 = 1_000_000;
		const { store, fetchCount } = makeStore({ cachePath, now: () => t0 });
		await store.getModels();
		const forced = await store.getModels(true);
		assert.equal(fetchCount(), 2);
		assert.equal(forced.fromCache, false);
		// 端点返回空 data → 抛错（fetchAndCache 不缓存空目录），store 回退旧缓存
		const emptyPayload = new TokendanceCatalogStore({
			getCachePath: () => cachePath,
			log: () => {},
			now: () => t0,
			fetchFn: async () => ({ ok: true, json: async () => ({ data: [] }) }),
		});
		const fallback = await emptyPayload.getModels();
		assert.equal(fallback.fromCache, true, "空列表应回退旧缓存而非返回空");
		assert.equal(fallback.models.length, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("refresh() 失败向上抛（IPC 层负责兜底返回空结果）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tokendance-test-"));
	try {
		const { store } = makeStore({ cachePath: join(dir, "x.json"), failFetch: true });
		await assert.rejects(() => store.refresh());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("损坏缓存文件按无缓存处理，重新拉取可用", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tokendance-test-"));
	try {
		const cachePath = join(dir, "tokendance-models.json");
		await writeFile(cachePath, "{ not json", "utf8");
		const { store, fetchCount } = makeStore({ cachePath });
		const result = await store.getModels();
		assert.equal(result.fromCache, false);
		assert.equal(result.models.length, 2);
		assert.equal(fetchCount(), 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
