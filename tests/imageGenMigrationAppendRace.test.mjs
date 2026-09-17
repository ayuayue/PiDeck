import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function legacyLine(id, data) {
	return JSON.stringify({
		id,
		role: "user",
		text: "legacy",
		timestamp: 1,
		images: [{ type: "image", data, mimeType: "image/png" }],
	});
}

/** 轮询等待谓词成立或超时（迁移闸门用：两种实现下都能推进到下一步）。 */
async function waitFor(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

it("迁移进行中 append 的新行不得被迁移快照覆盖丢失（M6）", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-imagegen-m6-"));
	const storeDir = join(root, "sessions");
	mkdirSync(storeDir, { recursive: true });
	const file = join(storeDir, `${SESSION_ID}.jsonl`);
	// 旧格式文件：一行带内联 base64 的消息（触发迁移）
	writeFileSync(file, `${legacyLine("m-legacy", "B".repeat(300))}\n`, "utf8");

	// 受控 blob 替身：第一次 put（迁移改写该行时调用）在闸门上挂起，
	// 模拟大文件迁移耗时窗口；后续 put 立即返回合法 ref（64 位 hex + .png）。
	let firstPut = true;
	let releaseGate;
	let markPutStarted;
	const putStarted = new Promise((resolve) => {
		markPutStarted = resolve;
	});
	const gate = new Promise((resolve) => {
		releaseGate = resolve;
	});
	const fakeBlobs = {
		async put() {
			if (!firstPut) return "b".repeat(64) + ".png";
			firstPut = false;
			markPutStarted();
			await gate;
			return "a".repeat(64) + ".png";
		},
		async pruneUnreferenced() {
			return 0;
		},
	};
	const { ImageSessionStore } = loadTsCommonJs("src/main/imagegen/ImageSessionStore.ts");
	const store = new ImageSessionStore({ getStorePath: () => storeDir, blobs: fakeBlobs });

	// 读触发迁移：迁移在 rewriteLegacyLine → put 上挂起（读到旧格式行后卡住）
	const reading = store.readMessages(SESSION_ID);
	await putStarted;

	// 迁移窗口内并发 append 一条纯文本消息（无图片，不会触碰 fakeBlobs.put）。
	// 未修复：append 与迁移并发，立刻落盘（waitFor 立即命中），随后被迁移快照覆盖 → 丢行；
	// 已修复：append 被文件串行锁挡住，直到迁移结束才写入（waitFor 超时后放行闸门）。
	const appending = store.append(SESSION_ID, [
		{ id: "m-new", role: "user", text: "appended-during-migration", timestamp: 2 },
	]);
	await waitFor(() => readFileSync(file, "utf8").includes("appended-during-migration"), 300);

	releaseGate();
	await Promise.all([appending, reading]);

	const raw = readFileSync(file, "utf8");
	assert.ok(raw.includes("appended-during-migration"), "迁移窗口内 append 的行必须存活");
	assert.match(raw, /"ref":"a{64}\.png"/, "迁移本身必须已完成（旧行已改写为引用格式）");
});

it("并发 append 之间也必须串行（M6 附属回归）", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-imagegen-m6b-"));
	const storeDir = join(root, "sessions");
	const { ImageSessionStore } = loadTsCommonJs("src/main/imagegen/ImageSessionStore.ts");
	const store = new ImageSessionStore({
		getStorePath: () => storeDir,
		blobs: { async put() { return null; }, async pruneUnreferenced() { return 0; } },
	});
	// 引用格式文件（不触发迁移），20 条并发追加必须全部落盘、无一被覆盖
	const first = { id: "base", role: "user", text: "base", timestamp: 0 };
	await store.append("33333333-3333-4333-8333-333333333333", [first]);
	const sid = "33333333-3333-4333-8333-333333333333";
	const file = join(storeDir, `${sid}.jsonl`);
	const writes = [];
	for (let i = 0; i < 20; i += 1) {
		writes.push(store.append(sid, [{ id: `p-${i}`, role: "user", text: `t-${i}`, timestamp: i + 1 }]));
	}
	await Promise.all(writes);
	const raw = readFileSync(file, "utf8");
	for (let i = 0; i < 20; i += 1) {
		assert.ok(raw.includes(`"p-${i}"`), `并发追加的行 p-${i} 必须存活`);
	}
});
