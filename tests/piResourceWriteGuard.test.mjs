import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 资源写通道一致性（task-14）：未路由的写操作在非本机 target 下必须由主进程拒绝。
 *
 * 为什么：UI 已在 WSL 目标下拦截这些动作，但 handler 仍指向本机单例——一旦渲染层被绕过/回归，
 * 用户的 WSL 操作会静默写成 Windows HOME 内容。这里按 IPC 边界断言：非本机 target 回稳定码且
 * 不调用本机 manager；缺省 options 的本机行为逐字不变。
 */

const shared = loadTsCommonJs("src/shared/piConfig.ts");
const target = loadTsCommonJs("src/main/config/piResourceTarget.ts");
const HOST = "11111111-1111-4111-8111-111111111111";

const WSL_OPTIONS = () => ({ target: { kind: "wsl" } });
const SSH_OPTIONS = () => ({ target: { kind: "ssh", hostId: HOST } });

function createHarness() {
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
		(name) =>
		(...args) => {
			calls.push([name, ...args]);
			return name.startsWith("extension.update") ? { updated: true, output: "" } : undefined;
		};
	const promptManager = {
		create: record("prompt.create"),
		delete: record("prompt.delete"),
		rename: record("prompt.rename"),
		toggle: record("prompt.toggle"),
		openFolder: record("prompt.openFolder"),
	};
	const extensionManager = {
		install: record("extension.install"),
		removeBuiltIn: record("extension.removeBuiltIn"),
		restoreBuiltIn: record("extension.restoreBuiltIn"),
		uninstall: record("extension.uninstall"),
		toggleFromUi: record("extension.toggle"),
		updateExtensions: record("extension.updateAll"),
		updateExtension: record("extension.updateOne"),
	};
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const { registerStoreIpc } = loadTsCommonJs("src/main/ipc/storeIpc.ts", { stubs: { electron } });
	registerStoreIpc({
		promptManager,
		skillManager: {},
		xuePromptManager: {},
		extensionManager,
		projectResourceManager: {},
		appLogger: { info: async () => {}, warn: async () => {}, error: async () => {} },
		mainCopy: (key) => key,
	});
	return { handlers, ipcChannels, calls };
}

async function invoke(harness, channel, ...args) {
	const handler = harness.handlers.get(harness.ipcChannels[channel]);
	assert.ok(handler, "missing handler " + channel);
	// 统一 await：同步 handler（如 openFolder）抛错也要变成 rejected promise 供 assert.rejects 观察。
	return await handler({}, ...args);
}

test("requireLocalPiResourceTarget：缺省/local 放行，wsl 回 writeUnsupported，ssh 回 sshUnsupported", () => {
	assert.equal(target.requireLocalPiResourceTarget(undefined), undefined);
	assert.equal(target.requireLocalPiResourceTarget({ target: { kind: "local" } }), undefined);
	assert.throws(() => target.requireLocalPiResourceTarget(WSL_OPTIONS()), { message: shared.PI_RESOURCE_CODES.writeUnsupported });
	assert.throws(() => target.requireLocalPiResourceTarget(SSH_OPTIONS()), { message: shared.PI_RESOURCE_CODES.sshUnsupported });
	assert.throws(() => target.requireLocalPiResourceTarget({ target: { kind: "local" }, force: true }), { message: shared.PI_RESOURCE_CODES.targetInvalid });
});

test("prompt 写通道（task-16 起已路由）：wsl target 在池未装配时 fail closed，绝不回退本机", async () => {
	const h = createHarness();
	const cases = [
		["promptsCreate", [{ name: "n", description: "d" }, WSL_OPTIONS()]],
		["promptsDelete", ["C:/prompts/a.md", WSL_OPTIONS()]],
		["promptsRename", ["old", "new", WSL_OPTIONS()]],
		["promptsToggle", ["C:/prompts/a.md", true, WSL_OPTIONS()]],
		["promptsOpenFolder", [WSL_OPTIONS()]],
	];
	for (const [channel, args] of cases) {
		await assert.rejects(invoke(h, channel, ...args), { message: shared.PI_RESOURCE_CODES.unavailable }, channel);
	}
	assert.deepEqual(h.calls, []);
	await assert.rejects(invoke(h, "promptsDelete", "C:/prompts/a.md", SSH_OPTIONS()), { message: shared.PI_RESOURCE_CODES.sshUnsupported });
	assert.deepEqual(h.calls, []);
});

test("商店导入与技能安装同样拒绝非本机 target（底层都写入全局资源目录）", async () => {
	const h = createHarness();
	const item = { title: "Demo", description: "demo", content: "body" };
	const cases = [
		["promptStoreImport", [{ ...item }, WSL_OPTIONS()]],
		["skillStoreImport", [item, "pi-global", undefined, WSL_OPTIONS()]],
		["skillHubInstall", ["owner/skill", undefined, WSL_OPTIONS()]],
		["yaoPromptsImport", ["slug", "cat", undefined, WSL_OPTIONS()]],
	];
	for (const [channel, args] of cases) {
		await assert.rejects(invoke(h, channel, ...args), { message: shared.PI_RESOURCE_CODES.writeUnsupported }, channel);
	}
	assert.deepEqual(h.calls, []);
});

test("extension 写通道：toggle 已路由（池缺失 fail closed），install/uninstall/update 等仍为稳定码守卫", async () => {
	const h = createHarness();
	await assert.rejects(invoke(h, "extensionsToggle", "npm:pkg", true, "user", undefined, undefined, WSL_OPTIONS()), { message: shared.PI_RESOURCE_CODES.unavailable });
	const guarded = [
		["extensionsRemoveBuiltIn", ["local-ext", WSL_OPTIONS()]],
		["extensionsRestoreBuiltIn", ["local-ext", WSL_OPTIONS()]],
		["extensionsUninstall", ["npm:pkg", "user", undefined, WSL_OPTIONS()]],
		["extensionsInstall", ["npm:pkg", undefined, WSL_OPTIONS()]],
		["extensionsUpdate", [WSL_OPTIONS()]],
		["extensionsUpdateOne", ["npm:pkg", WSL_OPTIONS()]],
	];
	for (const [channel, args] of guarded) {
		await assert.rejects(invoke(h, channel, ...args), { message: shared.PI_RESOURCE_CODES.writeUnsupported }, channel);
	}
	assert.deepEqual(h.calls, []);
});

test("缺省 options 的本机行为不变：写通道照常调用本机 manager", async () => {
	const h = createHarness();
	await invoke(h, "promptsDelete", "C:/prompts/a.md");
	await invoke(h, "promptsToggle", "C:/prompts/a.md", false);
	await invoke(h, "extensionsToggle", "local-ext", true, "user");
	await invoke(h, "extensionsUpdateOne", "local-ext");
	assert.deepEqual(h.calls, [
		["prompt.delete", "C:/prompts/a.md"],
		["prompt.toggle", "C:/prompts/a.md", false],
		["extension.toggle", "local-ext", true, "user", undefined, undefined],
		["extension.updateOne", "local-ext"],
	]);
});
