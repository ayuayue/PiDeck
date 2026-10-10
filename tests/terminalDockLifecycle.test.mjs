import assert from "node:assert/strict";
import test from "node:test";
import { deferred, dockHarness, tab } from "./helpers/terminalDockHarness.mjs";

test("unrelated terminal events never enter this dock replay cache", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	h.emitData("foreign", "foreign output");
	h.emitExit("foreign", 1);
	assert.deepEqual(h.appended, []);
	h.emitData("A", "own output");
	assert.deepEqual(h.appended, ["own output"]);
	assert.ok(h.terminals.at(-1).output.endsWith("own output"));
	h.unmount();
});

test("closed active tab is not serialized back into its deleted replay cache", async () => {
	const h = dockHarness();
	await h.ready();
	h.closeTab("A");
	await h.settle();
	assert.deepEqual(h.ids, ["B"]);
	assert.deepEqual(h.serialized, []);
	h.emitData("A", "late output");
	h.emitExit("A", 0);
	assert.deepEqual(h.appended, []);
	h.unmount();
});

test("valid tab switching and collapse still serialize and replay the local terminal", async () => {
	const h = dockHarness();
	await h.ready();
	h.selectTab("B");
	await h.settle();
	assert.equal(h.serialized.length, 1);
	h.selectTab("A");
	await h.settle();
	assert.equal(h.terminals.at(-1).output, "serialized terminal");
	h.render({ collapsed: true });
	h.render({ collapsed: false });
	assert.equal(h.terminals.at(-1).output, "serialized terminal");
	h.unmount();
});

test("early terminal exit is shown after create settles and never gets a startup command", async () => {
	const h = dockHarness([tab("A")], { startupCommand: "test command" });
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.emitData("C", "first prompt");
	h.emitExit("C", 7);
	creating.resolve(tab("C"));
	await h.settle();
	assert.equal(h.isExited("C"), true);
	assert.ok(h.terminals.at(-1).output.includes("[process exited with code 7]"));
	h.emitData("C", "late output");
	await h.settle();
	assert.deepEqual(h.inputs, []);
	h.unmount();
});

test("a create response already marked exited never schedules its startup command", async () => {
	const h = dockHarness([tab("A")], { startupCommand: "test command" });
	await h.ready();
	h.setCreate(async () => ({ ...tab("C"), exited: true, exitCode: 1 }));
	h.addTab();
	await h.settle();
	assert.equal(h.isExited("C"), true);
	h.emitData("C", "late output");
	await h.settle();
	assert.deepEqual(h.inputs, []);
	h.unmount();
});

test("a running terminal still receives its startup command once after its first prompt", async () => {
	const h = dockHarness([tab("A")], { startupCommand: "test command" });
	await h.ready();
	h.addTab();
	await h.settle();
	h.emitData("C", "first prompt");
	h.emitData("C", "more output");
	await h.settle();
	assert.equal(h.isExited("C"), false);
	assert.deepEqual(h.inputs, [["C", "test command\r"]]);
	h.unmount();
});

test("prompt arriving before create response triggers the startup command once after creation", async () => {
	const h = dockHarness([tab("A")], { startupCommand: " test command " });
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.emitData("C", "first prompt");
	assert.deepEqual(h.inputs, []);
	creating.resolve(tab("C"));
	await h.settle();
	assert.deepEqual(h.inputs, [["C", "test command\r"]]);
	h.emitData("C", "more output");
	await h.settle();
	assert.deepEqual(h.inputs, [["C", "test command\r"]]);
	h.unmount();
});

test("parallel creates wait for each terminal's own prompt before injecting once", async () => {
	const h = dockHarness([tab("A")], { startupCommand: "test command" });
	await h.ready();
	const c = deferred();
	const d = deferred();
	let calls = 0;
	h.setCreate(() => (++calls === 1 ? c.promise : d.promise));
	h.addTab();
	h.addTab();
	h.emitData("C", "early prompt");
	h.emitData("foreign", "other terminal's prompt");
	d.resolve(tab("D"));
	await h.settle();
	assert.deepEqual(h.inputs, []);
	c.resolve(tab("C"));
	await h.settle();
	assert.deepEqual(h.inputs, [["C", "test command\r"]]);
	h.emitData("C", "more output");
	h.emitData("D", "first prompt");
	h.emitData("D", "more output");
	await h.settle();
	assert.deepEqual(h.inputs, [
		["C", "test command\r"],
		["D", "test command\r"],
	]);
	h.unmount();
});

