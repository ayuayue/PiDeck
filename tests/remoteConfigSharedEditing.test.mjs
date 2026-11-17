import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const HOST = "11111111-1111-4111-8111-111111111111";
const deferred = () => {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

function loaderHarness() {
	const host = quickMessageHookHost();
	const { useConfigLoader } = loadTsCommonJs("src/renderer/src/config/configModal/useConfigLoader.ts", { stubs: { react: host.react } });
	const state = {};
	const set = (key) => (value) => {
		state[key] = typeof value === "function" ? value(state[key]) : value;
	};
	const baseline = (current) => ({ current });
	const reads = [];
	const api = {
		config: {
			getModels: async () => {
				reads.push("models");
				return { parsed: { providers: { remote: { models: [{ id: "m" }] } } }, raw: '{"providers":{}}' };
			},
			getSettings: async () => {
				reads.push("settings");
				return { parsed: { defaultModel: "remote-model" }, raw: "{}" };
			},
			getAuth: async () => ({ parsed: {}, raw: "{}" }),
			getRaw: async () => ({ raw: "{}" }),
		},
	};
	const deps = {
		api,
		rawApi: api,
		targetKind: "ssh",
		tab: "models",
		configTargetOption: { target: { kind: "ssh", hostId: HOST } },
		dirtyTabsRef: baseline(new Set()),
		mcpTabRef: baseline(null),
		applySuggestedBaseUrl: () => false,
		clearDirty: (key) => deps.dirtyTabsRef.current.delete(key),
		baselineModelsRef: baseline({ providers: {} }),
		baselineAuthRef: baseline({}),
		baselineSettingsRef: baseline({}),
		baselineTrustRef: baseline({}),
		baselineRawRef: baseline({ fileName: "models.json", content: "" }),
		baselineWslMcpRef: baseline(""),
	};
	for (const key of ["Loading", "Error", "ConfigDiagnostic", "ModelsData", "AuthData", "SettingsData", "SettingsLoaded", "TrustData", "RawContent", "RawFileName", "WslMcpRaw", "DiscoveredModels"]) deps["set" + key] = set(key);
	return { host, state, reads, deps, render: () => host.render(() => useConfigLoader(deps)) };
}

test("SSH shared loader populates normal forms and preserves dirty settings and source drafts", async () => {
	const h = loaderHarness();
	h.deps.dirtyTabsRef.current = new Set(["config:settings", "config:raw"]);
	h.deps.baselineSettingsRef.current = { draft: true };
	h.state.SettingsData = { draft: "unsaved" };
	h.state.RawContent = "unsaved raw";
	await h.render().loadConfig("models");
	assert.equal(h.state.ModelsData.providers.remote.models[0].id, "m");
	assert.deepEqual(h.reads, ["models"], "dirty views must not refresh their saved version behind a draft");
	assert.deepEqual(h.state.SettingsData, { draft: "unsaved" });
	assert.equal(h.state.RawContent, "unsaved raw");
	assert.equal(h.deps.dirtyTabsRef.current.has("config:settings"), true);
});

test("late responses from an old SSH host or unmounted page cannot replace the current editor", async () => {
	const h = loaderHarness();
	const gate = deferred();
	h.deps.api.config.getModels = () => gate.promise;
	const old = h.render().loadConfig("models");
	h.deps.api = { config: {} };
	h.deps.configTargetOption = { target: { kind: "ssh", hostId: "22222222-2222-4222-8222-222222222222" } };
	h.render();
	gate.resolve({ parsed: { providers: { stale: { models: [] } } }, raw: "{}" });
	await old;
	assert.equal(h.state.ModelsData, undefined);
	assert.equal(h.state.Loading, true, "old-host async finalizers must not set state");
	h.host.unmount();
});

test("旧主机的自适应模型查询完成时不能改写新主机的草稿", async () => {
	const host = quickMessageHookHost();
	const gate = deferred();
	const { useConfigModelRowsEditing } = loadTsCommonJs("src/renderer/src/config/configModal/useConfigModelRowsEditing.ts", { stubs: { react: host.react, "../../utils/notice": { showNotice: () => {} } } });
	const updates = [];
	const deps = {
		api: { projects: { getModelSpec: () => gate.promise } },
		modelsData: { providers: { remote: { models: [{ id: "m" }] } } },
		setModelsData: (value) => updates.push(value),
		setResettingModelKey: () => {},
		markDirty: () => {},
	};
	const old = host.render(() => useConfigModelRowsEditing(deps)).handleResetModelToAdaptive("remote", 0);
	deps.api = { projects: {} };
	host.render(() => useConfigModelRowsEditing(deps));
	gate.resolve({ contextWindow: 32000, matchedId: "m" });
	await old;
	assert.deepEqual(updates, []);
});

test("versioned raw save failure keeps content and never reloads over the draft", async () => {
	const host = quickMessageHookHost();
	const { useConfigRawEditing } = loadTsCommonJs("src/renderer/src/config/configModal/ConfigRawTab.tsx", {
		stubs: { react: host.react, "../../components/ui-shadcn/ConfirmDialog": { ConfirmDialog: () => null }, "../RawTab": { RawTab: () => null }, "../WslConfigSourceHint": { WslConfigSourceHint: () => null }, "../useConfigEditorApi": { useConfigEditor: () => ({ remote: true }) } },
	});
	let reloads = 0;
	const draft = '{"providers":{"new":{"models":[]}}}';
	const baseline = { fileName: "models.json", content: "{}" };
	const deps = {
		api: { config: {} },
		rawContent: draft,
		rawFileName: "models.json",
		baselineRawRef: { current: baseline },
		saveAndReload: async () => false,
		reloadConfig: async () => {
			reloads++;
		},
	};
	assert.equal(await host.render(() => useConfigRawEditing(deps)).handleSaveRaw(), false);
	assert.equal(reloads, 0);
	assert.equal(deps.rawContent, draft);
	assert.deepEqual(deps.baselineRawRef.current, baseline);
});

test("SSH uses the normal top save and save-all flow, stopping on failed writes", async () => {
	const host = quickMessageHookHost();
	const { useConfigSaveOrchestration } = loadTsCommonJs("src/renderer/src/config/configModal/useConfigSaveOrchestration.ts", { stubs: { react: host.react } });
	const calls = [];
	const deps = {
		configTarget: { kind: "ssh", hostId: HOST },
		configTargetOption: { target: { kind: "ssh", hostId: HOST } },
		dshUi: {},
		saving: false,
		backendPane: "pi",
		section: "config",
		tab: "models",
		addingProvider: false,
		editingProvider: null,
		providerPageSavePendingRef: { current: false },
		providerPageSaveRef: { current: undefined },
		dirtyTabs: new Set(["config:models", "config:settings"]),
		dirtyTabsRef: { current: new Set() },
		handleSaveModels: async () => {
			calls.push("models");
			return true;
		},
		handleSaveSettings: async () => {
			calls.push("settings");
			return false;
		},
		setCloseConfirmOpen: () => {},
		onClose: () => {
			calls.push("close");
		},
	};
	const actions = host.render(() => useConfigSaveOrchestration(deps));
	await actions.handleSaveCurrent();
	assert.deepEqual(calls, ["models"]);
	deps.dirtyTabsRef.current = new Set(deps.dirtyTabs);
	deps.saveSettingsDraftOnly = deps.handleSaveSettings;
	calls.length = 0;
	await host.render(() => useConfigSaveOrchestration(deps)).handleSaveAndClose();
	assert.deepEqual(calls, ["models", "settings"], "failed settings write must keep the editor open");
});

test("save-and-close waits for the provider page and does not close when its disk save fails", async () => {
	const host = quickMessageHookHost();
	const { useConfigSaveOrchestration } = loadTsCommonJs("src/renderer/src/config/configModal/useConfigSaveOrchestration.ts", { stubs: { react: host.react } });
	const calls = [];
	const pending = { current: null };
	const dirtyTabs = new Set(["config:models"]);
	const deps = {
		configTarget: { kind: "ssh", hostId: HOST },
		dshUi: {},
		backendPane: "pi",
		section: "config",
		tab: "models",
		addingProvider: true,
		editingProvider: null,
		providerPageSavePendingRef: pending,
		providerPageSaveRef: {
			current: () => {
				calls.push("submitted");
				return true;
			},
		},
		dirtyTabs,
		dirtyTabsRef: { current: dirtyTabs },
		setCloseConfirmOpen: () => {},
		onClose: () => calls.push("close"),
	};
	const saving = host.render(() => useConfigSaveOrchestration(deps)).handleSaveAndClose();
	await Promise.resolve();
	assert.deepEqual(calls, ["submitted"]);
	assert.equal(typeof pending.current, "function");
	pending.current(false);
	await saving;
	assert.deepEqual(calls, ["submitted"]);
});
