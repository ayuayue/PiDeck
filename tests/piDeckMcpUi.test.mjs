import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (v) => JSON.parse(JSON.stringify(v));
// 宿主返回的状态必须带回全部字段：refresh/apply 会把它们写回草稿，缺字段会把草稿清成 undefined。
const state = { enabled: false, running: false, projectIds: [], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: false, projects: [{ id: "p1", name: "Project" }] };
function harness(api) {
	const host = quickMessageHookHost();
	const { usePiDeckMcp } = loadTsCommonJs("src/renderer/src/hooks/usePiDeckMcp.ts", { stubs: { react: host.react, "../desktopApi": { desktopApi: { piDeckMcp: api } } } });
	return { render: () => host.render(usePiDeckMcp), unmount: host.unmount };
}

test("MCP consent hook keeps scope drafts explicit and prevents duplicate same-frame mutations", async () => {
	let finish;
	const calls = [];
	const h = harness({
		getState: async () => ({ ok: true, value: state }),
		setAccess: (input) => {
			calls.push(plain(input));
			return new Promise((r) => {
				finish = r;
			});
		},
	});
	h.render();
	await flush();
	h.render().setProjectIds(["p1"]);
	const view = h.render();
	const first = view.apply(true);
	await view.apply(true);
	assert.deepEqual(calls, [{ enabled: true, projectIds: ["p1"], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: false }]);
	assert.equal(h.render().busy, true);
	finish({ ok: true, value: { ...state, enabled: true, running: true, projectIds: ["p1"] } });
	await first;
	assert.equal(h.render().state.running, true);
});

test("select-all / clear-selection data path: a draft holding every project id is applied verbatim", async () => {
	const many = {
		enabled: true,
		running: true,
		projectIds: ["p1"],
		allProjects: false,
		allowControl: false,
		allowAgentWrite: false,
		allowAutomationWrite: false,
		allowFavoritesWrite: false,
		projects: [
			{ id: "p1", name: "A" },
			{ id: "p2", name: "B" },
			{ id: "p3", name: "C" },
		],
	};
	const calls = [];
	const h = harness({
		getState: async () => ({ ok: true, value: many }),
		setAccess: async (input) => {
			calls.push(plain(input));
			return { ok: true, value: { ...many, projectIds: input.projectIds } };
		},
	});
	h.render();
	await flush();
	// 面板「全选」写入的就是当前项目列表的 id 全集，「全不选」写入空数组；两者都必须原样到达 IPC。
	h.render().setProjectIds(many.projects.map((project) => project.id));
	await h.render().apply(true);
	h.render().setProjectIds([]);
	await h.render().apply(true);
	assert.deepEqual(calls, [
		{ enabled: true, projectIds: ["p1", "p2", "p3"], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: false },
		{ enabled: true, projectIds: [], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: false },
	]);
});

test("通配授权与写开关随 apply 一起提交，关闭时一并撤回", async () => {
	const wildcard = { enabled: true, running: true, projectIds: [], allProjects: true, allowControl: true, allowAgentWrite: true, allowAutomationWrite: true, allowFavoritesWrite: true, projects: [{ id: "p1", name: "A" }] };
	const calls = [];
	const h = harness({
		getState: async () => ({ ok: true, value: wildcard }),
		setAccess: async (input) => {
			calls.push(plain(input));
			return { ok: true, value: { ...wildcard, ...input } };
		},
	});
	h.render();
	await flush();
	// 通配模式下白名单可以为空：否则「所有项目」会被 project-required 卡在草稿里保存不了。
	await h.render().apply(true);
	assert.deepEqual(calls, [{ enabled: true, projectIds: [], allProjects: true, allowControl: true, allowAgentWrite: true, allowAutomationWrite: true, allowFavoritesWrite: true }]);
	h.render().setAllProjects(false);
	h.render().setAllowControl(false);
	h.render().setAllowAgentWrite(false);
	h.render().setAllowAutomationWrite(false);
	await h.render().apply(false);
	// 关闭 = 撤回全部授权：写开关必须落回安全默认，而不是留在磁盘上等下次启用。
	assert.deepEqual(calls[1], { enabled: false, projectIds: [], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: false });
	assert.equal(h.render().allProjects, false);
	assert.equal(h.render().allowControl, false);
	assert.equal(h.render().allowAgentWrite, false);
	assert.equal(h.render().allowAutomationWrite, false);
	assert.equal(h.render().allowFavoritesWrite, false);
});

