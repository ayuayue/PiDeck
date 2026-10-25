import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 用户反馈（2026-10-21 诊断包）：已停止进程的长历史会话，先在 GUI 里正常看到历史，
// 一发消息触发 runtime 恢复，历史整段消失、上滑也翻不出来，直到本轮回复结束才回来。
//
// 机制：会话停着时时间线读的是磁盘页（source="disk"，历史在 messages 里，没有 history
// 前缀字段）。激活后主进程按「激活分页」只下发尾部窗口段，渲染层全量 flush 分支
// 用 current?.history 调和前缀——disk 条目没有这个字段，于是窗口段直接替换掉整个
// 磁盘历史，分页游标（page.nextBefore）也一起丢；若首个 flush 是 0 条空窗口
// （后台历史还没读出来 / 读失败），画面直接变空会话且没有任何加载入口。
//
// 契约：disk → runtime 交接必须把已展示的磁盘页转成 history 前缀（版本取自磁盘页
// indexVersion），窗口段照常覆盖尾部；fileVersion 变化（压缩/外部改写）时整段丢弃。

const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
const SESSION_ID = "session-a";

function message(index) {
	return {
		id: "m" + index,
		agentId: "agent-1",
		role: index % 2 === 0 ? "user" : "assistant",
		text: "t" + index,
		timestamp: 1_000 + index,
		meta: { entryId: "e" + index },
	};
}

/** 40 条磁盘历史，磁盘页游标 nextBefore=12（更早还有历史可翻）。 */
const DISK_MESSAGES = Array.from({ length: 40 }, (_, index) => message(index));
const DISK_PAGE = { total: 40, nextBefore: 12, indexVersion: "111:222" };

function setup() {
	const store = createStore();
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: SESSION_ID,
		messages: DISK_MESSAGES,
		source: "disk",
		page: DISK_PAGE,
	});
	return store;
}

function runtimeMessagesEvent(payload) {
	return { kind: "event", sessionId: SESSION_ID, agentId: "agent-new", runtimeGeneration: 2, sourceChannel: "sessions:messages", payload };
}

function entry(store) {
	return store.get(atoms.sessionMessagesCacheAtom)[SESSION_ID];
}

test("激活后窗口化全量 flush 保留已展示的磁盘历史与分页游标", () => {
	const store = setup();
	// 激活分页：runtime 只持有尾部 6 条（windowStart=34），fileVersion 与磁盘页同版本。
	store.set(atoms.applySessionRuntimeEventAtom, runtimeMessagesEvent({ messages: DISK_MESSAGES.slice(34), windowStart: 34, totalLength: 40, fileVersion: DISK_PAGE.indexVersion }));
	const current = entry(store);
	assert.equal(current.source, "runtime");
	assert.equal(current.messages.length, 6, "尾部窗口段照常以 runtime 为权威");
	assert.ok(current.history, "窗口前的磁盘历史必须转成 history 前缀，否则用户眼前的历史会整段消失");
	assert.equal(current.history.messages.length, 34, "前缀应包含窗口之前已读出的磁盘消息");
	assert.equal(current.history.nextBefore, 12, "磁盘页游标必须保留，否则上滑无法继续翻历史");
	const displayed = [...(current.history?.messages ?? []), ...current.messages];
	assert.deepEqual(
		displayed.map((item) => item.id),
		DISK_MESSAGES.map((item) => item.id),
		"显示数组必须连续覆盖磁盘历史 + 窗口段，不重复不缺口",
	);
});

test("激活时先到的空窗口不得清空用户正在看的历史", () => {
	const store = setup();
	// 后台历史尚未读取（或读取失败）：主进程先下发 0 条空窗口。
	store.set(atoms.applySessionRuntimeEventAtom, runtimeMessagesEvent({ messages: [], totalLength: 0 }));
	const current = entry(store);
	assert.equal(current.source, "runtime");
	assert.equal(current.messages.length, 0);
	assert.ok(current.history, "空窗口 flush 后磁盘历史必须继续作为前缀展示");
	assert.equal(current.history.messages.length, DISK_MESSAGES.length, "历史条数不得减少");
	const displayed = [...(current.history?.messages ?? []), ...current.messages];
	assert.equal(displayed.length, DISK_MESSAGES.length, "空窗口期间时间线仍显示完整历史");
});

test("普通追加（用户发消息落盘）不丢前缀，历史继续可见", () => {
	const store = setup();
	// 发消息 → pi 把 prompt 追加进 JSONL → size 变大、mtime 变化：版本字符串必然不同。
	// 这种「长大」是同一条会话的延续，若按异代丢弃，用户一发送历史就又没了。
	store.set(atoms.applySessionRuntimeEventAtom, runtimeMessagesEvent({ messages: [...DISK_MESSAGES.slice(34), message(40)], windowStart: 34, totalLength: 41, fileVersion: "222:9999" }));
	const current = entry(store);
	assert.ok(current.history, "追加写入不得让历史前缀整段消失");
	assert.equal(current.history.messages.length, 34);
	assert.equal(current.messages.length, 7, "窗口段包含刚发出的消息");
});

test("文件被压缩重写（体积变小）时前缀整段丢弃，不拼异代内容", () => {
	const store = setup();
	store.set(
		atoms.applySessionRuntimeEventAtom,
		// 压缩后文件显著变小（mtime 变新、size 从 222 缩到 100）
		runtimeMessagesEvent({ messages: DISK_MESSAGES.slice(34), windowStart: 34, totalLength: 40, fileVersion: "999:100" }),
	);
	const current = entry(store);
	assert.equal(current.history, undefined, "压缩后文件变小说明历史被重写，前缀必须丢弃");
	assert.equal(current.messages.length, 6);
});

test("磁盘页没有版本信息时不冒险保留（宁缺勿串）", () => {
	const store = createStore();
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: SESSION_ID,
		messages: DISK_MESSAGES,
		source: "disk",
		page: { total: 40, nextBefore: 12 },
	});
	store.set(atoms.applySessionRuntimeEventAtom, runtimeMessagesEvent({ messages: DISK_MESSAGES.slice(34), windowStart: 34, totalLength: 40, fileVersion: "111:222" }));
	const current = entry(store);
	assert.equal(current.history, undefined, "无法证明磁盘页与当前文件同代时必须丢弃");
});

test("已经是 runtime 前缀的会话不受影响（不重复拼接）", () => {
	const store = setup();
	const flush = runtimeMessagesEvent({ messages: DISK_MESSAGES.slice(34), windowStart: 34, totalLength: 40, fileVersion: DISK_PAGE.indexVersion });
	store.set(atoms.applySessionRuntimeEventAtom, flush);
	const first = entry(store);
	const firstHistoryLength = first.history?.messages.length;
	// 同一份窗口再 flush 一次（流式期间反复重建条目）
	store.set(atoms.applySessionRuntimeEventAtom, runtimeMessagesEvent({ messages: DISK_MESSAGES.slice(34), windowStart: 34, totalLength: 40, fileVersion: DISK_PAGE.indexVersion }));
	const second = entry(store);
	assert.equal(second.history?.messages.length, firstHistoryLength, "重复 flush 不得把窗口段再拼进前缀");
	assert.equal(second.messages.length, 6);
});
