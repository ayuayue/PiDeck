import assert from "node:assert/strict";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

function loadOutlineAtoms(buildOutline, toolStubs = {}) {
	const currentSessionIdAtom = atom(undefined);
	const sessionMessagesCacheAtom = atom({});
	const load = createTsSandbox({ stubs: { "./session-atoms": { currentSessionIdAtom, sessionMessagesCacheAtom }, "../components/app/AppUtils": { buildOutline, getToolChangedLineCount: () => 0, getToolFilePath: () => undefined, getToolNewContent: () => undefined, ...toolStubs } } });
	const projectionCache = load("src/renderer/src/atoms/outlineProjectionCache.ts");
	const outlineAtoms = load("src/renderer/src/atoms/session-outline-atoms.ts");
	return { ...outlineAtoms, currentSessionIdAtom, sessionMessagesCacheAtom, projectionCache };
}

/** 修改文件清单测试用的 tool 消息工厂：args 走投影器写入的对象形态。 */
function toolMessage(id, toolName, args, status) {
	return { id, agentId: "agent", role: "tool", text: "", timestamp: 5, meta: { toolName, args, status } };
}

function toolStubs() {
	return {
		getToolFilePath: (args) => (args && typeof args === "object" ? args.path : undefined),
		getToolChangedLineCount: () => 3,
		getToolNewContent: (_toolName, args) => (args && typeof args === "object" ? args.newText : undefined),
	};
}

function message(id, role, text, timestamp) {
	return { id, agentId: "agent", role, text, timestamp };
}
function entry(messages, outlineRevision) {
	return {
		messages,
		revision: outlineRevision,
		source: "runtime",
		updatedAt: 1,
		outlineRevision,
		outlineLastUserIndex: 0,
	};
}

test("unchanged outline revision returns the existing outline projection", () => {
	let buildCount = 0;
	const atoms = loadOutlineAtoms((messages) => {
		buildCount += 1;
		return messages
			.filter((message) => message.role === "user")
			.map((message) => ({
				id: message.id,
				role: message.role,
				title: message.text,
				time: String(message.timestamp),
			}));
	});
	const store = createStore();
	store.set(atoms.currentSessionIdAtom, "session-a");
	store.set(atoms.sessionMessagesCacheAtom, {
		"session-a": entry([message("question", "user", "Question", 1), message("answer", "assistant", "Partial", 2)], 7),
	});
	const first = store.get(atoms.outlineItemsAtom);

	store.set(atoms.sessionMessagesCacheAtom, {
		"session-a": entry([message("question", "user", "Question", 1), message("answer", "assistant", "Completed", 2)], 7),
	});
	const second = store.get(atoms.outlineItemsAtom);

	assert.equal(second, first);
	assert.equal(buildCount, 1);
});

test("advanced outline revision rebuilds the user checkpoint projection", () => {
	const atoms = loadOutlineAtoms((messages) =>
		messages
			.filter((message) => message.role === "user")
			.map((message) => ({
				id: message.id,
				role: message.role,
				title: message.text,
				time: String(message.timestamp),
			})),
	);
	const store = createStore();
	store.set(atoms.currentSessionIdAtom, "session-a");
	store.set(atoms.sessionMessagesCacheAtom, {
		"session-a": entry([message("question", "user", "Original", 1)], 7),
	});
	const first = store.get(atoms.outlineItemsAtom);

	store.set(atoms.sessionMessagesCacheAtom, {
		"session-a": entry([message("question", "user", "Edited", 1)], 8),
	});
	const second = store.get(atoms.outlineItemsAtom);

	assert.notEqual(second, first);
	assert.equal(second[0].title, "Edited");
});

test("unchanged tool messages keep the modified-files projection reference", () => {
	const atoms = loadOutlineAtoms(() => [], toolStubs());
	const store = createStore();
	store.set(atoms.currentSessionIdAtom, "session-a");
	const firstTool = toolMessage("edit-1", "edit", { path: "/repo/a.ts", newText: "const next = 1;" }, "running");
	store.set(atoms.sessionMessagesCacheAtom, {
		"session-a": entry([firstTool], 1),
	});
	const first = store.get(atoms.modifiedFilesAtom);
	assert.equal(first.length, 1);

	// 模拟流式消息 flush：给全新的消息数组引用，但 tool 内容与状态都没变。
	store.set(atoms.sessionMessagesCacheAtom, {
		"session-a": entry([{ ...firstTool }], 1),
	});
	const second = store.get(atoms.modifiedFilesAtom);

	assert.equal(second, first, "内容未变时必须复用旧数组引用，否则 App 根会被每 50ms 叫醒重渲");
	assert.equal(second[0].path, "/repo/a.ts");
});

test("changed tool status rebuilds the modified-files projection", () => {
	const atoms = loadOutlineAtoms(() => [], toolStubs());
	const store = createStore();
	store.set(atoms.currentSessionIdAtom, "session-a");
	store.set(atoms.sessionMessagesCacheAtom, {
		"session-a": entry([toolMessage("edit-1", "edit", { path: "/repo/a.ts", newText: "const next = 1;" }, "running")], 1),
	});
	const first = store.get(atoms.modifiedFilesAtom);

	store.set(atoms.sessionMessagesCacheAtom, {
		"session-a": entry([toolMessage("edit-1", "edit", { path: "/repo/a.ts", newText: "const next = 2;" }, "done")], 1),
	});
	const second = store.get(atoms.modifiedFilesAtom);

	assert.notEqual(second, first);
	assert.equal(second[0].status, "done");
	assert.equal(second[0].content, "const next = 2;");
});

test("switching sessions rebuilds the modified-files projection", () => {
	const atoms = loadOutlineAtoms(() => [], toolStubs());
	const store = createStore();
	store.set(atoms.currentSessionIdAtom, "session-a");
	store.set(atoms.sessionMessagesCacheAtom, {
		"session-a": entry([toolMessage("edit-a", "edit", { path: "/repo/a.ts", newText: "a" }, "done")], 1),
	});
	const first = store.get(atoms.modifiedFilesAtom);

	store.set(atoms.currentSessionIdAtom, "session-b");
	store.set(atoms.sessionMessagesCacheAtom, {
		"session-a": entry([toolMessage("edit-a", "edit", { path: "/repo/a.ts", newText: "a" }, "done")], 1),
		"session-b": entry([toolMessage("write-b", "write", { path: "/repo/b.ts", newText: "b" }, "done")], 1),
	});
	const second = store.get(atoms.modifiedFilesAtom);

	assert.notEqual(second, first);
	// vm 沙箱里的数组原型与测试进程不同，先摊平到本 realm 再比较
	assert.deepEqual([...second.map((file) => file.path)], ["/repo/b.ts"]);
});
