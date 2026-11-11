import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 资源 IPC 目标路由（W1）：prompts.list/edit 与 extensions.list 带可选 target。
 *
 * 断言按 IPC 边界：缺省 options 走本机单例（存量调用零变化）；wsl target 走池；
 * 非法/ssh 目标在触碰任何管理器前回稳定码；池未装配时回退本机而不是报错。
 */

const shared = loadTsCommonJs("src/shared/piConfig.ts");
const HOST = "11111111-1111-4111-8111-111111111111";
const LOCAL_PROMPT = "C:/prompts/a.md";
const WSL_PROMPT = "wsl-home/.pi/agent/prompts/a.md";

function createHarness(options = {}) {
	const handlers = new Map();
	const electron = {
		ipcMain: {
			handle(channel, handler) {
				handlers.set(channel, handler);
			},
		},
	};
	const calls = [];
	const localPrompt = {
		async list() {
			calls.push(["local.prompts.list"]);
			return { templates: [], globalDir: "C:/local" };
		},
		async readContent(path) {
			calls.push(["local.prompts.read", path]);
			return "local";
		},
		async writeContent(path, content) {
			calls.push(["local.prompts.write", path, content]);
		},
	};
	const localExtension = {
		async list(force) {
			calls.push(["local.extensions.list", force]);
			return { extensions: [] };
		},
	};
	const wslPrompt = {
		async list() {
			calls.push(["wsl.prompts.list"]);
			return { templates: [], globalDir: "wsl-home/.pi/agent/prompts" };
		},
		async readContent(path) {
			calls.push(["wsl.prompts.read", path]);
			return "wsl";
		},
		async writeContent(path, content) {
			calls.push(["wsl.prompts.write", path, content]);
		},
	};
	const wslExtension = {
		async list(force) {
			calls.push(["wsl.extensions.list", force]);
			return { extensions: [] };
		},
	};
	const poolCalls = [];
	const piResourcePool = options.piResourcePool ?? {
		// 与真实池同语义：本机目标返回装配单例，wsl 目标返回该档案的实例。
		async prompts(parsed) {
			poolCalls.push(["prompts", JSON.parse(JSON.stringify(parsed))]);
			return parsed?.target?.kind === "wsl" ? wslPrompt : localPrompt;
		},
		async extensions(parsed) {
			poolCalls.push(["extensions", JSON.parse(JSON.stringify(parsed))]);
			return parsed?.target?.kind === "wsl" ? wslExtension : localExtension;
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
		piResourcePool: options.noPool ? undefined : piResourcePool,
		appLogger: { info: async () => {}, warn: async () => {}, error: async () => {} },
		mainCopy: (key) => key,
	});
	return { handlers, ipcChannels, calls, poolCalls };
}

const wslOptions = () => ({ target: { kind: "wsl" } });
const parsedWsl = () => ({ target: { kind: "wsl" } });

test("缺省 options 保持旧行为：本机单例、池不参与", async () => {
	const { handlers, ipcChannels, calls, poolCalls } = createHarness();
	await handlers.get(ipcChannels.promptsList)({});
	await handlers.get(ipcChannels.promptsEdit)({}, LOCAL_PROMPT);
	await handlers.get(ipcChannels.promptsEdit)({}, LOCAL_PROMPT, "body");
	await handlers.get(ipcChannels.extensionsList)({});
	assert.deepEqual(calls, [["local.prompts.list"], ["local.prompts.read", LOCAL_PROMPT], ["local.prompts.write", LOCAL_PROMPT, "body"], ["local.extensions.list", false]]);
	// 池会被询问，但本机目标不带 wsl target（真实池此时返回本机单例，不构造任何实例）。
	assert.ok(
		poolCalls.every(([, parsed]) => parsed.target === undefined),
		JSON.stringify(poolCalls),
	);
});

test("wsl target 走池：list/read/save 都命中该档案的管理器", async () => {
	const { handlers, ipcChannels, calls, poolCalls } = createHarness();
	await handlers.get(ipcChannels.promptsList)({}, wslOptions());
	await handlers.get(ipcChannels.promptsEdit)({}, WSL_PROMPT, undefined, wslOptions());
	await handlers.get(ipcChannels.promptsEdit)({}, WSL_PROMPT, "body", wslOptions());
	await handlers.get(ipcChannels.extensionsList)({}, true, wslOptions());
	assert.deepEqual(calls, [["wsl.prompts.list"], ["wsl.prompts.read", WSL_PROMPT], ["wsl.prompts.write", WSL_PROMPT, "body"], ["wsl.extensions.list", true]]);
	assert.deepEqual(poolCalls, [
		["prompts", parsedWsl()],
		["prompts", parsedWsl()],
		["prompts", parsedWsl()],
		["extensions", parsedWsl()],
	]);
});

test("非法/ssh 目标在管理器之前失败：回闭集稳定码且不落本机", async () => {
	const { handlers, ipcChannels, calls, poolCalls } = createHarness();
	await assert.rejects(handlers.get(ipcChannels.promptsList)({}, { target: { kind: "ssh", hostId: HOST } }), { message: shared.PI_RESOURCE_CODES.sshUnsupported });
	await assert.rejects(handlers.get(ipcChannels.promptsEdit)({}, LOCAL_PROMPT, "body", { target: { kind: "wsl", hostId: "nope" } }), { message: shared.PI_RESOURCE_CODES.targetInvalid });
	await assert.rejects(handlers.get(ipcChannels.extensionsList)({}, false, { target: { kind: "local" }, refreshAll: true }), { message: shared.PI_RESOURCE_CODES.targetInvalid });
	assert.deepEqual(calls, []);
	assert.deepEqual(poolCalls, []);
});

test("池未装配时回退本机单例（不因装配顺序让资源页不可用）", async () => {
	const { handlers, ipcChannels, calls } = createHarness({ noPool: true });
	await handlers.get(ipcChannels.promptsList)({}, wslOptions());
	await handlers.get(ipcChannels.extensionsList)({});
	assert.deepEqual(calls, [["local.prompts.list"], ["local.extensions.list", false]]);
});
