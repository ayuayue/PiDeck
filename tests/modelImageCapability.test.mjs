import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { modelSupportsNativeImages, resolveVisionBridgeExpected, imagesFromModelsJson } = loadTsCommonJs("src/renderer/src/utils/modelImageCapability.ts");

test("只有目录明确 images===true 才算原生看图", () => {
	const models = [
		{ provider: "openai", id: "gpt-4o", images: true },
		{ provider: "openai", id: "gpt-4.1", images: false },
		{ provider: "openai", id: "o3" },
	];
	assert.equal(modelSupportsNativeImages(models, { provider: "openai", modelId: "gpt-4o" }), true);
	assert.equal(modelSupportsNativeImages(models, { provider: "openai", modelId: "gpt-4.1" }), false);
	assert.equal(modelSupportsNativeImages(models, { provider: "openai", modelId: "o3" }), false);
	assert.equal(modelSupportsNativeImages(models, { provider: "openai", modelId: "missing" }), false);
	assert.equal(modelSupportsNativeImages(models, { provider: "openai" }), false);
	assert.equal(modelSupportsNativeImages(models, undefined), false);
});

test("本地 models.json 的 input 勾选覆盖 CLI images 列", () => {
	const listed = [{ provider: "openai", id: "gpt-4.1", images: false }];
	const local = {
		providers: {
			openai: { models: [{ id: "gpt-4.1", input: ["text", "image"] }] },
		},
	};
	assert.equal(imagesFromModelsJson(local).get("openai\0gpt-4.1"), true);
	assert.equal(modelSupportsNativeImages(listed, { provider: "openai", modelId: "gpt-4.1" }, local), true, "配置页勾了图片能力后，即使 CLI 缓存还是 no，也应视为原生看图");
	const localOff = {
		providers: {
			openai: { models: [{ id: "gpt-4o", input: ["text"] }] },
		},
	};
	assert.equal(modelSupportsNativeImages([{ provider: "openai", id: "gpt-4o", images: true }], { provider: "openai", modelId: "gpt-4o" }, localOff), false);
});

test("视觉桥 UI：原生看图 / DSH 不显示转换中，未知目录保持静默", () => {
	assert.equal(resolveVisionBridgeExpected({ backend: "dsh", modelSupportsImages: true }), false);
	assert.equal(resolveVisionBridgeExpected({ backend: "pi", modelSupportsImages: true }), false);
	assert.equal(resolveVisionBridgeExpected({ backend: "pi", modelSupportsImages: null }), null);
	assert.equal(resolveVisionBridgeExpected({ backend: "pi", modelSupportsImages: false }), true);
	assert.equal(resolveVisionBridgeExpected({ modelSupportsImages: false }), true);
});

test("用户气泡按会话级 visionBridgeExpected 跳过轮询，而不是只看视觉桥开关", () => {
	const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
	const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	const hook = readFileSync("src/renderer/src/hooks/useSessionVisionBridgeExpected.ts", "utf8");
	assert.match(surface, /visionBridgeExpected === false/);
	assert.match(surface, /visionBridgeExpected === null/);
	assert.match(surface, /visionBridgeEnabled !== true/);
	assert.match(timeline, /useSessionVisionBridgeExpected/);
	// 会话级默认传参 + 生图参考图分支显式禁用（2026-08：生图参考图直接进供应商 API，
	// 不走 LLM 视觉桥；普通带图消息仍按会话级判定）
	assert.match(timeline, /visionBridgeExpected=\{\s*imageGenUserMessageIds\.has\(message\.id\) \? false : visionBridgeExpected\s*\}/);
	assert.match(timeline, /imageGenUserMessageIds/);
	assert.match(hook, /listModels/);
	assert.match(hook, /getModels/);
	assert.match(hook, /modelSupportsNativeImages/);
});
