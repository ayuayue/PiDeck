/**
 * TokenDance 公开报价 → 折扣/免费徽章：解析口径 + 缓存 TTL + 失败回退。
 * 全部走依赖注入（fetchFn / now / getCachePath），不触真实网络。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseTokenDancePriceTags, TokendancePricingStore, TOKENDANCE_PRICING_TTL_MS } = loadTsCommonJs("src/main/config/tokendancePricing.ts");

const INPUT_ITEM = "openai:chat-completions:input_tokens";
const OUTPUT_ITEM = "openai:chat-completions:completion_tokens";

/** vm 沙箱里 TS 模块产出的对象原型与本进程不同，deepStrictEqual 会误报，统一转纯 JSON 再比。 */
const plain = (value) => JSON.parse(JSON.stringify(value));
const eq = (actual, expected, message) => assert.deepEqual(plain(actual), expected, message);

/** 一个模型行：items = 现价，reference = 参考价（都没有就是未打折）。 */
function model(slug, items, reference) {
	const toItems = (rates) => Object.entries(rates).map(([id, rate]) => ({ id, plans: [{ unit: "per_million_tokens", rate }] }));
	return { slug, pricing: { items: toItems(items), ...(reference ? { reference: toItems(reference) } : {}) } };
}

const SAMPLE_PAYLOAD = {
	models: [
		model("glm-4.7", { [INPUT_ITEM]: "0.8", [OUTPUT_ITEM]: "3.2" }, { [INPUT_ITEM]: "1", [OUTPUT_ITEM]: "4" }),
		model("deep-discount", { [INPUT_ITEM]: "0.25" }, { [INPUT_ITEM]: "1" }),
		model("full-price", { [INPUT_ITEM]: "2" }, { [INPUT_ITEM]: "2" }),
		model("free-model", { [INPUT_ITEM]: "0", [OUTPUT_ITEM]: "0" }),
		model("no-reference", { [INPUT_ITEM]: "0.5" }),
		{ slug: "no-pricing" },
		{ slug: 123, pricing: { items: [] } },
	],
};

test("parseTokenDancePriceTags 按现价/参考价算折扣，免费与未打折都不出徽章", () => {
	const tags = parseTokenDancePriceTags(SAMPLE_PAYLOAD);
	eq(tags["glm-4.7"], { discount: 0.8 });
	// 千分位精度保留：0.25 不被浮点误差吃掉
	eq(tags["deep-discount"], { discount: 0.25 });
	eq(tags["free-model"], { free: true });
	// 原价（ratio=1）、无参考价、无 pricing、非法 slug 都不产生徽章
	assert.equal(tags["full-price"], undefined);
	assert.equal(tags["no-reference"], undefined);
	assert.equal(tags["no-pricing"], undefined);
	assert.equal(tags[123], undefined);
});

test("parseTokenDancePriceTags 各项倍率不一致时优先输入 token 单价", () => {
	const tags = parseTokenDancePriceTags({
		models: [model("mixed", { [INPUT_ITEM]: "0.5", [OUTPUT_ITEM]: "0.25" }, { [INPUT_ITEM]: "1", [OUTPUT_ITEM]: "1" })],
	});
	eq(tags.mixed, { discount: 0.5 });
});

test("parseTokenDancePriceTags 计费项单价 0 不参与折扣比（缓存免费不该算成 0 折）；数字/字符串 rate 都收", () => {
	const tags = parseTokenDancePriceTags({
		models: [model("zero-item", { [INPUT_ITEM]: 0.9, [OUTPUT_ITEM]: 5 }, { [INPUT_ITEM]: 1 }), { slug: "numeric", pricing: { items: [{ id: INPUT_ITEM, plans: [{ rate: 1.5 }] }], reference: [{ id: INPUT_ITEM, plans: [{ rate: 3 }] }] } }],
	});
	eq(tags["zero-item"], { discount: 0.9 });
	eq(tags.numeric, { discount: 0.5 });
});

