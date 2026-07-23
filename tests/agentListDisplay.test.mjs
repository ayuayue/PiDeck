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
		source: "codex",
		...overrides,
	};
}

test("sidebar highlight follows only the session currently displayed in the conversation window", () => {
	const { isSidebarSessionRowActive } = loadModule();
	const parentPath = "C:\\sessions\\parent.jsonl";
	const childPath = "C:\\sessions\\parent\\run\\session.jsonl";

	assert.equal(isSidebarSessionRowActive({
		rowSessionPath: childPath,
		displayedSessionPath: childPath.toLowerCase().replaceAll("\\", "/"),
		rowAgentId: "child-agent",
		activeAgentId: "child-agent",
	}), true);
	assert.equal(isSidebarSessionRowActive({
		rowSessionPath: parentPath,
		displayedSessionPath: childPath,
		rowAgentId: "parent-agent",
		activeAgentId: "parent-agent",
	}), false);
	assert.equal(isSidebarSessionRowActive({
		rowSessionPath: childPath,
		displayedSessionPath: parentPath,
		rowAgentId: "child-agent",
		activeAgentId: "child-agent",
	}), false);
	assert.equal(isSidebarSessionRowActive({
		rowAgentId: "new-agent",
		activeAgentId: "new-agent",
	}), true);
});

test("viewer handoff only bridges the matching historical session", () => {
	const { getSessionViewerHandoffState } = loadModule();
	const viewerSessionPath = "C:\\Users\\Dev\\.pi\\agent\\sessions\\old.jsonl";
	const assertState = (input, expected) => {
		const actual = getSessionViewerHandoffState(input);
		// transpiled module runs in a vm realm, so compare scalar fields instead of object prototypes.
		assert.equal(actual.isViewerActive, expected.isViewerActive);
		assert.equal(actual.canBridgeMessages, expected.canBridgeMessages);
	};

	assertState(
		{ viewerSessionPath, activeAgentPending: false },
		{ isViewerActive: true, canBridgeMessages: true },
	);
	assertState(
		{
			viewerSessionPath,
			activeAgentId: "pending-new",
			activeAgentPending: true,
		},
		{ isViewerActive: false, canBridgeMessages: false },
	);
	assertState(
		{
			viewerSessionPath,
			activeAgentId: "pending-resume",
			activeAgentSessionPath: "c:/users/dev/.pi/agent/sessions/old.jsonl",
			activeAgentPending: true,
		},
		{ isViewerActive: true, canBridgeMessages: true },
	);
	assertState(
		{
			viewerSessionPath,
			activeAgentId: "agent-new",
			activeAgentSessionPath: "C:\\Users\\Dev\\.pi\\agent\\sessions\\new.jsonl",
			activeAgentPending: false,
		},
		{ isViewerActive: false, canBridgeMessages: false },
	);
	assertState(
		{
			viewerSessionPath,
			activeAgentId: "agent-resume",
			activeAgentSessionPath: "C:\\Users\\Dev\\.pi\\agent\\sessions\\old.jsonl",
			activeAgentPending: false,
		},
		{ isViewerActive: false, canBridgeMessages: true },
	);
});

test("groups imported Codex subagent sessions under their parent session", () => {
	const { getProjectAgentSessionDisplay } = loadModule();

	const display = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [
			session({
				filePath: "/sessions/codex_parent.jsonl",
				name: "Parent",
				updatedAt: 10,
				codexThreadSource: "user",
			}),
			session({
				filePath: "/sessions/codex_child.jsonl",
				name: "Reviewer",
				updatedAt: 12,
				codexThreadSource: "subagent",
				codexParentThreadId: "parent-thread",
			}),
		].map((item, index) =>
			index === 0 ? { ...item, id: "parent-thread" } : item,
		),
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].session.name, "Parent");
	assert.equal(display.children[0].codexSubagents.length, 1);
	assert.equal(display.children[0].codexSubagents[0].name, "Reviewer");
});

test("groups Pi child sessions under a parent using normalized paths", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const parentPath = "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent.jsonl";
	const display = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [
			session({ filePath: parentPath, name: "Parent", source: "pi", updatedAt: 10 }),
			session({
				filePath: "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent\\run\\run-0\\session.jsonl",
				name: "Worker",
				source: "pi",
				updatedAt: 12,
				parentSessionPath: "c:/users/dev/.pi/agent/sessions/parent.jsonl",
			}),
		],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].piSubagents.length, 1);
	assert.equal(display.children[0].piSubagents[0].name, "Worker");
});

test("keeps a started Pi child session nested under its parent without a duplicate top-level agent", () => {
	const { getAgentForSessionPath, getProjectAgentSessionDisplay } = loadModule();
	const parentPath = "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent.jsonl";
	const childPath = "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent\\run\\run-0\\session.jsonl";
	const childSession = session({
		filePath: childPath,
		name: "Worker",
		source: "pi",
		updatedAt: 12,
		parentSessionPath: parentPath,
	});
	const pendingChildAgent = {
		id: "pending-child",
		projectId: "p1",
		cwd: "C:\\project",
		title: "Worker",
		status: "starting",
		sessionPath: childPath.toLowerCase().replaceAll("\\", "/"),
		createdAt: 20,
	};
	const display = getProjectAgentSessionDisplay({
		agents: [pendingChildAgent],
		sessions: [
			session({ filePath: parentPath, name: "Parent", source: "pi", updatedAt: 10 }),
			childSession,
		],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].session.name, "Parent");
	assert.equal(display.children[0].piSubagents.length, 1);
	assert.equal(getAgentForSessionPath([pendingChildAgent], childSession.filePath).id, "pending-child");
});

test("does not duplicate an orphan Pi child when its Agent is already the top-level fallback", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const childPath = "/sessions/missing-parent/run/run-0/session.jsonl";
	const display = getProjectAgentSessionDisplay({
		agents: [{
			id: "agent-child",
			projectId: "p1",
			cwd: "/project",
			title: "Worker",
			status: "running",
			sessionPath: childPath,
			createdAt: 20,
		}],
		sessions: [session({
			filePath: childPath,
			name: "Worker",
			source: "pi",
			updatedAt: 12,
			parentSessionPath: "/sessions/missing-parent.jsonl",
		})],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "agent");
});

test("groups Pi child sessions under an agent whose linked session was filtered out", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const parentPath = "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent.jsonl";
	const agent = {
		id: "agent-1",
		projectId: "p1",
		title: "Parent Agent",
		status: "running",
		sessionPath: parentPath,
		createdAt: 10,
	};
	const display = getProjectAgentSessionDisplay({
		agents: [agent],
		sessions: [
			// 父 sessions 列表不包含父文件（模拟被 Agent 激活后滤掉）
			session({
				filePath: "C:\\Users\\Dev\\.pi\\agent\\sessions\\parent\\run\\run-0\\session.jsonl",
				name: "Worker",
				source: "pi",
				updatedAt: 12,
				parentSessionPath: "c:/users/dev/.pi/agent/sessions/parent.jsonl",
			}),
		],
		visibleChildCount: 5,
	});

	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "agent");
	assert.equal(display.children[0].piSubagents.length, 1);
	assert.equal(display.children[0].piSubagents[0].name, "Worker");
});
