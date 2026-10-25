import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 收藏页两个纯逻辑：
 * - favoriteIdentity：「整条消息」收藏的身份键与已收藏态索引（星标/右键菜单据此切换）；
 * - filterFavorites：搜索 + kind 筛选（页面本地过滤）。
 */
const { favoriteMessageKey, collectFavoritedMessageKeys, findMessageFavorite } = loadTsCommonJs("src/renderer/src/components/favorites/favoriteIdentity.ts");
const { filterFavorites, applyFavoriteOrder } = loadTsCommonJs("src/renderer/src/components/favorites/favoriteFilters.ts");

const entry = (overrides = {}) => ({
	id: "f1",
	createdAt: 1000,
	kind: "message",
	text: "正文",
	role: "assistant",
	sessionId: "s1",
	sessionTitle: "会话一",
	projectId: "p1",
	messageId: "m1",
	model: null,
	partial: false,
	truncated: false,
	...overrides,
});

test("favoriteMessageKey：会话 + 消息 id 组成身份，缺 messageId 时不可去重", () => {
	assert.equal(favoriteMessageKey("s1", "m1"), "s1::m1");
	assert.equal(favoriteMessageKey(null, "m1"), "::m1");
	assert.equal(favoriteMessageKey("s1", null), null, "live 流式正文没有稳定身份");
	assert.equal(favoriteMessageKey(undefined, undefined), null);
});

test("collectFavoritedMessageKeys：只收整条消息收藏，忽略划选片段与缺 id 的条目", () => {
	const keys = [...collectFavoritedMessageKeys([entry(), entry({ id: "f2", kind: "selection" }), entry({ id: "f3", messageId: null })])];
	assert.deepEqual(keys, ["s1::m1"]);
});

test("findMessageFavorite：按会话 + 消息 id 命中第一条，不同会话不串", () => {
	const first = entry();
	const second = entry({ id: "f2", text: "另一条" });
	assert.equal(findMessageFavorite([first, second], "s1", "m1"), first);
	assert.equal(findMessageFavorite([first, second], "s2", "m1"), undefined, "跨会话不能命中");
	assert.equal(findMessageFavorite([first], "s1", null), undefined);
});

test("filterFavorites：kind 筛选 + 正文/会话标题不区分大小写搜索", () => {
	const entries = [entry(), entry({ id: "f2", kind: "selection", text: "剪贴板片段", sessionTitle: "另一个会话" })];
	assert.deepEqual([...filterFavorites(entries, "", "all").map((item) => item.id)], ["f1", "f2"]);
	assert.deepEqual([...filterFavorites(entries, "", "selection").map((item) => item.id)], ["f2"]);
	assert.deepEqual([...filterFavorites(entries, "剪贴板", "all").map((item) => item.id)], ["f2"]);
	assert.deepEqual([...filterFavorites(entries, "会话一", "all").map((item) => item.id)], ["f1"]);
	assert.deepEqual([...filterFavorites(entries, "不存在", "all")], []);
});

test("applyFavoriteOrder：可见条目按新顺序占位，被过滤隐藏的条目留在原位", () => {
	const entries = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" }), entry({ id: "d" })];
	// 搜索只命中 d 和 b：把 d 拖到 b 前面，隐藏的 a/c 不能被挤到末尾。
	const next = applyFavoriteOrder(entries, ["d", "b"]);
	assert.deepEqual([...next.map((item) => item.id)], ["a", "d", "c", "b"]);
});

test("applyFavoriteOrder：未知 id 忽略，空顺序不改动列表", () => {
	const entries = [entry({ id: "a" }), entry({ id: "b" })];
	assert.deepEqual([...applyFavoriteOrder(entries, ["missing"]).map((item) => item.id)], ["a", "b"]);
	assert.deepEqual([...applyFavoriteOrder(entries, []).map((item) => item.id)], ["a", "b"]);
});
