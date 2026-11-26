import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * pi 升级后的收尾（账本 P1「更新完成后失效 versionCache 并提示已有 Agent 需重启」）。
 *
 * 两半：
 *   1. **版本探测缓存失效**：`PiSelfUpdateRunner.update()` 的 finally 里同时清
 *      `ExtensionManager.piVersion`（resetVersionProbeCache）与 `PiProcess.versionCache`，
 *      失败也要清（失败的更新器可能已经改了文件）。
 *   2. **提示重启**：升级只换磁盘上的可执行文件，已经 spawn 的 pi 进程仍跑旧版本——
 *      渲染层在更新成功时提示「已开的会话要重启才用新版本」（`utils/piUpdateHint`）。
 *
 * 不做「有几个会话要重启」的计数：预热池、其他窗口的会话都会让数字偏差，一句话说清
 * 事实更可靠，也免得为一个可能错的数字再加一条 IPC 契约。
 */

/** 载入 runner；`./PiProcess` 换成计数桩——静态版本缓存就在那里清。 */
function loadRunner() {
	const calls = { invalidateVersionCache: 0 };
	const { PiSelfUpdateRunner } = loadTsCommonJs("src/main/pi/piSelfUpdateRunner.ts", {
		stubs: {
			electron: { app: { getPath: () => process.cwd(), getVersion: () => "0.0.0", isPackaged: false } },
			"../logging/sharedLogger": { getAppLogger: () => null },
			"./PiProcess": {
				PiProcess: {
					invalidateVersionCache: () => {
						calls.invalidateVersionCache += 1;
					},
				},
			},
		},
	});
	return { PiSelfUpdateRunner, calls };
}

function makeRunner(PiSelfUpdateRunner, { currentVersion = "1.6.1", latestVersion = "1.7.0", fail = true } = {}) {
	const calls = { resetVersionProbeCache: 0, runPi: 0 };
	const runner = new PiSelfUpdateRunner({
		locator: { check: async () => ({ installed: true, version: currentVersion, command: "/usr/local/bin/pi" }) },
		getSettings: () => ({ customPiPath: "", wslEnabled: false }),
		translate: (key) => key,
		sanitizeCommandOutput: (value) => value,
		runPi: async () => {
			calls.runPi += 1;
			if (fail) throw new Error("boom");
			return "updated";
		},
		resetVersionProbeCache: () => {
			calls.resetVersionProbeCache += 1;
		},
		homeDir: () => process.cwd(),
	});
	// 不碰网络：版本接口直接给出目标版本
	runner.fetchLatestVersion = async () => ({ version: latestVersion });
	return { runner, calls };
}

test("更新失败也清两份版本探测缓存（失败的更新器可能已替换磁盘文件）", async () => {
	const { PiSelfUpdateRunner, calls: processCacheCalls } = loadRunner();
	const { runner, calls } = makeRunner(PiSelfUpdateRunner, { fail: true });
	await assert.rejects(() => runner.update(), /boom/);
	assert.equal(calls.runPi, 1, "确实走到了执行更新的分支");
	assert.equal(calls.resetVersionProbeCache, 1, "ExtensionManager 的 piVersion 缓存必须在失败路径也清掉");
	assert.equal(processCacheCalls.invalidateVersionCache, 1, "PiProcess.versionCache 必须同一处清掉");
});

test("没有新版时不清缓存、不跑更新（不必为「无变化」制造探测风暴）", async () => {
	const { PiSelfUpdateRunner, calls: processCacheCalls } = loadRunner();
	const { runner, calls } = makeRunner(PiSelfUpdateRunner, { currentVersion: "1.6.1", latestVersion: "1.6.1" });
	const result = await runner.update();
	assert.equal(result.updated, false);
	assert.equal(calls.runPi, 0);
	assert.equal(calls.resetVersionProbeCache, 0);
	assert.equal(processCacheCalls.invalidateVersionCache, 0);
});

test("更新成功后提示语切到「重启会话才用新版本」", () => {
	const { piUpdateToastKey } = loadTsCommonJs("src/renderer/src/utils/piUpdateHint.ts");
	assert.equal(piUpdateToastKey({ updated: true }), "settings.piUpdateRestartAgents");
	assert.equal(piUpdateToastKey({ updated: false }), "settings.piUpdateChecked");
});

test("提示文案在 zh-CN / en-US / zh-TW 三份词典里都存在（运行时取值）", () => {
	const dictionaries = [
		["zh-CN", "src/renderer/src/i18n/rendererCopy.zh-CN.ts", "zhCN"],
		["en-US", "src/renderer/src/i18n/rendererCopy.en-US.ts", "enUS"],
		["zh-TW", "src/renderer/src/i18n/rendererCopy.zh-TW.ts", "zhTW"],
	];
	for (const [label, path, exportName] of dictionaries) {
		const copy = loadTsCommonJs(path)[exportName];
		const text = copy?.["settings.piUpdateRestartAgents"];
		assert.equal(typeof text, "string", `${label} 缺这条文案`);
		assert.ok(text.length > 10, `${label} 文案不能是占位符`);
	}
});
