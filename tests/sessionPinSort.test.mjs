import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const source = readFileSync("src/renderer/src/agentListDisplay.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, {
		filename: "agentListDisplay.ts",
	});
	return sandbox.exports;
}

function session(overrides) {
	return {
		id: overrides.filePath,
		filePath: overrides.filePath,
		preview: "",
		updatedAt: overrides.updatedAt ?? 1,
		messageCount: 1,
		source: "pi",
		...overrides,
	};
}

test("sortSessionsPinnedFirst puts pinned sessions first regardless of recency", () => {
	const { sortSessionsPinnedFirst } = loadModule();
	const old = session({ filePath: "/a/old.jsonl", updatedAt: 100 });
	const pinned = session({ filePath: "/a/pinned.jsonl", updatedAt: 10 });
	const newest = session({ filePath: "/a/newest.jsonl", updatedAt: 200 });
	const keys = new Set(["/a/pinned.jsonl"]);

	const sorted = sortSessionsPinnedFirst([old, newest, pinned], keys);
	assert.deepEqual(
		Array.from(sorted).map((s) => s.filePath),
		["/a/pinned.jsonl", "/a/newest.jsonl", "/a/old.jsonl"],
	);
});

test("sortSessionsPinnedFirst matches pinned paths case-insensitively and across separators", () => {
	const { sortSessionsPinnedFirst } = loadModule();
	const a = session({ filePath: "C:\\Users\\Dev\\.pi\\sessions\\S.jsonl", updatedAt: 10 });
	const b = session({ filePath: "C:\\Users\\Dev\\.pi\\sessions\\T.jsonl", updatedAt: 20 });
	// 存储时是反斜杠路径，比较时用小写正斜杠形式仍应命中
	const keys = new Set(["c:/users/dev/.pi/sessions/s.jsonl"]);

	const sorted = sortSessionsPinnedFirst([a, b], keys);
	assert.deepEqual(
		Array.from(sorted).map((s) => s.filePath),
		["C:\\Users\\Dev\\.pi\\sessions\\S.jsonl", "C:\\Users\\Dev\\.pi\\sessions\\T.jsonl"],
	);
});

test("sortSessionsPinnedFirst keeps updatedAt order when nothing is pinned", () => {
	const { sortSessionsPinnedFirst } = loadModule();
	const a = session({ filePath: "/a/old.jsonl", updatedAt: 10 });
	const b = session({ filePath: "/a/new.jsonl", updatedAt: 20 });
	const sorted = sortSessionsPinnedFirst([a, b], undefined);
	assert.deepEqual(
		Array.from(sorted).map((s) => s.filePath),
		["/a/new.jsonl", "/a/old.jsonl"],
	);
});

test("getProjectAgentSessionDisplay ranks pinned sessions above newer unpinned ones", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const pinnedOld = session({ filePath: "/p/pinned.jsonl", updatedAt: 5 });
	const fresh = session({ filePath: "/p/fresh.jsonl", updatedAt: 999 });
	const keys = new Set(["/p/pinned.jsonl"]);

	const display = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [fresh, pinnedOld],
		visibleChildCount: 10,
		pinnedSessionKeys: keys,
	});
	assert.deepEqual(
		Array.from(display.visibleChildren).map((c) => c.session.filePath),
		["/p/pinned.jsonl", "/p/fresh.jsonl"],
	);
	assert.equal(display.visibleChildren[0].pinned, true);
	assert.equal(display.visibleChildren[1].pinned, false);
});

test("agent rows linked to a pinned session stay pinned", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const pinnedOld = session({ filePath: "/p/pinned.jsonl", updatedAt: 5 });
	const fresh = session({ filePath: "/p/fresh.jsonl", updatedAt: 999 });
	const keys = new Set(["/p/pinned.jsonl"]);

	// pinned 会话已激活为 Agent：会话不再出现在 sessions 列表，只由 agent.sessionPath 关联
	const display = getProjectAgentSessionDisplay({
		agents: [
			{
				id: "agent-1",
				title: "Agent",
				projectId: "p",
				status: "running",
				createdAt: 100,
				sessionPath: "/p/pinned.jsonl",
				toolCalls: [],
				lastActiveAt: 100,
			},
		],
		sessions: [fresh],
		visibleChildCount: 10,
		pinnedSessionKeys: keys,
	});
	assert.equal(display.visibleChildren[0].type, "agent");
	assert.equal(display.visibleChildren[0].pinned, true);
});
