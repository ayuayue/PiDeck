import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	validatePluginInstallInput,
	validatePluginLifecycleInput,
	toDynamicPluginView,
	toStaticPluginView,
	mergeStaticPluginViews,
	resolveBridgeAgent,
	pluginBridgeRpc,
	handlePluginBridgeFetch,
	apply,
} = loadTsCommonJs("src/main/dsh/pideckPluginBridge.ts", { globals: { Response } });

test("validatePluginInstallInput：host-only 源码包合法", () => {
	const result = validatePluginInstallInput({
		sessionId: "session-1",
		idPrefix: "clip",
		name: "Clipboard",
		purpose: "Clipboard panel",
		hostCode: "export default { apply(ctx) {} }",
	});
	assert.equal(result.ok, true);
	assert.equal(result.ok && result.value.idPrefix, "clip");
	assert.equal(result.ok && result.value.hostCode, "export default { apply(ctx) {} }");
	assert.equal(result.ok && result.value.clientCode, undefined);
});

test("validatePluginInstallInput：client-only 源码包合法", () => {
	const result = validatePluginInstallInput({
		sessionId: "session-1",
		idPrefix: "uip",
		name: "UI",
		purpose: "UI panel",
		clientCode: "export default { apply(ctx) {} }",
	});
	assert.equal(result.ok, true);
});

test("validatePluginInstallInput：idPrefix 必须 3-6 个小写字母", () => {
	for (const idPrefix of ["ab", "ABCD", "a1bc", "abcdefg", ""]) {
		const result = validatePluginInstallInput({
			sessionId: "session-1",
			idPrefix,
			name: "X",
			purpose: "Y",
			hostCode: "code",
		});
		assert.equal(result.ok, false, `idPrefix 应被拒绝: ${JSON.stringify(idPrefix)}`);
	}
	assert.equal(validatePluginInstallInput({ sessionId: "s", idPrefix: "abc", name: "X", purpose: "Y", hostCode: "c" }).ok, true);
});

test("validatePluginInstallInput：name/purpose/sessionId 必填，两侧源码至少其一", () => {
	assert.equal(validatePluginInstallInput({ sessionId: "", idPrefix: "abc", name: "X", purpose: "Y", hostCode: "c" }).ok, false);
	assert.equal(validatePluginInstallInput({ sessionId: "s", idPrefix: "abc", name: "", purpose: "Y", hostCode: "c" }).ok, false);
	assert.equal(validatePluginInstallInput({ sessionId: "s", idPrefix: "abc", name: "X", purpose: "", hostCode: "c" }).ok, false);
	assert.equal(validatePluginInstallInput({ sessionId: "s", idPrefix: "abc", name: "X", purpose: "Y" }).ok, false);
	assert.equal(validatePluginInstallInput(null).ok, false);
});

test("validatePluginInstallInput：源码超限拒绝", () => {
	const big = "x".repeat(1_000_001);
	const result = validatePluginInstallInput({ sessionId: "s", idPrefix: "abc", name: "X", purpose: "Y", hostCode: big });
	assert.equal(result.ok, false);
});

test("validatePluginLifecycleInput：run 需要 packageId，stop/uninstall 不需要", () => {
	assert.equal(validatePluginLifecycleInput({ sessionId: "s", pluginId: "p-1", packageId: "pkg-1", mode: "run" }).ok, true);
	assert.equal(validatePluginLifecycleInput({ sessionId: "s", pluginId: "p-1", packageId: "pkg-1", mode: "update" }).ok, true);
	assert.equal(validatePluginLifecycleInput({ sessionId: "s", pluginId: "p-1" }).ok, true);
	assert.equal(validatePluginLifecycleInput({ sessionId: "s", pluginId: "p-1", packageId: "pkg-1", mode: "delete" }).ok, false);
	assert.equal(validatePluginLifecycleInput({ sessionId: "s" }).ok, false);
	assert.equal(validatePluginLifecycleInput({ pluginId: "p-1" }).ok, false);
});

