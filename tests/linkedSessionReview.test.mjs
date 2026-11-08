import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LINKED_SESSION_MAX_AUTO_CONTINUE, LinkedSessionService, LinkedSessionStore, emit, flush, lastAssistantTextSince, makeRig, plain, runTurn, startOne } from "./helpers/linkedSessionRig.mjs";

/**
 * PR 审查 B1-B4 与次要项的回归。每条用例在修复前都复现过原问题（见各用例的断言说明）。
 */

test("B1：本轮没有文本（纯工具轮 / 被中断）不会把上一轮的结论再报一次", async () => {
	const rig = makeRig();
	await startOne(rig);
	runTurn(rig, "child-1", { text: "第一轮结论：A 方案可行。" });
	await flush();
	await flush();
	assert.match(rig.sent[0].message, /第一轮结论/);
	rig.sent.length = 0;
	runTurn(rig, "child-1", { text: null });
	await flush();
	await flush();
	assert.equal(rig.sent.length, 1, "这一轮结束了，照常通知父会话");
	assert.doesNotMatch(rig.sent[0].message, /第一轮结论/);
	assert.doesNotMatch(rig.sent[0].agentMessage, /第一轮结论/);
	assert.match(rig.sent[0].agentMessage, /\(没有文本回复\)/);
	const link = rig.store.getLink("child-1");
	assert.equal(link.turnCount, 2);
	assert.match(link.lastReport, /第一轮结论/, "lastReport 仍是最近一次有文本的回报，无文本轮次不推进 lastReportAt");
});

test("B1：回合内产出多条 assistant 文本取最后一条；基线之前的消息不算", async () => {
	const rig = makeRig();
	await startOne(rig);
	rig.messages.set("child-1", [{ role: "assistant", text: "旧消息" }]);
	emit(rig.service, "child-1", "agents:runtime-state", { state: { isTurnActive: true } });
	rig.messages.get("child-1").push({ role: "assistant", text: "中间说明" }, { role: "assistant", text: "" }, { role: "assistant", text: "最终结论" });
	emit(rig.service, "child-1", "agents:state", { status: "idle" });
	await flush();
	await flush();
	assert.match(rig.sent[0].message, /最终结论/);
	assert.doesNotMatch(rig.sent[0].message, /旧消息|中间说明/);
});

test("B1：没观察到回合开始就收到终态（失败）：不取文本，只报错误", async () => {
	const rig = makeRig();
	await startOne(rig);
	rig.messages.set("child-1", [{ role: "assistant", text: "更早的结论" }]);
	emit(rig.service, "child-1", "agents:state", { status: "error", error: "启动失败" });
	await flush();
	await flush();
	assert.match(rig.sent[0].message, /启动失败/);
	assert.doesNotMatch(rig.sent[0].message, /更早的结论/);
});

test("B1：lastAssistantTextSince 在消息列表被压缩（比基线还短）时整张列表都算本轮", () => {
	const messages = [{ role: "assistant", text: "压缩后的摘要" }];
	assert.equal(lastAssistantTextSince(messages, 9), "压缩后的摘要");
	assert.equal(lastAssistantTextSince(messages, 1), "");
	assert.equal(lastAssistantTextSince([{ role: "user", text: "x" }], 0), "");
});

test("B2：被父会话拒绝的投递不占自动续跑额度", async () => {
	const rig = makeRig();
	await startOne(rig);
	rig.rejectFor.add("parent");
	for (let index = 0; index < LINKED_SESSION_MAX_AUTO_CONTINUE * 2; index += 1) {
		runTurn(rig, "child-1");
		await flush();
		await flush();
	}
	assert.equal(rig.sent.length, LINKED_SESSION_MAX_AUTO_CONTINUE * 2, "每次都试着投递过，且都被拒");
	rig.rejectFor.delete("parent");
	rig.sent.length = 0;
	runTurn(rig, "child-1");
	await flush();
	await flush();
	assert.equal(rig.sent.length, 1, "父会话恢复后第一条回报照常送达，没有被空烧的额度挡住");
});

test("B2：send 抛异常同样退还额度，不产生 unhandledRejection", async () => {
	const rig = makeRig();
	await startOne(rig);
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const originalSend = rig.service.deps.send;
		rig.service.deps.send = async () => {
			throw new Error("coordinator exploded");
		};
		for (let index = 0; index < LINKED_SESSION_MAX_AUTO_CONTINUE + 1; index += 1) {
			runTurn(rig, "child-1");
			await flush();
			await flush();
		}
		rig.service.deps.send = originalSend;
		runTurn(rig, "child-1");
		await flush();
		await flush();
		assert.equal(rig.sent.length, 1, "额度没有被抛异常的投递耗光");
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	assert.equal(unhandled.length, 0);
});

