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
	const calls = { read: [], prepend: [], setPending: [], clear: [] };
	const ports = {
		sessionId: "s1",
		revision: 7,
		readRecordMessagePage: async (sessionId, before, pageSize, options) => {
			calls.read.push({ sessionId, before, pageSize, options });
			return { messages: [{ id: "m-c", meta: { entryId: "e-c" } }], nextBefore: 100, indexVersion: "v1" };
		},
		prependHistoryPage: (input) => {
			calls.prepend.push(input);
			return overrides.prependResult === undefined ? true : overrides.prependResult;
		},
		clearHistory: (sessionId) => {
			calls.clear.push(sessionId);
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
	assert.equal(calls.read[0].options?.includeBeforeEntry, true, "定位页必须包含目标 entry");
	assert.ok(calls.read[0].pageSize > 0, "pageSize 必须有值");
});

test("目录侧给投影消息 id：剥出后半段再当 entryId 用", async () => {
	const { ports, calls } = makePorts();
	await useJumpPageFetch(ports)(pending("agent-1-history-e-real"), "owner-A");
	assert.equal(calls.read[0].options?.beforeEntryId, "e-real", "必须剥掉 agentId-history- 前缀");
	assert.equal(calls.read[0].options?.includeBeforeEntry, true, "投影 id 路径也必须请求含目标的页");
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

test("a full bounded jump page is prepended without a renderer retention cutoff", async () => {
	const { ports, calls } = makePorts({
		readRecordMessagePage: async () => ({ messages: Array.from({ length: LIMIT }, (_, i) => ({ id: "m" + i })), nextBefore: 0 }),
	});
	useJumpPageFetch(ports)(pending("e-target"), "owner-A");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(calls.prepend.length, 1);
	assert.equal(calls.prepend[0].page.messages.length, LIMIT);
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

test("目标已在已加载数据里时不取页：白读一次盘还会把 200 轮塞进前缀", () => {
	// 点在屏幕上的消息是最常见的情况。此时取页只是白读 13-26MB（200 轮），
	// 还会把这 200 轮塞进历史前缀，改变用户回到顶部时看到的东西。
	const { ports, calls } = makePorts();
	const started = useJumpPageFetch(ports)(pending("e-target"), "owner-A", true);
	assert.equal(started, false, "目标已加载时不该发起取页");
	assert.equal(calls.read.length, 0, "不该发出 IPC");
	// 目标未加载时照旧取页（同一条用例守两个方向，避免「永远不取」也能绿）
	const second = makePorts();
	assert.equal(useJumpPageFetch(second.ports)(pending("e-target"), "owner-A", false), true);
	assert.equal(second.calls.read.length, 1);
});

test("已有历史前缀时也要能落地：prepend 被守卫拒掉后清前缀重试一次", async () => {
	// prependSessionHistoryPageAtom 的守卫是 current.history.nextBefore !== input.before。
	// 一次取页传 before: undefined，所以只要用户之前翻过页（history 存在），这次 prepend
	// 必被拒——页白读，目标仍不在数据里，最后报「未能跳转」。
	// 处置：被拒后清掉旧前缀再试一次（旧前缀对「跳到别处」本来就没用）。
	const { ports, calls } = makePorts({ prependResult: false });
	useJumpPageFetch(ports)(pending("e-target"), "owner-A", false);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(calls.clear.length, 1, "prepend 被拒后必须清一次旧前缀");
	assert.equal(calls.prepend.length, 2, "清完要重试一次 prepend，总共两次");
});

test("prepend 一次成功时不清前缀：别把用户翻出来的历史白白丢掉", async () => {
	const { ports, calls } = makePorts();
	useJumpPageFetch(ports)(pending("e-target"), "owner-A", false);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(calls.prepend.length, 1);
	assert.equal(calls.clear.length, 0, "第一次就成功时不该清");
});
