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

function loadModule() {
	const identitySandbox = { exports: {} };
	vm.runInNewContext(transpile("src/shared/sessionIdentity.ts"), identitySandbox, {
		filename: "sessionIdentity.ts",
	});
	const pillsSandbox = { exports: {} };
	vm.runInNewContext(transpile("src/renderer/src/sessionFilterPills.ts"), pillsSandbox, {
		filename: "sessionFilterPills.ts",
	});
	const sandbox = {
		exports: {},
		require: (specifier) => {
			if (specifier === "../../shared/sessionIdentity") return identitySandbox.exports;
			if (specifier === "./sessionFilterPills") return pillsSandbox.exports;
			throw new Error(`Unexpected import: ${specifier}`);
		},
	};
	vm.runInNewContext(transpile("src/renderer/src/agentListDisplay.ts"), sandbox, {
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

test("matches native Session paths only for runtime/catalog deduplication", () => {
	const { isSameSessionPath } = loadModule();
	const parentPath = "C:\\sessions\\parent.jsonl";
	const childPath = "C:\\sessions\\parent\\run\\session.jsonl";

	assert.equal(
		isSameSessionPath(childPath, childPath.toLowerCase().replaceAll("\\", "/")),
		true,
	);
	assert.equal(isSameSessionPath(parentPath, childPath), false);
	assert.equal(isSameSessionPath(undefined, undefined), false);
});


test("keeps a stable Session row and key when a runtime is attached", () => {
	const { getProjectAgentSessionDisplay, getSessionRowKey } = loadModule();
	const record = session({
		id: "desktop-session-1",
		filePath: "C:/sessions/stable.jsonl",
		source: "pi",
	});
	const before = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [record],
	});
	const after = getProjectAgentSessionDisplay({
		agents: [{
			id: "runtime-1",
			sessionPath: "c:/SESSIONS/STABLE.jsonl",
			sessionEnvironment: "native",
			createdAt: 2,
			status: "idle",
		}],
		sessions: [record],
	});

	assert.equal(before.children[0].type, "session");
	assert.equal(after.children[0].type, "session");
	assert.equal(before.children[0].key, "session:desktop-session-1");
	assert.equal(after.children[0].key, before.children[0].key);
	assert.equal(after.children[0].agent.id, "runtime-1");
	assert.equal(getSessionRowKey(record), "session:desktop-session-1");
});

test("DSH agent 与 DSH 会话按 dshSessionId 配对：只渲染一个会话行，不产生重复 agent 行", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const dshSession = session({
		id: "dsh-session-1",
		filePath: "",
		backend: "dsh",
		dshSessionId: "session-abc",
		source: "pi",
		updatedAt: 5,
	});
	// 激活 DSH 会话后：agent 行（backend=dsh, sessionId=dshSessionId）与
	// 会话行（无 filePath → unkeyedSessions）同时出现会产生两个相同标题的条目，
	// 必须按 dshSessionId 配对合并成一个会话行。
	const display = getProjectAgentSessionDisplay({
		agents: [{
			id: "dsh:session-abc",
			backend: "dsh",
			sessionId: "session-abc",
			sessionPath: undefined,
			createdAt: 2,
			status: "idle",
		}],
		sessions: [dshSession],
	});
	assert.equal(display.children.length, 1, "配对后只保留一个行，不得出现重复条目");
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].session.id, "dsh-session-1");
	assert.equal(display.children[0].agent?.id, "dsh:session-abc", "会话行携带配对 agent 装饰");
});

test("DSH agent 无配对会话时仍平铺为 agent 行（孤儿不消失）", () => {
	const { getProjectAgentSessionDisplay } = loadModule();
	const display = getProjectAgentSessionDisplay({
		agents: [{
			id: "dsh:orphan",
			backend: "dsh",
			sessionId: "session-orphan",
			createdAt: 2,
			status: "idle",
		}],
		sessions: [],
	});
	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "agent");
});

test("DSH attach 回写窗口期：按 deckSessionId 兜底配对，不产生重复条目", () => {
	// 2026-09-12 automation 实测：attachRuntime 回写 dshSessionId 是 fire-and-forget，
	// 渲染层 agent 快照先于 catalog attach 到达时 session.dshSessionId 还没落盘，
	// 只按 dshSessionId 配对会出现「agent 行 + 会话行」两个相同标题的条目。
	const { getProjectAgentSessionDisplay } = loadModule();
	const dshSession = session({
		id: "catalog-dsh-1",
		filePath: "",
		backend: "dsh",
		// dshSessionId 尚未回写（attach 窗口期）
		source: "pi",
		updatedAt: 5,
	});
	const display = getProjectAgentSessionDisplay({
		agents: [{
			id: "dsh:session-xyz",
			backend: "dsh",
			sessionId: "session-xyz",
			deckSessionId: "catalog-dsh-1",
			createdAt: 2,
			status: "running",
		}],
		sessions: [dshSession],
	});
	assert.equal(display.children.length, 1, "deckSessionId 兜底配对后只保留一个行");
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].agent?.id, "dsh:session-xyz", "会话行携带配对 agent 装饰");
});