test("hydrating an existing terminal never reruns its startup command", async () => {
	const h = dockHarness([{ ...tab("A"), buffer: "saved prompt" }], { startupCommand: "test command" });
	await h.ready();
	h.emitData("A", "live prompt");
	await h.settle();
	assert.deepEqual(h.inputs, []);
	h.unmount();
});

test("failed create discards its early prompt instead of triggering the next terminal", async () => {
	const h = dockHarness([tab("A")], { startupCommand: "test command" });
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.emitData("C", "orphan prompt");
	creating.reject(new Error("spawn failed"));
	await h.settle();
	h.setCreate(async () => tab("C"));
	h.addTab();
	await h.settle();
	assert.deepEqual(h.inputs, []);
	h.emitData("C", "new prompt");
	await h.settle();
	assert.deepEqual(h.inputs, [["C", "test command\r"]]);
	h.unmount();
});

test("startup command write failure is reported without retrying on later output", async () => {
	const h = dockHarness([tab("A")], { startupCommand: "test command" });
	await h.ready();
	h.setInput(async () => {
		throw new Error("write failed");
	});
	h.addTab();
	await h.settle();
	h.emitData("C", "first prompt");
	await h.settle();
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0][0], /write failed/);
	assert.equal(h.notices[0][2], "error");
	h.emitData("C", "more output");
	await h.settle();
	assert.deepEqual(h.inputs, [["C", "test command\r"]]);
	h.unmount();
});

test("initial output emitted before create settles is retained for replay", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.emitData("C", "initial prompt");
	creating.resolve(tab("C"));
	await h.settle();
	assert.equal(h.terminals.at(-1).output, "initial prompt");
	h.emitData("foreign", "foreign output");
	assert.deepEqual(h.appended, ["initial prompt"]);
	h.unmount();
});

test("parallel tab closes cannot resurrect an already closed tab", async () => {
	const h = dockHarness();
	await h.ready();
	const a = deferred();
	const b = deferred();
	h.setClose((id) => (id === "A" ? a.promise : b.promise));
	h.closeTab("A");
	h.closeTab("B");
	a.resolve();
	await h.settle();
	b.resolve();
	await h.settle();
	assert.deepEqual(h.ids, []);
	assert.equal(h.closeCount, 1);
	h.unmount();
});

test("a tab created while the last old tab closes remains visible", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const closing = deferred();
	h.setClose(() => closing.promise);
	h.closeTab("A");
	h.addTab();
	await h.settle();
	closing.resolve();
	await h.settle();
	assert.deepEqual(h.ids, ["C"]);
	assert.equal(h.closeCount, 0);
	h.unmount();
});

test("close-all removes only its captured tabs, not a newly created tab", async () => {
	const h = dockHarness();
	await h.ready();
	const closing = deferred();
	h.setClose(() => closing.promise);
	h.closeAll();
	h.addTab();
	await h.settle();
	closing.resolve();
	await h.settle();
	assert.deepEqual(h.ids, ["C"]);
	assert.equal(h.closeCount, 0);
	h.unmount();
});

test("late close completion after unmount cannot close the current owner dock", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const closing = deferred();
	h.setClose(() => closing.promise);
	h.closeTab("A");
	h.unmount();
	closing.resolve();
	for (let i = 0; i < 8; i++) await Promise.resolve();
	assert.equal(h.closeCount, 0);
});

