/**
 * ImageSessionStore + ImageBlobStore 单测：生图草稿（无 pi 会话文件）的独立历史存储。
 *
 * 覆盖 2026-09 OOM 事故后的新契约：
 * - 图片 base64 不再写进 JSONL，改落盘为 blob（内容寻址去重），消息只留 ref；
 * - append 只追加（不做全量重写），超字节水位才压缩一次；
 * - readMessages 尾部有界读取 + 行数上限，回传渲染层的图片数据量有上界；
 * - 旧版（内联 base64）文件首次读写即自愈迁移，迁移后体积降一个量级；
 * - 孤儿 blob 回收（带宽限期），扫描失败时 fail-closed 不删图。
 *
 * TS 依赖图用 tests/helpers/loadTsCommonJs 加载：ImageSessionStore 会 require
 * 无扩展名的 ./ImageBlobStore，裸 require 解析不了。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const REF_RE = /^[0-9a-f]{64}\.(?:png|jpe?g|webp|gif|bmp|avif)$/;

function loadModules() {
	return {
		ImageBlobStore: loadTsCommonJs("src/main/imagegen/ImageBlobStore.ts").ImageBlobStore,
		IMAGE_BLOB_MAX_BYTES: loadTsCommonJs("src/main/imagegen/ImageBlobStore.ts").IMAGE_BLOB_MAX_BYTES,
		ImageSessionStore: loadTsCommonJs("src/main/imagegen/ImageSessionStore.ts").ImageSessionStore,
	};
}

/** 测试用图片字节（内容不同 → ref 不同） */
function pngBytes(seed) {
	return Buffer.from(`fake-png-payload-${seed}`).toString("base64");
}

async function makeTempDir(prefix) {
	return mkdtemp(join(tmpdir(), prefix));
}

async function cleanup(...dirs) {
	const { rm } = await import("node:fs/promises");
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
}

/** 建一套「sessions + blobs」存储 */
function makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs) {
	const blobStore = new ImageBlobStore({ getBlobsPath: () => blobs });
	const store = new ImageSessionStore({
		getStorePath: () => sessions,
		blobs: blobStore,
	});
	return { store, blobStore };
}

/** 一轮生图记录：user（可带参考图）+ assistant（结果图） */
function round(n, options = {}) {
	const userImages = options.reference ? [{ type: "image", data: pngBytes(`ref-${n}`), mimeType: "image/png" }] : undefined;
	return [
		{
			id: `u-${n}`,
			agentId: "",
			role: "user",
			text: `prompt ${n}`,
			timestamp: 1700000000000 + n,
			...(userImages ? { images: userImages } : {}),
		},
		{
			id: `a-${n}`,
			agentId: "",
			role: "assistant",
			text: "",
			stopReason: "stop",
			timestamp: 1700000000000 + n,
			images: [{ type: "image", data: pngBytes(`out-${n}`), mimeType: "image/png" }],
			meta: { imageGen: { status: "complete", prompt: `prompt ${n}` } },
		},
	];
}

test("append/read round-trip：图片换成 blob 引用，base64 不再进 JSONL", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const { store } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		await store.append(UUID_A, round(1, { reference: true }));

		const messages = await store.readMessages(UUID_A);
		assert.equal(messages.length, 2);
		assert.equal(messages[0].role, "user");
		assert.equal(messages[0].text, "prompt 1");
		// 参考图与结果图都变成 ref，且不再带内联字节
		for (const message of messages) {
			assert.equal(message.images.length, 1);
			assert.match(message.images[0].ref, REF_RE);
			assert.equal(message.images[0].data, undefined);
			assert.equal(message.images[0].mimeType, "image/png");
		}
		// 两张图内容不同 → 两个 blob 文件
		assert.equal((await readdir(blobs)).length, 2);
		// 磁盘上的 JSONL 一行内联 base64 都没有
		const raw = await readFile(join(sessions, `${UUID_A}.jsonl`), "utf8");
		assert.equal(raw.split("\n").filter(Boolean).length, 2);
		assert.doesNotMatch(raw, /"data":"[A-Za-z0-9+/]{16,}/);
	} finally {
		await cleanup(sessions, blobs);
	}
});