test("toDynamicPluginView：inventory 行映射为安全 JSON 视图", () => {
	// vm realm 对象原型不同，deepEqual 不可用：按字段断言
	const view = toDynamicPluginView({
		pluginId: "plugin-clip-1",
		agentId: "session-9",
		packages: [
			{ packageId: "pkg-a", name: "Clipboard", purpose: "Clip", hasHostHalf: true, hasClientHalf: false },
			{ packageId: "pkg-b", name: "Clipboard v2", purpose: "Clip", hasHostHalf: true, hasClientHalf: true },
		],
		currentPackageId: "pkg-a",
		nextPackageId: "pkg-b",
		activeRun: { pluginRunId: "run-1", packageId: "pkg-a" },
		latestRun: { status: "running", mode: "run", error: { message: "boom", stack: "at x" } },
	});
	assert.equal(view.pluginId, "plugin-clip-1");
	assert.equal(view.agentId, "session-9");
	assert.equal(view.packages.length, 2);
	assert.equal(view.packages[0].packageId, "pkg-a");
	assert.equal(view.packages[1].hasClientHalf, true);
	assert.equal(view.currentPackageId, "pkg-a");
	assert.equal(view.activeRun.pluginRunId, "run-1");
	assert.equal(view.activeRun.packageId, "pkg-a");
	assert.equal(view.status, "running");
	assert.equal(view.mode, "run");
	assert.equal(view.error, "boom");
	assert.equal(toDynamicPluginView(null), undefined);
	assert.equal(toDynamicPluginView({ pluginId: 1, agentId: "s" }), undefined);
});

test("toStaticPluginView：Loader 条目映射", () => {
	const view = toStaticPluginView({ entryId: "e1", moduleName: "@deepseek-ai/dsh-shell", enabled: false, fiberPhase: "active" });
	assert.equal(view.entryId, "e1");
	assert.equal(view.moduleName, "@deepseek-ai/dsh-shell");
	assert.equal(view.enabled, false);
	assert.equal(view.fiberPhase, "active");
	assert.equal(toStaticPluginView({ moduleName: "x" }), undefined);
});

test("mergeStaticPluginViews：同模块多条条目合并成一行（enabled 取任一启用、phase 取高优先级）", () => {
	const merged = mergeStaticPluginViews([
		{ entryId: "e1", moduleName: "@deepseek-ai/dsh-shell", enabled: false, fiberPhase: null },
		{ entryId: "e2", moduleName: "@deepseek-ai/dsh-shell", enabled: true, fiberPhase: "active" },
		{ entryId: "e3", moduleName: "@deepseek-ai/dsh-agent", enabled: true, fiberPhase: "active" },
	]);
	assert.equal(merged.length, 2);
	// 顺序按首次出现：dsh-shell 保留第一条 entryId e1，enabled 合并为 true
	assert.equal(merged[0].moduleName, "@deepseek-ai/dsh-shell");
	assert.equal(merged[0].entryId, "e1");
	assert.equal(merged[0].enabled, true);
	assert.equal(merged[0].fiberPhase, "active");
	assert.equal(merged[1].entryId, "e3");
});

test("mergeStaticPluginViews：phase 优先级 failed > active，且不改变模块顺序", () => {
	const merged = mergeStaticPluginViews([
		{ entryId: "e1", moduleName: "@deepseek-ai/m", enabled: true, fiberPhase: "active" },
		{ entryId: "e2", moduleName: "@deepseek-ai/m", enabled: true, fiberPhase: "failed" },
		{ entryId: "e3", moduleName: "@deepseek-ai/other", enabled: false, fiberPhase: "loading" },
	]);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].fiberPhase, "failed");
	assert.equal(merged[0].entryId, "e1");
	assert.equal(merged[1].moduleName, "@deepseek-ai/other");
	assert.equal(merged[1].fiberPhase, "loading");
});

test("mergeStaticPluginViews：空输入返回空、null phase 不参与优先级", () => {
	// vm realm 数组跨域，deepEqual 不可用：按长度/字段断言
	const empty = mergeStaticPluginViews([]);
	assert.equal(Array.isArray(empty), true);
	assert.equal(empty.length, 0);
	const single = mergeStaticPluginViews([{ entryId: "e1", moduleName: "m", enabled: false, fiberPhase: null }]);
	assert.equal(single.length, 1);
	assert.equal(single[0].fiberPhase, null);
});

test("resolveBridgeAgent：按 sessionId 解析 live Agent", () => {
	const agent = { id: "session-1" };
	const ctx = { get: (key) => (key === "agents" ? { get: (id) => (id === "session-1" ? agent : undefined) } : undefined) };
	// vm realm 对象原型不同，deepEqual 不可用：按引用与字段断言
	const found = resolveBridgeAgent(ctx, "session-1");
	assert.equal(found.ok, true);
	assert.equal(found.ok && found.value.agent, agent);
	assert.equal(resolveBridgeAgent(ctx, "session-missing").ok, false);
	assert.equal(resolveBridgeAgent({}, "session-1").ok, false);
});

