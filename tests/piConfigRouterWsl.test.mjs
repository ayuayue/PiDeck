import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * PiConfigRouter 第三条路由（P1-1）：wsl 目标只走 WslPiConfigStore。
 *
 * 断言的都是「哪个端口被调用」这类行为：
 * - wsl 目标绝不落本机 ConfigManager（读/写都一样），本机目标也绝不碰 wsl 存储；
 * - wsl 保存与本地同语义：整文件写入，不需要 expectedVersion/patch；
 * - provider test/fetch/usage 对 wsl 目标与 ssh 同口径拒绝（WSL 侧不发起任何请求）；
 * - 未装配 wsl 存储时 fail closed（WSL_CONFIG_UNAVAILABLE），不偷偷退回本机。
 */

const routerModule = loadTsCommonJs("src/main/config/PiConfigRouter.ts");
const shared = loadTsCommonJs("src/shared/piConfig.ts");
const HOST = "11111111-1111-4111-8111-111111111111";
const VERSION = "c".repeat(64);

async function rejectionCode(run) {
	try {
		await run();
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
	throw new Error("EXPECTED_REJECTION");
}

function harness(options = {}) {
	const localCalls = [];
	const remoteCalls = [];
	const wslCalls = [];
	const local = {
		getModelsConfig: async () => {
			localCalls.push("read-models");
			return { raw: "{}", parsed: { providers: {} } };
		},
		getSettingsConfig: async () => {
			localCalls.push("read-settings");
			return { raw: "{}", parsed: {} };
		},
		saveModelsConfig: async () => {
			localCalls.push("save-models");
			return { valid: true };
		},
		saveSettingsConfig: async () => {
			localCalls.push("save-settings");
			return { valid: true };
		},
		getRawConfig: async (file) => {
			localCalls.push(["raw-read", file]);
			return { raw: "{}" };
		},
		saveRawConfig: async (file, raw) => {
			localCalls.push(["raw-save", file, raw]);
			return { valid: true };
		},
	};
	const remote = {
		read: async (input) => {
			remoteCalls.push(["read", input]);
			return { kind: "remote", hostId: input.hostId, file: input.file, version: VERSION, sha256: VERSION, data: { providers: {} }, secrets: [] };
		},
		readAuth: async (input) => {
			remoteCalls.push(["read-auth", input]);
			return { kind: "remote-auth", hostId: input.hostId, version: VERSION, sha256: VERSION, providers: [{ provider: "openai", type: "api_key", configured: true }] };
		},
		patch: async (input) => {
			remoteCalls.push(["patch", input]);
			return { kind: "remote", hostId: input.hostId, file: input.file, version: VERSION, sha256: VERSION };
		},
	};
	const wsl = {
		read: async (input) => {
			wslCalls.push(["read", input]);
			return { kind: "wsl", file: input.file, distro: "Ubuntu-26.04", user: "dev", data: { providers: {} } };
		},
		saveModels: async (input) => {
			wslCalls.push(["save-models", input]);
			return options.saveFails ? { valid: false, error: "mainConfig.providerNameInvalid:../evil" } : { valid: true, receipt: { kind: "wsl", file: "models" } };
		},
		saveSettings: async (input) => {
			wslCalls.push(["save-settings", input]);
			return { valid: true, receipt: { kind: "wsl", file: "settings" } };
		},
		readRaw: async (input) => {
			wslCalls.push(["raw-read", input]);
			return { raw: "{}" };
		},
		saveRaw: async (input) => {
			wslCalls.push(["raw-save", input]);
			return { valid: true, receipt: { kind: "wsl", file: input.file } };
		},
	};
	const router = routerModule.createPiConfigRouter({ local, remote: options.remote === false ? undefined : remote, wsl: options.wsl === false ? undefined : wsl });
	return { router, localCalls, remoteCalls, wslCalls };
}

test("wsl 目标只走 WslPiConfigStore：不落本机 ConfigManager，也不走 ssh 后端", async () => {
	const h = harness();
	const models = await h.router.readModels({ target: { kind: "wsl" } });
	assert.equal(models.kind, "wsl");
	assert.deepEqual(JSON.parse(JSON.stringify(h.wslCalls[0])), ["read", { file: "models" }]);
	assert.deepEqual(h.localCalls, []);
	assert.deepEqual(h.remoteCalls, []);

	const settings = await h.router.readSettings({ target: { kind: "wsl" } });
	assert.equal(settings.kind, "wsl");
	assert.deepEqual(JSON.parse(JSON.stringify(h.wslCalls[1])), ["read", { file: "settings" }]);

	const savedModels = await h.router.saveModels({ providers: {} }, { target: { kind: "wsl" } });
	assert.equal(savedModels.kind, "wsl");
	assert.equal(savedModels.value.valid, true);
	assert.deepEqual(JSON.parse(JSON.stringify(savedModels.value.receipt)), { kind: "wsl", file: "models" });
	const savedSettings = await h.router.saveSettings({ theme: "dark" }, { target: { kind: "wsl" } });
	assert.equal(savedSettings.kind, "wsl");
	assert.deepEqual(JSON.parse(JSON.stringify(savedSettings.value.receipt)), { kind: "wsl", file: "settings" });
	assert.deepEqual(h.localCalls, [], "wsl 目标不得读写本机配置");
	assert.deepEqual(h.remoteCalls, [], "wsl 目标不得走 ssh 后端");
});

test("wsl 保存的校验失败原样回到渲染层（与本地一致的 ConfigValidationResult 语义）", async () => {
	const h = harness({ saveFails: true });
	const result = await h.router.saveModels({ providers: { "../evil": { models: [] } } }, { target: { kind: "wsl" } });
	assert.equal(result.kind, "wsl");
	assert.equal(result.value.valid, false);
	assert.match(result.value.error, /providerNameInvalid/);
	assert.deepEqual(h.localCalls, []);
});

test("本机/ssh 目标不受第三条路由影响", async () => {
	const h = harness();
	const local = await h.router.readModels();
	assert.equal(local.kind, "local");
	const ssh = await h.router.readModels({ target: { kind: "ssh", hostId: HOST } });
	assert.equal(ssh.kind, "remote");
	await h.router.saveSettings({ theme: "dark" }, { target: { kind: "ssh", hostId: HOST }, expectedVersion: VERSION, patch: { theme: "dark" } });
	assert.deepEqual(h.wslCalls, [], "本机/ssh 目标不得碰 wsl 存储");
});

test("wsl 目标 fail closed：未装配存储回 WSL_CONFIG_UNAVAILABLE，渲染层自报身份回 WSL_CONFIG_TARGET_INVALID", async () => {
	const unavailable = harness({ wsl: false });
	assert.equal(await rejectionCode(() => unavailable.router.readModels({ target: { kind: "wsl" } })), shared.WSL_CONFIG_CODES.unavailable);
	assert.equal(await rejectionCode(() => unavailable.router.saveModels({ providers: {} }, { target: { kind: "wsl" } })), shared.WSL_CONFIG_CODES.unavailable);
	assert.deepEqual(unavailable.localCalls, []);

	const h = harness();
	assert.equal(await rejectionCode(() => h.router.readModels({ target: { kind: "wsl", hostId: "bad" } })), shared.WSL_CONFIG_CODES.targetInvalid);
	// wsl 不接受 ssh 的版本守卫字段（整文件写入语义）。
	assert.equal(await rejectionCode(() => h.router.saveModels({ providers: {} }, { target: { kind: "wsl" }, expectedVersion: VERSION, patch: {} })), shared.WSL_CONFIG_CODES.targetInvalid);
	assert.deepEqual(h.wslCalls, []);
	assert.deepEqual(h.localCalls, []);
});

test("源文件级读写按 target 路由：本机回原文、wsl 落发行版目录、ssh 只发脱敏帧", async () => {
	const local = harness();
	const localRaw = await local.router.readRaw("trust", undefined);
	assert.equal(localRaw.kind, "local");
	assert.deepEqual(JSON.parse(JSON.stringify(local.localCalls)), [["raw-read", "trust"]]);
	const rawText = JSON.stringify({ "/srv": true }, null, 2);
	await local.router.writeRaw("trust", rawText, undefined);
	assert.deepEqual(JSON.parse(JSON.stringify(local.localCalls[1])), ["raw-save", "trust", rawText]);

	const wsl = harness();
	const wslRead = await wsl.router.readRaw("auth", { target: { kind: "wsl" } });
	assert.equal(wslRead.kind, "wsl");
	assert.deepEqual(JSON.parse(JSON.stringify(wsl.wslCalls[0])), ["raw-read", { file: "auth" }]);
	const wslSave = await wsl.router.writeRaw("auth", '{"openai":{"key":"sk-x"}}', { target: { kind: "wsl" } });
	assert.equal(wslSave.kind, "wsl");
	assert.deepEqual(JSON.parse(JSON.stringify(wsl.wslCalls[1])), ["raw-save", { file: "auth", raw: '{"openai":{"key":"sk-x"}}' }]);
	assert.deepEqual(wsl.localCalls, [], "wsl 目标不得碰本机读取器");
	assert.deepEqual(wsl.remoteCalls, []);

	const ssh = harness();
	const sshRead = await ssh.router.readRaw("mcp", { target: { kind: "ssh", hostId: HOST } });
	assert.equal(sshRead.kind, "remote");
	assert.deepEqual(JSON.parse(JSON.stringify(ssh.remoteCalls[0])), ["read", { hostId: HOST, file: "mcp" }]);
	// ssh 写只接受 patch 守卫；body 在 ssh 路由被忽略。
	await ssh.router.writeRaw("mcp", "ignored body", { target: { kind: "ssh", hostId: HOST }, expectedVersion: VERSION, patch: { mcpServers: {} } });
	assert.deepEqual(JSON.parse(JSON.stringify(ssh.remoteCalls[1])), ["patch", { hostId: HOST, file: "mcp", expectedVersion: VERSION, patch: { mcpServers: {} } }]);
	assert.equal(await rejectionCode(() => ssh.router.writeRaw("mcp", "{}", { target: { kind: "ssh", hostId: HOST } })), shared.REMOTE_CONFIG_CODES.versionConflict);
	// ssh 的 auth.json 只能读派生视图；写入依旧被拒（patch 白名单不含 auth）。
	const sshAuth = await ssh.router.readRaw("auth", { target: { kind: "ssh", hostId: HOST } });
	assert.equal(sshAuth.kind, "remote-auth");
	assert.deepEqual(JSON.parse(JSON.stringify(ssh.remoteCalls[2])), ["read-auth", { hostId: HOST }]);
	assert.equal(await rejectionCode(() => ssh.router.writeRaw("auth", "{}", { target: { kind: "ssh", hostId: HOST }, expectedVersion: VERSION, patch: {} })), shared.REMOTE_CONFIG_CODES.targetInvalid);
	assert.deepEqual(ssh.localCalls, []);
});

test("未知文件名一律拒绝，不做「按文件名猜文件」的兜底", async () => {
	const h = harness();
	assert.equal(await rejectionCode(() => h.router.readRaw("secrets", undefined)), shared.WSL_CONFIG_CODES.targetInvalid);
	assert.equal(await rejectionCode(() => h.router.writeRaw("../auth", "{}", undefined)), shared.WSL_CONFIG_CODES.targetInvalid);
	assert.deepEqual(h.localCalls, []);
});

test("provider test / 拉取模型 / 用量查询：非本机目标一律在发起请求前拒绝", async () => {
	assert.doesNotThrow(() => routerModule.rejectRemotePiConfigTarget(undefined));
	assert.doesNotThrow(() => routerModule.rejectRemotePiConfigTarget({ kind: "local" }));
	for (const target of [{ kind: "ssh", hostId: HOST }, { kind: "wsl" }]) {
		assert.equal(
			(() => {
				try {
					routerModule.rejectRemotePiConfigTarget(target);
					return "ALLOWED";
				} catch (error) {
					return error.message;
				}
			})(),
			shared.REMOTE_CONFIG_CODES.providerOperationUnsupported,
			JSON.stringify(target),
		);
	}
});