test("同一会话多轮追加：顺序保留（旧轮在前，新轮在后）", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const { store } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		await store.append(UUID_A, round(1));
		await store.append(UUID_A, round(2));
		await store.append(UUID_A, round(3));
		const messages = await store.readMessages(UUID_A);
		assert.equal(messages.length, 6);
		assert.equal(JSON.stringify(messages.map((m) => m.text || m.meta.imageGen.prompt)), JSON.stringify(["prompt 1", "prompt 1", "prompt 2", "prompt 2", "prompt 3", "prompt 3"]));
	} finally {
		await cleanup(sessions, blobs);
	}
});

test("append 只追加：不清空既有内容（不做全量重写）", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const { store } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		await store.append(UUID_A, round(1));
		const afterFirst = await stat(join(sessions, `${UUID_A}.jsonl`));
		await store.append(UUID_A, round(2));
		const raw = await readFile(join(sessions, `${UUID_A}.jsonl`), "utf8");
		assert.equal(raw.split("\n").filter(Boolean).length, 4);
		assert.ok((await stat(join(sessions, `${UUID_A}.jsonl`))).size > afterFirst.size);
	} finally {
		await cleanup(sessions, blobs);
	}
});

test("同一张图重复出现只落一份 blob（内容寻址去重）", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const { store } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		const shared = { type: "image", data: pngBytes("same"), mimeType: "image/png" };
		await store.append(UUID_A, [
			{ id: "u-1", agentId: "", role: "user", text: "p", timestamp: 1, images: [shared] },
			{ id: "a-1", agentId: "", role: "assistant", text: "", timestamp: 1, images: [shared] },
		]);
		const messages = await store.readMessages(UUID_A);
		assert.equal(messages[0].images[0].ref, messages[1].images[0].ref);
		assert.equal((await readdir(blobs)).length, 1);
	} finally {
		await cleanup(sessions, blobs);
	}
});

test("sessionId 白名单：非法 id（路径注入）静默拒绝，不落盘不读", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const { store } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		const evil = "../../../escape.txt";
		await store.append(evil, round(1));
		assert.equal(JSON.stringify(await store.readMessages(evil)), "[]");
		assert.deepEqual(await readdir(sessions), []);
		assert.deepEqual(await readdir(blobs), []);
	} finally {
		await cleanup(sessions, blobs);
	}
});

test("损坏行跳过：单行 JSON 损坏不阻断整段历史", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const { store } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		await store.append(UUID_A, round(1));
		// 在中间插一行坏 JSON
		const file = join(sessions, `${UUID_A}.jsonl`);
		const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
		await writeFile(file, `${lines[0]}\n{ broken json\n${lines[1]}\n`, "utf8");
		const messages = await store.readMessages(UUID_A);
		assert.equal(messages.length, 2);
		assert.equal(messages[0].role, "user");
		assert.equal(messages[1].role, "assistant");
	} finally {
		await cleanup(sessions, blobs);
	}
});

test("行数上限：超限只保留最新（防单会话失控）", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const { store } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		// 1050 轮 = 2100 条 > MAX_MESSAGES(2000)
		for (let i = 0; i < 1050; i += 1) await store.append(UUID_A, round(i));
		const messages = await store.readMessages(UUID_A);
		assert.equal(messages.length, 2000);
		assert.equal(messages.at(-1).role, "assistant");
		assert.equal(messages.at(-1).meta.imageGen.prompt, "prompt 1049");
	} finally {
		await cleanup(sessions, blobs);
	}
});

test("字节水位：超过 4 MB 时压缩保留最新，文件回落到水位内", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const { store } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		// 每行约 500 字节 × 10000 行 ≈ 5 MB > MAX_SESSION_BYTES(4 MB)
		const bulk = [];
		for (let i = 0; i < 10000; i += 1) {
			bulk.push({
				id: `m-${i}`,
				agentId: "",
				role: "user",
				text: "x".repeat(430),
				timestamp: 1700000000000 + i,
			});
		}
		await store.append(UUID_A, bulk);
		const info = await stat(join(sessions, `${UUID_A}.jsonl`));
		assert.ok(info.size <= 4 * 1024 * 1024, `compacted size ${info.size}`);
		const lines = (await readFile(join(sessions, `${UUID_A}.jsonl`), "utf8")).split("\n").filter(Boolean);
		assert.ok(lines.length <= 2000, `kept ${lines.length} lines`);
		// 保留的是最新的：末行是最后一条
		assert.match(lines.at(-1), /"id":"m-9999"/);
	} finally {
		await cleanup(sessions, blobs);
	}
});

