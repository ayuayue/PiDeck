/**
 * AcpMessageSnapshotStore 单测：每会话条数截断 + 会话数 LRU 淘汰。
 * 背景：此前 messageSnapshots 是无淘汰的裸 Map（todo：会话数无上限），
 * stop/重启频繁的长会话场景内存只增不减；两层护栏语义在此钉死。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AcpMessageSnapshotStore } = loadTsCommonJs("src/main/acp/AcpMessageSnapshotStore.ts");

/** 构造最小 ChatMessage 形状（store 只透传，不读字段）。 */
function msg(id) {
	return { id, role: "user", content: [{ type: "text", text: `m${id}` }], createdAt: "2026-01-01T00:00:00.000Z" };
}

test("每会话快照截到最近 400 条（防单会话内存失控，不截正常长回合）", () => {
	const store = new AcpMessageSnapshotStore();
	const messages = [];
	for (let i = 0; i < 500; i += 1) messages.push(msg(i));
	store.set("s1", messages);
	const got = store.get("s1");
	assert.equal(got.length, 400);
	// 保留的是最新一段：第一条是原第 100 条。
	assert.equal(got[0].id, 100);
	assert.equal(got[399].id, 499);
});

test("会话数超 32 时逐出最旧（LRU），set 重写刷新位置", () => {
	const store = new AcpMessageSnapshotStore();
	for (let i = 0; i < 32; i += 1) store.set(`s${i}`, [msg(i)]);
	// 重写 s0 → 刷新到最新位置；再进第 33 个会话，逐出的应是最久未更新的 s1。
	store.set("s0", [msg("refreshed")]);
	store.set("s32", [msg(32)]);
	assert.equal(store.get("s1"), undefined, "最久未更新的会话被逐出");
	assert.deepEqual(
		store.get("s0").map((m) => m.id),
		["refreshed"],
		"重写过的会话存活且内容最新",
	);
	assert.equal(store.get("s32").id ?? store.get("s32")[0].id, 32);
});

test("快照存储的是拷贝，后续投影原数组变更不影响已存快照", () => {
	const store = new AcpMessageSnapshotStore();
	const live = [msg(1)];
	store.set("s1", live);
	live.push(msg(2));
	assert.equal(store.get("s1").length, 1, "set 时切片拷贝，不别名 live 数组");
});
