import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { autoUpdateDshRuntimeIfOutdated } = loadTsCommonJs(
	"src/main/dsh/runtime/dshRuntimeAutoUpdate.ts",
);

/** 构造一组可注入替身：状态/安装/扫描/删除全部可控，默认配置为 outdated 场景。 */
function makeDeps(overrides = {}) {
	const calls = { installs: 0, refreshes: 0, uninstalls: [], ready: 0 };
	const deps = {
		getStatus: () => ({
			state: "outdated",
			runtimeVersion: "0.1.1-rc.2",
			declaredRuntimeVersion: "0.1.5-rc.1",
			source: "managed",
		}),
		refresh: () => {
			calls.refreshes += 1;
			return { state: "installed", runtimeVersion: "0.1.5-rc.1", source: "managed" };
		},
		install: async () => {
			calls.installs += 1;
			return { ok: true };
		},
		listInstalled: () => [
			{ dirName: "0.1.1-rc.2", manifest: { runtimeVersion: "0.1.1-rc.2" } },
			{ dirName: "0.1.5-rc.1", manifest: { runtimeVersion: "0.1.5-rc.1" } },
		],
		resolveActiveDirName: () => "0.1.5-rc.1",
		uninstall: async (dirName) => {
			calls.uninstalls.push(dirName);
		},
		appVersion: () => "0.7.5",
		isPackaged: () => true,
		onRuntimeReady: () => {
			calls.ready += 1;
		},
		log: () => {},
		...overrides,
	};
	return { deps, calls };
}

test("自动更新：outdated 时安装 → 刷新 → 回收旧版本 → 就绪回调", async () => {
	const { deps, calls } = makeDeps();
	const result = await autoUpdateDshRuntimeIfOutdated(deps);
	assert.equal(result.action, "updated");
	assert.equal(result.runtimeVersion, "0.1.5-rc.1");
	assert.equal(calls.installs, 1);
	assert.equal(calls.refreshes, 1);
	// 只回收旧版本，新启用目录保留
	assert.deepEqual(calls.uninstalls, ["0.1.1-rc.2"]);
	assert.equal(result.pruned.length, 1);
	assert.equal(calls.ready, 1);
});

test("自动更新：非打包态跳过（dev 项目 node_modules 即声明版本）", async () => {
	const { deps, calls } = makeDeps({ isPackaged: () => false });
	const result = await autoUpdateDshRuntimeIfOutdated(deps);
	// 跨 realm（vm 加载 TS）对象原型不同，逐字段断言而不是 deepStrictEqual。
	assert.equal(result.action, "skipped");
	assert.equal(result.reason, "not-packaged");
	assert.equal(calls.installs, 0);
	assert.equal(calls.ready, 0);
});

test("自动更新：状态非 outdated（installed/notInstalled）跳过，不静默安装", async () => {
	const installed = makeDeps({
		getStatus: () => ({ state: "installed", runtimeVersion: "0.1.5-rc.1", source: "managed" }),
	});
	const installedResult = await autoUpdateDshRuntimeIfOutdated(installed.deps);
	assert.equal(installedResult.action, "skipped");
	assert.equal(installedResult.reason, "state-not-outdated");
	assert.equal(installed.calls.installs, 0);

	const notInstalled = makeDeps({
		getStatus: () => ({ state: "notInstalled", declaredRuntimeVersion: "0.1.5-rc.1" }),
	});
	const notInstalledResult = await autoUpdateDshRuntimeIfOutdated(notInstalled.deps);
	assert.equal(notInstalledResult.action, "skipped");
	assert.equal(notInstalledResult.reason, "state-not-outdated");
	assert.equal(notInstalled.calls.installs, 0, "notInstalled 保持安装引导，不自动下载");
});

test("自动更新：安装失败时回收与就绪回调都不执行", async () => {
	const { deps, calls } = makeDeps({ install: async () => ({ ok: false, error: "runtime index unavailable" }) });
	const result = await autoUpdateDshRuntimeIfOutdated(deps);
	assert.equal(result.action, "install-failed");
	assert.equal(result.error, "runtime index unavailable");
	assert.equal(calls.refreshes, 0);
	assert.equal(calls.uninstalls.length, 0);
	assert.equal(calls.ready, 0);
});

test("自动更新：单个旧目录删除失败不阻断其余回收与就绪回调", async () => {
	const { deps, calls } = makeDeps({
		uninstall: async (dirName) => {
			calls.uninstalls.push(dirName);
			if (dirName === "0.1.1-rc.2") {
				throw new Error('failed to remove runtime directory "0.1.1-rc.2": EPERM');
			}
		},
		listInstalled: () => [
			{ dirName: "0.1.0", manifest: { runtimeVersion: "0.1.0" } },
			{ dirName: "0.1.1-rc.2", manifest: { runtimeVersion: "0.1.1-rc.2" } },
			{ dirName: "0.1.5-rc.1", manifest: { runtimeVersion: "0.1.5-rc.1" } },
		],
	});
	const result = await autoUpdateDshRuntimeIfOutdated(deps);
	assert.equal(result.action, "updated");
	assert.equal(result.pruned.length, 1);
	assert.equal(result.pruned[0], "0.1.0");
	assert.equal(result.pruneErrors.length, 1);
	assert.equal(result.pruneErrors[0].dirName, "0.1.1-rc.2");
	assert.equal(calls.ready, 1, "回收失败不影响新 runtime 启用");
});
