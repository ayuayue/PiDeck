/**
 * 逐模型 compat 面板的纯函数（src/renderer/src/config/modelCompatFields.ts）。
 *
 * 关注契约：只有面板管理的布尔键会被「应用目录建议」写入；手写的非管理键
 * （supportsMidConvoSystemMessages / allowedFallbackModels 等）必须原样保留，
 * 否则打开弹框点一下建议就会把 models.json 里的其他 compat 静默抹掉。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MODEL_COMPAT_FIELDS, applyModelCompatSuggestion, diffModelCompatSuggestion, hasModelCompat, pickManagedCompatFlags, readCompatBooleans, setModelCompatFlag, summarizeModelCompat } = loadTsCommonJs("src/renderer/src/config/modelCompatFields.ts");

// vm 里 transpile 出来的对象原型不在本 realm，deepStrictEqual 前统一摊平成普通 JSON 值。
const plain = (value) => JSON.parse(JSON.stringify(value));

const catalogCompat = {
	forceAdaptiveThinking: true,
	supportsTemperature: false,
	supportsMidConvoSystemMessages: true,
	allowedFallbackModels: [{ provider: "anthropic", model: "claude-opus-5" }],
	thinkingFormat: "deepseek",
};

test("readCompatBooleans 只保留布尔键", () => {
	assert.deepEqual(plain(readCompatBooleans(catalogCompat)), {
		forceAdaptiveThinking: true,
		supportsTemperature: false,
		supportsMidConvoSystemMessages: true,
	});
	assert.deepEqual(plain(readCompatBooleans(undefined)), {});
	assert.deepEqual(plain(readCompatBooleans("nope")), {});
});

test("pickManagedCompatFlags 只取面板能编辑/撤销的键", () => {
	assert.deepEqual(plain(pickManagedCompatFlags(catalogCompat)), {
		forceAdaptiveThinking: true,
		supportsTemperature: false,
	});
});

test("setModelCompatFlag 三态：写值 / 跟随 Pi 删键 / 清空后整段 compat 消失", () => {
	assert.deepEqual(plain(setModelCompatFlag(undefined, "supportsTemperature", false)), { supportsTemperature: false });
	assert.deepEqual(plain(setModelCompatFlag({ supportsTemperature: false, extra: true }, "supportsTemperature", undefined)), { extra: true });
	assert.equal(setModelCompatFlag({ supportsTemperature: false }, "supportsTemperature", undefined), undefined);
	// 手改坏配置（非对象）不能让展开运算把字符键带进 models.json
	assert.deepEqual(plain(setModelCompatFlag("junk", "supportsStore", true)), { supportsStore: true });
});

test("diffModelCompatSuggestion 只列出与当前值不同的管理键", () => {
	const diff = diffModelCompatSuggestion({ forceAdaptiveThinking: true, supportsTemperature: true }, { forceAdaptiveThinking: true, supportsTemperature: false, supportsMidConvoSystemMessages: true });
	assert.deepEqual(plain(diff), [{ key: "supportsTemperature", suggested: false, current: true }]);

	// 未表态（undefined）也算差异：否则用户不知道该打开什么。
	assert.deepEqual(plain(diffModelCompatSuggestion(undefined, { forceAdaptiveThinking: true })), [{ key: "forceAdaptiveThinking", suggested: true }]);
});

test("applyModelCompatSuggestion 只写建议中的管理键，保留其他 compat 键", () => {
	const next = applyModelCompatSuggestion({ extra: true, supportsTemperature: true }, { forceAdaptiveThinking: true, supportsTemperature: false });
	assert.deepEqual(plain(next), { extra: true, supportsTemperature: false, forceAdaptiveThinking: true });
	// 建议为空时原样返回，不制造 `{}`。
	assert.deepEqual(plain(applyModelCompatSuggestion({ extra: true }, {})), { extra: true });
});

test("MODEL_COMPAT_FIELDS 覆盖 Claude 新模型的两个关键键", () => {
	const keys = MODEL_COMPAT_FIELDS.map((field) => field.key);
	assert.ok(keys.includes("forceAdaptiveThinking"));
	assert.ok(keys.includes("supportsTemperature"));
});

test("summarizeModelCompat 全量列出布尔键（含非管理键，供 tooltip 对照 models.json）", () => {
	assert.equal(summarizeModelCompat(catalogCompat), "forceAdaptiveThinking=true · supportsTemperature=false · supportsMidConvoSystemMessages=true");
	assert.equal(summarizeModelCompat(undefined), "");
});

test("hasModelCompat：只有非布尔键也算已配置（图标要亮，否则用户看不见手写 compat）", () => {
	assert.equal(hasModelCompat({ thinkingFormat: "openrouter" }), true);
	assert.equal(hasModelCompat({}), false);
	assert.equal(hasModelCompat(undefined), false);
});
