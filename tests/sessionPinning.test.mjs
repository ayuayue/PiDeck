import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadAgentListDisplay() {
	const identitySandbox = { exports: {} };
	vm.runInNewContext(transpile("src/shared/sessionIdentity.ts"), identitySandbox);
	const pillsSandbox = { exports: {} };
	vm.runInNewContext(transpile("src/renderer/src/sessionFilterPills.ts"), pillsSandbox);
	const sandbox = {
		exports: {},
		require: (specifier) => {
			if (specifier === "../../shared/sessionIdentity") return identitySandbox.exports;
			if (specifier === "./sessionFilterPills") return pillsSandbox.exports;
			throw new Error(`Unexpected import: ${specifier}`);
		},
	};
	vm.runInNewContext(transpile("src/renderer/src/agentListDisplay.ts"), sandbox);
	return sandbox.exports;
}

function loadPinnedSettingsPolicy() {
	const sandbox = { exports: {} };
	vm.runInNewContext(transpile("src/shared/pinnedSessions.ts"), sandbox);
	return sandbox.exports;
}

function session(id, updatedAt) {
	return {
		id,
		name: id,
		filePath: `C:/sessions/${id}.jsonl`,
		preview: "",
		updatedAt,
		messageCount: 1,
		source: "pi",
		environment: "native",
	};
}

function childSessionIds(display) {
	return display.children.map((child) =>
		child.type === "session" ? child.session.id : `agent:${child.agent.id}`,
	);
}

test("pinned sessions lead only their project list while both partitions keep time order", () => {
	const { getProjectAgentSessionDisplay } = loadAgentListDisplay();
	const display = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [
			session("new-unpinned", 40),
			session("older-pinned", 10),
			session("newer-pinned", 20),
			session("old-unpinned", 5),
		],
		pinnedSessionIds: new Set(["older-pinned", "newer-pinned"]),
		visibleChildCount: 3,
	});

	assert.deepEqual(Array.from(childSessionIds(display)), [
		"newer-pinned",
		"older-pinned",
		"new-unpinned",
		"old-unpinned",
	]);
	assert.deepEqual(
		Array.from(display.visibleChildren, (child) => child.type === "session" && child.session.id),
		["newer-pinned", "older-pinned", "new-unpinned"],
	);
});

test("a pinned catalog session stays pinned when decorated by a running agent", () => {
	const { getProjectAgentSessionDisplay } = loadAgentListDisplay();
	const pinned = session("pinned-running", 1);
	const display = getProjectAgentSessionDisplay({
		agents: [{
			id: "runtime-1",
			projectId: "project-a",
			cwd: "C:/project-a",
			title: "Running",
			status: "running",
			sessionPath: pinned.filePath,
			createdAt: 100,
		}],
		sessions: [session("new-history", 50), pinned],
		pinnedSessionIds: new Set([pinned.id]),
		visibleChildCount: 5,
	});

	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].session.id, pinned.id);
	assert.equal(display.children[0].agent.id, "runtime-1");
});

test("unknown persisted ids are ignored without changing chronological order", () => {
	const { getProjectAgentSessionDisplay } = loadAgentListDisplay();
	const display = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [session("older", 1), session("newer", 2)],
		pinnedSessionIds: new Set(["deleted-session"]),
	});
	assert.deepEqual(Array.from(childSessionIds(display)), ["newer", "older"]);
});

test("persisted pin ids drop invalid values and duplicates", () => {
	const { normalizePinnedSessionIds } = loadPinnedSettingsPolicy();
	assert.deepEqual(
		Array.from(normalizePinnedSessionIds([" session-a ", "", null, "session-a", "session-b", 7])),
		["session-a", "session-b"],
	);
	assert.deepEqual(Array.from(normalizePinnedSessionIds("session-a")), []);
});
