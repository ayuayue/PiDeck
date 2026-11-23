import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const HOST = "11111111-1111-4111-8111-111111111111";
const { createRemoteResourceEditorApi } = loadTsCommonJs("src/renderer/src/config/remoteResourceEditorApi.ts", { stubs: { "../utils/clipboard": { writeClipboard: async () => {} }, "../utils/notice": { showNotice: () => {} }, "../i18n": { t: (key) => key } } });

function fixture() {
	const changes = [];
	const removed = new Set(["pi-deck-todo.ts"]);
	const snapshot = { home: "/home/debian", scope: "global", projectRoot: null, files: [], settings: {}, settingsVersion: "a".repeat(64), discovery: { skills: [], prompts: [], extensions: [], overrides: { disabledGlobalSkills: [], disabledGlobalPrompts: [], disabledGlobalExtensions: [] } } };
	const api = {
		remotePiResources: async (_host, input) => (input.action === "packages" ? { output: "", extensions: [] } : input.action === "list" ? snapshot : { applied: true }),
		settings: { get: async () => ({ removedBuiltInExtensions: [...removed] }) },
		extensions: {
			builtInStatus: async () => ({ effectiveVersion: "1.2.3" }),
			toggle: async (source, enabled) => {
				changes.push({ source, enabled });
				if (enabled) removed.delete(source);
				else removed.add(source);
			},
		},
	};
	return { editor: createRemoteResourceEditorApi(api, HOST, async () => {}), changes, removed };
}

test("remote list exposes only SSH-capable PiDeck built-ins using their shared actual settings", async () => {
	const f = fixture();
	const rows = (await f.editor.extensions.list()).extensions;
	const todo = rows.find((row) => row.source === "pi-deck-todo.ts");
	assert.equal(todo?.builtIn, true);
	assert.equal(todo.enabled, false);
	assert.equal(todo.currentVersion, "1.2.3");
	assert.equal(todo.path, undefined, "a local path must never be represented as a remote path");
	assert.ok(rows.some((row) => row.source === "pi-deck-plan-mode.ts"));
	assert.equal(
		rows.some((row) => row.source === "pi-deck-vision.ts"),
		false,
	);
	await f.editor.extensions.toggle("pi-deck-todo.ts", true, "user");
	assert.equal((await f.editor.extensions.list(false)).extensions.find((row) => row.source === "pi-deck-todo.ts").enabled, true);
	assert.deepEqual(f.changes, [{ source: "pi-deck-todo.ts", enabled: true }]);
});

test("remote package row shows update controls only when an update exists", () => {
	const Button = () => null;
	const Switch = () => null;
	const load = createTsSandbox({
		stubs: {
			"react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
			"../components/ui-shadcn/button": { Button },
			"../components/ui-shadcn/switch": { Switch },
			"../components/ui-shadcn/table": { TableCell: () => null, TableRow: () => null },
			"lucide-react": { Copy: () => null, FolderOpen: () => null, RefreshCw: () => null, Trash2: () => null },
			"../i18n": { t: (key) => key },
			"./useConfigEditorApi": { useConfigEditor: () => ({ remote: true }) },
			"./RemoteExtensionSourceButton": { RemoteExtensionSourceButton: () => null },
		},
	});
	const { ExtensionTableRow } = load("src/renderer/src/config/extensionsTableRows.tsx");
	const render = (hasUpdate) => JSON.stringify(ExtensionTableRow({ extension: { id: "x", source: "npm:example", scope: "user", currentVersion: "1.0.0", latestVersion: hasUpdate ? "2.0.0" : "1.0.0", hasUpdate }, effectiveEnabled: true, inherited: false, uninstalling: false, updatingOne: false }));
	assert.equal(render(false).includes("config.extensionUpdateOne"), false);
	assert.equal(render(true).includes("config.extensionUpdateOne"), true);
	const row = ExtensionTableRow({ extension: { source: "pi-deck-todo.ts", scope: "user", builtIn: true, enabled: true }, effectiveEnabled: true, inherited: true });
	const findSwitch = (node) => {
		if (!node || typeof node !== "object") return undefined;
		if (node.type === Switch) return node;
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) {
				for (const item of child) {
					const found = findSwitch(item);
					if (found) return found;
				}
			} else {
				const found = findSwitch(child);
				if (found) return found;
			}
		}
	};
	assert.equal(findSwitch(row)?.props.disabled, true, "project view must not write a host setting through a project switch");
});
