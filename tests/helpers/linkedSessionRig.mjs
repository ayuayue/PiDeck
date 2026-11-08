import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * 关联会话单测共用的装配：真实的 LinkedSessionStore / LinkedSessionService，依赖全部用内存桩。
 * linkedSessionStore.test.mjs 与 linkedSessionReview.test.mjs 共用，保证两处驱动回合的方式一致。
 */

export const { LinkedSessionStore, clipReport } = loadTsCommonJs("src/main/linkedSessions/LinkedSessionStore.ts");
export const { LinkedSessionService, lastAssistantTextSince } = loadTsCommonJs("src/main/linkedSessions/LinkedSessionService.ts");
export const { LINKED_SESSION_MAX_AUTO_CONTINUE } = loadTsCommonJs("src/shared/types/linkedSessions.ts");

export const plain = (value) => JSON.parse(JSON.stringify(value));

export const DEFAULT_TEXT = "完成了：改了 a.ts，测试 3/3 通过。";

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function makeRig({ liveParents = new Set(["parent"]) } = {}) {
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
	/** 会话 id -> 运行时消息列表：回报只能从回合开始时的条数之后取 assistant 文本。 */
	const messages = new Map();
	/** 对这些会话的投递一律被拒绝（模拟 tab 处于 error）。 */
	const rejectFor = new Set();
	const discarded = [];
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
			return rejectFor.has(input.sessionId) ? { accepted: false, error: "tab-in-error" } : { accepted: true };
		},
		hasLiveRuntime: (id) => liveParents.has(id) || id.startsWith("child-"),
		getMessageCount: (id) => (messages.get(id) ?? []).length,
		getAssistantTextSince: (id, from) => lastAssistantTextSince(messages.get(id) ?? [], from),
		discardDraft: async (id) => {
			discarded.push(id);
		},
	});
	return { store, service, sent, sessions, messages, rejectFor, discarded };
}

export function emit(service, sessionId, sourceChannel, payload) {
	service.observeRuntimeEvent({ sessionId, agentId: "a", runtimeGeneration: 1, sourceChannel, payload });
}

/**
 * 驱动一个子会话跑完一轮：runtime-state 开始 -> （本轮产出 assistant 文本）-> agents:state 终态。
 * text 为 null 表示纯工具轮 / 被中断：本轮没有任何 assistant 文本。
 */
export function runTurn(rig, sessionId, { fail = false, text = DEFAULT_TEXT } = {}) {
	emit(rig.service, sessionId, "agents:runtime-state", { state: { isTurnActive: true } });
	if (text !== null) {
		const list = rig.messages.get(sessionId) ?? [];
		list.push({ role: "assistant", text });
		rig.messages.set(sessionId, list);
	}
	emit(rig.service, sessionId, "agents:state", fail ? { status: "error", error: "boom" } : { status: "idle" });
}

export async function startOne(rig) {
	await rig.service.handle("agent-parent", { op: "start", title: "子任务", prompt: "做事", initiation: "user_asked" });
	rig.sent.length = 0;
}
