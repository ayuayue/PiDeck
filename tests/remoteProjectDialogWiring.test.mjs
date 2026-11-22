import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { configModalSource } from "./helpers/configModalSources.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/**
 * 项目管理弹窗与配置页的接线契约（2026-11 远端项目管理）。
 *
 * 这一组防的是「又退回本机」这类静默回归：四个页签的失败形态都是稳定码，界面上看不出是
 * 目标绑错了还是主机拒绝了。用真实生产模块配替身端口验证项目身份能到达最终请求。
 */

const targetModel = loadTsCommonJs("src/renderer/src/config/piConfigTargetModel.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const modal = configModalSource;

test("资源管理器的目标只从入口项目派生：远端项目固定其主机，其它一律本机", () => {
	assert.deepEqual(plain(targetModel.resourceOnlyTarget(undefined)), { kind: "local" });
	assert.deepEqual(plain(targetModel.resourceOnlyTarget({ kind: "local", environment: "native", localPath: "/work/app" })), { kind: "local" });
	assert.deepEqual(plain(targetModel.resourceOnlyTarget({ kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111", remotePath: "/srv/app" })), { kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111" });
});

test("项目管理弹窗把入口项目与 projectId 一起交给编辑器，不再固定本机", () => {
	const project = {
		id: "project-remote",
		kind: "remote",
		name: "Remote App",
		path: undefined,
		locator: { kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111", remotePath: "/srv/app" },
	};
	const load = createTsSandbox({
		stubs: {
			"react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
			"lucide-react": { FolderOpen: "FolderOpen", X: "X" },
			"../../ConfigModal": { ConfigPane: "ConfigPane" },
			"../../rendererUtils": { isChatProject: () => false },
			"../../../../shared/projectLocation": { isRemoteProject: () => true },
			"../../i18n": { t: (key) => key },
			"../ui-shadcn/alert": { Alert: "Alert", AlertDescription: "AlertDescription" },
			"../ui-shadcn/button": { Button: "Button" },
			"../ui-shadcn/dialog": { Dialog: "Dialog", DialogClose: "DialogClose", DialogContent: "DialogContent", DialogDescription: "DialogDescription", DialogHeader: "DialogHeader", DialogTitle: "DialogTitle" },
		},
	});
	const { ProjectResourcesModal } = load("src/renderer/src/components/app/ProjectResourcesModal.tsx");
	const tree = ProjectResourcesModal({ project, onClose: () => {} });
	const find = (node, type) => {
		if (node === null || typeof node !== "object") return undefined;
		if (node.type === type) return node;
		const children = node.props?.children;
		for (const child of Array.isArray(children) ? children : [children]) {
			const match = find(child, type);
			if (match) return match;
		}
		return undefined;
	};
	const pane = find(tree, "ConfigPane");
	assert.ok(pane);
	assert.equal(pane.props.projectId, project.id);
	assert.equal(pane.props.projectKind, project.kind);
	assert.equal(pane.props.projects.length, 1);
	assert.equal(pane.props.projects[0].id, project.id);
	assert.match(modal, /useConfigEditorApi\(configTarget, window\.piDesktop, resourceOnly \? projectId : undefined\)/);

	const remoteApi = { marker: "remote" };
	const calls = [];
	const configHooks = loadTsCommonJs("src/renderer/src/config/useConfigEditorApi.ts", {
		stubs: {
			react: { createContext: (value) => ({ current: value }), useContext: (context) => context.current, useMemo: (factory) => factory() },
			"../desktopApi": { desktopApi: {} },
			"./useRemoteHostConnection": { useRemoteHostConnection: () => ({ ensureConnected: async () => ({ ok: true }) }) },
			"./remoteConfigEditorApi": {
				createRemoteConfigEditorApi: (...args) => {
					calls.push(args);
					return { api: remoteApi, rawApi: remoteApi };
				},
			},
		},
	});
	const localApi = { marker: "local" };
	const editor = configHooks.useConfigEditorApi({ kind: "ssh", hostId: project.locator.hostId }, localApi, project.id);
	assert.equal(editor.remote, true);
	assert.equal(editor.api.api, remoteApi);
	assert.equal(editor.rawApi, remoteApi);
	assert.equal(calls[0][3], project.id);
});

test("projectId 到达远端资源与 MCP 请求", async () => {
	const hostId = "11111111-1111-4111-8111-111111111111";
	const projectRequests = [];
	const resourceResult = {
		home: "/home/tester",
		projectRoot: "/srv/app",
		files: [],
		discovery: { overrides: {} },
	};
	const { createRemoteResourceEditorApi } = loadTsCommonJs("src/renderer/src/config/remoteResourceEditorApi.ts", {
		stubs: {
			"../utils/clipboard": { writeClipboard: async () => {} },
			"../utils/notice": { showNotice: () => {} },
			"../i18n": { t: (key) => key },
			minimatch: { minimatch: () => true },
			"../../../shared/promptStoreVariables": { convertStoreVarsToPiVars: (value) => value },
		},
	});
	const resources = createRemoteResourceEditorApi(
		{
			remotePiResources: async (host, request) => {
				projectRequests.push({ host, request });
				return resourceResult;
			},
		},
		hostId,
		async () => {},
		"project-remote",
	);
	const project = await resources.projectResources.list();
	assert.equal(project.skillLocations[0].path, "/srv/app/.pi/skills");
	assert.deepEqual(plain(projectRequests), [{ host: hostId, request: { action: "list", scope: "project", projectId: "project-remote" } }]);

	const mcpRequests = [];
	const { createRemoteConfigEditorApi } = loadTsCommonJs("src/renderer/src/config/remoteConfigEditorApi.ts", {
		stubs: {
			"../i18n": { t: (key) => key },
			"./remoteConfigDocument": { remoteConfigDocument: (data) => ({ data }) },
			"../utils/deepEqual": { deepEqual: () => true },
			"./remoteConfigModel": { readRemoteConfigSnapshot: () => ({}), readRemoteConfigWriteReceipt: () => ({}) },
			"./remoteAuthEditorApi": { createRemoteAuthEditor: () => ({ read: async () => ({}), write: async () => ({ valid: true }) }) },
			"./remoteResourceEditorApi": { createRemoteResourceEditorApi: () => ({ config: {} }) },
		},
	});
	const mcp = createRemoteConfigEditorApi(
		{
			remotePiMcp: async (host, request) => {
				mcpRequests.push({ host, request });
				if (request.action === "snapshot") return { action: "snapshot", snapshot: { servers: [] } };
				if (request.action === "save") return { action: "save", valid: true };
				return { action: "list", report: { servers: [] } };
			},
		},
		hostId,
		async () => ({ ok: true }),
		"project-remote",
	);
	const projectScope = { scope: "project", projectId: "project-remote" };
	assert.deepEqual(plain(await mcp.config.getMcp(projectScope)), { servers: [] });
	assert.deepEqual(plain(await mcp.config.saveMcp({ servers: [] }, projectScope, "revision-1")), { valid: true });
	assert.deepEqual(plain(await mcp.config.mcpListStatus(projectScope)), { servers: [] });
	assert.deepEqual(plain(mcpRequests.map(({ request }) => request)), [
		{ action: "snapshot", scope: "project", projectId: "project-remote" },
		{ action: "save", file: { servers: [] }, expectedVersion: "revision-1", scope: "project", projectId: "project-remote" },
		{ action: "list", scope: "project", projectId: "project-remote" },
	]);
});

test("保存分发：MCP 页只有 WSL 走文本保存，其余走 McpTab 自己的保存", async () => {
	const host = quickMessageHookHost();
	const { useConfigSaveOrchestration } = loadTsCommonJs("src/renderer/src/config/configModal/useConfigSaveOrchestration.ts", {
		stubs: {
			react: host.react,
			"../../i18n": { t: (key) => key },
			"../configDirtyMarks": { orderDirtyKeysForSave: (keys) => [...keys] },
			"./configModalStorage": { sectionTabValue: (section, tab) => `${section}:${tab}` },
		},
	});
	const events = [];
	const noSave = async () => false;
	const deps = {
		configTarget: { kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111" },
		configTargetOption: undefined,
		dshUi: { showDshConfigForms: false },
		saving: false,
		backendPane: "pi",
		section: "config",
		tab: "mcp",
		addingProvider: false,
		editingProvider: null,
		providerPageSaveRef: { current: undefined },
		providerPageSavePendingRef: { current: null },
		dirtyTabs: new Set(["config:mcp"]),
		dirtyTabsRef: { current: new Set(["config:mcp"]) },
		clearDirty: (key) => events.push(`clear:${key}`),
		markDirty: (key) => events.push(`dirty:${key}`),
		onSaved: () => events.push("saved"),
		showToast: (message) => events.push(`toast:${message}`),
		handleSaveModels: noSave,
		saveSettingsDraftOnly: noSave,
		handleSaveAuth: noSave,
		handleSaveSettings: noSave,
		handleSaveTrust: noSave,
		handleSaveWslMcp: async () => {
			events.push("wsl-save");
			return true;
		},
		handleSaveRaw: noSave,
		saveGlobalSkillEditor: noSave,
		handleSaveEditPrompt: noSave,
		securitySectionRef: { current: null },
		dshConfigRef: { current: null },
		mcpTabRef: {
			current: {
				save: async () => {
					events.push("mcp-save");
					return true;
				},
			},
		},
		resourceMcpTabRef: { current: null },
		setCloseConfirmOpen: () => {},
		onClose: () => {},
	};
	await host.render(() => useConfigSaveOrchestration(deps)).handleSaveCurrent();
	assert.deepEqual(events, ["mcp-save", "clear:config:mcp", "saved", "toast:config.saved"]);

	events.length = 0;
	const wslDeps = { ...deps, configTarget: { kind: "wsl", hostId: "wsl-test" } };
	await host.render(() => useConfigSaveOrchestration(wslDeps)).handleSaveCurrent();
	assert.deepEqual(events, ["wsl-save"]);
});