test("B2：任何入口的非回报消息都清零额度，回报 / 转发自己的消息不清零", async () => {
	const rig = makeRig();
	await startOne(rig);
	for (let index = 0; index < LINKED_SESSION_MAX_AUTO_CONTINUE; index += 1) {
		runTurn(rig, "child-1");
		await flush();
		await flush();
	}
	assert.equal(rig.sent.length, LINKED_SESSION_MAX_AUTO_CONTINUE);
	// 服务自己的回报 / 转发 id 带 linked- 前缀：不算用户输入
	rig.service.noteOutgoingPrompt({ sessionId: "parent", requestId: LinkedSessionService.newRequestId() });
	rig.sent.length = 0;
	runTurn(rig, "child-1");
	await flush();
	await flush();
	assert.equal(rig.sent.length, 0, "额度仍然用完");
	// Web 端 / 飞书 / 自动化的 requestId 都不带前缀
	for (const requestId of ["web-1", "feishu-uuid", "automation-run-3"]) {
		rig.service.noteOutgoingPrompt({ sessionId: "parent", requestId });
		rig.sent.length = 0;
		runTurn(rig, "child-1");
		await flush();
		await flush();
		assert.equal(rig.sent.length, 1, `${requestId} 之后额度已清零`);
		// 把额度重新用完，下一轮循环再验证
		for (let index = 1; index < LINKED_SESSION_MAX_AUTO_CONTINUE; index += 1) {
			runTurn(rig, "child-1");
			await flush();
			await flush();
		}
	}
});

test("B3：error 状态下的 agents:state 整包快照重复到达，同一次失败只报一次；新一轮开始后再失败照报", async () => {
	const rig = makeRig();
	await startOne(rig);
	emit(rig.service, "child-1", "agents:runtime-state", { state: { isTurnActive: true } });
	for (let index = 0; index < 6; index += 1) emit(rig.service, "child-1", "agents:state", { status: "error", error: "boom" });
	await flush();
	await flush();
	assert.equal(rig.sent.length, 1, "1 次失败 + 5 次快照 = 1 条回报");
	assert.equal(rig.store.getLink("child-1").turnCount, 1);
	// 没有新回合开始的 closed 快照也不再报
	emit(rig.service, "child-1", "agents:state", { status: "closed" });
	await flush();
	await flush();
	assert.equal(rig.sent.length, 1);
	assert.equal(rig.store.getLink("child-1").state, "stopped");
	// 用户重启子会话后又跑了一轮并失败：这是新的一次失败
	emit(rig.service, "child-1", "agents:state", { status: "running" });
	emit(rig.service, "child-1", "agents:state", { status: "error", error: "boom2" });
	emit(rig.service, "child-1", "agents:state", { status: "error", error: "boom2" });
	await flush();
	await flush();
	assert.equal(rig.sent.length, 2);
	assert.match(rig.sent[1].message, /boom2/);
	assert.equal(rig.store.getLink("child-1").turnCount, 2);
});

test("B3：运行中进程退出（closed）也只报一次", async () => {
	const rig = makeRig();
	await startOne(rig);
	emit(rig.service, "child-1", "agents:runtime-state", { state: { isTurnActive: true } });
	for (let index = 0; index < 4; index += 1) emit(rig.service, "child-1", "agents:state", { status: "closed" });
	await flush();
	await flush();
	assert.equal(rig.sent.length, 1);
	assert.match(rig.sent[0].message, /退出/);
});

test("B4：会话行消失（catalog 集中回调）清掉关系；它作父会话挂着的提议一并清掉，批量只写一次", async () => {
	const rig = makeRig();
	await rig.service.handle("agent-parent", { op: "start", title: "后续", prompt: "做事", initiation: "own_initiative" });
	await rig.service.handle("agent-parent", { op: "start", title: "子一", prompt: "做事", initiation: "user_asked" });
	await rig.service.handle("agent-parent", { op: "start", title: "子二", prompt: "做事", initiation: "user_asked" });
	let changes = 0;
	rig.store.onChanged(() => {
		changes += 1;
	});
	await rig.service.noteSessionsRemoved(["parent", "child-1", "child-2"]);
	assert.equal(changes, 1);
	assert.deepEqual(plain(rig.store.snapshot()), { links: [], proposals: [] });
});

test("B4：归档的子会话恢复出来是新 id——旧关系清除而不是变孤儿，旧 id 不再回报", async () => {
	const rig = makeRig();
	await startOne(rig);
	await rig.service.noteSessionsRemoved(["child-1"]);
	assert.equal(rig.store.getLink("child-1"), undefined);
	runTurn(rig, "child-1");
	await flush();
	await flush();
	assert.equal(rig.sent.length, 0);
	const listed = await rig.service.handle("agent-parent", { op: "list" });
	assert.equal(listed.data.children.length, 0, "list_linked_sessions 不再报死会话");
});

