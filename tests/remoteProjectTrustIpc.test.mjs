/**
 * 远端项目 trust 的 IPC 域（P4.4b）：三通道 + 边界校验 + 门禁。
 *
 * 真 handler（`registerRemoteProjectTrustIpc`）配一个记录调用的 service 替身：测的是**边界行为**
 * （handler 第一行的入参校验、门禁关闭时的稳定码、稳定码透传与折叠），不是 service 内部（那由
 * remoteProjectTrustStore.test.mjs 覆盖）。
 *
 * 同时锁「三处同步」：通道名只来自 `shared/ipc.ts`，main 注册的就是那三个，preload 用同一批常量转发。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ROOT = "/srv/app";

/** 记录调用的 service 替身（handler 只依赖这三个方法）。 */
function createService(overrides = {}) {
	const calls = { decide: [], revoke: [], list: 0 };
	return {
		calls,
		async list() {
			calls.list += 1;
			return overrides.list ?? [];
		},
		async decide(input) {
			calls.decide.push(input);
			if (overrides.decideError) throw overrides.decideError;
			return { hostId: input.hostId, hostLabel: "Build box", canonicalRoot: input.remoteRoot, decision: input.decision, decidedAt: "2026-10-01T00:00:00.000Z", status: "active" };
		},
		async revoke(input) {
			calls.revoke.push(input);
			if (overrides.revokeError) throw overrides.revokeError;
			return overrides.removed ?? true;
		},
	};
}

/** 每个用例一份新的模块实例（handler 注册在模块加载时的闭包里）。 */
function createIpc(input) {
	const handlers = new Map();
	const { registerRemoteProjectTrustIpc } = loadTsCommonJs("src/main/ipc/remoteProjectTrustIpc.ts", {
		stubs: { electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } } },
	});
	registerRemoteProjectTrustIpc(input);
	return handlers;
}

test("三处同步：shared 定义通道名、main 注册同一批 handler、preload 用同一批常量转发", () => {
	assert.equal(ipcChannels.remoteTrustList, "remote:trust-list");
	assert.equal(ipcChannels.remoteTrustSet, "remote:trust-set");
	assert.equal(ipcChannels.remoteTrustClear, "remote:trust-clear");
	const handlers = createIpc({ enabled: true, trust: () => createService() });
	assert.deepEqual([...handlers.keys()].sort(), [ipcChannels.remoteTrustList, ipcChannels.remoteTrustSet, ipcChannels.remoteTrustClear].sort());
	const preload = preloadSource;
	for (const name of ["remoteTrustList", "remoteTrustSet", "remoteTrustClear"]) assert.match(preload, new RegExp(`ipcChannels\\.${name}`), `preload 必须经共享常量转发 ${name}`);
});

test("门禁关闭 / 未装配：三条通道都返回稳定码，不暴露「有这条路」", async () => {
	for (const input of [{ enabled: false, trust: () => createService() }, { enabled: true }]) {
		const handlers = createIpc(input);
		assert.deepEqual(plain(await handlers.get(ipcChannels.remoteTrustList)()), fail("REMOTE_FEATURE_DISABLED"));
		assert.deepEqual(plain(await handlers.get(ipcChannels.remoteTrustSet)(undefined, HOST_ID, ROOT, "approve")), fail("REMOTE_FEATURE_DISABLED"));
		assert.deepEqual(plain(await handlers.get(ipcChannels.remoteTrustClear)(undefined, HOST_ID, ROOT)), fail("REMOTE_FEATURE_DISABLED"));
	}
});

