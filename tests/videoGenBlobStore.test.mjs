import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 视频落盘（内容寻址 blob）：流式写盘 + sha256 命名 + 白名单解析。
 * 遵循「生图存储」领域约束的视频版：字节永不进 JSON，读取方只有 ref。
 */

const { loadTsCommonJs } = await import("./helpers/loadTsCommonJs.mjs");
const { VideoBlobStore, VIDEO_BLOB_REF_RE, VIDEO_BLOB_MAX_BYTES, videoBlobMimeType } = loadTsCommonJs("src/main/videogen/VideoBlobStore.ts");
const videoContent = loadTsCommonJs("src/shared/videoContentSrc.ts");

function streamOf(chunks) {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
			controller.close();
		},
	});
}

test("putFromResponse：流式落盘返回内容寻址 ref，字节与哈希一致", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-videogen-blobs-"));
	const store = new VideoBlobStore({ getBlobsPath: () => join(dir, "blobs") });
	const bytes = new TextEncoder().encode("fake-mp4-bytes-here");
	const ref = await store.putFromResponse({ body: streamOf([bytes]), headers: { get: () => "video/mp4" } });
	assert.ok(ref, "ref should be returned");
	assert.match(ref, /^[0-9a-f]{64}\.mp4$/);
	const expected = createHash("sha256").update(bytes).digest("hex");
	assert.equal(ref, `${expected}.mp4`);
	const onDisk = readFileSync(join(dir, "blobs", ref));
	assert.deepEqual([...onDisk], [...bytes]);
	assert.equal(videoBlobMimeType(ref), "video/mp4");
});

test("putFromResponse：空流/无 body 返回 null（调用方映射 downloadFailed）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-videogen-blobs-"));
	const store = new VideoBlobStore({ getBlobsPath: () => join(dir, "blobs") });
	assert.equal(await store.putFromResponse({ body: streamOf([]), headers: { get: () => "video/mp4" } }), null);
	assert.equal(await store.putFromResponse({ headers: { get: () => "video/mp4" } }), null);
});

test("resolvePath：白名单校验，路径穿越/非法形态一律 null", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-videogen-blobs-"));
	const store = new VideoBlobStore({ getBlobsPath: () => join(dir, "blobs") });
	const ref = await store.putFromResponse({ body: streamOf([new Uint8Array([1, 2, 3])]), headers: { get: () => "video/webm" } });
	assert.match(ref, /\.webm$/);
	assert.ok(store.resolvePath(ref));
	assert.equal(store.resolvePath(`${"a".repeat(64)}.exe`), null);
	assert.equal(store.resolvePath("..\\evil.mp4"), null);
	assert.equal(store.resolvePath("sub/dir.mp4"), null);
	assert.equal(store.resolvePath(42), null);
});

test("大小上限常量：512MiB（读取永远有字节上界）", () => {
	assert.equal(VIDEO_BLOB_MAX_BYTES, 512 * 1024 * 1024);
	assert.match(String(VIDEO_BLOB_REF_RE), /mp4/);
});

test("videoContentSrc：统一入口，缺 ref 返回 null 而不是 undefined URL", () => {
	assert.equal(videoContent.videoContentSrc(null), null);
	assert.equal(videoContent.videoContentSrc(undefined), null);
	assert.equal(videoContent.videoContentSrc({}), null);
	assert.equal(videoContent.videoContentSrc({ ref: `${"ab".repeat(32)}.mp4` }), `pideck-video://blob/${"ab".repeat(32)}.mp4`);
	assert.equal(videoContent.videoBlobUrl(`${"cd".repeat(32)}.webm`), `pideck-video://blob/${"cd".repeat(32)}.webm`);
});
