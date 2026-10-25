// 视觉桥配置有效性判定：开启状态未选模型 = 无效配置（保存按钮禁用 + save 前置拦截），
// 关闭状态允许空模型（「关掉视觉桥」本身就是要保存的目标）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { visionModelMissing } = loadTsCommonJs("src/renderer/src/utils/visionModelMissing.ts");

test("enabled without provider/model is missing", () => {
	assert.equal(visionModelMissing({ enabled: true, provider: "", model: "" }), true);
	assert.equal(visionModelMissing({ enabled: true }), true);
	assert.equal(visionModelMissing(null), false);
});

test("enabled with provider or model is valid", () => {
	assert.equal(visionModelMissing({ enabled: true, provider: "glm", model: "glm-4v" }), false);
	assert.equal(visionModelMissing({ enabled: true, provider: "glm", model: "" }), false);
	assert.equal(visionModelMissing({ enabled: true, provider: "", model: "glm-4v" }), false);
});

test("disabled with empty model is valid (turning it off must be saveable)", () => {
	assert.equal(visionModelMissing({ enabled: false, provider: "", model: "" }), false);
	assert.equal(visionModelMissing({ enabled: false, provider: "glm", model: "glm-4v" }), false);
});
