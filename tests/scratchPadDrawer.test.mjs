import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** 只模拟草稿存储和抽屉命令，不启动 Electron、不写真实用户草稿。 */
function createHarness(initialPanel = null) {
	const host = quickMessageHookHost();
	const listeners = new Map();
	const timers = new Map();
	const saves = [];
	const commands = [];
	let timerId = 0;
	let drawer = initialPanel;
	let collapsed = false;
	const draft = { path: "/notes/first.md", name: "First", createdAt: 1, updatedAt: 1 };
	const load = createTsSandbox({
		stubs: { react: host.react },
		globals: {
			window: {
				piDesktop: {
					scratchPad: {
						list: async () => [draft],
						load: async () => ({ content: "existing note" }),
						save: async (path, content) => saves.push({ path, content }),
					},
				},
				addEventListener: (name, handler) => listeners.set(name, handler),
				removeEventListener: (name, handler) => {
					if (listeners.get(name) === handler) listeners.delete(name);
				},
			},
			setTimeout: (callback) => {
				timers.set(++timerId, callback);
				return timerId;
			},
			clearTimeout: (id) => timers.delete(id),
		},
	});
	const { useScratchPad } = load("src/renderer/src/hooks/useScratchPad.ts");
	const openDrawerForce = (panel) => {
		commands.push({ action: "open", panel });
		drawer = panel;
		collapsed = false;
	};
	const closeDrawer = () => {
		commands.push({ action: "close" });
		drawer = null;
	};
	return {
		commands,
		saves,
		listeners,
		timers,
		render: () => host.render(() => useScratchPad({ drawer, drawerCollapsed: collapsed, openDrawerForce, closeDrawer })),
		setPanel: (panel) => {
			drawer = panel;
		},
		collapse: () => {
			collapsed = true;
		},
		unmount: () => host.unmount(),
	};
}

async function settle() {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test("scratch pad open and toggle use the shared right drawer instead of independent visibility", () => {
	const harness = createHarness("files");
	let scratch = harness.render();
	assert.equal(scratch.isOpen, false);
	scratch.open();
	assert.deepEqual(harness.commands, [{ action: "open", panel: "scratchPad" }]);
	scratch = harness.render();
	assert.equal(scratch.isOpen, true);
	scratch.toggle();
	assert.deepEqual(harness.commands.at(-1), { action: "close" });
	scratch = harness.render();
	assert.equal(scratch.isOpen, false);
	scratch.toggle();
	assert.equal(harness.render().isOpen, true, "immediate reopen must not wait on an old floating-panel timer");
	harness.collapse();
	assert.equal(harness.render().isOpen, false);
	harness.unmount();
});

test("switching away from scratch pad flushes the latest content and cancels pending autosave", async () => {
	const harness = createHarness("scratchPad");
	harness.render();
	await settle();
	let scratch = harness.render();
	scratch.setContent("latest edit");
	scratch = harness.render();
	assert.equal(scratch.content, "latest edit");
	assert.equal(harness.timers.size, 1);
	harness.setPanel("browser");
	assert.equal(harness.render().isOpen, false);
	await settle();
	assert.deepEqual(harness.saves, [{ path: "/notes/first.md", content: "latest edit" }]);
	assert.equal(harness.timers.size, 0);
	harness.setPanel("scratchPad");
	assert.equal(harness.render().content, "latest edit", "switching panels must preserve the editor draft");
	harness.unmount();
});

test("scratch pad keyboard shortcut stays global, Escape respects consumed events, and listeners clean up", () => {
	const harness = createHarness();
	harness.render();
	const key = (overrides) => ({ key: "s", ctrlKey: true, metaKey: false, shiftKey: true, defaultPrevented: false, preventDefault() {}, stopPropagation() {}, ...overrides });
	assert.equal(typeof harness.listeners.get("keydown"), "function");
	harness.listeners.get("keydown")(key({}));
	assert.equal(harness.render().isOpen, true);
	harness.listeners.get("keydown")(key({ key: "Escape", ctrlKey: false, shiftKey: false, defaultPrevented: true }));
	assert.equal(harness.render().isOpen, true, "closing a nested menu must not close the whole drawer");
	harness.listeners.get("keydown")(key({ key: "Escape", ctrlKey: false, shiftKey: false }));
	assert.equal(harness.render().isOpen, false);
	harness.listeners.get("keydown")(key({ ctrlKey: false, metaKey: true }));
	assert.equal(harness.render().isOpen, true);
	harness.unmount();
	assert.equal(harness.listeners.size, 0);
	assert.equal(harness.timers.size, 0);
});

test("scratch pad renders only inside DrawerSurface and is included in drawer restoration", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const surface = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
	const panels = readFileSync("src/renderer/src/hooks/useWorkspacePanels.ts", "utf8");
	assert.match(app, /useScratchPad\(workspace\)/);
	assert.match(app, /<DrawerSurface\s[^>]*scratchPad=\{scratchPad\}/);
	assert.doesNotMatch(app, /<ScratchPadOverlay/);
	assert.match(surface, /drawer\s*===\s*"scratchPad"\s*&&\s*!drawerCollapsed/);
	assert.match(surface, /<ScratchPadDrawer\s+controller=\{scratchPad\}/);
	assert.match(panels, /const\s+validPanels\s*=\s*\[[^\]]*"scratchPad"/);
});