test("旧格式自愈：内联 base64 文件首读即迁移为引用格式，体积降一个量级", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const file = join(sessions, `${UUID_A}.jsonl`);
		// 模拟旧版落盘：每行内联 200 KB base64 图片（事故现场是单行 10 MB 级）
		const bigBase64 = Buffer.alloc(150 * 1024, 7).toString("base64");
		const legacy = [
			JSON.stringify({
				id: "u-1",
				agentId: "",
				role: "user",
				text: "prompt legacy",
				timestamp: 1,
				images: [{ type: "image", data: bigBase64, mimeType: "image/png" }],
			}),
			JSON.stringify({
				id: "a-1",
				agentId: "",
				role: "assistant",
				text: "",
				timestamp: 2,
				images: [{ type: "image", data: bigBase64, mimeType: "image/png" }],
				meta: { imageGen: { status: "complete", prompt: "prompt legacy" } },
			}),
			"{ broken legacy line",
		];
		await writeFile(file, `${legacy.join("\n")}\n`, "utf8");
		const before = (await stat(file)).size;

		const { store } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		const messages = await store.readMessages(UUID_A);

		// 迁移后：消息带 ref，不再带字节
		assert.equal(messages.length, 2);
		for (const message of messages) {
			assert.match(message.images[0].ref, REF_RE);
			assert.equal(message.images[0].data, undefined);
		}
		// 两张图内容相同 → 去重成一个 blob
		assert.equal((await readdir(blobs)).length, 1);
		const after = (await stat(file)).size;
		assert.ok(after * 10 < before, `expected shrink: ${before} → ${after}`);
		const raw = await readFile(file, "utf8");
		assert.doesNotMatch(raw, /"data":"[A-Za-z0-9+/]{16,}/);
		// 损坏行原样保留（不替用户丢内容）
		assert.match(raw, /broken legacy line/);

		// 幂等：再读一次不再改动
		const sizeAfterSecondRead = (await stat(file)).size;
		await store.readMessages(UUID_A);
		assert.equal((await stat(file)).size, sizeAfterSecondRead);
	} finally {
		await cleanup(sessions, blobs);
	}
});

test("旧格式自愈：append 前先迁移，新行不会与内联 base64 混写", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const file = join(sessions, `${UUID_A}.jsonl`);
		await writeFile(
			file,
			`${JSON.stringify({
				id: "u-0",
				agentId: "",
				role: "user",
				text: "old",
				timestamp: 0,
				images: [{ type: "image", data: pngBytes("legacy"), mimeType: "image/png" }],
			})}\n`,
			"utf8",
		);
		const { store } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		await store.append(UUID_A, round(1));
		const raw = await readFile(file, "utf8");
		assert.equal(raw.split("\n").filter(Boolean).length, 3);
		assert.doesNotMatch(raw, /"data":"[A-Za-z0-9+/]{16,}/);
	} finally {
		await cleanup(sessions, blobs);
	}
});

test("孤儿 blob 回收：无引用且过宽限期的删除，被引用的与新鲜的保留", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const { store, blobStore } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		// 带参考图的一轮：user 与 assistant 各一张图 → 两个被引用的 blob
		await store.append(UUID_A, round(1, { reference: true }));
		const referenced = (await store.readMessages(UUID_A)).flatMap((m) => (m.images ?? []).map((image) => image.ref));
		assert.equal(referenced.length, 2);

		// 造一个无引用的旧 blob（2 小时前）
		const orphanRef = await blobStore.put(pngBytes("orphan"), "image/png");
		assert.ok(orphanRef);
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await utimes(join(blobs, orphanRef), old, old);

		const removed = await store.pruneOrphanBlobs();
		assert.equal(removed, 1);
		assert.ok(!existsSync(join(blobs, orphanRef)), "orphan should be removed");
		for (const ref of referenced) assert.ok(existsSync(join(blobs, ref)), "referenced kept");

		// 宽限期内不动：刚写入的孤儿 blob 保留（避免误删「先落盘、后写引用」的图）
		const freshOrphan = await blobStore.put(pngBytes("fresh-orphan"), "image/png");
		assert.equal(await store.pruneOrphanBlobs(), 0);
		assert.ok(existsSync(join(blobs, freshOrphan)));
	} finally {
		await cleanup(sessions, blobs);
	}
});

