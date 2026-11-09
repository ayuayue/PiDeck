import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端 pi 环境域（`remote:pi-probe` / `remote:pi-path`）的边界契约。
 *
 * 用户反馈的现场：添加连接后另开一个进度弹窗，最后一步「准备远端 pi」从未真正探测过。
 * 现在整条检测内联在添加表单里，这两条通道就是它的数据来源，所以这里钉住四件事：
 * 1. 两个通道都真的注册上（漏一处 = 运行时 undefined）；
 * 2. 失败一律折叠成稳定码，异常消息与命令都不外传；
 * 3. 手填路径必须先过形状校验（远端绝对路径 + 档案 token 字符集），非法值一个请求都不发；
 * 4. 写路径走服务（同一个锁内写库 + 作废缓存），写成功后立刻重探。
 */
const HOST_ID = "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

function handlersFor(input) {
	const handlers = new Map();
	const { registerRemoteHostPiIpc } = loadTsCommonJs("src/main/ipc/remoteHostPiIpc.ts", {
		stubs: {
			electron: {
				ipcMain: {
					handle(channel, handler) {
						handlers.set(channel, handler);
					},
				},
			},
		},
	});
	registerRemoteHostPiIpc(input);
	return handlers;
}

const facts = { nodePath: "/usr/bin/node", piPath: "/home/me/.nvm/versions/node/v22.11.0/bin/pi", version: "0.85.1", runnerPath: "/home/me/.pideck/remote-host/bundles/x/runner.mjs", deployRoot: "/home/me/.pideck/remote-host" };

function serviceWith(overrides = {}) {
	const calls = { probe: [], set: [] };
	const service = {
		async remotePiRuntimeFacts(hostId) {
			calls.probe.push(hostId);
			return { ...facts };
		},
		async setRemotePiCommand(hostId, command) {
			calls.set.push({ hostId, command });
		},
		...overrides,
	};
	return { service, calls, resolveService: async () => ({ service }) };
}

