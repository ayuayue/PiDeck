import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 资源写通道目标路由（task-16）：local/缺省 → 原单例；wsl → 池；池缺失 fail closed；
 * 未路由的 extensions 写（install/uninstall/update…）仍保持 writeUnsupported 守卫。
 */

const shared = loadTsCommonJs("src/shared/piConfig.ts");
const routing = loadTsCommonJs("src/main/config/piResourceWriteRouting.ts");
const HOST = "11111111-1111-4111-8111-111111111111";
const WSL_OPTIONS = () => ({ target: { kind: "wsl" } });

test("路由helper：local 返回原单例且不碰池；wsl 走 pick；池缺失 fail closed", async () => {
	const local = { name: "local" };
	let picked = null;
	const pool = { prompts: async (parsed) => (picked = { kind: "pool", parsed }) };
	assert.equal(await routing.resolvePiResourceWriteManager({ options: undefined, pool, local: () => local, pick: async () => assert.fail("pool must not be used for local") }), local);
	assert.equal(await routing.resolvePiResourceWriteManager({ options: { target: { kind: "local" } }, pool, local: () => local, pick: async () => assert.fail("pool must not be used for local") }), local);
	assert.equal(picked, null);

	const result = await routing.resolvePiResourceWriteManager({ options: WSL_OPTIONS(), pool, local: () => local, pick: async (p, parsed) => await p.prompts(parsed) });
	assert.deepEqual(JSON.parse(JSON.stringify(result.parsed)), { target: { kind: "wsl" } });

	await assert.rejects(routing.resolvePiResourceWriteManager({ options: WSL_OPTIONS(), pool: undefined, local: () => local, pick: async () => local }), { message: shared.PI_RESOURCE_CODES.unavailable });
	await assert.rejects(routing.resolvePiResourceWriteManager({ options: { target: { kind: "ssh", hostId: HOST } }, pool, local: () => local, pick: async () => local }), { message: shared.PI_RESOURCE_CODES.sshUnsupported });
	await assert.rejects(routing.resolvePiResourceWriteManager({ options: { target: { kind: "wsl", hostId: "nope" } }, pool, local: () => local, pick: async () => local }), { message: shared.PI_RESOURCE_CODES.targetInvalid });
});

function createStoreHarness() {
	const handlers = new Map();
	const electron = {
		ipcMain: {
			handle(channel, handler) {
				handlers.set(channel, handler);
			},
		},
	};
	const calls = [];
	const record =
		(prefix) =>
		(...args) => {
			calls.push([prefix, ...args]);
			return prefix.endsWith(".openFolder") || prefix.endsWith(".delete") ? undefined : { name: "x", path: "x" };
		};
	const localPrompt = {
		create: record("local.prompt.create"),
		delete: record("local.prompt.delete"),
		rename: record("local.prompt.rename"),
		toggle: record("local.prompt.toggle"),
		openFolder: record("local.prompt.openFolder"),
	};
	const localExtension = { toggleFromUi: record("local.extension.toggle"), uninstall: record("local.extension.uninstall") };
	const wslManagers = {};
	const poolCalls = [];
	const piResourcePool = {
		async prompts(parsed) {
			poolCalls.push(["prompts", JSON.parse(JSON.stringify(parsed))]);
			wslManagers.prompts ??= { create: record("wsl.prompt.create"), delete: record("wsl.prompt.delete"), rename: record("wsl.prompt.rename"), toggle: record("wsl.prompt.toggle"), openFolder: record("wsl.prompt.openFolder") };
			return wslManagers.prompts;
		},
		async extensions(parsed) {
			poolCalls.push(["extensions", JSON.parse(JSON.stringify(parsed))]);
			wslManagers.extensions ??= { toggleFromUi: record("wsl.extension.toggle") };
			return wslManagers.extensions;
		},
		async skills(parsed) {
			poolCalls.push(["skills", JSON.parse(JSON.stringify(parsed))]);
			wslManagers.skills ??= { list: async () => ({ skills: [], locations: [] }) };
			return wslManagers.skills;
		},
	};
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const { registerStoreIpc } = loadTsCommonJs("src/main/ipc/storeIpc.ts", { stubs: { electron } });
	registerStoreIpc({
		promptManager: localPrompt,
		skillManager: {},
		xuePromptManager: {},
		extensionManager: localExtension,
		projectResourceManager: {},
		piResourcePool,
		appLogger: { info: async () => {}, warn: async () => {}, error: async () => {} },
		mainCopy: (key) => key,
	});
	return { handlers, ipcChannels, calls, poolCalls };
}

async function invoke(h, channel, ...args) {
	return await h.handlers.get(h.ipcChannels[channel])({}, ...args);
}

test("prompts 写通道：wsl 落池且不碰本机单例；缺省仍走本机", async () => {
	const h = createStoreHarness();
	await invoke(h, "promptsCreate", { name: "n", description: "d" }, WSL_OPTIONS());
	await invoke(h, "promptsDelete", "wsl-home/prompts/a.md", WSL_OPTIONS());
	await invoke(h, "promptsRename", "old", "new", WSL_OPTIONS());
	await invoke(h, "promptsToggle", "wsl-home/prompts/a.md", false, WSL_OPTIONS());
	await invoke(h, "promptsOpenFolder", WSL_OPTIONS());
	assert.ok(
		h.calls.every(([name]) => name.startsWith("wsl.prompt.")),
		JSON.stringify(h.calls),
	);
	assert.equal(h.calls.length, 5);

	h.calls.length = 0;
	await invoke(h, "promptsDelete", "C:/prompts/a.md");
	await invoke(h, "promptsToggle", "C:/prompts/a.md", true);
	assert.deepEqual(h.calls, [
		["local.prompt.delete", "C:/prompts/a.md"],
		["local.prompt.toggle", "C:/prompts/a.md", true],
	]);
});

test("extensions toggle：wsl 落池且不碰本机；缺省仍走本机", async () => {
	const h = createStoreHarness();
	await invoke(h, "extensionsToggle", "local-ext", true, "user", undefined, undefined, WSL_OPTIONS());
	assert.deepEqual(h.calls, [["wsl.extension.toggle", "local-ext", true, "user", undefined, undefined]]);
	h.calls.length = 0;
	await invoke(h, "extensionsToggle", "local-ext", false, "user");
	assert.deepEqual(h.calls, [["local.extension.toggle", "local-ext", false, "user", undefined, undefined]]);
});

test("未路由的 extensions 写仍是稳定码守卫（install/uninstall 不落本机也不进池）", async () => {
	const h = createStoreHarness();
	await assert.rejects(invoke(h, "extensionsUninstall", "npm:pkg", "user", undefined, WSL_OPTIONS()), { message: shared.PI_RESOURCE_CODES.writeUnsupported });
	await assert.rejects(invoke(h, "extensionsInstall", "npm:pkg", undefined, WSL_OPTIONS()), { message: shared.PI_RESOURCE_CODES.writeUnsupported });
	assert.deepEqual(h.calls, []);
	assert.deepEqual(h.poolCalls, []);
});
