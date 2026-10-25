import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseDshTeamProjection } = loadTsCommonJs("src/main/dsh/dshTeamProjection.ts");
const { projectDshEvent } = loadTsCommonJs("src/main/dsh/dshEventProjector.ts");

/** loadTsCommonJs 的 vm 沙箱对象与测试域不同 realm，deepStrictEqual 会因原型不同误报；
 *  统一经 JSON 往返归一到测试域对象再断言。 */
function json(value) {
	return JSON.parse(JSON.stringify(value));
}

const AGENT = "agent-1";

/** 官方 TeamProjection 形状（lib/types/types.d.ts 的 TeamMemberProjection/TeamTaskView/TeamProjection）。 */
const officialProjection = {
	members: [
		{ id: "s-lead", name: "lead", role: "lead", phase: "active" },
		{ id: "s-mate", name: "researcher", role: "teammate", phase: "provisioning" },
		{ id: "s-dead", name: "writer", role: "teammate", phase: "failed", error: "spawn timeout" },
	],
	tasks: [
		// TeamTaskView 全字段（含 PiDeck 不消费的 revision/blockedBy/writeScopes/writeScopeWarnings）
		{ id: "t-1", revision: 3, subject: "调研数据面", description: "读 projection.d.ts", status: "in_progress", blockedBy: [], writeScopes: ["src/"], ownerName: "researcher", ready: true, writeScopeWarnings: [] },
		{ id: "t-2", revision: 1, subject: "写报告", description: "", status: "pending", blockedBy: ["t-1"], writeScopes: [], ready: false, writeScopeWarnings: [] },
	],
};

test("parses the official agentTeam projection into the normalized panel state", () => {
	const parsed = json(parseDshTeamProjection(officialProjection));
	assert.equal(parsed.members.length, 3);
	assert.deepEqual(parsed.members[2], { id: "s-dead", name: "writer", role: "teammate", phase: "failed", error: "spawn timeout" });
	assert.equal(parsed.tasks.length, 2);
	assert.deepEqual(parsed.tasks[0], { id: "t-1", subject: "调研数据面", description: "读 projection.d.ts", status: "in_progress", ownerName: "researcher", ready: true });
	assert.equal(parsed.tasks[1].ownerName, undefined, "未分配任务的 ownerName 不落键");
	assert.equal(parsed.failure, undefined);
});

test("null clears, empty collections are valid, dirty frames keep the previous value", () => {
	assert.equal(parseDshTeamProjection(null), null, "null = 显式清空");
	assert.deepEqual(json(parseDshTeamProjection({ members: [], tasks: [] })), { members: [], tasks: [] }, "空 roster + 空任务板是有效值（已启用但未 spawn）");
	assert.equal(parseDshTeamProjection(undefined), undefined, "缺帧 = 保持原值");
	assert.equal(parseDshTeamProjection("nope"), undefined, "非对象 = 脏帧");
	assert.equal(parseDshTeamProjection({ members: officialProjection.members }), undefined, "members/tasks 任一非数组 = 脏帧（不得半清）");
});

test("individual dirty rows are skipped without hiding the rest", () => {
	const parsed = json(
		parseDshTeamProjection({
			members: [{ id: "ok", name: "keep", role: "teammate", phase: "active" }, { id: "", name: "no-id", role: "teammate", phase: "active" }, { id: "bad-role", name: "x", role: "boss", phase: "active" }, "not-a-row"],
			tasks: [{ id: "t", subject: "keep", description: "", status: "pending", ready: false }, { id: "t2", subject: "", status: "pending" }, 42],
			failure: "TEAM_MAX_MEMBERS",
		}),
	);
	assert.deepEqual(parsed.members, [{ id: "ok", name: "keep", role: "teammate", phase: "active" }]);
	assert.deepEqual(parsed.tasks, [{ id: "t", subject: "keep", description: "", status: "pending", ready: false }]);
	assert.equal(parsed.failure, "TEAM_MAX_MEMBERS");
});

/** dsh-session 事件形状（seq/data/time），类型对齐现有 projector 测试。 */
function event(type, seq, data) {
	return { type, seq, data, time: 1_700_000_000_000 };
}

test("team-domain session events pass through the projector without crashing or emitting messages", () => {
	let state;
	for (const teamEvent of [
		event("team/member", 20, { member: { id: "s-mate", name: "researcher", role: "teammate", phase: "provisioning" } }),
		event("team/task", 21, { task: { id: "t-1", subject: "调研数据面", status: "pending" }, op: "created" }),
		event("team/message/queued", 22, { from: "s-lead", to: "s-mate", message: "hi" }),
		event("team/message/delivered", 23, { to: "s-mate", messageId: "m-1" }),
	]) {
		state = projectDshEvent(state, teamEvent, AGENT);
	}
	assert.equal(state.messages.length, 0, "team 域事件不产生时间线消息（Team 面板走 agentTeam 投影，不走会话流）");
	assert.equal(state.isStreaming, false);
});

test("spawn_teammate and team tools project as ordinary tool calls", () => {
	let state = projectDshEvent(undefined, event("user/message", 1, { content: [{ type: "text", text: "组个队" }], source: { kind: "user", rpcId: "rpc-1" } }), AGENT);
	state = projectDshEvent(state, event("tool/call", 2, { toolName: "spawn_teammate", callId: "c-team", arguments: '{"name":"researcher"}' }), AGENT);
	state = projectDshEvent(state, event("tool/call", 3, { toolName: "assign_task", callId: "c-task", arguments: '{"task":"t-1"}' }), AGENT);
	state = projectDshEvent(state, event("tool/call", 3, { toolName: "assign_task", callId: "c-task", arguments: '{"task":"t-1"}' }), AGENT);
	const toolMessages = state.messages.filter((message) => message.role === "tool");
	assert.equal(toolMessages.length, 2, "team 工具按普通工具卡片投影，且同 callId 只入列一次");
});