test("both pi channels are registered and honour the feature gate", async () => {
	const handlers = handlersFor({ enabled: false, resolveService: async () => ({ code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" }) });
	assert.ok(handlers.has("remote:pi-probe"), "remote:pi-probe must be registered");
	assert.ok(handlers.has("remote:pi-path"), "remote:pi-path must be registered");
	assert.deepEqual(JSON.parse(JSON.stringify(await handlers.get("remote:pi-probe")(null, HOST_ID))), { ok: false, hostId: HOST_ID, code: "REMOTE_FEATURE_DISABLED" });
	assert.deepEqual(JSON.parse(JSON.stringify(await handlers.get("remote:pi-path")(null, HOST_ID, "/home/me/bin/pi"))), { ok: false, hostId: HOST_ID, code: "REMOTE_FEATURE_DISABLED" });
});

test("a probe returns the renderer-safe facts and nothing else", async () => {
	const { resolveService, calls } = serviceWith();
	const handler = handlersFor({ enabled: true, resolveService }).get("remote:pi-probe");
	const result = await handler(null, HOST_ID);
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, hostId: HOST_ID, piPath: facts.piPath, version: facts.version });
	assert.equal("nodePath" in result, false, "the node path must not cross IPC");
	assert.equal("runnerPath" in result, false, "deploy paths must not cross IPC");
	assert.deepEqual(calls.probe, [HOST_ID]);
});

test("a probe carries the verification warning when the version is above the checked window", async () => {
	const { resolveService } = serviceWith({ async remotePiRuntimeFacts() {
		return { ...facts, version: "0.86.0", warning: "REMOTE_PI_VERSION_UNVERIFIED" };
	} });
	const handler = handlersFor({ enabled: true, resolveService }).get("remote:pi-probe");
	const result = await handler(null, HOST_ID);
	assert.equal(result.ok, true);
	assert.equal(result.warning, "REMOTE_PI_VERSION_UNVERIFIED");
});

test("probe failures collapse to a stable code, never free text", async () => {
	const handler = handlersFor({
		enabled: true,
		resolveService: async () => ({
			service: {
				async remotePiRuntimeFacts() {
					throw new Error("REMOTE_PI_NOT_FOUND");
				},
				async setRemotePiCommand() {},
			},
		}),
	}).get("remote:pi-probe");
	assert.equal((await handler(null, HOST_ID)).code, "REMOTE_PI_NOT_FOUND");
	const noisy = handlersFor({
		enabled: true,
		resolveService: async () => ({
			service: {
				async remotePiRuntimeFacts() {
					throw new Error("ssh: connect to host example.com port 22 failed");
				},
				async setRemotePiCommand() {},
			},
		}),
	}).get("remote:pi-probe");
	assert.equal((await noisy(null, HOST_ID)).code, "REMOTE_PI_PROBE_FAILED");
});

test("a malformed host id is refused before the service is touched", async () => {
	let touched = 0;
	const handler = handlersFor({
		enabled: true,
		resolveService: async () => {
			touched += 1;
			return { service: {} };
		},
	}).get("remote:pi-probe");
	const result = await handler(null, "../../etc/passwd");
	assert.equal(result.code, "REMOTE_HOST_ID_INVALID");
	assert.equal(touched, 0);
});

test("an explicit pi path is validated in-process before anything is written", async () => {
	const { service, calls, resolveService } = serviceWith();
	const handler = handlersFor({ enabled: true, resolveService }).get("remote:pi-path");
	for (const bad of ["pi", "~/bin/pi", "/home/me/bin dir/pi", "/home/用户/bin/pi", "/usr/../bin/pi", "/usr/bin/pi/", 42]) {
		const result = await handler(null, HOST_ID, bad);
		assert.equal(result.code, "REMOTE_PI_PATH_INVALID", `must reject ${String(bad)}`);
	}
	assert.deepEqual(calls.set, [], "no write may happen for a path that cannot be persisted");
	assert.deepEqual(calls.probe, []);
	assert.equal(typeof service.setRemotePiCommand, "function");
});

test("a valid path is written through the service and probed again in the same call", async () => {
	const { calls, resolveService } = serviceWith();
	const handler = handlersFor({ enabled: true, resolveService }).get("remote:pi-path");
	const result = await handler(null, HOST_ID, "/home/me/bin/pi-coding-agent");
	assert.equal(result.ok, true);
	assert.deepEqual(calls.set, [{ hostId: HOST_ID, command: "/home/me/bin/pi-coding-agent" }]);
	assert.deepEqual(calls.probe, [HOST_ID], "the answer must come from a fresh probe, not from the input");
});

test("null clears the override instead of writing an empty path", async () => {
	const { calls, resolveService } = serviceWith();
	const handler = handlersFor({ enabled: true, resolveService }).get("remote:pi-path");
	await handler(null, HOST_ID, null);
	assert.deepEqual(calls.set, [{ hostId: HOST_ID, command: undefined }]);
	assert.deepEqual(calls.probe, [HOST_ID]);
});

test("a store that refuses the write reports its own stable code", async () => {
	const handler = handlersFor({
		enabled: true,
		resolveService: async () => ({
			service: {
				async remotePiRuntimeFacts() {
					return { ...facts };
				},
				async setRemotePiCommand() {
					throw new Error("REMOTE_HOST_STORE_NEEDS_REPAIR");
				},
			},
		}),
	}).get("remote:pi-path");
	const result = await handler(null, HOST_ID, "/home/me/bin/pi");
	assert.equal(result.code, "REMOTE_HOST_STORE_NEEDS_REPAIR");
});

test("an unavailable connection service is a stable code, not a rejection", async () => {
	const handler = handlersFor({ enabled: true, resolveService: async () => ({ code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" }) }).get("remote:pi-probe");
	assert.equal((await handler(null, HOST_ID)).code, "REMOTE_CONNECTION_SERVICE_UNAVAILABLE");
});
