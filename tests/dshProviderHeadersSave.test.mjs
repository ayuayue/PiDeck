import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** 渲染真实供应商卡片，只替换叶子视图；IPC 替身遵守 DSH merge 与 path set/unset 语义。 */
function harness(headers, { failMutate = false } = {}) {
	const host = quickMessageHookHost();
	let stored = { providers: { custom: { baseURL: "https://example.com/v1", api: "openai-completions", headers } } };
	let namespace = {
		ns: "llm-pi-ai",
		revision: 1,
		value: stored,
		user: stored,
		secrets: [],
		schema: {
			uid: 0,
			refs: {
				0: { type: "object", dict: { providers: 1 } },
				1: { type: "dict", inner: 2 },
				2: { type: "object", dict: { baseURL: 3, headers: 4 } },
				3: { type: "string" },
				4: { type: "dict", inner: 3 },
			},
		},
	};
	const mutations = [];
	const patches = [];
	let save;
	let dirty = false;
	const sectionApi = {
		registerSave: (_id, callback) => {
			save = callback;
		},
		unregisterSave: () => {},
		onDirtyChange: (_id, next) => {
			dirty = next;
		},
	};
	const load = createTsSandbox({
		globals: { structuredClone },
		stubs: {
			react: { ...host.react, useId: () => host.react.useRef("provider-card").current, useMemo: (factory, deps) => host.react.useCallback(factory, deps)() },
			"../i18n": { t: (key) => key },
			"../desktopApi": {
				desktopApi: {
					sessions: {
						mutateDshSettings: async (_ns, ops) => {
							if (failMutate) throw new Error("settings write failed");
							mutations.push(...structuredClone(ops));
							stored = structuredClone(stored);
							for (const op of ops) {
								const parent = op.path.slice(0, -1).reduce((value, key) => (value[key] ??= {}), stored);
								const key = op.path.at(-1);
								if (op.op === "set") parent[key] = structuredClone(op.value);
								else delete parent[key];
							}
						},
						setDshCredential: async () => {},
						unsetDshCredential: async () => {},
					},
				},
			},
			"../utils/notice": { showNotice: () => {} },
			"../utils/clipboard": { writeClipboard: async () => {} },
			"../components/app/UsageQueryEntryButton": { UsageQueryEntryButton: "usage-button" },
			"../components/app/ProviderUsageInline": { ProviderUsageInline: "usage-inline" },
			"../components/ui-shadcn/button": { Button: "button" },
			"../components/ui-shadcn/input": { Input: "input" },
			"../components/ui-shadcn/ConfirmDialog": { ConfirmDialog: "confirm" },
			"./DshSchemaForm": { DshSchemaField: "schema-field" },
			"./DshModelsEditor": { DshModelsEditor: "models-editor" },
			"./ProviderMigrationButton": { ProviderMigrationButton: "migration" },
			"./AddDshProviderDialog": { AddDshProviderDialog: "add-provider" },
			"./DshHeadersEditor": { DshHeadersEditor: "headers-editor" },
			"../hooks/useProviderReorder": { useProviderReorder: () => ({ registerCard() {}, cardProps: () => ({}), gripProps: () => ({}), draggingName: null, dropTarget: null }) },
		},
	});
	const { PiAiProvidersCard } = load("src/renderer/src/config/DshProviderCards.tsx");
	const props = {
		writable: true,
		ops: { credentials: {}, setKey: async () => {}, unsetKey: async () => {} },
		sectionApi,
		onOpenUsageProbeDialog() {},
		onSave: async (patch) => {
			patches.push(structuredClone(patch));
			stored = merge(stored, patch);
			namespace = { ...namespace, value: stored, user: stored, revision: namespace.revision + 1 };
		},
	};
	const render = () => host.render(() => PiAiProvidersCard({ ...props, namespace }));
	find(render(), (node) => node.type?.name === "ProviderRowHead").props.onToggle();
	render();
	return {
		render,
		save: () => save(),
		get stored() {
			return stored;
		},
		get dirty() {
			return dirty;
		},
		mutations,
		patches,
		close: host.unmount,
	};
}

/** DSH settings.update 的对象深合并不能表达删除，刻意保留此差异以捕获保存回归。 */
function merge(base, patch) {
	const next = { ...base };
	for (const [key, value] of Object.entries(patch)) next[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(base?.[key] ?? {}, value) : value;
	return next;
}
function find(node, predicate) {
	if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
	if (!node || typeof node !== "object") return undefined;
	return predicate(node) ? node : find(node.props?.children, predicate);
}
const editor = (view) => find(view.render(), (node) => node.type === "headers-editor");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("请求头改名保存采用整表替换，不留下旧名称且不覆盖供应商其他字段", async () => {
	const view = harness({ "X-Old": "old", "X-Keep": "keep" });
	try {
		editor(view).props.onChange({ "X-New": "new", "X-Keep": "keep" });
		view.render();
		assert.equal(await view.save(), true);
		assert.deepEqual(plain(view.stored.providers.custom.headers), { "X-New": "new", "X-Keep": "keep" });
		assert.equal(view.stored.providers.custom.baseURL, "https://example.com/v1");
		assert.deepEqual(plain(editor(view).props.value), { "X-New": "new", "X-Keep": "keep" });
		assert.equal(view.dirty, false);
	} finally {
		view.close();
	}
});

test("清空最后一个请求头不会回弹，保存后移除 headers 以恢复自动值", async () => {
	const view = harness({ "x-opencode-session": "manual" });
	try {
		editor(view).props.onChange(undefined);
		assert.equal(editor(view).props.value, undefined);
		assert.equal(view.dirty, true);
		assert.equal(await view.save(), true);
		assert.equal(Object.hasOwn(view.stored.providers.custom, "headers"), false);
		assert.equal(editor(view).props.value, undefined);
		assert.deepEqual(plain(view.mutations), [{ op: "unset", path: ["providers", "custom", "headers"] }]);
	} finally {
		view.close();
	}
});

test("空请求头值是显式覆盖，不被 prune 当作空配置丢掉", async () => {
	const view = harness({ "x-opencode-session": "manual" });
	try {
		editor(view).props.onChange({ "x-opencode-session": "" });
		view.render();
		assert.equal(await view.save(), true);
		assert.equal(view.stored.providers.custom.headers["x-opencode-session"], "");
	} finally {
		view.close();
	}
});

test("请求头写入失败保留草稿与脏标记，并显示错误", async () => {
	const view = harness({ "X-Old": "old" }, { failMutate: true });
	try {
		editor(view).props.onChange({ "X-New": "new" });
		view.render();
		assert.equal(await view.save(), false);
		assert.deepEqual(plain(editor(view).props.value), { "X-New": "new" });
		assert.equal(view.dirty, true);
		assert.ok(find(view.render(), (node) => node.props?.["data-testid"] === "dsh-save-error"));
	} finally {
		view.close();
	}
});
