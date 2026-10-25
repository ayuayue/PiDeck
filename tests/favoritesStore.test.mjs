import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { FavoritesStore } = loadTsCommonJs("src/main/favorites/FavoritesStore.ts");
const { parseAddFavoriteInput } = loadTsCommonJs("src/main/favorites/favoriteInput.ts");
const { FAVORITE_ENTRY_LIMIT, FAVORITE_TEXT_MAX_CHARS } = loadTsCommonJs("src/shared/types/favorites.ts");

/** 每个用例一份独立 userData 目录，用例结束删干净（store 只认注入的 filePath）。 */
async function withStore(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-favorites-"));
	try {
		await run(join(dir, "favorites.json"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function favoriteInput(overrides = {}) {
	return parseAddFavoriteInput({ kind: "message", text: "第一条快照", ...overrides });
}

test("add 落盘快照：list 按收藏时间倒序、字段完整", async () => {
	await withStore(async (filePath) => {
		const store = new FavoritesStore(filePath);
		await store.load();
		const older = await store.add(favoriteInput({ text: "较早的收藏" }), 1_000);
		const newer = await store.add(favoriteInput({ kind: "selection", text: "较新的收藏", role: "assistant", sessionId: "s1", sessionTitle: "会话一", projectId: "p1", messageId: "m1", model: "global/x", partial: true }), 2_000);

		const list = store.list();
		assert.deepEqual([...list.map((entry) => entry.id)], [newer.id, older.id]);
		assert.equal(list[0].kind, "selection");
		assert.equal(list[0].sessionTitle, "会话一");
		assert.equal(list[0].partial, true);
		assert.equal(list[0].createdAt, 2_000);
		assert.equal(list[1].createdAt, 1_000);
	});
});

test("load 读回已落盘收藏（跨实例、保持倒序）", async () => {
	await withStore(async (filePath) => {
		const first = new FavoritesStore(filePath);
		await first.load();
		await first.add(favoriteInput({ text: "持久化" }), 5_000);

		const second = new FavoritesStore(filePath);
		const loaded = await second.load();
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0].text, "持久化");
		assert.equal(loaded[0].createdAt, 5_000);
	});
});

test("remove 只删命中 id：未知 id 返回 false 且不写坏文件", async () => {
	await withStore(async (filePath) => {
		const store = new FavoritesStore(filePath);
		await store.load();
		const entry = await store.add(favoriteInput(), 1_000);
		assert.equal(await store.remove("missing"), false);
		assert.equal(store.list().length, 1);
		assert.equal(await store.remove(entry.id), true);
		assert.equal(store.list().length, 0);
	});
});

test("坏文件（非 JSON）按空列表重建并写回合法 JSON", async () => {
	await withStore(async (filePath) => {
		await writeFile(filePath, "{ not json", "utf8");
		const store = new FavoritesStore(filePath);
		const loaded = await store.load();
		assert.equal(loaded.length, 0);
		const repaired = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(repaired.entries.length, 0);
	});
});

test("超长正文截断并标记 truncated（收藏仍成功）", async () => {
	await withStore(async (filePath) => {
		const store = new FavoritesStore(filePath);
		await store.load();
		const entry = await store.add(favoriteInput({ text: "x".repeat(FAVORITE_TEXT_MAX_CHARS + 32) }), 1_000);
		assert.equal(entry.text.length, FAVORITE_TEXT_MAX_CHARS);
		assert.equal(entry.truncated, true);
	});
});

test("load 归一化：丢弃坏条目、去重 id、保留文件里的顺序", async () => {
	await withStore(async (filePath) => {
		const valid = (id, createdAt) => ({ id, createdAt, kind: "message", text: "内容 " + id });
		const entries = [valid("a", 1), valid("a", 9), { id: "bad" }, { ...valid("b", 2), kind: "unknown" }, valid("c", 3)];
		await writeFile(filePath, JSON.stringify({ version: 1, entries }), "utf8");

		const store = new FavoritesStore(filePath);
		const loaded = await store.load();
		const ids = [...loaded.map((entry) => entry.id)];
		// 不再按 createdAt 重排：文件顺序就是用户拖拽出来的偏好，重启时不能把它抹掉。
		assert.deepEqual(ids, ["a", "c"], "重复 id 只留首次出现、坏条目与非法 kind 丢弃、顺序以文件为准");
	});
});

test("load 按 FAVORITE_ENTRY_LIMIT 裁剪：保留排在前面的一批", async () => {
	await withStore(async (filePath) => {
		const valid = (id, createdAt) => ({ id, createdAt, kind: "message", text: "内容 " + id });
		const entries = [];
		for (let index = 0; index < FAVORITE_ENTRY_LIMIT + 5; index += 1) entries.push(valid("bulk-" + index, 100 + index));
		await writeFile(filePath, JSON.stringify({ version: 1, entries }), "utf8");

		const store = new FavoritesStore(filePath);
		const loaded = await store.load();
		assert.equal(loaded.length, FAVORITE_ENTRY_LIMIT);
		assert.equal(loaded[0].id, "bulk-0", "头部（用户排在最前的）保留");
		assert.equal(loaded[loaded.length - 1].id, "bulk-" + (FAVORITE_ENTRY_LIMIT - 1), "超出上限的尾部被裁掉");
	});
});

test("reorder 落盘用户拖拽顺序：未列出的条目按原顺序追加", async () => {
	await withStore(async (filePath) => {
		const store = new FavoritesStore(filePath);
		await store.load();
		const a = await store.add(favoriteInput({ text: "a" }), 1_000);
		const b = await store.add(favoriteInput({ text: "b" }), 2_000);
		const c = await store.add(favoriteInput({ text: "c" }), 3_000);
		// add 前插 → 当前列表是 [c, b, a]；只列出 a 和 c，模拟渲染层拿着部分顺序的载荷。
		const next = await store.reorder([a.id, c.id]);
		assert.deepEqual([...next.map((entry) => entry.id)], [a.id, c.id, b.id], "列出项按顺序前置，未列出的保持原序追加");
		const persisted = JSON.parse(await readFile(filePath, "utf8"));
		assert.deepEqual([...persisted.entries.map((entry) => entry.id)], [a.id, c.id, b.id], "顺序写进 favorites.json");

		const reloaded = await new FavoritesStore(filePath).load();
		assert.deepEqual([...reloaded.map((entry) => entry.id)], [a.id, c.id, b.id], "重启后顺序不回到按时间倒序");
	});
});

test("reorder 忽略未知/重复 id，顺序未变时不写盘", async () => {
	await withStore(async (filePath) => {
		const store = new FavoritesStore(filePath);
		await store.load();
		const a = await store.add(favoriteInput({ text: "a" }), 1_000);
		const b = await store.add(favoriteInput({ text: "b" }), 2_000);
		const before = await readFile(filePath, "utf8");
		const same = await store.reorder(["missing", b.id, b.id, a.id]);
		assert.deepEqual([...same.map((entry) => entry.id)], [b.id, a.id], "未知 id 忽略、重复 id 只算一次");
		assert.equal(await readFile(filePath, "utf8"), before, "顺序没变不重写文件（拖回原位不该落盘）");
	});
});

test("removeMany 一次落盘删除多条：未知 id 忽略、返回实际条数", async () => {
	await withStore(async (filePath) => {
		const store = new FavoritesStore(filePath);
		await store.load();
		const a = await store.add(favoriteInput({ text: "a" }), 1_000);
		const b = await store.add(favoriteInput({ text: "b" }), 2_000);
		const c = await store.add(favoriteInput({ text: "c" }), 3_000);

		const removed = await store.removeMany([a.id, c.id, "missing-id"]);
		assert.equal(removed, 2, "只统计真正命中的条目");
		assert.deepEqual([...store.list().map((entry) => entry.id)], [b.id]);

		const persisted = JSON.parse(await readFile(filePath, "utf8"));
		assert.deepEqual([...persisted.entries.map((entry) => entry.id)], [b.id], "批量删除同步写进 favorites.json");

		const reloaded = await new FavoritesStore(filePath).load();
		assert.deepEqual([...reloaded.map((entry) => entry.id)], [b.id], "重启后不会复活");
	});
});

test("removeMany 空载荷/全未命中不写盘、返回 0", async () => {
	await withStore(async (filePath) => {
		const store = new FavoritesStore(filePath);
		await store.load();
		await store.add(favoriteInput({ text: "a" }), 1_000);
		const before = await readFile(filePath, "utf8");
		assert.equal(await store.removeMany([]), 0);
		assert.equal(await store.removeMany(["nope", "  "]), 0);
		assert.equal(await readFile(filePath, "utf8"), before, "没有命中时不该重写文件");
	});
});
