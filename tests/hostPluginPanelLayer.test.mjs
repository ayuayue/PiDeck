import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { atom, createStore } from "jotai/vanilla";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: (specifier) => imports[specifier] ?? nodeRequire(specifier), Map }, { filename: filePath });
	return module.exports;
}

/**
 * 会话列同一时刻只呈现一层**页面**：页面式插件面板与「定时任务/智能体/收藏」页面互斥。
 * 打开页面式面板必须同时让页面失活，否则 App 里「页面激活就收起面板」的 effect 会在同一次
 * 提交里把刚打开的面板关掉，表现成「停在定时任务/智能体页面时点会话分组没反应」。
 * 对话框/浮层只浮在页面之上，不该让页面失活。
 */
function loadAtoms() {
	const workspacePageAtoms = compileModule("src/renderer/src/atoms/workspace-page-atoms.ts", {
		"./session-state-atoms": { currentSessionIdAtom: atom(undefined) },
		"../utils/workspacePageTabs": compileModule("src/renderer/src/utils/workspacePageTabs.ts"),
	});
	const hostPluginAtoms = compileModule("src/renderer/src/atoms/host-plugin-atoms.ts", {
		"./workspace-page-atoms": workspacePageAtoms,
		// 面板 atom 模块在求值时只持有 desktopApi 引用，这里给最小桩，不触网。
		"../desktopApi": { desktopApi: { hostPlugins: { list: async () => ({ ok: true, value: { plugins: [] } }), onChanged: () => () => {} } } },
		"../../../shared/types/hostPlugin": {},
	});
	return { workspacePageAtoms, hostPluginAtoms };
}

function catalogWith(presentation) {
	return {
		catalog: {
			plugins: [
				{
					enabled: true,
					fingerprint: "fp",
					manifest: { id: "session-groups", name: "会话分组", contributes: { panels: [{ id: "main", title: "会话分组", presentation }] } },
				},
			],
		},
	};
}

const PAGE_PANEL = { pluginId: "session-groups", panelId: "main" };

test("打开页面式插件面板会让工作区页面失活，且页面 Tab 保留", () => {
	const { workspacePageAtoms, hostPluginAtoms } = loadAtoms();
	const store = createStore();
	store.set(hostPluginAtoms.hostPluginCatalogAtom, catalogWith("page"));
	store.set(workspacePageAtoms.openWorkspacePageAtom, "agents");
	assert.equal(store.get(workspacePageAtoms.activeWorkspacePageAtom), "agents");

	store.set(hostPluginAtoms.openHostPluginPanelAtom, PAGE_PANEL);

	assert.deepEqual(store.get(hostPluginAtoms.hostPluginPanelAtom), PAGE_PANEL);
	assert.equal(store.get(workspacePageAtoms.activeWorkspacePageAtom), null, "面板打开后页面必须失活，否则会被互斥 effect 立刻关掉");
	assert.deepEqual(Array.from(store.get(workspacePageAtoms.openWorkspacePageIdsAtom)), ["agents"], "失活不等于关闭，页面 Tab 仍在，切回来状态还在");
});

test("打开对话框面板不打断工作区页面", () => {
	const { workspacePageAtoms, hostPluginAtoms } = loadAtoms();
	const store = createStore();
	store.set(hostPluginAtoms.hostPluginCatalogAtom, catalogWith("modal"));
	store.set(workspacePageAtoms.openWorkspacePageAtom, "automation");

	store.set(hostPluginAtoms.openHostPluginPanelAtom, PAGE_PANEL);

	assert.equal(store.get(workspacePageAtoms.activeWorkspacePageAtom), "automation");
});

test("收起面板不影响已经失活的页面，页面可再激活", () => {
	const { workspacePageAtoms, hostPluginAtoms } = loadAtoms();
	const store = createStore();
	store.set(hostPluginAtoms.hostPluginCatalogAtom, catalogWith("page"));
	store.set(workspacePageAtoms.openWorkspacePageAtom, "automation");
	store.set(hostPluginAtoms.openHostPluginPanelAtom, PAGE_PANEL);
	store.set(hostPluginAtoms.openHostPluginPanelAtom, null);

	assert.equal(store.get(hostPluginAtoms.hostPluginPanelAtom), null);
	assert.equal(store.get(workspacePageAtoms.activeWorkspacePageAtom), null);

	store.set(workspacePageAtoms.openWorkspacePageAtom, "automation");
	assert.equal(store.get(workspacePageAtoms.activeWorkspacePageAtom), "automation");
});

test("没有页面在呈现时打开面板不会动页面状态", () => {
	const { workspacePageAtoms, hostPluginAtoms } = loadAtoms();
	const store = createStore();
	store.set(hostPluginAtoms.hostPluginCatalogAtom, catalogWith("page"));
	store.set(hostPluginAtoms.openHostPluginPanelAtom, PAGE_PANEL);

	assert.equal(store.get(workspacePageAtoms.activeWorkspacePageAtom), null);
	assert.deepEqual(Array.from(store.get(workspacePageAtoms.openWorkspacePageIdsAtom)), []);
});
