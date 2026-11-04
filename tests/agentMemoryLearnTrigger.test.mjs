/** 结算触发走真实三后端会话文件与索引；补全是假模型，不联网、不产生费用。 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as db from "../resources/agent-memory/db.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const stubs = { "../../../resources/agent-memory/db.mjs": db, "./db.mjs": db };
const { runLearnerForAgent } = loadTsCommonJs("src/main/agentMemory/agentMemoryLearner.ts", { stubs });
const { readLearnState } = loadTsCommonJs("src/main/agentMemory/autoLearn.ts");

function fixture(t, backend) {
	const base = mkdtempSync(join(tmpdir(), "pideck-learn-trigger-"));
	const root = join(base, "memory");
	const dir = join(base, "sessions", "workspace", "runtime");
	mkdirSync(root, { recursive: true });
	mkdirSync(dir, { recursive: true });
	t.after(() => {
		db.closeDatabase(root);
		rmSync(base, { recursive: true, force: true });
	});
	const sessionId = `runtime-${backend}`;
	const tab = { backend, sessionId, deckSessionId: `catalog-${backend}`, projectId: "project-alpha" };
	return {
		root,
		tab,
		sources: [{ backend, dir: join(base, "sessions"), project: "project-alpha" }],
		writeTurns(turns) {
			const messages = Array.from({ length: turns * 2 }, (_, index) => ({
				id: `message-${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `第 ${Math.floor(index / 2) + 1} 轮项目约定`,
				timestamp: 1767225600000 + index,
			}));
			if (backend === "acp") {
				writeFileSync(join(dir, "archive.json"), JSON.stringify({ acpSessionId: sessionId, messages, updatedAt: 1767225700000 }));
				return;
			}
			const header = { type: "session", id: sessionId, cwd: "/project-alpha", timestamp: "2026-01-01T00:00:00.000Z" };
			const events = messages.map((message, index) =>
				backend === "pi" ? { type: "message", id: message.id, message: { role: message.role, content: message.text } } : { type: `${message.role}/message`, seq: index + 1, data: message.role === "user" ? { content: message.text, source: { kind: "user" } } : { message: { content: message.text } } },
			);
			writeFileSync(join(dir, "session.jsonl"), [header, ...events].map((event) => JSON.stringify(event)).join("\n"));
		},
	};
}

for (const backend of ["pi", "acp", "dsh"]) {
	test(`${backend} 结算：按后端 ID 索引、catalog ID 选模型，每新增 12 轮学习且失败可重试`, async (t) => {
		const { root, tab, sources, writeTurns } = fixture(t, backend);
		const calls = [];
		const deps = {
			root,
			sources,
			complete: async (catalogId, input) => {
				calls.push({ catalogId, input });
				if (calls.length === 1) throw new Error("fake-model-timeout");
				return "[]";
			},
		};
		writeTurns(11);
		assert.equal((await runLearnerForAgent(deps, tab)).skipped, "below-threshold");
		assert.equal(calls.length, 0);

		writeTurns(12);
		const failed = await runLearnerForAgent(deps, tab);
		assert.equal(failed.error, "fake-model-timeout", "达到 12 轮必须真正触达假模型，而不是查错会话后静默跳过");
		const indexedId = backend === "pi" ? tab.sessionId : `${backend}:${tab.sessionId}`;
		assert.equal(readLearnState(root).sessions[indexedId], undefined, "失败不得推进水位");

		const learned = await runLearnerForAgent(deps, tab);
		assert.equal(learned.ran, true);
		assert.equal(learned.userTurns, 12);
		assert.equal((await runLearnerForAgent(deps, tab)).skipped, "below-threshold", "重复结算不重复计费");
		writeTurns(23);
		assert.equal((await runLearnerForAgent(deps, tab)).skipped, "below-threshold");
		writeTurns(24);
		assert.equal((await runLearnerForAgent(deps, tab)).ran, true, "同一会话再新增 12 轮还应学习");
		assert.equal(calls.length, 3, "一次失败重试、两次成功，除此之外不调用");
		assert.ok(
			calls.every((call) => call.catalogId === tab.deckSessionId),
			"模型回退查找仍必须使用 catalog ID",
		);
		assert.ok(calls[0].input.text.includes("第 12 轮项目约定"));
		const state = readLearnState(root);
		assert.equal(state.sessions[indexedId].learnedTurns, 24, "水位按整份会话计数，不受最近 40 条消息限制");
		assert.equal(state.sessions[tab.deckSessionId], undefined, "不能把 catalog ID 混入索引水位");
	});
}

test("缺失后端会话 ID 或不支持的后端不得误用 catalog ID 学习", async (t) => {
	const { root, tab, sources, writeTurns } = fixture(t, "pi");
	writeTurns(12);
	let calls = 0;
	const deps = {
		root,
		sources,
		complete: async () => {
			calls += 1;
			return "[]";
		},
	};
	for (const incomplete of [
		{ ...tab, sessionId: undefined },
		{ ...tab, deckSessionId: undefined },
		{ ...tab, backend: "imagegen" },
	]) {
		assert.equal((await runLearnerForAgent(deps, incomplete)).skipped, "no-session");
	}
	assert.equal(calls, 0);
	assert.equal((await runLearnerForAgent(deps, { ...tab, backend: undefined })).ran, true, "缺省后端仍为 pi");
	assert.equal(calls, 1);
});
