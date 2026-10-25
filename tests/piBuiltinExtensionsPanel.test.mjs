import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

function summary(enabled = true, error) {
	return {
		settingsPath: "/agent/settings.json",
		exists: true,
		revision: enabled ? "on" : "off",
		builtins: ["mcp", "llama.cpp", "codemode", "tool-search"].map((name) => ({ name, enabled, explicitInLayer: false, state: "inherit" })),
		entries: { extensions: [], skills: [], prompts: [], themes: [] },
		...(error ? { error } : {}),
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

async function flush() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function setup(config) {
	const host = quickMessageHookHost();
	const notices = [];
	const Button = () => null;
	const Switch = () => null;
	const react = { ...host.react, useMemo: (factory, deps) => host.react.useCallback(factory, deps)() };
	const load = createTsSandbox({
		stubs: {
			react,
			"react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
			"lucide-react": { Loader2: () => null, AlertTriangle: () => null, RefreshCw: () => null },
			"../i18n": { t: (key) => key },
			"../utils/notice": { showNotice: (message) => notices.push(message) },
			"../components/ui-shadcn/button": { Button },
			"../components/ui-shadcn/switch": { Switch },
		},
		globals: { window: { piDesktop: { config } } },
	});
	const { PiBuiltinExtensionsPanel } = load("src/renderer/src/config/PiBuiltinExtensionsPanel.tsx");
	const render = (props = { scope: "global" }) => host.render(() => PiBuiltinExtensionsPanel(props));
	function nodes(view, predicate) {
		if (Array.isArray(view)) return view.flatMap((child) => nodes(child, predicate));
		if (!view || typeof view !== "object") return [];
		return [...(predicate(view) ? [view] : []), ...nodes(view.props?.children, predicate)];
	}
	return {
		render,
		notices,
		switches: (view) => nodes(view, (node) => node.type === Switch),
		refresh: (view) => nodes(view, (node) => node.type === Button)[0],
		hasText: (view, text) => JSON.stringify(view).includes(text),
		cleanup: () => host.unmount(),
	};
}

test("builtin panel loads once across state updates and unrelated parent renders", async () => {
	let reads = 0;
	const panel = setup({
		piResourcesSummary: async () => {
			reads++;
			return summary();
		},
		piResourcesSetBuiltin: async () => ({ ok: true }),
	});
	panel.render();
	await flush();
	for (let i = 0; i < 4; i++) panel.render({ scope: "global", onChanged: () => {} });
	assert.equal(reads, 1, "a newly allocated scope must not trigger an endless load effect");
	panel.cleanup();
});

test("builtin toggle persists once, refreshes and updates the controlled switch", async () => {
	let current = summary();
	const requests = [];
	let changes = 0;
	const panel = setup({
		piResourcesSummary: async () => current,
		piResourcesSetBuiltin: async (request) => {
			requests.push(request);
			current = summary(false);
			return { ok: true };
		},
	});
	const props = {
		scope: "global",
		onChanged: () => {
			changes++;
		},
	};
	panel.render(props);
	await flush();
	const view = panel.render(props);
	await panel.switches(view)[2].props.onCheckedChange(false);
	await flush();
	const after = panel.render(props);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].name, "codemode");
	assert.equal(requests[0].enabled, false);
	assert.equal(requests[0].expectedRevision, "on");
	assert.equal(panel.switches(after)[2].props.checked, false);
	assert.equal(changes, 1);
	assert.equal(panel.notices.length, 1);
	panel.cleanup();
});

test("builtin configuration parse errors stay visible and block toggles", async () => {
	let writes = 0;
	const panel = setup({
		piResourcesSummary: async () => summary(true, "invalid settings JSON"),
		piResourcesSetBuiltin: async () => {
			writes++;
			return { ok: true };
		},
	});
	panel.render();
	await flush();
	const view = panel.render();
	assert.ok(panel.hasText(view, "invalid settings JSON"));
	assert.ok(panel.switches(view).every((node) => node.props.disabled));
	panel.switches(view)[0].props.onCheckedChange(false);
	await flush();
	assert.equal(writes, 0);
	panel.cleanup();
});

test("late global reads cannot replace a newly selected project's state", async () => {
	const global = deferred();
	const panel = setup({ piResourcesSummary: async (scope) => (scope.scope === "global" ? global.promise : summary(false)), piResourcesSetBuiltin: async () => ({ ok: true }) });
	panel.render();
	const project = { scope: "project", projectId: "p1" };
	panel.render(project);
	await flush();
	global.resolve(summary(true));
	await flush();
	assert.ok(panel.switches(panel.render(project)).every((node) => !node.props.checked));
	panel.cleanup();
});

test("a revision conflict refreshes the switches without hiding the save error", async () => {
	let current = summary();
	const panel = setup({
		piResourcesSummary: async () => current,
		piResourcesSetBuiltin: async () => {
			current = summary(false);
			return { ok: false, error: "settings.json changed on disk; reload before saving." };
		},
	});
	panel.render();
	await flush();
	panel.switches(panel.render())[0].props.onCheckedChange(false);
	await flush();
	const view = panel.render();
	assert.ok(panel.hasText(view, "changed on disk"));
	assert.equal(panel.switches(view)[0].props.checked, false);
	panel.cleanup();
});
