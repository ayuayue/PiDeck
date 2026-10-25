import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { IMPORTED_IMAGE_MAX_BASE64_CHARS, capImportedImage, importedContentHasToolCall, importedUnknownBlockAsText, normalizeImportedStopReason, tryImportedImageBlock } = loadTsCommonJs("src/main/sessions/importNormalize.ts");

const asPlain = (value) => JSON.parse(JSON.stringify(value));

test("normalizeImportedStopReason: 有 toolCall 一律 toolUse", () => {
	assert.equal(normalizeImportedStopReason({ raw: "end_turn", hasToolCall: true }), "toolUse");
	assert.equal(normalizeImportedStopReason({ raw: "stop", hasToolCall: true }), "toolUse");
});

test("normalizeImportedStopReason: 源枚举映射到 pi", () => {
	assert.equal(normalizeImportedStopReason({ hasToolCall: false }), "stop");
	assert.equal(normalizeImportedStopReason({ raw: "end_turn", hasToolCall: false }), "stop");
	assert.equal(normalizeImportedStopReason({ raw: "tool-calls", hasToolCall: false }), "toolUse");
	assert.equal(normalizeImportedStopReason({ raw: "tool_use", hasToolCall: false }), "toolUse");
	assert.equal(normalizeImportedStopReason({ raw: "max_tokens", hasToolCall: false }), "length");
	assert.equal(normalizeImportedStopReason({ raw: "error", hasToolCall: false }), "error");
	assert.equal(normalizeImportedStopReason({ raw: "aborted", hasToolCall: false }), "aborted");
	assert.equal(normalizeImportedStopReason({ raw: "weird", hasToolCall: false }), "stop");
});

test("importedUnknownBlockAsText: 未知块落成 JSON 文本", () => {
	assert.deepEqual(asPlain(importedUnknownBlockAsText({ type: "mystery", foo: 1 })), {
		type: "text",
		text: '{"type":"mystery","foo":1}',
	});
});

test("tryImportedImageBlock: 小图写成 pi image，无字节/过大写占位", () => {
	assert.deepEqual(asPlain(tryImportedImageBlock({ type: "image", data: "abc", mimeType: "image/png" })), { type: "image", data: "abc", mimeType: "image/png" });
	assert.deepEqual(
		asPlain(
			tryImportedImageBlock({
				type: "image",
				source: { type: "base64", media_type: "image/jpeg", data: "xyz" },
			}),
		),
		{ type: "image", data: "xyz", mimeType: "image/jpeg" },
	);
	assert.deepEqual(asPlain(tryImportedImageBlock({ type: "image", filename: "shot.png" })), {
		type: "text",
		text: "[image: shot.png]",
	});
	assert.equal(tryImportedImageBlock({ type: "text", text: "hi" }), null);

	const huge = { type: "image", data: "a".repeat(IMPORTED_IMAGE_MAX_BASE64_CHARS + 1), mimeType: "image/png" };
	assert.deepEqual(asPlain(tryImportedImageBlock(huge)), {
		type: "text",
		text: "[image: image/png]",
	});
	assert.equal(asPlain(capImportedImage({ type: "image", data: "ok", mimeType: "image/png" }, "x")).type, "image");
});

test("importedContentHasToolCall: 识别 assistant content 里的 toolCall", () => {
	assert.equal(importedContentHasToolCall([{ type: "text", text: "hi" }]), false);
	assert.equal(importedContentHasToolCall([{ type: "toolCall", id: "1", name: "Read" }]), true);
});