test("MCP export fetched after unmount cannot run a config write or clipboard action", async () => {
	let finish;
	const actions = [];
	const h = harness({
		getState: async () => ({ ok: true, value: state }),
		connection: () =>
			new Promise((r) => {
				finish = r;
			}),
	});
	h.render();
	await flush();
	const pending = h.render().withConnection(async (value) => {
		actions.push(value);
		return true;
	});
	h.unmount();
	finish({ ok: true, value: { mcpServers: { pideck: { enabled: false } } } });
	assert.equal(await pending, false);
	assert.deepEqual(actions, []);
});

test("failed host update refreshes actual running state and exposes the error", async () => {
	let calls = 0;
	const h = harness({ getState: async () => ({ ok: true, value: ++calls === 1 ? { ...state, running: true } : state }), setAccess: async () => ({ ok: false, code: "config-write-failed" }) });
	h.render();
	await flush();
	await h.render().apply(false);
	assert.equal(h.render().state.running, false);
	assert.equal(h.render().error, "config-write-failed");
	assert.equal(h.render().busy, false);
});

test("connection handoff merges without overwriting existing local/inherited services and stays disabled", () => {
	const { addPiDeckMcpDefinition } = loadTsCommonJs("src/renderer/src/config/piDeckMcpConfigMerge.ts");
	const current = { autoEnableCodemode: false, custom: { preserved: true }, mcpServers: { other: { command: "other", custom: true } } };
	const definition = { url: "http://127.0.0.1:1234/mcp", headers: { Authorization: "Bearer test" }, enabled: true };
	const next = plain(addPiDeckMcpDefinition(current, new Set(["other"]), definition));
	assert.deepEqual(next, { ...current, mcpServers: { ...current.mcpServers, pideck: { ...definition, enabled: false } } });
	assert.equal(addPiDeckMcpDefinition(current, new Set(["pideck"]), definition), null);
	assert.equal(addPiDeckMcpDefinition(next, new Set(), definition), null);
	assert.equal(current.mcpServers.pideck, undefined);
});

test("saved consent remains revocable when its listener could not start", async () => {
	const host = quickMessageHookHost();
	const updates = [];
	const control = (name) => ({ [name]: () => null });
	const { PiDeckMcpPanel } = loadTsCommonJs("src/renderer/src/config/PiDeckMcpPanel.tsx", {
		stubs: {
			react: { ...host.react, useId: () => "mcp" },
			"../i18n": { t: (key) => key },
			"../desktopApi": {
				desktopApi: {
					piDeckMcp: {
						getState: async () => ({ ok: true, value: { ...state, enabled: true, running: false, error: "listen-failed" } }),
						setAccess: async (access) => {
							updates.push(plain(access));
							return { ok: true, value: state };
						},
					},
				},
			},
			"../components/ui-shadcn/button": control("Button"),
			"../components/ui-shadcn/checkbox": control("Checkbox"),
			"../components/ui-shadcn/label": control("Label"),
		},
	});
	const render = () => host.render(() => PiDeckMcpPanel({ existingNames: new Set(), disabled: false, onAdd: async () => true }));
	const nodes = (element) => (Array.isArray(element) ? element.flatMap(nodes) : element?.props ? [element, ...nodes(element.props.children)] : []);
	render();
	await flush();
	const disable = nodes(render()).find((node) => node.props.children === "config.mcp.pideck.disable").props;
	assert.equal(disable.disabled, false);
	disable.onClick();
	await flush();
	assert.deepEqual(updates, [{ enabled: false, projectIds: [], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: false }]);
	host.unmount();
});

