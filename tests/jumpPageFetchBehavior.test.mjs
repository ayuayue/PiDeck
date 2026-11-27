import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * useJumpPageFetch 的行为判据。
 *
 * 为什么这条重要：本片之前只有两条源码扫描（jumpEntryKeepsEntryId / jumpPageFetchEntryIdSpace），
 * 它们断言「代码长什么样」，不证明「跑起来对不对」。而 useJumpPageFetch 返回的函数不依赖
 * React 状态（ports 全在参数里），可以直接调用——所以它能被真判，不需要 DOM。
 *
 * 覆盖六件事：取页的参数形状、id 空间剥离、只取一次、超限不 prepend、
 * 切会话后到达的页作废、失败不抛。
 */
const { useJumpPageFetch, jumpEntryIdOf } = loadTsCommonJs("src/renderer/src/components/session/timeline/useJumpPageFetch.ts");

const LIMIT = 8000;

/** 打桩 ports：记录每次调用，便于断言「谁被调用、参数是什么」。 */
function makePorts(overrides = {}) {
	const calls = { read: [], prepend: [], setPending: [] };
	const ports = {
		sessionId: "s1",
		revision: 7,
		readRecordMessagePage: async (sessionId, before, pageSize, options) => {
			calls.read.push({ sessionId, before, pageSize, options });
			return { messages: [{ id: "m-c", meta: { entryId: "e-c" } }], nextBefore: 100, indexVersion: "v1" };
		},
		prependHistoryPage: (input) => {
			calls.prepend.push(input);
			return true;
		},
		historyPrefixMessageLimit: LIMIT,
		setPendingJump: (next) => {
			calls.setPending.push(next);
		},
		...overrides,
	};
	return { ports, calls };
}

const pending = (messageId, overrides = {}) => ({
	ownerKey: "owner-A",
	value: { messageId, expandAttempts: 0, loadAttempts: 0, nonce: 1, ...overrides },
});

test("入口给 entryId：一次取页，before=undefined、pageSize=200、beforeEntryId 原样", async () => {
	const { ports, calls } = makePorts();
	const fetchOnce = useJumpPageFetch(ports);
	const started = fetchOnce(pending("e-target"), "owner-A");
	assert.equal(started, true, "应当发起取页");
	assert.equal(calls.read.length, 1);
	assert.equal(calls.read[0].beforeEntryId, undefined, "不该传数值游标");
	assert.equal(calls.read[0].options?.beforeEntryId, "e-target", "锚点必须是原样的 entryId");
	assert.ok(calls.read[0].pageSize > 0, "pageSize 必须有值");
});

test("目录侧给投影消息 id：剥出后半段再当 entryId 用", async () => {
	const { ports, calls } = makePorts();
	await useJumpPageFetch(ports)(pending("agent-1-history-e-real"), "owner-A");
	assert.equal(calls.read[0].options?.beforeEntryId, "e-real", "必须剥掉 agentId-history- 前缀");
	// 反例：不剥就传进去，主进程找不到锚点、页面回空并标成「没有更早历史」
	assert.notEqual(calls.read[0].options?.beforeEntryId, "agent-1-history-e-real");
});

test("只取一次：pageFetched 已置位的请求不再发 IPC", () => {
	const { ports, calls } = makePorts();
	const started = useJumpPageFetch(ports)(pending("e-target", { pageFetched: true }), "owner-A");
	assert.equal(started, false, "已取过就不该再取");
	assert.equal(calls.read.length, 0, "不该发出第二次 IPC");
});

test("先落标记再发请求：effect 重跑不会打出第二串 IPC", () => {
	const { ports, calls } = makePorts();
	useJumpPageFetch(ports)(pending("e-target"), "owner-A");
	assert.equal(calls.setPending.length, 1, "必须立刻落 pageFetched");
	const marked = calls.setPending[0].value;
	assert.equal(marked.pageFetched, true);
	assert.equal(marked.nonce, 2, "nonce 推进，让 effect 重跑而不是被 deps 判为同一次");
});

test("超上限的整页不 prepend：宁可跳不到，也不给「没有更早历史」的假结论", async () => {
	const { ports, calls } = makePorts({
		readRecordMessagePage: async () => ({ messages: new Array(LIMIT).fill(0).map((_, i) => ({ id: "m" + i })), nextBefore: 0 }),
	});
	useJumpPageFetch(ports)(pending("e-target"), "owner-A");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(calls.prepend.length, 0, "整页装不下就不该 prepend");
});

test("切会话后到达的页作废：不污染新会话的历史", async () => {
	const { ports, calls } = makePorts();
	// 请求发出后用户切走了会话：currentOwnerKey 不再是发起时那个
	useJumpPageFetch(ports)(pending("e-target"), "owner-B");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(calls.prepend.length, 0, "ownerKey 不匹配时不该 prepend");
});

test("取页失败吞掉：不抛、不重试，交给扩窗兜底", async () => {
	const { ports, calls } = makePorts({
		readRecordMessagePage: async (sessionId, before, pageSize, options) => {
			calls.read.push({ sessionId, before, pageSize, options });
			throw new Error("ipc failed");
		},
	});
	useJumpPageFetch(ports)(pending("e-target"), "owner-A");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(calls.prepend.length, 0);
	assert.equal(calls.read.length, 1, "失败不重试");
});

test("没有 sessionId 时不取页（切走或尚未就绪）", () => {
	const { ports, calls } = makePorts({ sessionId: undefined });
	assert.equal(useJumpPageFetch(ports)(pending("e-target"), "owner-A"), false);
	assert.equal(calls.read.length, 0);
});

test("jumpEntryIdOf：两种 id 空间的分界可用一条命令判", () => {
	assert.equal(jumpEntryIdOf("e-plain"), "e-plain", "没有前缀就是原样");
	assert.equal(jumpEntryIdOf("agent-9-history-e-abc"), "e-abc");
	assert.equal(jumpEntryIdOf("a-history-b-history-c"), "b-history-c", "只剥第一处");
});