test("copy-on-select reattaches after collapsing and expanding the xterm instance", async () => {
	const h = dockHarness([tab("A")], { copyOnSelect: true });
	await h.ready();
	assert.equal(h.terminals.at(-1).selectionListeners.size, 1);
	h.render({ collapsed: true });
	h.render({ collapsed: false });
	const terminal = h.terminals.at(-1);
	assert.equal(terminal.selectionListeners.size, 1);
	for (const listener of terminal.selectionListeners) listener();
	await h.settle();
	assert.deepEqual(h.copied, ["selected text"]);
	h.unmount();
});

test("failed clipboard write does not report a successful right-click copy", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	h.setClipboardOk(false);
	h.contextMenu();
	await h.settle();
	assert.equal(
		h.notices.some(([message]) => message === "terminal.copied"),
		false,
	);
	h.unmount();
});

test("failed single close keeps the tab and reports the failure", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	h.setClose(async () => {
		throw new Error("close failed");
	});
	h.closeTab("A");
	await h.settle();
	assert.deepEqual(h.ids, ["A"]);
	assert.equal(h.closeCount, 0);
	assert.ok(h.notices.some(([message, , tone]) => message.includes("close failed") && tone === "error"));
	h.unmount();
});

test("failed create reports the error without changing existing tabs", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	h.setCreate(async () => {
		throw new Error("spawn failed");
	});
	h.addTab();
	await h.settle();
	assert.deepEqual(h.ids, ["A"]);
	assert.ok(h.notices.some(([message, , tone]) => message.includes("spawn failed") && tone === "error"));
	h.unmount();
});

test("partial close-all failure keeps failed tabs and reports it", async () => {
	const h = dockHarness();
	await h.ready();
	h.setClose(async (id) => {
		if (id === "B") throw new Error("B close failed");
	});
	h.closeAll();
	await h.settle();
	assert.deepEqual(h.ids, ["B"]);
	assert.equal(h.closeCount, 0);
	assert.ok(h.notices.some(([message, , tone]) => message.includes("B close failed") && tone === "error"));
	h.unmount();
});

test("last-tab close waits for a pending create before hiding the dock", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.closeTab("A");
	await h.settle();
	assert.equal(h.closeCount, 0);
	creating.resolve(tab("C"));
	await h.settle();
	assert.deepEqual(h.ids, ["C"]);
	assert.equal(h.closeCount, 0);
	h.unmount();
});

test("failed pending create allows a previously requested empty dock close", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.closeTab("A");
	await h.settle();
	creating.reject(new Error("spawn failed"));
	await h.settle();
	assert.deepEqual(h.ids, []);
	assert.equal(h.closeCount, 1);
	h.unmount();
});

test("close-all confirmation does not capture tabs created while the dialog is open", async () => {
	const h = dockHarness([tab("A")], { confirmClose: "always" });
	await h.ready();
	h.closeAll();
	await h.settle();
	h.addTab();
	await h.settle();
	h.confirmCloseAll();
	await h.settle();
	assert.deepEqual(h.ids, ["C"]);
	assert.equal(h.closeCount, 0);
	h.unmount();
});

test("switching terminal owner clears stale tabs before the new owner hydrates", async () => {
	const h = dockHarness([tab("A")]);
	await h.ready();
	const loading = deferred();
	h.setEnsure(() => loading.promise);
	h.render({ target: { kind: "project", projectId: "other", cwd: "/other" } });
	await h.settle();
	assert.deepEqual(h.ids, []);
	loading.resolve([tab("D")]);
	await h.settle();
	assert.deepEqual(h.ids, ["D"]);
	h.unmount();
});

test("old owner create completion cannot insert a tab or run its command in the new owner", async () => {
	const h = dockHarness([tab("A")], { startupCommand: "test command" });
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	h.addTab();
	h.emitData("C", "early prompt");
	h.setEnsure(async () => [tab("D")]);
	h.render({ target: { kind: "project", projectId: "other", cwd: "/other" } });
	await h.settle();
	creating.resolve(tab("C"));
	await h.settle();
	assert.deepEqual(h.ids, ["D"]);
	assert.equal(h.closeCount, 0);
	assert.deepEqual(h.inputs, []);
	h.unmount();
});
