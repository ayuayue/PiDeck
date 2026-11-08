import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 关联会话（子对话，docs/host-boundaries.md 例外九）：关系表 + 编排服务。
 *
 * 每条断言对应一个会出事的地方：
 * - 一张卡片只能开一个会话（重复点击 / 过期后点击）；
 * - 只认 token 解析出的调用方，只能给直接关联的会话发消息；
 * - 子会话回合结束才回报，残留 idle 快照不算；
 * - 回报自动续跑有上限，用户发消息清零；父会话没运行时不拉起；
 * - 重启后不留下「永远在跑」的子会话与挂起的 offer。
 */

const { LinkedSessionStore, clipReport } = loadTsCommonJs("src/main/linkedSessions/LinkedSessionStore.ts");
const { LinkedSessionService } = loadTsCommonJs("src/main/linkedSessions/LinkedSessionService.ts");
const { LINKED_SESSION_MAX_AUTO_CONTINUE } = loadTsCommonJs("src/shared/types/linkedSessions.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

function makeRig({ liveParents = new Set(["parent"]), lastText = "完成了：改了 a.ts，测试 3/3 通过。" } = {}) {
	const store = new LinkedSessionStore(null);
	const sessions = new Map([
		["parent", { id: "parent", projectId: "p1", title: "父会话", backend: "pi", environment: "native" }],
		["other", { id: "other", projectId: "p1", title: "无关会话", backend: "pi", environment: "native" }],
	]);
	const agents = new Map([
		["agent-parent", "parent"],
		["agent-other", "other"],
	]);
	const sent = [];
	let draftSeq = 0;
	const service = new LinkedSessionService({
		store,
		getSessionIdForAgent: (agentId) => agents.get(agentId),
		getSession: (id) => sessions.get(id),
		createDraft: async ({ parent, title }) => {
			draftSeq += 1;
			const id = `child-${draftSeq}`;
			sessions.set(id, { id, projectId: parent.projectId, title, backend: "pi", environment: "native" });
			agents.set(`agent-${id}`, id);
			return { id };
		},
		send: async (input) => {
			sent.push(input);
			return { accepted: true };
		},
		hasLiveRuntime: (id) => liveParents.has(id) || id.startsWith("child-"),
		getLastAssistantText: () => lastText,
	});
	return { store, service, sent, sessions };
}

/** 驱动一个子会话跑完一轮：runtime-state 开始 → agents:state idle。 */
function runTurn(service, sessionId, { fail = false } = {}) {
	service.observeRuntimeEvent({ sessionId, agentId: "a", runtimeGeneration: 1, sourceChannel: "agents:runtime-state", payload: { state: { isTurnActive: true } } });
	service.observeRuntimeEvent({ sessionId, agentId: "a", runtimeGeneration: 1, sourceChannel: "agents:state", payload: fail ? { status: "error", error: "boom" } : { status: "idle" } });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("user_asked 立即建子会话：草稿 + 带父会话身份的简报 + 关系落表", async () => {
	const { service, sent, store } = makeRig();
	const result = await service.handle("agent-parent", { op: "start", title: "修登录页", prompt: "把 login.ts 的空指针修掉", initiation: "user_asked" });
	assert.equal(result.ok, true);
	assert.equal(result.data.status, "started");
	assert.equal(result.data.sessionId, "child-1");
	assert.equal(sent.length, 1);
	assert.equal(sent[0].sessionId, "child-1");
	assert.equal(sent[0].message, "把 login.ts 的空指针修掉", "用户可见的是简报原文");
	assert.match(sent[0].agentMessage, /session_id: parent/, "子会话要知道父会话是谁才能回发");
	const link = store.getLink("child-1");
	assert.equal(link.parentSessionId, "parent");
	assert.equal(link.state, "starting");
});

test("未绑定会话的 token 一律拒绝（调用方身份只认 token → agent → 会话）", async () => {
	const { service } = makeRig();
	const result = await service.handle("agent-unknown", { op: "list" });
	assert.deepEqual(plain(result), { ok: false, error: "session-not-bound" });
});

test("offer 挂起到用户作答；「新会话」建会话并让工具调用返回 started；重复点击无副作用", async () => {
	const { service, store } = makeRig();
	const pending = service.handle("agent-parent", { op: "start", title: "补测试", prompt: "给 a.ts 补单测", initiation: "offer", toolCallId: "tc-1" });
	await flush();
	const proposal = store.snapshot().proposals[0];
	assert.equal(proposal.status, "pending");
	assert.equal(proposal.toolCallId, "tc-1", "时间线卡片按工具调用 id 找提议");
	const first = await service.answerProposal({ proposalId: proposal.id, answer: "new" });
	const second = await service.answerProposal({ proposalId: proposal.id, answer: "new" });
	assert.equal(first.ok, true);
	assert.deepEqual(plain(second), { ok: false, error: "proposal-settled" });
	const result = await pending;
	assert.equal(result.data.status, "started");
	assert.equal(store.snapshot().links.length, 1, "两次点击只开了一个会话");
	assert.equal(store.getProposal(proposal.id).childSessionId, result.data.sessionId);
});

test("offer 选「在此做」：工具调用返回 do_here，不建会话", async () => {
	const { service, store } = makeRig();
	const pending = service.handle("agent-parent", { op: "start", title: "补测试", prompt: "给 a.ts 补单测", initiation: "offer" });
	await flush();
	const proposal = store.snapshot().proposals[0];
	await service.answerProposal({ proposalId: proposal.id, answer: "here" });
	const result = await pending;
	assert.equal(result.data.status, "do_here");
	assert.equal(store.snapshot().links.length, 0);
});

test("own_initiative 只登记卡片立即返回；之后 proposal_id 启动它；别的会话不能启动", async () => {
	const { service, store } = makeRig();
	const proposed = await service.handle("agent-parent", { op: "start", title: "清理死代码", prompt: "删掉 legacy/ 下无引用的文件", initiation: "own_initiative" });
	assert.equal(proposed.data.status, "proposed");
	assert.equal(store.snapshot().links.length, 0);
	const stolen = await service.handle("agent-other", { op: "start", proposalId: proposed.data.proposalId });
	assert.deepEqual(plain(stolen), { ok: false, error: "proposal-not-found" });
	const started = await service.handle("agent-parent", { op: "start", proposalId: proposed.data.proposalId });
	assert.equal(started.data.status, "started");
	assert.equal(store.getProposal(proposed.data.proposalId).status, "started");
});

test("own_initiative 卡片选「在此做」：把简报作为跟进消息发回父会话", async () => {
	const { service, sent, store } = makeRig();
	const proposed = await service.handle("agent-parent", { op: "start", title: "清理死代码", prompt: "删掉 legacy/", initiation: "own_initiative" });
	await service.answerProposal({ proposalId: proposed.data.proposalId, answer: "here" });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].sessionId, "parent");
	assert.equal(sent[0].streamingBehavior, "followUp");
	assert.match(sent[0].agentMessage, /删掉 legacy\//);
	assert.equal(store.snapshot().links.length, 0);
});

test("send_to_session 只允许直接关联的会话；子会话可以回发父会话", async () => {
	const { service, sent } = makeRig();
	await service.handle("agent-parent", { op: "start", title: "子任务", prompt: "做事", initiation: "user_asked" });
	sent.length = 0;
	const denied = await service.handle("agent-other", { op: "send", sessionId: "child-1", message: "插一句" });
	assert.deepEqual(plain(denied), { ok: false, error: "session-not-linked" });
	const down = await service.handle("agent-parent", { op: "send", sessionId: "child-1", message: "顺便改下 README" });
	assert.equal(down.ok, true);
	const up = await service.handle("agent-child-1", { op: "send", sessionId: "parent", message: "需要你拍板：保留旧 API 吗" });
	assert.equal(up.ok, true);
	assert.deepEqual(
		sent.map((item) => [item.sessionId, item.streamingBehavior]),
		[
			["child-1", "followUp"],
			["parent", "followUp"],
		],
	);
	assert.match(sent[1].message, /子会话/);
});

test("子会话回合结束才回报：残留 idle 快照不算一轮；回报带最终回复且以 followUp 送达父会话", async () => {
	const { service, sent, store } = makeRig();
	await service.handle("agent-parent", { op: "start", title: "子任务", prompt: "做事", initiation: "user_asked" });
	sent.length = 0;
	service.observeRuntimeEvent({ sessionId: "child-1", agentId: "a", runtimeGeneration: 1, sourceChannel: "agents:state", payload: { status: "idle" } });
	await flush();
	assert.equal(sent.length, 0, "没开始过的 idle 不是回合结束");
	runTurn(service, "child-1");
	await flush();
	await flush();
	assert.equal(sent.length, 1);
	assert.equal(sent[0].sessionId, "parent");
	assert.equal(sent[0].streamingBehavior, "followUp");
	assert.match(sent[0].message, /改了 a\.ts/);
	assert.match(sent[0].agentMessage, /<linked-session-report session_id="child-1"/);
	const link = store.getLink("child-1");
	assert.equal(link.turnCount, 1);
	assert.equal(link.state, "idle");
});

test("失败回合标 failed 并回报错误文本", async () => {
	const { service, sent, store } = makeRig({ lastText: "" });
	await service.handle("agent-parent", { op: "start", title: "子任务", prompt: "做事", initiation: "user_asked" });
	sent.length = 0;
	runTurn(service, "child-1", { fail: true });
	await flush();
	await flush();
	assert.equal(store.getLink("child-1").state, "failed");
	assert.match(sent[0].message, /失败/);
	assert.match(sent[0].message, /boom/);
});

test("防空转：连续自动续跑到上限后只记表不再发；用户在父会话发消息清零", async () => {
	const { service, sent, store } = makeRig();
	await service.handle("agent-parent", { op: "start", title: "子任务", prompt: "做事", initiation: "user_asked" });
	sent.length = 0;
	for (let index = 0; index < LINKED_SESSION_MAX_AUTO_CONTINUE + 2; index += 1) {
		runTurn(service, "child-1");
		await flush();
		await flush();
	}
	assert.equal(sent.length, LINKED_SESSION_MAX_AUTO_CONTINUE);
	assert.equal(store.getLink("child-1").turnCount, LINKED_SESSION_MAX_AUTO_CONTINUE + 2, "超限的回合照样记表，list_linked_sessions 能读到");
	service.noteUserPrompt("parent");
	runTurn(service, "child-1");
	await flush();
	await flush();
	assert.equal(sent.length, LINKED_SESSION_MAX_AUTO_CONTINUE + 1);
});

test("父会话没有活着的运行时：不为回报拉起它", async () => {
	const { service, sent } = makeRig({ liveParents: new Set() });
	await service.handle("agent-parent", { op: "start", title: "子任务", prompt: "做事", initiation: "user_asked" });
	sent.length = 0;
	runTurn(service, "child-1");
	await flush();
	await flush();
	assert.equal(sent.length, 0);
});

test("归档后的子会话不再回报；list 只列未归档", async () => {
	const { service, sent } = makeRig();
	await service.handle("agent-parent", { op: "start", title: "子任务", prompt: "做事", initiation: "user_asked" });
	await service.archive("child-1");
	sent.length = 0;
	runTurn(service, "child-1");
	await flush();
	await flush();
	assert.equal(sent.length, 0);
	const listed = await service.handle("agent-parent", { op: "list" });
	assert.equal(listed.data.children.length, 0);
});

test("会话被删 / 被归档：删父会话清掉整条关系；归档子会话只标归档、不再回报", async () => {
	const { service, store, sent } = makeRig();
	await service.handle("agent-parent", { op: "start", title: "子一", prompt: "做事", initiation: "user_asked" });
	await service.handle("agent-parent", { op: "start", title: "子二", prompt: "做事", initiation: "user_asked" });
	await service.noteSessionRemoved("child-2", "archive");
	assert.equal(store.getLink("child-2").archived, true, "归档只标记，恢复后按普通会话显示");
	sent.length = 0;
	runTurn(service, "child-2");
	await flush();
	await flush();
	assert.equal(sent.length, 0, "已归档的子会话不再回报");
	await service.noteSessionRemoved("parent", "delete");
	assert.equal(store.getLink("child-1"), undefined, "父会话被删，子会话关系一并清掉");
	assert.equal(store.getLink("child-2"), undefined);
	assert.equal(store.childrenOf("parent", true).length, 0);
});

test("落盘可重入：重启后运行中状态归为已停止、挂起的 offer 归为过期，坏条目丢弃", async () => {
	const dir = mkdtempSync(join(tmpdir(), "linked-sessions-"));
	try {
		const file = join(dir, "linked-sessions.json");
		const first = new LinkedSessionStore(file);
		await first.load();
		await first.addLink({ childSessionId: "c1", parentSessionId: "p", projectId: "proj", title: "子" });
		await first.setState("c1", "running");
		await first.addProposal({ parentSessionId: "p", projectId: "proj", title: "卡片", prompt: "简报", initiation: "offer" });
		const raw = JSON.parse(readFileSync(file, "utf8"));
		raw.links.push({ childSessionId: "bad" }, { childSessionId: "same", parentSessionId: "same", projectId: "proj" });
		writeFileSync(file, JSON.stringify(raw));
		const second = new LinkedSessionStore(file);
		await second.load();
		const snapshot = second.snapshot();
		assert.equal(snapshot.links.length, 1);
		assert.equal(snapshot.links[0].state, "stopped");
		assert.equal(snapshot.proposals[0].status, "expired");
		// 再载一次收敛到同一状态
		const third = new LinkedSessionStore(file);
		await third.load();
		assert.deepEqual(plain(third.snapshot()), plain(snapshot));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("回报截取：压空白、超长加省略号", () => {
	assert.equal(clipReport("a\n\n\n\nb"), "a\n\nb");
	const long = "字".repeat(500);
	const clipped = clipReport(long);
	assert.equal(clipped.length, 401);
	assert.ok(clipped.endsWith("…"));
});
