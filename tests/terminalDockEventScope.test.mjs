import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function tab(id) {
	return { id, agentId: "", ownerKey: "cwd:project", title: id, cwd: "/project", shell: "bash", createdAt: 0 };
}

/** 在公开 hook 接口上裁决事件归属，IPC 完成时机由测试控制。 */
function harness() {
	const host = quickMessageHookHost();
	const hydrated = [];
	let ensure = async () => [tab("A")];
	let create = async () => tab("C");
	let result;
	const terminal = {
		ensure: (...args) => ensure(...args),
		create: (...args) => create(...args),
		list: async () => [tab("A")],
		close: async () => {},
	};
	const load = createTsSandbox({
		stubs: {
			react: host.react,
			"../i18n": { t: (key) => key },
			"../utils/notice": { showNotice() {} },
		},
		globals: { Error },
	});
	const { useTerminalDockTabs } = load("src/renderer/src/hooks/useTerminalDockTabs.ts");
	let options = {
		target: { kind: "project", projectId: "project", cwd: "/project" },
		terminal,
		enabled: true,
		confirmClose: "never",
		onHydrate: (tabs) => hydrated.push(Array.from(tabs, (item) => item.id)),
		onCreated() {},
		onClosed() {},
		onClose() {},
		onExpand() {},
	};
	function render(patch = {}) {
		options = { ...options, ...patch };
		result = host.render(() => useTerminalDockTabs(options));
		return result;
	}
	async function settle() {
		for (let i = 0; i < 8; i++) await Promise.resolve();
		return render();
	}
	return {
		render,
		settle,
		hydrated,
		get current() {
			return result;
		},
		setEnsure(fn) {
			ensure = fn;
		},
		setCreate(fn) {
			create = fn;
		},
		async ready() {
			render();
			await settle();
		},
		unmount: () => host.unmount(),
	};
}

test("settled dock accepts only its own tabs and rejects a closed tab immediately", async () => {
	const h = harness();
	await h.ready();
	assert.equal(h.current.acceptsTabEvent("A"), true);
	assert.equal(h.current.acceptsTabEvent("foreign"), false);
	assert.equal(h.current.ownsTab("A"), true);
	await h.current.performCloseTab(tab("A"));
	assert.equal(h.current.ownsTab("A"), false);
	assert.equal(h.current.acceptsTabEvent("A"), false);
	h.unmount();
});

test("pending create admits early output until its tab ID is known, then prunes the replay scope", async () => {
	const h = harness();
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	const pending = h.current.addTab();
	assert.equal(h.current.acceptsTabEvent("C"), true);
	assert.equal(h.current.ownsTab("C"), false);
	creating.resolve(tab("C"));
	await pending;
	assert.equal(h.current.acceptsTabEvent("C"), true);
	assert.equal(h.current.acceptsTabEvent("foreign"), false);
	assert.deepEqual(h.hydrated.at(-1), ["A", "C"]);
	h.unmount();
});

test("failed create also settles the replay scope instead of retaining unrelated output", async () => {
	const h = harness();
	await h.ready();
	const creating = deferred();
	h.setCreate(() => creating.promise);
	const pending = h.current.addTab();
	creating.reject(new Error("spawn failed"));
	await pending;
	assert.equal(h.current.acceptsTabEvent("C"), false);
	assert.deepEqual(h.hydrated.at(-1), ["A"]);
	h.unmount();
});

test("owner switch clears the replay scope before ensure completes and ignores the old owner", async () => {
	const h = harness();
	await h.ready();
	const loading = deferred();
	h.setEnsure(() => loading.promise);
	h.render({ target: { kind: "project", projectId: "other", cwd: "/other" } });
	assert.equal(h.current.ownsTab("A"), false);
	assert.deepEqual(h.hydrated.at(-1), []);
	loading.resolve([tab("D")]);
	await h.settle();
	assert.equal(h.current.acceptsTabEvent("A"), false);
	assert.equal(h.current.acceptsTabEvent("D"), true);
	h.unmount();
});

test("hydration admits initial prompt output, but disabled or unmounted scopes accept nothing", async () => {
	const h = harness();
	const loading = deferred();
	h.setEnsure(() => loading.promise);
	h.render();
	assert.equal(h.current.acceptsTabEvent("A"), true);
	h.render({ enabled: false });
	assert.equal(h.current.acceptsTabEvent("A"), false);
	loading.resolve([tab("A")]);
	await h.settle();
	assert.equal(h.current.ownsTab("A"), false);
	h.unmount();
	assert.equal(h.current.acceptsTabEvent("A"), false);
});