test("pluginBridgeRpc：分发到服务方法，未知方法/缺服务返回结构化错误", async () => {
	const service = {
		inventory: () => ({ ok: true, value: [{ pluginId: "p" }] }),
		staticInventory: () => ({ ok: true, value: [] }),
		install: () => ({ ok: true, value: { pluginId: "p" } }),
		run: () => Promise.resolve({ ok: true, value: { status: "running" } }),
		stop: () => ({ ok: false, error: "not-running" }),
		uninstall: () => Promise.resolve({ ok: true, value: { ok: true, wasRunning: false } }),
	};
	assert.deepEqual(await pluginBridgeRpc(service, "inventory", undefined), { ok: true, value: [{ pluginId: "p" }] });
	assert.deepEqual(await pluginBridgeRpc(service, "run", { sessionId: "s", pluginId: "p", packageId: "pkg" }), { ok: true, value: { status: "running" } });
	assert.deepEqual(await pluginBridgeRpc(service, "stop", {}), { ok: false, error: "not-running" });
	assert.equal((await pluginBridgeRpc(service, "nope", undefined)).ok, false);
	assert.equal((await pluginBridgeRpc(undefined, "inventory", undefined)).ok, false);
});

test("handlePluginBridgeFetch：POST JSON 协议、非 POST/坏 JSON/缺服务都返回结构化 4xx", async () => {
	const ctx = {
		get: (key) => key === "pideckPluginBridge"
			? { inventory: () => ({ ok: true, value: [] }) }
			: undefined,
	};
	const ok = await handlePluginBridgeFetch(ctx, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ method: "inventory", params: undefined }),
	});
	assert.equal(ok.status, 200);
	assert.deepEqual(JSON.parse(await ok.text()), { ok: true, value: [] });

	const badMethod = await handlePluginBridgeFetch(ctx, { method: "GET" });
	assert.equal(badMethod.status, 400);

	const badJson = await handlePluginBridgeFetch(ctx, { method: "POST", body: "{nope" });
	assert.equal(badJson.status, 400);
	assert.equal(JSON.parse(await badJson.text()).ok, false);

	const missingService = await handlePluginBridgeFetch({ get: () => undefined }, {
		method: "POST",
		body: JSON.stringify({ method: "inventory" }),
	});
	assert.equal(missingService.status, 400);
	assert.equal(JSON.parse(await missingService.text()).ok, false);
});

// ── 静态 Loader 清单：必须 await（回归） ──
// 背景：dsh-host-plugin-inventory 的 list() 是 async（内部还要聚合各 preset 的
// compositionInventory）。漏 await 时快照是 Promise，entries 取不到，桥返回
// ok:true + 空数组 —— 配置页就显示「暂无静态条目（0 条）」这种静默错误。

test("staticInventory：await 异步 list()，条目映射为视图（漏 await 会静默 0 条）", async () => {
	let service;
	const ctx = {
		provide: (_name, value) => {
			service = value;
		},
		get: (name) =>
			name === "pluginInventory"
				? {
						list: async () => ({
							entries: [
								{ entryId: "pideck/agent-presets", moduleName: "@deepseek-ai/dsh-agent-presets", enabled: true, fiberPhase: "active" },
								{ entryId: "pideck/plan-mode", moduleName: "@deepseek-ai/dsh-plan-mode", enabled: false, fiberPhase: null },
							],
						}),
					}
				: undefined,
	};
	apply(ctx);
	const result = await service.staticInventory();
	assert.equal(result.ok, true);
	assert.equal(result.value.length, 2, "异步清单条目必须透传（0 条即回归）");
	assert.equal(result.value[0].moduleName, "@deepseek-ai/dsh-agent-presets");
	assert.equal(result.value[0].enabled, true);
	assert.equal(result.value[1].moduleName, "@deepseek-ai/dsh-plan-mode");
	assert.equal(result.value[1].enabled, false);
});

test("staticInventory：pluginInventory 未挂载时报结构化错误（不吞成空清单）", async () => {
	let service;
	apply({
		provide: (_name, value) => {
			service = value;
		},
		get: () => undefined,
	});
	const result = await service.staticInventory();
	assert.equal(result.ok, false);
	assert.match(result.error, /pluginInventory is not mounted/);
});
