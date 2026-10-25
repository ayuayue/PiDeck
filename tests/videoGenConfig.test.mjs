import assert from "node:assert/strict";
import test from "node:test";

/**
 * 生视频独立配置白名单：非法字段丢弃、协议回落、长度上限、去重。
 * 与 tests/imageGenConfig.test.mjs 同口径（videoGenConfig 是纯函数无依赖）。
 */

const { loadTsCommonJs } = await import("./helpers/loadTsCommonJs.mjs");
const { sanitizeVideoGenConfig, EMPTY_VIDEO_GEN_CONFIG, sanitizeVideoGenProtocol } = loadTsCommonJs("src/shared/videoGenConfig.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

test("null / 非对象 / 数组 → 空配置（costConfirm 默认开）", () => {
	assert.deepEqual(plain(sanitizeVideoGenConfig(null)), plain(EMPTY_VIDEO_GEN_CONFIG));
	assert.deepEqual(plain(sanitizeVideoGenConfig([])), plain(EMPTY_VIDEO_GEN_CONFIG));
	assert.equal(EMPTY_VIDEO_GEN_CONFIG.costConfirm, true);
	assert.equal(EMPTY_VIDEO_GEN_CONFIG.providers.length, 0);
});

test("协议枚举：非法/缺省回落 minimax-v2，合法两族透传", () => {
	assert.equal(sanitizeVideoGenProtocol("kling-v1"), "minimax-v2");
	assert.equal(sanitizeVideoGenProtocol(undefined), "minimax-v2");
	assert.equal(sanitizeVideoGenProtocol("seedance-ark"), "seedance-ark");
});

test("provider 消毒：id 非法回退生成、models 去重去空、非法项整条丢弃", () => {
	const config = sanitizeVideoGenConfig({
		providers: [
			{
				id: "!!bad id!!",
				name: "  GW  ",
				baseUrl: "https://gw.example.com/",
				apiKey: "sk-1",
				protocol: "seedance-ark",
				models: ["m1", " m1 ", "", 42, "m2"],
				defaults: { resolution: "720p", duration: "5", ratio: "16:9" },
				priceNote: "480P≈¥0.28/秒",
			},
			"not-an-object",
			{ id: "vg-2", models: "nope" },
		],
		activeProviderId: "vg-2",
		activeModel: "m2",
		activeParams: { resolution: "480p", duration: "10" },
		costConfirm: false,
	});
	assert.equal(config.providers.length, 2);
	const first = config.providers[0];
	assert.notEqual(first.id, "!!bad id!!");
	assert.match(first.id, /^vg-/);
	assert.equal(first.name, "GW");
	assert.equal(first.protocol, "seedance-ark");
	assert.deepEqual([...first.models], ["m1", "m2"]);
	assert.equal(first.priceNote, "480P≈¥0.28/秒");
	const second = config.providers[1];
	assert.deepEqual([...second.models], []);
	assert.equal(config.activeProviderId, "vg-2");
	// activeModel 必须在选中供应商的模型表里，否则视为未选择（防悬空引用）
	assert.equal(config.activeModel, "");
	assert.equal(config.costConfirm, false);
});

test("长度上限：name/url/key/model/priceNote 截断，超量 provider 丢弃", () => {
	const providers = Array.from({ length: 25 }, (_, index) => ({ id: `vg-${index}`, models: ["m"] }));
	const config = sanitizeVideoGenConfig({ providers });
	assert.equal(config.providers.length, 20);
	const long = sanitizeVideoGenConfig({
		providers: [{ id: "vg-x", name: "n".repeat(200), baseUrl: `https://${"a".repeat(900)}`, apiKey: "k".repeat(900), models: ["m".repeat(300)], priceNote: "p".repeat(300) }],
	});
	const provider = long.providers[0];
	assert.equal(provider.name.length, 64);
	assert.equal(provider.baseUrl.length, 512);
	assert.equal(provider.apiKey.length, 512);
	assert.equal(provider.models[0].length, 128);
	assert.equal(provider.priceNote.length, 128);
});

test("active 引用悬空时清空（不静默选第一个，也不留悬空 id）", () => {
	const config = sanitizeVideoGenConfig({ providers: [{ id: "vg-1", models: ["m"] }], activeProviderId: "vg-gone", activeModel: "m-gone" });
	assert.equal(config.activeProviderId, "");
	assert.equal(config.activeModel, "");
});