test("次要：首条 prompt 被拒——不留 failed 子会话，own_initiative 卡片回到 pending 能再点", async () => {
	const rig = makeRig();
	const proposed = await rig.service.handle("agent-parent", { op: "start", title: "清理", prompt: "删掉死代码", initiation: "own_initiative" });
	rig.rejectFor.add("child-1");
	const first = await rig.service.answerProposal({ proposalId: proposed.data.proposalId, answer: "new" });
	assert.deepEqual(plain(first), { ok: false, error: "tab-in-error" });
	assert.equal(rig.store.snapshot().links.length, 0, "没有 failed 子会话残留");
	assert.deepEqual(plain(rig.discarded), ["child-1"], "空草稿被撤掉");
	assert.equal(rig.store.getProposal(proposed.data.proposalId).status, "pending");
	rig.rejectFor.clear();
	const second = await rig.service.answerProposal({ proposalId: proposed.data.proposalId, answer: "new" });
	assert.equal(second.ok, true, "不会永远 proposal-settled");
	assert.equal(rig.store.getProposal(proposed.data.proposalId).status, "started");
});

test("次要：offer 的首条 prompt 被拒——工具调用拿到错误，卡片收口为 expired", async () => {
	const rig = makeRig();
	const pending = rig.service.handle("agent-parent", { op: "start", title: "补测试", prompt: "给 a.ts 补单测", initiation: "offer" });
	await flush();
	const proposal = rig.store.snapshot().proposals[0];
	rig.rejectFor.add("child-1");
	await rig.service.answerProposal({ proposalId: proposal.id, answer: "new" });
	const result = await pending;
	assert.deepEqual(plain(result), { ok: false, error: "tab-in-error" });
	assert.equal(rig.store.getProposal(proposal.id).status, "expired");
	assert.equal(rig.store.snapshot().links.length, 0);
});

test("次要：load 与启动期的写操作不再竞态——磁盘上的旧关系与启动期新写的关系都在", async () => {
	const dir = mkdtempSync(join(tmpdir(), "linked-sessions-race-"));
	try {
		const file = join(dir, "linked-sessions.json");
		const seed = new LinkedSessionStore(file);
		await seed.load();
		await seed.addLink({ childSessionId: "old", parentSessionId: "p", projectId: "proj", title: "旧" });
		const store = new LinkedSessionStore(file);
		const loading = store.load();
		const writing = store.addLink({ childSessionId: "new", parentSessionId: "p", projectId: "proj", title: "新" });
		await Promise.all([loading, writing]);
		assert.deepEqual(
			plain(
				store
					.snapshot()
					.links.map((link) => link.childSessionId)
					.sort(),
			),
			["new", "old"],
		);
		const reread = new LinkedSessionStore(file);
		await reread.load();
		assert.deepEqual(
			plain(
				reread
					.snapshot()
					.links.map((link) => link.childSessionId)
					.sort(),
			),
			["new", "old"],
			"磁盘上也是两条",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("次要：落盘失败不产生 unhandledRejection，侧栏仍收到变化通知，回报照发", async () => {
	const dir = mkdtempSync(join(tmpdir(), "linked-sessions-fail-"));
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const rig = makeRig();
		await startOne(rig);
		// 换成一个写不进去的路径（目录不存在）：persist 必然失败
		const broken = new LinkedSessionStore(join(dir, "missing-dir", "linked-sessions.json"));
		broken.state = rig.store.state;
		rig.service.deps.store = broken;
		let notified = 0;
		broken.onChanged(() => {
			notified += 1;
		});
		runTurn(rig, "child-1");
		await flush();
		await flush();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(notified >= 1, "侧栏收到变化");
		assert.equal(rig.sent.length, 1, "回报不因磁盘问题丢失");
		assert.equal(broken.getLink("child-1").turnCount, 1);
		// 状态类写（running / stopped）失败也只记日志
		emit(rig.service, "child-1", "agents:runtime-state", { state: { isTurnActive: true } });
		emit(rig.service, "child-1", "agents:state", { status: "closed" });
		await new Promise((resolve) => setTimeout(resolve, 20));
	} finally {
		process.off("unhandledRejection", onUnhandled);
		rmSync(dir, { recursive: true, force: true });
	}
	assert.equal(unhandled.length, 0);
});

test("次要：手动归档 / 解档子会话时父会话的自动续跑额度重新计", async () => {
	const rig = makeRig();
	await startOne(rig);
	for (let index = 0; index < LINKED_SESSION_MAX_AUTO_CONTINUE; index += 1) {
		runTurn(rig, "child-1");
		await flush();
		await flush();
	}
	rig.sent.length = 0;
	runTurn(rig, "child-1");
	await flush();
	await flush();
	assert.equal(rig.sent.length, 0, "额度用完");
	await rig.service.archive("child-1", true);
	await rig.service.archive("child-1", false);
	runTurn(rig, "child-1");
	await flush();
	await flush();
	assert.equal(rig.sent.length, 1);
});
