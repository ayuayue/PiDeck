/**
 * /api/state 的条件请求（ETag / If-None-Match）纯函数行为。
 *
 * 动机：Web 端每 10s 轮询一次 /api/state，载荷含全部会话投影（500+ 条约 228KB）。
 * 目录没变的窗口里全量重传纯属浪费（移动端按流量计费）。这里钉住两件事：
 *   1. ETag 只随「Web 端看得见的字段」变化——内部字段抖动不能让它失效（否则缓存形同虚设）；
 *   2. 匹配规则覆盖弱标签/多值/通配，避免客户端带 W/ 前缀或代理合并后漏判。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { stateEtag, ifNoneMatchHits, canonicalStateString } = loadTsCommonJs("src/main/web/WebStateEtag.ts");

function snapshot(overrides = {}) {
	return {
		projects: [{ id: "p1", name: "PiDeck", path: "C:/repo" }],
		sessions: [{ id: "s1", title: "标题", updatedAt: 1000, backend: "pi", status: "idle" }],
		runtimes: [{ sessionId: "s1", agentId: "a1", status: "idle", runtimeGeneration: 1 }],
		pendingUiRequests: [],
		...overrides,
	};
}

test("同内容 => 同 ETag；字段顺序无关", () => {
	assert.equal(stateEtag(snapshot()), stateEtag(snapshot()));
	// 同一批数据换个对象字面量顺序也必须一致（canonical 串按固定字段序拼接）
	const reordered = { pendingUiRequests: [], runtimes: snapshot().runtimes, sessions: snapshot().sessions, projects: snapshot().projects };
	assert.equal(stateEtag(reordered), stateEtag(snapshot()));
});

test("会话标题/状态/更新时间/后端变化 => ETag 变化（Web 可见字段）", () => {
	const base = stateEtag(snapshot());
	for (const patch of [{ title: "新标题" }, { status: "running" }, { updatedAt: 2000 }, { backend: "dsh" }]) {
		const next = stateEtag(snapshot({ sessions: [{ id: "s1", title: "标题", updatedAt: 1000, backend: "pi", status: "idle", ...patch }] }));
		assert.notEqual(next, base, `字段 ${JSON.stringify(patch)} 变化必须换 ETag`);
	}
});

test("runtime 代数/状态、项目名、挂起提问变化 => ETag 变化", () => {
	const base = stateEtag(snapshot());
	assert.notEqual(stateEtag(snapshot({ runtimes: [{ sessionId: "s1", agentId: "a1", status: "running", runtimeGeneration: 1 }] })), base);
	assert.notEqual(stateEtag(snapshot({ runtimes: [{ sessionId: "s1", agentId: "a1", status: "idle", runtimeGeneration: 2 }] })), base);
	assert.notEqual(stateEtag(snapshot({ projects: [{ id: "p1", name: "改名", path: "C:/repo" }] })), base);
	assert.notEqual(stateEtag(snapshot({ pendingUiRequests: [{ sessionId: "s1", requestId: "r1" }] })), base);
});

test("Web 不可见的内部字段不参与哈希（避免无谓失效）", () => {
	const withInternal = snapshot({ sessions: [{ id: "s1", title: "标题", updatedAt: 1000, backend: "pi", status: "idle", filePath: "C:/x/y.jsonl", messageCount: 42 }] });
	assert.equal(stateEtag(withInternal), stateEtag(snapshot()), "filePath/messageCount 不在 Web 投影里，不应影响 ETag");
});

test("If-None-Match：精确、弱标签、多值、通配都命中", () => {
	const etag = stateEtag(snapshot());
	assert.equal(ifNoneMatchHits(etag, etag), true);
	assert.equal(ifNoneMatchHits(`W/${etag}`, etag), true, "弱标签前缀要容忍");
	assert.equal(ifNoneMatchHits(`"other", ${etag}`, etag), true, "多值列表命中任意一项即可");
	assert.equal(ifNoneMatchHits("*", etag), true);
});

test("If-None-Match：缺失/不匹配按「需要响应体」处理", () => {
	const etag = stateEtag(snapshot());
	assert.equal(ifNoneMatchHits(undefined, etag), false);
	assert.equal(ifNoneMatchHits("", etag), false);
	assert.equal(ifNoneMatchHits('"deadbeef"', etag), false);
});

test("canonical 串里不含裸 \u0001/\u0002/\u0003 混淆：字段间用固定分隔符", () => {
	const text = canonicalStateString(snapshot());
	assert.ok(text.includes("\u0001"), "字段分隔符");
	assert.ok(text.includes("\u0003"), "区块分隔符");
});