test("无记录会话返回空数组（不抛错）", async () => {
	const { ImageBlobStore, ImageSessionStore } = loadModules();
	const sessions = await makeTempDir("pideck-img-sessions-");
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const { store } = makeStore(ImageBlobStore, ImageSessionStore, sessions, blobs);
		assert.equal(JSON.stringify(await store.readMessages(UUID_B)), "[]");
	} finally {
		await cleanup(sessions, blobs);
	}
});

// ── ImageBlobStore ──

test("ImageBlobStore：data URL 前缀与裸 base64 都能落盘，内容相同即同一 ref", async () => {
	const { ImageBlobStore } = loadModules();
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const store = new ImageBlobStore({ getBlobsPath: () => blobs });
		const bare = pngBytes("x");
		const refA = await store.put(bare, "image/png");
		const refB = await store.put(`data:image/png;base64,${bare}`, "image/png");
		assert.ok(refA && REF_RE.test(refA));
		assert.equal(refA, refB);
		assert.equal((await readdir(blobs)).length, 1);
	} finally {
		await cleanup(blobs);
	}
});

test("ImageBlobStore：非法 base64 / 空内容一律拒绝，合法短 base64 正常落盘", async () => {
	const { ImageBlobStore } = loadModules();
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const store = new ImageBlobStore({ getBlobsPath: () => blobs });
		// 字符集非法 / 长度为 0：拒绝（Node 的 base64 解码器会静默忽略非法字符，必须先校验）
		assert.equal(await store.put("!!!not-base64!!!", "image/png"), null);
		assert.equal(await store.put("", "image/png"), null);
		assert.equal(await store.put("   ", "image/png"), null);
		// "QUJD" = 3 字节，是合法 base64
		assert.ok(await store.put("QUJD", "image/png"));
		assert.equal((await readdir(blobs)).length, 1);
	} finally {
		await cleanup(blobs);
	}
});

test("ImageBlobStore：引用名白名单拒绝路径穿越与非法扩展名", async () => {
	const { ImageBlobStore } = loadModules();
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const store = new ImageBlobStore({ getBlobsPath: () => blobs });
		assert.equal(store.resolvePath("../../evil.png"), null);
		assert.equal(store.resolvePath(`${"a".repeat(64)}.ts`), null);
		assert.equal(store.resolvePath("a".repeat(64)), null);
		assert.equal(store.resolvePath(`${"A".repeat(64)}.png`), null);
		assert.equal(store.resolvePath(""), null);
		const ref = await store.put(pngBytes("ok"), "image/png");
		assert.ok(store.resolvePath(ref));
		const payload = await store.readPayload(ref);
		assert.equal(payload.mimeType, "image/png");
		assert.equal(Buffer.from(payload.data, "base64").toString(), "fake-png-payload-ok");
	} finally {
		await cleanup(blobs);
	}
});

test("ImageBlobStore：readPayload 对超限文件返回 null（读取字节上界，AGENTS.md 生图硬约束）", async () => {
	// 回归：put() 有 32MB 上界，但 readPayload() 原先无上界直接 readFile+base64 膨胀；
	// blobs 目录被外部放入超大合法命名文件时（篡改/损坏/手工误放），读取即 OOM。
	const { ImageBlobStore, IMAGE_BLOB_MAX_BYTES } = loadModules();
	const blobs = await makeTempDir("pideck-img-blobs-");
	try {
		const store = new ImageBlobStore({ getBlobsPath: () => blobs });
		// 手工放入超过上界的合法命名 blob（绕过 put 的写入口径）
		const oversizedRef = `${"f".repeat(64)}.png`;
		await writeFile(join(blobs, oversizedRef), Buffer.alloc(IMAGE_BLOB_MAX_BYTES + 1024, 1));
		assert.equal(await store.readPayload(oversizedRef), null);
		// 正常大小文件不受影响
		const normalRef = await store.put(pngBytes("fine"), "image/png");
		assert.ok(await store.readPayload(normalRef));
	} finally {
		await cleanup(blobs);
	}
});