test("set 的入参在边界第一行校验：hostId / 项目根 / 决策各有自己的稳定码，且不触碰 service", async () => {
	const service = createService();
	const handlers = createIpc({ enabled: true, trust: () => service });
	const set = handlers.get(ipcChannels.remoteTrustSet);

	assert.deepEqual(plain(await set(undefined, "not-a-host-id", ROOT, "approve")), fail("REMOTE_PROJECT_TRUST_HOST_INVALID"));
	assert.deepEqual(plain(await set(undefined, undefined, ROOT, "approve")), fail("REMOTE_PROJECT_TRUST_HOST_INVALID"));
	for (const badRoot of ["srv/app", "/srv/app\nrm -rf /", "", "/" + "a".repeat(5000), 42, null]) {
		assert.deepEqual(plain(await set(undefined, HOST_ID, badRoot, "approve")), fail("REMOTE_PROJECT_TRUST_ROOT_INVALID"), `非法项目根必须被边界拒绝：${String(badRoot).slice(0, 24)}`);
	}
	for (const badDecision of ["maybe", "trust", "", undefined, true]) {
		assert.deepEqual(plain(await set(undefined, HOST_ID, ROOT, badDecision)), fail("REMOTE_PROJECT_TRUST_DECISION_INVALID"));
	}
	assert.deepEqual(plain(service.calls.decide), [], "非法入参一律不得到达 service");
});

test("set/clear 合法入参：原样交给 service，结果透传；clear 的 removed 如实回报", async () => {
	const service = createService();
	const handlers = createIpc({ enabled: true, trust: () => service });

	const setResult = await handlers.get(ipcChannels.remoteTrustSet)(undefined, HOST_ID, ROOT, "deny");
	// v5 单信封：成功载荷进 value。
	assert.deepEqual(plain(setResult), { ok: true, value: { entry: { hostId: HOST_ID, hostLabel: "Build box", canonicalRoot: ROOT, decision: "deny", decidedAt: "2026-10-01T00:00:00.000Z", status: "active" } } });
	assert.deepEqual(plain(service.calls.decide), [{ hostId: HOST_ID, remoteRoot: ROOT, decision: "deny" }], "handler 不改写也不补默认值（规范化在主进程 trust 域里做）");

	const clearResult = await handlers.get(ipcChannels.remoteTrustClear)(undefined, HOST_ID, ROOT);
	assert.deepEqual(plain(clearResult), { ok: true, value: { removed: true } });
	assert.deepEqual(plain(service.calls.revoke), [{ hostId: HOST_ID, remoteRoot: ROOT }]);
	// 入参不合法时同样不得到达 service。
	assert.deepEqual(plain(await handlers.get(ipcChannels.remoteTrustClear)(undefined, HOST_ID, "relative/path")), fail("REMOTE_PROJECT_TRUST_ROOT_INVALID"));
});

test("错误折叠：域内稳定码原样透出，自由文本一律折叠成不可用（不把内部措辞带出去）", async () => {
	const domainCode = createIpc({ enabled: true, trust: () => createService({ decideError: new Error("REMOTE_PROJECT_TRUST_ENDPOINT_UNVERIFIED") }) });
	assert.deepEqual(plain(await domainCode.get(ipcChannels.remoteTrustSet)(undefined, HOST_ID, ROOT, "approve")), fail("REMOTE_PROJECT_TRUST_ENDPOINT_UNVERIFIED"));

	const freeText = createIpc({ enabled: true, trust: () => createService({ decideError: new Error("EPERM: /home/user/.config/pideck/settings.json is busy") }) });
	assert.deepEqual(plain(await freeText.get(ipcChannels.remoteTrustSet)(undefined, HOST_ID, ROOT, "approve")), fail("REMOTE_PROJECT_TRUST_UNAVAILABLE"));

	const listFailure = createIpc({
		enabled: true,
		trust: () => ({
			async list() {
				throw new Error("boom");
			},
			decide: async () => undefined,
			revoke: async () => false,
		}),
	});
	assert.deepEqual(plain(await listFailure.get(ipcChannels.remoteTrustList)()), fail("REMOTE_PROJECT_TRUST_UNAVAILABLE"));
});

/** 失败信封的完整期望形状：code 之外还必须有 outcome（单信封契约）。 */
function fail(code) {
	return { ok: false, code, outcome: "rejected" };
}

/** 沙箱里造的对象的原型与测试文件不同：比较前复制成本地值。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}
