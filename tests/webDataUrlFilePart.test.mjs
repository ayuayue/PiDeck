/**
 * dataUrlToFilePart（Web 图片附件 → AI SDK file part）纯函数测试。
 *
 * 契约背景：服务端 /api/chat 只从 user 消息 parts 提取图片（extractChatImages），
 * 气泡缩略图渲染也只认 file parts——parts 形态错了图片就静默丢失，这里锁住形态。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { dataUrlToFilePart } = loadTsCommonJs("src/renderer/src/web/webMessageParts.ts");

test("png data URL → file part：type/file 前缀 mediaType/原样 url", () => {
	const url = "data:image/png;base64,iVBORw0KGgo=";
	const part = dataUrlToFilePart(url);
	// vm 沙箱对象与宿主 realm 不同源，逐字段断言（deepStrictEqual 会因原型链失配误报）
	assert.equal(part.type, "file");
	assert.equal(part.mediaType, "image/png");
	assert.equal(part.url, url);
});

test("jpeg/webp 媒体类型从前缀解析，data 保留 url 形态", () => {
	assert.equal(dataUrlToFilePart("data:image/jpeg;base64,abc").mediaType, "image/jpeg");
	assert.equal(dataUrlToFilePart("data:image/webp;base64,abc").mediaType, "image/webp");
	// url 字段保留完整 data URL（服务端 extractChatImages 兼容 url 形态）
	assert.equal(dataUrlToFilePart("data:image/webp;base64,abc").url, "data:image/webp;base64,abc");
});

test("非 data URL 形态按 png 兜底（压缩器只产出 png/jpeg/webp，异常输入不抛）", () => {
	const fallback = dataUrlToFilePart("https://example.com/a.png");
	assert.equal(fallback.type, "file");
	assert.equal(fallback.mediaType, "image/png");
	assert.equal(fallback.url, "https://example.com/a.png");
	assert.equal(dataUrlToFilePart("").mediaType, "image/png");
});