test("filters runtime rows by their canonical Session origin before falling back to agent source", () => {
	const { filterAgentsForSidebarDisplay } = loadModule();
	const piSession = session({ id: "pi-session", filePath: "C:/sessions/pi.jsonl", source: "pi" });
	const codexSession = session({ id: "codex-session", filePath: "C:/sessions/codex.jsonl", source: "codex" });
	const agents = [
		{ id: "pi-runtime", sessionPath: "c:/SESSIONS/PI.jsonl", sessionEnvironment: "native", sessionSource: "codex", createdAt: 1, status: "running" },
		{ id: "codex-runtime", sessionPath: "c:/SESSIONS/CODEX.jsonl", sessionEnvironment: "native", sessionSource: "pi", createdAt: 2, status: "running" },
		{ id: "unlinked-pi", sessionSource: "pi", createdAt: 3, status: "idle" },
		{ id: "unlinked-codex", sessionSource: "codex", createdAt: 4, status: "idle" },
	];
	const visible = filterAgentsForSidebarDisplay({
		agents,
		allSessions: [piSession, codexSession],
		visibleSessions: [piSession],
		sources: new Set(["pi"]),
	});
	assert.deepEqual(visible.map((agent) => agent.id), ["pi-runtime", "unlinked-pi"]);
});

test("unlinked DSH agents match the dsh filter pill instead of their pi source", () => {
	const { filterAgentsForSidebarDisplay } = loadModule();
	const agents = [
		{ id: "dsh-runtime", backend: "dsh", sessionSource: "pi", createdAt: 1, status: "running" },
		{ id: "pi-runtime", sessionSource: "pi", createdAt: 2, status: "running" },
	];
	const onlyPi = filterAgentsForSidebarDisplay({
		agents,
		allSessions: [],
		visibleSessions: [],
		sources: new Set(["pi"]),
	});
	assert.deepEqual(onlyPi.map((agent) => agent.id), ["pi-runtime"]);
	const onlyDsh = filterAgentsForSidebarDisplay({
		agents,
		allSessions: [],
		visibleSessions: [],
		sources: new Set(["dsh"]),
	});
	assert.deepEqual(onlyDsh.map((agent) => agent.id), ["dsh-runtime"]);
});

test("preserves WSL path case while deduplicating native paths", () => {
	const { getProjectAgentSessionDisplay, getAgentForSessionPath } = loadModule();
	const wslDisplay = getProjectAgentSessionDisplay({
		agents: [],
		sessions: [
			session({ filePath: "/home/Dev/session.jsonl", wsl: true }),
			session({ filePath: "/home/dev/session.jsonl", wsl: true }),
		],
	});
	assert.equal(wslDisplay.children.length, 2);

	const agents = [
		{ id: "upper", sessionPath: "/home/Dev/session.jsonl", createdAt: 1 },
		{ id: "lower", sessionPath: "/home/dev/session.jsonl", createdAt: 2 },
	];
	assert.equal(
		getAgentForSessionPath(agents, "/home/Dev/session.jsonl", "wsl")?.id,
		"upper",
	);
	assert.equal(
		getAgentForSessionPath(agents, "/home/Dev/session.jsonl", "native")?.id,
		"lower",
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

test("collectDisplayedSessionIds excludes drafts already shown as agent or session rows", () => {
	const { collectDisplayedSessionIds } = loadModule();
	const sessionRow = {
		type: "session",
		key: "session:history-1",
		session: session({ filePath: "C:/sessions/history.jsonl", id: "history-1" }),
		sortAt: 10,
		codexSubagents: [],
		piSubagents: [],
	};
	const agentRow = {
		type: "agent",
		key: "agent:live-1",
		agent: {
			id: "live-1",
			projectId: "p1",
			cwd: "C:/project",
			title: "PiDeck agent",
			status: "running",
			sessionPath: "C:/sessions/draft.jsonl",
			createdAt: 20,
		},
		sortAt: 20,
		codexSubagents: [],
		piSubagents: [],
	};
	const ids = collectDisplayedSessionIds(
		[sessionRow, agentRow],
		(agent) => (agent.id === "live-1" ? "draft-1" : undefined),
	);
	assert.deepEqual([...ids], ["history-1", "draft-1"]);
});