test("PiDeck catalog uses dedicated consent panel, native logo and localized controls; no remote management fallback", () => {
	const read = (path) => readFileSync(path, "utf8");
	assert.match(read("src/renderer/src/config/McpTab.tsx"), /selectedTemplateDefinition\?\.id\s*===\s*"pideck"\s*\?\s*\(\s*<PiDeckMcpPanel/);
	// 上游新增 logoStyle 品牌切换（自定义图优先，其次 pi-tui 专属三色标，否则 LogoMark）：契约断言都算「原生 logo」，不把品牌开关误判为回退
	const mcpViews = read("src/renderer/src/config/McpResourceViews.tsx");
	assert.match(mcpViews, /entry\.id\s*===\s*"pideck"\s*&&\s*customLogo\s*\?\s*\(?\s*<img src=\{customLogo\}/, "pideck 目录条目必须优先用自定义品牌图");
	assert.match(mcpViews, /entry\.id\s*===\s*"pideck"\s*&&\s*logoStyle\s*===\s*"pi-tui"\s*\?\s*\(?\s*<PiTuiLogoMark/, "pideck 目录条目在 pi-tui 风格下用官方三色标");
	const preview = read("src/renderer/src/previewApi.ts");
	assert.match(preview, /piDeckMcp:\s*\{[\s\S]*?getState:\s*async\s*\(\)\s*=>\s*\(\{\s*ok:\s*false,\s*code:\s*"desktop-only"/);
	for (const locale of ["zh-CN", "en-US", "zh-TW"]) assert.match(read(`src/renderer/src/i18n/rendererCopy.${locale}.ts`), /"config\.mcp\.pideck\.warning"\s*:/);
	// 一键授权入口：按钮文案必须来自 i18n 词典，删掉按钮或硬编码文案都会红。
	const panel = read("src/renderer/src/config/PiDeckMcpPanel.tsx");
	for (const key of ["config.mcp.pideck.selectAll", "config.mcp.pideck.selectNone", "config.mcp.pideck.allProjects", "config.mcp.pideck.allowControl", "config.mcp.pideck.allowAgentWrite", "config.mcp.pideck.allowAutomationWrite", "config.mcp.pideck.allowFavoritesWrite"])
		assert.match(panel, new RegExp(`t\\(\\s*"${key.replace(/\./g, "\\.")}"`), `面板缺少 ${key}`);
});

test("智能体写开关随 apply 提交，关闭时一并撤回", async () => {
	const calls = [];
	const h = harness({
		getState: async () => ({ ok: true, value: state }),
		setAccess: async (input) => {
			calls.push(plain(input));
			return { ok: true, value: { ...state, ...input } };
		},
	});
	h.render();
	await flush();
	h.render().setProjectIds(["p1"]);
	h.render().setAllowAgentWrite(true);
	await h.render().apply(true);
	assert.deepEqual(calls[0], { enabled: true, projectIds: ["p1"], allProjects: false, allowControl: false, allowAgentWrite: true, allowAutomationWrite: false, allowFavoritesWrite: false });
	await h.render().apply(false);
	assert.deepEqual(calls[1], { enabled: false, projectIds: [], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: false });
	assert.equal(h.render().allowAgentWrite, false);
});

test("定时任务写开关随 apply 提交，关闭时一并撤回", async () => {
	const calls = [];
	const h = harness({
		getState: async () => ({ ok: true, value: state }),
		setAccess: async (input) => {
			calls.push(plain(input));
			return { ok: true, value: { ...state, ...input } };
		},
	});
	h.render();
	await flush();
	h.render().setProjectIds(["p1"]);
	h.render().setAllowAutomationWrite(true);
	await h.render().apply(true);
	assert.deepEqual(calls[0], { enabled: true, projectIds: ["p1"], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: true, allowFavoritesWrite: false });
	await h.render().apply(false);
	assert.deepEqual(calls[1], { enabled: false, projectIds: [], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: false });
	assert.equal(h.render().allowAutomationWrite, false);
	assert.equal(h.render().allowFavoritesWrite, false);
});

test("收藏写开关随 apply 提交，关闭时一并撤回", async () => {
	const calls = [];
	const h = harness({
		getState: async () => ({ ok: true, value: state }),
		setAccess: async (input) => {
			calls.push(plain(input));
			return { ok: true, value: { ...state, ...input } };
		},
	});
	h.render();
	await flush();
	h.render().setProjectIds(["p1"]);
	h.render().setAllowFavoritesWrite(true);
	await h.render().apply(true);
	assert.deepEqual(calls[0], { enabled: true, projectIds: ["p1"], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: true });
	await h.render().apply(false);
	assert.deepEqual(calls[1], { enabled: false, projectIds: [], allProjects: false, allowControl: false, allowAgentWrite: false, allowAutomationWrite: false, allowFavoritesWrite: false });
	assert.equal(h.render().allowFavoritesWrite, false);
});
