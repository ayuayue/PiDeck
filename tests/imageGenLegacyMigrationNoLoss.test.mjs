import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

// ImageBlobStore / ImageSessionStore 都不依赖 electron，可直接加载完整生产模块
// （与 tests/imageGenSessionStore.test.mjs 同款加载方式）。
function makeStore() {
	const root = mkdtempSync(join(tmpdir(), "pideck-imagegen-m5-"));
	const storeDir = join(root, "sessions");
	const blobsDir = join(root, "blobs");
	mkdirSync(storeDir, { recursive: true });
	const { ImageBlobStore, IMAGE_BLOB_MAX_BYTES } = loadTsCommonJs(
		"src/main/imagegen/ImageBlobStore.ts",
	);
	const { ImageSessionStore } = loadTsCommonJs("src/main/imagegen/ImageSessionStore.ts");
	const store = new ImageSessionStore({
		getStorePath: () => storeDir,
		blobs: new ImageBlobStore({ getBlobsPath: () => blobsDir }),
	});
	return { store, storeDir, blobsDir, IMAGE_BLOB_MAX_BYTES };
}

/** 旧格式消息行：内联 base64 图片（data 内容由调用方控制）。 */
function legacyLine(id, data) {
	return JSON.stringify({
		id,
		role: "user",
		text: "legacy",
		timestamp: 1,
		images: [{ type: "image", data, mimeType: "image/png" }],
	});
}

/** 1×1 真实 PNG 的 base64（put 成功，可正常迁移）。 */
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

it("无法落库的图片（非法 base64）所在行必须原样保留（M5）", async () => {
	const { store, storeDir } = makeStore();
	const file = join(storeDir, `${SESSION_ID}.jsonl`);
	const badData = "@".repeat(300); // 非空但非法的 base64：put() 归一化即拒 → null
	writeFileSync(file, `${legacyLine("m-bad", badData)}\n`, "utf8");

	await store.readMessages(SESSION_ID); // 触发自愈迁移

	const raw = readFileSync(file, "utf8");
	assert.ok(raw.includes('"m-bad"'), "消息行本身必须还在");
	assert.ok(raw.includes(badData), "迁移失败的图片必须保留原始 base64，不得静默丢弃后覆盖原文件");
});

it("超过 IMAGE_BLOB_MAX_BYTES 的图片所在行必须原样保留（M5，备忘录原始场景）", async () => {
	const { store, storeDir, blobsDir, IMAGE_BLOB_MAX_BYTES } = makeStore();
	const file = join(storeDir, `${SESSION_ID}.jsonl`);
	const hugeData = Buffer.alloc(IMAGE_BLOB_MAX_BYTES + 1024).toString("base64");
	writeFileSync(file, `${legacyLine("m-huge", hugeData)}\n`, "utf8");

	await store.readMessages(SESSION_ID); // 触发自愈迁移

	const raw = readFileSync(file, "utf8");
	assert.ok(
		raw.includes(hugeData.slice(0, 64)),
		"超限图片必须原样保留，不得丢弃后用无图行原子覆盖原文件",
	);
	assert.ok(
		!existsSync(blobsDir) || readdirSync(blobsDir).length === 0,
		"超限图片不应产生 blob 文件",
	);
});

it("可正常落库的小图仍照常迁移为 ref 引用（回归守卫）", async () => {
	const { store, storeDir } = makeStore();
	const file = join(storeDir, `${SESSION_ID}.jsonl`);
	writeFileSync(file, `${legacyLine("m-ok", TINY_PNG)}\n`, "utf8");
	await store.readMessages(SESSION_ID);
	const raw = readFileSync(file, "utf8");
	assert.match(raw, /"ref":"[0-9a-f]{64}\.png"/, "小图应迁移为 blob 引用");
	assert.ok(!raw.includes(TINY_PNG), "已迁移图片不应再保留内联 base64");
});

it("损坏行继续原样保留，且不阻断同文件其他行迁移（既有策略回归守卫）", async () => {
	const { store, storeDir } = makeStore();
	const file = join(storeDir, `${SESSION_ID}.jsonl`);
	const corrupt = '{"id":"m-corrupt","role":"user", oops not json';
	writeFileSync(file, `${legacyLine("m-ok2", TINY_PNG)}\n${corrupt}\n`, "utf8");
	await store.readMessages(SESSION_ID);
	const raw = readFileSync(file, "utf8");
	assert.match(raw, /"ref":"[0-9a-f]{64}\.png"/, "好行应完成迁移");
	assert.ok(raw.includes(corrupt), "损坏行必须原样保留");
});
