/**
 * 模型目录更新 IPC 边界测试。
 *
 * 两个易错点：分支参数只在白名单内（防 URL/路径注入），
 * 以及手动更新/还原后必须通知装配层重取结论——否则「更新成功了但提示还在」
 * （快照要等下一轮定时检查才更新，默认 2h）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 捕获 ipcMain.handle 注册的处理器，模拟 invoke。 */
function loadCatalogIpc() {
	const handlers = new Map();
	const electronStub = {
		ipcMain: {
			handle(channel, handler) {
				handlers.set(channel, handler);
			},
		},
	};
	const mod = loadTsCommonJs("src/main/ipc/catalogIpc.ts", { stubs: { electron: electronStub } });
	return { ...mod, handlers };
}

function createFakeUpdater() {
	const calls = [];
	return {
		calls,
		getStatus: () => ({ overlay: null, builtin: null, hasOverlayFiles: false }),
		checkRemote: async (branch) => {
			calls.push(["checkRemote", branch]);
			return { ok: true, remoteVersion: "9.9.9", hasUpdate: true };
		},
		update: async (branch) => {
			calls.push(["update", branch]);
			return { ok: true, updated: true };
		},
		restoreBuiltin: () => {
			calls.push(["restoreBuiltin"]);
			return { ok: true, updated: true };
		},
		restorePrevious: () => {
			calls.push(["restorePrevious"]);
			return { ok: true, updated: true };
		},
	};
}

test("catalog: 手动更新/还原后回调 onCatalogChanged（提示不能留到下一轮定时检查）", async () => {
	const { registerCatalogIpc, handlers } = loadCatalogIpc();
	const updater = createFakeUpdater();
	const changed = [];
	registerCatalogIpc(updater, { onCatalogChanged: (kind) => changed.push(kind) });

	await handlers.get("catalog:update-from-github")({}, "main");
	handlers.get("catalog:update-restore")();
	handlers.get("catalog:update-restore-previous")();
	assert.deepEqual(changed, ["update", "restore", "restore"]);

	// 只读接口不该触发重取（每次描边都打一次网络检查）
	await handlers.get("catalog:update-status")();
	await handlers.get("catalog:update-check")({}, "main");
	assert.deepEqual(changed, ["update", "restore", "restore"]);
});

test("catalog: 更新失败也回调（本轮结论已变，提示不应停在旧结论上）", async () => {
	const { registerCatalogIpc, handlers } = loadCatalogIpc();
	const updater = createFakeUpdater();
	updater.update = async () => ({ ok: false, code: "network", message: "both sources down" });
	const changed = [];
	registerCatalogIpc(updater, { onCatalogChanged: (kind) => changed.push(kind) });

	const result = await handlers.get("catalog:update-from-github")({}, "main");
	assert.equal(result.ok, false);
	assert.deepEqual(changed, ["update"]);
});

test("catalog: 分支参数仅接受白名单，非法值回落 main", async () => {
	const { registerCatalogIpc, handlers } = loadCatalogIpc();
	const updater = createFakeUpdater();
	registerCatalogIpc(updater);

	await handlers.get("catalog:update-check")({}, "main");
	await handlers.get("catalog:update-check")({}, "dev");
	await handlers.get("catalog:update-check")({}, "../../etc/passwd");
	await handlers.get("catalog:update-check")({}, undefined);
	await handlers.get("catalog:update-from-github")({}, "https://evil.example/x");
	assert.deepEqual(updater.calls, [
		["checkRemote", "main"],
		["checkRemote", "dev"],
		["checkRemote", "main"],
		["checkRemote", "main"],
		["update", "main"],
	]);
});