test("parseTokenDancePriceTags 非对象/无 models 数组返回空表", () => {
	eq(parseTokenDancePriceTags(null), {});
	eq(parseTokenDancePriceTags("x"), {});
	eq(parseTokenDancePriceTags({}), {});
	eq(parseTokenDancePriceTags({ models: "not-array" }), {});
	eq(parseTokenDancePriceTags({ models: [] }), {});
});

function makeStore({ now, cachePath, fetchFn, failFetch = false, fetchedPayload } = {}) {
	let fetchCount = 0;
	const store = new TokendancePricingStore({
		getCachePath: () => cachePath,
		log: () => {},
		now: now ?? (() => 1_000_000),
		fetchFn:
			fetchFn ??
			(async () => {
				fetchCount += 1;
				if (failFetch) return { ok: false, status: 500, json: async () => ({}) };
				return { ok: true, json: async () => fetchedPayload ?? SAMPLE_PAYLOAD };
			}),
	});
	return { store, fetchCount: () => fetchCount };
}

test("价格表落盘缓存：TTL 内不再发请求，过期后重新拉取", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tokendance-pricing-"));
	try {
		const cachePath = join(dir, "tokendance-pricing.json");
		const t0 = 1_000_000;
		let currentTime = t0;
		const { store, fetchCount } = makeStore({ cachePath, now: () => currentTime });
		const first = await store.getTags();
		assert.equal(fetchCount(), 1);
		assert.equal(first.tags["glm-4.7"].discount, 0.8);
		// 磁盘缓存已写
		const disk = JSON.parse(await readFile(cachePath, "utf8"));
		assert.equal(disk.at, t0);
		assert.equal(disk.tags["glm-4.7"].discount, 0.8);
		// TTL 内：内存直接命中
		const second = await store.getTags();
		assert.equal(fetchCount(), 1, "TTL 内不应重新拉取");
		assert.equal(second.fromCache, true);
		// 过期：先拿旧表返回，后台刷新
		currentTime = t0 + TOKENDANCE_PRICING_TTL_MS + 1;
		const stale = await store.getTags();
		assert.equal(stale.tags["glm-4.7"].discount, 0.8, "过期旧表仍然可用");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(fetchCount(), 2, "过期后应在后台换新");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("拉取失败回退旧缓存；完全无缓存返回空表（徽章缺席，不影响模型列表）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tokendance-pricing-"));
	try {
		const cachePath = join(dir, "tokendance-pricing.json");
		const { store } = makeStore({ cachePath, now: () => 1_000_000 });
		await store.getTags();
		// 新实例（无内存缓存）+ 过期磁盘缓存 + 拉取失败 → 用磁盘旧表
		const failing = makeStore({ cachePath, now: () => 1_000_000 + TOKENDANCE_PRICING_TTL_MS + 1, failFetch: true });
		const fallback = await failing.store.getTags(true);
		assert.equal(fallback.tags["glm-4.7"].discount, 0.8);
		// 无任何缓存 + 拉取失败 → 空表（不 throw）
		const emptyPath = join(dir, "none.json");
		const empty = makeStore({ cachePath: emptyPath, failFetch: true });
		eq(await empty.store.getTags(), { tags: {}, at: 0, fromCache: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("空报价表视为异常走回退，不覆盖旧缓存", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tokendance-pricing-"));
	try {
		const cachePath = join(dir, "tokendance-pricing.json");
		await writeFile(cachePath, JSON.stringify({ at: 1, tags: { keep: { free: true } } }), "utf8");
		const { store } = makeStore({ cachePath, fetchedPayload: { models: [] } });
		const result = await store.getTags(true);
		eq(result.tags, { keep: { free: true } });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("损坏缓存文件按无缓存处理，重新拉取可用", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tokendance-pricing-"));
	try {
		const cachePath = join(dir, "tokendance-pricing.json");
		await writeFile(cachePath, "{ not json", "utf8");
		const { store, fetchCount } = makeStore({ cachePath });
		const result = await store.getTags();
		assert.equal(result.fromCache, false);
		assert.equal(result.tags["glm-4.7"].discount, 0.8);
		assert.equal(fetchCount(), 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
