/**
 * 图片显示源解析（shared/imageContentSrc）单测。
 *
 * 这里是「base64 只在内存活一轮、进历史换成 ref」这条契约在渲染层的唯一入口：
 * 所有 <img src> 都必须过 imageContentSrc，复制/保存/重发才走 loadImageBase64。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { IMAGE_BLOB_PROTOCOL, imageBlobUrl, imageContentSrc, hasImageSource, loadImageBase64, hydrateImageContents } = loadTsCommonJs("src/shared/imageContentSrc.ts");

const REF = `${"a".repeat(64)}.png`;

test("imageContentSrc：内联 base64 → data URL；ref → pideck-img:// URL", () => {
	assert.equal(imageContentSrc({ data: "QUJD", mimeType: "image/png" }), "data:image/png;base64,QUJD");
	assert.equal(imageContentSrc({ ref: REF, mimeType: "image/png" }), `${IMAGE_BLOB_PROTOCOL}://blob/${REF}`);
	assert.equal(imageBlobUrl(REF), `${IMAGE_BLOB_PROTOCOL}://blob/${REF}`);
});

test("imageContentSrc：data 优先于 ref；两者都没有返回 null（不能回退成空 data URL）", () => {
	assert.equal(imageContentSrc({ data: "QUJD", ref: REF, mimeType: "image/png" }), "data:image/png;base64,QUJD");
	assert.equal(imageContentSrc({ mimeType: "image/png" }), null);
	assert.equal(imageContentSrc(null), null);
	assert.equal(imageContentSrc(undefined), null);
});

test("hasImageSource：有 data 或 ref 才算可显示", () => {
	assert.equal(hasImageSource({ data: "QUJD" }), true);
	assert.equal(hasImageSource({ ref: REF }), true);
	assert.equal(hasImageSource({}), false);
	assert.equal(hasImageSource(null), false);
});

test("loadImageBase64：内联图不触发读取器", async () => {
	let called = 0;
	const payload = await loadImageBase64({ data: "QUJD", mimeType: "image/png" }, async () => {
		called += 1;
		return null;
	});
	assert.equal(payload.data, "QUJD");
	assert.equal(payload.mimeType, "image/png");
	assert.equal(called, 0);
});

test("loadImageBase64：ref 走读取器；读取失败或抛错都返回 null（不炸 UI 事件链）", async () => {
	const ok = await loadImageBase64({ ref: REF, mimeType: "image/png" }, async () => ({
		data: "REVG",
		mimeType: "image/png",
	}));
	assert.equal(ok.data, "REVG");

	assert.equal(await loadImageBase64({ ref: REF, mimeType: "image/png" }, async () => null), null);
	assert.equal(
		await loadImageBase64({ ref: REF, mimeType: "image/png" }, async () => {
			throw new Error("ipc down");
		}),
		null,
	);
	// 既无 data 也无 ref：不调读取器
	let called = 0;
	assert.equal(
		await loadImageBase64({ mimeType: "image/png" }, async () => {
			called += 1;
			return null;
		}),
		null,
	);
	assert.equal(called, 0);
});

test("hydrateImageContents：批量回填，取不到字节的条目被丢弃", async () => {
	const images = [
		{ type: "image", data: "QUJD", mimeType: "image/png" },
		{ type: "image", ref: REF, mimeType: "image/png" },
		{ type: "image", ref: `${"b".repeat(64)}.png`, mimeType: "image/png" },
	];
	const hydrated = await hydrateImageContents(images, async (ref) => (ref === REF ? { data: "REVG", mimeType: "image/jpeg" } : null));
	assert.equal(hydrated.length, 2);
	assert.equal(
		JSON.stringify(hydrated),
		JSON.stringify([
			{ type: "image", data: "QUJD", mimeType: "image/png" },
			{ type: "image", data: "REVG", mimeType: "image/jpeg" },
		]),
	);
	// 跨 realm 对象原型不同：统一用 JSON 比较（deepStrictEqual 会失败）
	assert.equal(JSON.stringify(await hydrateImageContents(undefined, async () => null)), "[]");
	assert.equal(JSON.stringify(await hydrateImageContents([], async () => null)), "[]");
});
