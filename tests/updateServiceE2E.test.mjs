/**
 * UpdateService integration tests.
 *
 * The updater itself is faked, but these tests exercise the real main-process
 * state machine end to end: updater events -> persisted snapshot -> actions.
 * Every test registers stop() up front so a failed assertion cannot leave the
 * two-hour scheduler alive and hold the Node test process open.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 生产依赖图（含 manualUpdateDelivery）由 helper 递归解析；Math/Date 注入宿主对象，
// 让「把 Math.random 固定为 0」的抖动测试仍然可控。
const { UpdateService, DEFAULT_CHECK_INTERVAL_MS, DEFAULT_START_DELAY_MS } = loadTsCommonJs("src/main/update/UpdateService.ts", {
	globals: { Math, Date },
});

/** Fake that translates electron-updater event names into AutoUpdaterLike callbacks. */
function createFakeUpdater() {
	let handlers = {};
	const updater = {
		autoDownload: true,
		checkCalls: 0,
		downloadCalls: 0,
		installCalls: 0,
		/** setAllowPrerelease 调用记录（dev 通道语义断言用）。 */
		allowPrereleaseCalls: [],
		checkImpl: null,
		downloadImpl: null,
		installImpl: null,
		setAutoDownload(enabled) {
			updater.autoDownload = enabled;
		},
		setFeedUrl(url) {
			updater.feedUrl = url;
		},
		setAllowPrerelease(enabled) {
			updater.allowPrereleaseCalls.push(enabled);
		},
		isAutoDownload() {
			return updater.autoDownload !== false;
		},
		async checkForUpdates() {
			updater.checkCalls += 1;
			if (updater.checkImpl) await updater.checkImpl();
		},
		async downloadUpdate() {
			updater.downloadCalls += 1;
			if (updater.downloadImpl) await updater.downloadImpl();
		},
		quitAndInstall() {
			updater.installCalls += 1;
			if (updater.installImpl) updater.installImpl();
		},
		onEvents(nextHandlers) {
			handlers = nextHandlers;
			return () => {
				handlers = {};
			};
		},
		emitChecking() {
			handlers.onChecking?.();
		},
		emitAvailable(version) {
			handlers.onUpdateAvailable?.(version, updater.autoDownload !== false);
		},
		emitProgress(progress) {
			handlers.onDownloadProgress?.(progress);
		},
		emitDownloaded(version) {
			handlers.onUpdateDownloaded?.(version);
		},
		emitNotAvailable() {
			handlers.onUpdateNotAvailable?.();
		},
		emitError(error) {
			handlers.onError?.(error);
		},
	};
	return updater;
}

function createSettingsStore(initial = {}) {
	let value = { autoDownloadUpdates: true, ...initial };
	return {
		get: () => ({ ...value }),
		update: async (patch) => {
			value = { ...value, ...patch };
			return { ...value };
		},
	};
}

function createAutomaticService(options = {}) {
	const updater = options.updater ?? createFakeUpdater();
	const settings = createSettingsStore(options.settings);
	const snapshots = [];
	const logs = [];
	const service = new UpdateService({
		settingsStore: settings,
		checkPiUpdate: options.checkPiUpdate,
		checkCatalogUpdate: options.checkCatalogUpdate,
		updateCatalog: options.updateCatalog,
		sendToRenderer: (snapshot) => snapshots.push(structuredClone(snapshot)),
		log: (level, message, details) => logs.push({ level, message, details }),
		getCurrentVersion: () => "0.7.3-beta",
		deliveryMode: "automatic",
		channel: options.channel,
		autoUpdater: updater,
		prepareForInstall: options.prepareForInstall,
		rollbackInstallPreparation: options.rollbackInstallPreparation,
		installExitTimeoutMs: options.installExitTimeoutMs,
	});
	return { service, updater, settings, snapshots, logs };
}

function createManualService(checkManualAppUpdate, options = {}) {
	const settings = createSettingsStore();
	const snapshots = [];
	const logs = [];
	const service = new UpdateService({
		settingsStore: settings,
		sendToRenderer: (snapshot) => snapshots.push(structuredClone(snapshot)),
		log: (level, message, details) => logs.push({ level, message, details }),
		getCurrentVersion: () => "0.7.3-beta",
		deliveryMode: "manual",
		deliveryReason: options.deliveryReason ?? "mac-unsigned",
		channel: options.channel,
		checkManualAppUpdate,
		downloadManualUpdate: options.downloadManualUpdate,
		openManualInstaller: options.openManualInstaller,
	});
	return { service, settings, snapshots, logs };
}

function stopAfter(t, service) {
	t.after(() => service.stop());
}

// --- automatic delivery -------------------------------------------------

test("automatic flow: check -> download progress -> ready -> install", (t) => {
	const lifecycle = [];
	const { service, updater, snapshots } = createAutomaticService({
		prepareForInstall: () => lifecycle.push("prepare"),
	});
	updater.installImpl = () => lifecycle.push("quitAndInstall");
	stopAfter(t, service);

	updater.emitChecking();
	assert.equal(snapshots.at(-1).app.download.phase, "checking");

	updater.emitAvailable("0.7.4");
	let snapshot = snapshots.at(-1);
	assert.equal(snapshot.deliveryMode, "automatic");
	assert.equal(snapshot.app.latestVersion, "0.7.4");
	assert.equal(snapshot.app.download.phase, "downloading");

	updater.emitProgress({ percent: 42.5, bytesPerSecond: 2_000_000, transferred: 50_000_000, total: 145_000_000 });
	snapshot = snapshots.at(-1);
	assert.equal(snapshot.app.download.percent, 42.5);
	assert.equal(snapshot.app.download.bytesPerSecond, 2_000_000);

	updater.emitDownloaded("0.7.4");
	snapshot = snapshots.at(-1);
	assert.equal(snapshot.app.download.phase, "ready");
	assert.equal(snapshot.app.download.percent, 100);

	service.installNow();
	assert.equal(updater.installCalls, 1);
	assert.deepEqual(lifecycle, ["prepare", "quitAndInstall"]);
	assert.equal(service.getSnapshot().app.download.phase, "installing");

	// 同一次安装期间的重复点击、检查结果都不能重新触发安装或覆盖退出中的状态。
	service.installNow();
	updater.emitNotAvailable();
	assert.equal(updater.installCalls, 1);
	assert.equal(service.getSnapshot().app.download.phase, "installing");
});

test("install failure restores the prepared exit state and keeps the downloaded update retryable", (t) => {
	const lifecycle = [];
	const updater = createFakeUpdater();
	updater.installImpl = () => {
		throw new Error("installer launch failed");
	};
	const { service } = createAutomaticService({
		updater,
		prepareForInstall: () => lifecycle.push("prepare"),
		rollbackInstallPreparation: () => lifecycle.push("rollback"),
	});
	stopAfter(t, service);

	updater.emitAvailable("0.7.4");
	updater.emitDownloaded("0.7.4");
	service.installNow();

	const snapshot = service.getSnapshot();
	assert.equal(snapshot.app.download.phase, "ready");
	assert.match(snapshot.app.download.error, /installer launch failed/);
	assert.deepEqual(lifecycle, ["prepare", "rollback"]);
});

test("install watchdog restores retryable state when Electron does not exit", async (t) => {
	const lifecycle = [];
	const { service, updater } = createAutomaticService({
		installExitTimeoutMs: 5,
		prepareForInstall: () => lifecycle.push("prepare"),
		rollbackInstallPreparation: () => lifecycle.push("rollback"),
	});
	stopAfter(t, service);

	updater.emitAvailable("0.7.4");
	updater.emitDownloaded("0.7.4");
	service.installNow();
	await new Promise((resolve) => setTimeout(resolve, 30));

	const snapshot = service.getSnapshot();
	assert.equal(snapshot.app.download.phase, "ready");
	assert.match(snapshot.app.download.error, /did not start/);
	assert.deepEqual(lifecycle, ["prepare", "rollback"]);
});

test("automatic delivery honors autoDownload=false and starts manual download immediately", async (t) => {
	const { service, updater } = createAutomaticService({ settings: { autoDownloadUpdates: false } });
	stopAfter(t, service);

	// start() applies the persisted preference before the first check.
	service.start({ startDelayMs: 1_000_000, intervalMs: 1_000_000 });
	assert.equal(updater.autoDownload, false);

	updater.emitAvailable("0.8.0");
	assert.equal(service.getSnapshot().app.download.phase, "available");
	assert.equal(service.getSnapshot().autoDownload, false);

	await service.downloadNow();
	assert.equal(updater.downloadCalls, 1);
	assert.equal(service.getSnapshot().app.download.phase, "downloading");

	updater.emitDownloaded("0.8.0");
	assert.equal(service.getSnapshot().app.download.phase, "ready");
});

test("checkNow records a no-update result, Pi result, and lastCheckAt", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	const { service, settings } = createAutomaticService({
		updater,
		checkPiUpdate: async () => ({ hasUpdate: false }),
	});
	stopAfter(t, service);

	await service.checkNow();
	const snapshot = service.getSnapshot();
	assert.equal(snapshot.app.latestVersion, "0.7.3-beta");
	assert.equal(snapshot.app.hasUpdate, false);
	assert.equal(snapshot.app.download.phase, "idle");
	assert.equal(snapshot.piCli.hasUpdate, false);
	assert.equal(typeof snapshot.lastCheckAt, "number");
	assert.equal(settings.get().updateLastCheckAt, snapshot.lastCheckAt);
});

test("applyPiCheckResult refreshes the pi node of the snapshot after an in-app pi upgrade", async (t) => {
	// 回归：应用内「更新 pi」只跑设置页自己的检查（api.pi.checkUpdate），后台快照不知道
	// 新版本已装好——侧栏设置按钮圆点会一直停在「pi 有新版本」，直到下一轮 2h 定时检查
	// （实测：1.4.0 已装好、设置页显示无更新，圆点仍在）。
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	const piCheck = async () => ({ currentVersion: "1.3.0", latestVersion: "1.4.0", hasUpdate: true });
	const { service, snapshots } = createAutomaticService({ updater, checkPiUpdate: piCheck });
	stopAfter(t, service);

	await service.checkNow();
	assert.equal(service.getSnapshot().piCli.hasUpdate, true);
	assert.equal(service.getSnapshot().piCli.currentVersion, "1.3.0");

	// 设置页刚跑过一轮真检查（升级后）：快照必须同刻跟上，不能等定时器。
	const pushesBefore = snapshots.length;
	service.applyPiCheckResult({ currentVersion: "1.4.0", latestVersion: "1.4.0", hasUpdate: false });
	assert.ok(snapshots.length > pushesBefore, "applyPiCheckResult must push the new snapshot to the renderer");
	const snapshot = snapshots.at(-1);
	assert.equal(snapshot.piCli.currentVersion, "1.4.0");
	assert.equal(snapshot.piCli.latestVersion, "1.4.0");
	assert.equal(snapshot.piCli.hasUpdate, false);
	// 快照里的已提示版本仍来自设置（不因同步结果被清掉）
	assert.equal(snapshot.piCli.notifiedVersion, undefined);
});

test("direct updater rejection becomes a visible error state", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		throw new Error("network unavailable");
	};
	const { service } = createAutomaticService({ updater });
	stopAfter(t, service);

	await service.checkNow();
	const snapshot = service.getSnapshot();
	assert.equal(snapshot.app.download.phase, "error");
	assert.equal(snapshot.app.download.errorKind, "check");
	assert.match(snapshot.app.download.error, /network unavailable/);
	assert.equal(typeof snapshot.lastCheckAt, "number");
});

test("a later no-update event cannot hide an already downloaded update", (t) => {
	const { service, updater } = createAutomaticService();
	stopAfter(t, service);

	updater.emitAvailable("0.7.4");
	updater.emitDownloaded("0.7.4");
	updater.emitChecking();
	updater.emitNotAvailable();

	const snapshot = service.getSnapshot();
	assert.equal(snapshot.app.latestVersion, "0.7.4");
	assert.equal(snapshot.app.download.phase, "ready");
});

test("notifySeen and skipVersion persist the app-version markers", async (t) => {
	const { service, updater, settings } = createAutomaticService();
	stopAfter(t, service);
	updater.emitAvailable("0.7.4");

	await service.notifySeen("app", "0.7.4");
	await service.skipVersion("0.7.4");
	const snapshot = service.getSnapshot();
	assert.equal(settings.get().updateNotifiedVersion, "0.7.4");
	assert.equal(settings.get().updateSkippedVersion, "0.7.4");
	assert.equal(snapshot.app.notifiedVersion, "0.7.4");
	assert.equal(snapshot.app.skippedVersion, "0.7.4");
});

// --- catalog (model directory) check ------------------------------------

test("checkNow folds a catalog update into the snapshot", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	const { service, snapshots } = createAutomaticService({
		updater,
		checkPiUpdate: async () => ({ hasUpdate: false }),
		checkCatalogUpdate: async () => ({
			ok: true,
			remoteVersion: "0.90.0",
			localVersion: "0.84.4",
			hasUpdate: true,
		}),
	});
	stopAfter(t, service);

	await service.checkNow();
	const snapshot = snapshots.at(-1);
	assert.equal(snapshot.catalog.hasUpdate, true);
	assert.equal(snapshot.catalog.latestVersion, "0.90.0");
	assert.equal(snapshot.catalog.localVersion, "0.84.4");
	assert.equal(snapshot.catalog.error, undefined);
});

test("catalog check without an injected checker keeps the snapshot node absent", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	const { service, snapshots } = createAutomaticService({ updater });
	stopAfter(t, service);

	await service.checkNow();
	assert.equal(snapshots.at(-1).catalog, null);
});

test("catalog check failure surfaces as error without marking an update", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	const { service, snapshots, logs } = createAutomaticService({
		updater,
		checkCatalogUpdate: async () => ({ ok: false, code: "network", message: "manifest fetch failed" }),
	});
	stopAfter(t, service);

	await service.checkNow();
	const snapshot = snapshots.at(-1);
	assert.equal(snapshot.catalog.hasUpdate, false);
	assert.equal(snapshot.catalog.latestVersion, undefined);
	assert.match(snapshot.catalog.error, /manifest fetch failed/);
});

test("a rejected catalog checker logs a warning and keeps the previous snapshot", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	const { service, snapshots, logs } = createAutomaticService({
		updater,
		checkCatalogUpdate: async () => {
			throw new Error("boom");
		},
	});
	stopAfter(t, service);

	await service.checkNow();
	assert.equal(snapshots.at(-1).catalog, null);
	// rejected 才会打 warn（与 app/pi 两路一致）；ok:false 只进快照 error 字段。
	assert.ok(logs.some(({ level, message }) => level === "warn" && message.includes("Catalog")));
});

// --- catalog (model directory) auto update -----------------------------

/**
 * 拼装层守卫：自动更新靠 main/index.ts 注入 updateCatalog、设置页把开关接到 UpdateService。
 * 这两处都不在 UpdateService 的行为测试覆盖范围内，漏了会退化成「开关无效但仍然显示已开启」。
 */
test("catalog auto update is wired end to end", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	const devTab = readFileSync("src/renderer/src/components/app/settings/DevTab.tsx", "utf8");
	assert.match(main, /updateCatalog: \(\) => catalogUpdater\.update\(\)/);
	assert.match(devTab, /onAutoUpdateChange=\{\(checked\) => updateDraft\(\{ catalogAutoUpdate: checked \}\)\}/);
});

/** 检查器固定返回「发现 1.2.0 新版本」，便于只变化自动更新那一路。 */
function detectedCatalogCheck() {
	return async () => ({ ok: true, remoteVersion: "1.2.0", localVersion: "1.0.4", hasUpdate: true });
}

test("catalog auto update pulls a detected catalog during the background check", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	let calls = 0;
	const { service, snapshots, logs } = createAutomaticService({
		updater,
		checkPiUpdate: async () => ({ hasUpdate: false }),
		checkCatalogUpdate: detectedCatalogCheck(),
		updateCatalog: async () => {
			calls += 1;
			return { ok: true, updated: true };
		},
	});
	stopAfter(t, service);

	await service.checkNow();
	// 设置未显式关闭（默认开）→ 后台检查发现新版本直接拉取，不需用户点「更新到最新」
	assert.equal(calls, 1);
	const snapshot = snapshots.at(-1);
	assert.equal(snapshot.catalog.hasUpdate, false);
	assert.equal(snapshot.catalog.localVersion, "1.2.0");
	assert.equal(snapshot.catalog.latestVersion, "1.2.0");
	assert.ok(logs.some(({ level, message }) => level === "info" && message === "Catalog auto updated"));
});

test("catalog auto update stays off when the setting is disabled", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	let calls = 0;
	const { service, snapshots } = createAutomaticService({
		updater,
		settings: { catalogAutoUpdate: false },
		checkCatalogUpdate: detectedCatalogCheck(),
		updateCatalog: async () => {
			calls += 1;
			return { ok: true, updated: true };
		},
	});
	stopAfter(t, service);

	await service.checkNow();
	// 关掉自动更新 = 旧行为：只提示，等用户手动点按钮
	assert.equal(calls, 0);
	assert.equal(snapshots.at(-1).catalog.hasUpdate, true);
});

test("catalog auto update does not run when the check found nothing newer", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	let calls = 0;
	const { service } = createAutomaticService({
		updater,
		checkCatalogUpdate: async () => ({ ok: true, remoteVersion: "1.2.0", localVersion: "1.2.0", hasUpdate: false }),
		updateCatalog: async () => {
			calls += 1;
			return { ok: true, updated: false };
		},
	});
	stopAfter(t, service);

	await service.checkNow();
	assert.equal(calls, 0);
});

test("catalog auto update re-derives the pending state when nothing could be written", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	// 第一轮检查说「有 1.2.0」，更新却写不进去（分支件与本地同版 / 另一实例已更新）→
	// 第二轮检查（自动重取）看到实际已是最新。
	let checks = 0;
	const { service, snapshots, logs } = createAutomaticService({
		updater,
		checkCatalogUpdate: async () => {
			checks += 1;
			return checks === 1 ? { ok: true, remoteVersion: "1.2.0", localVersion: "1.0.4", hasUpdate: true } : { ok: true, remoteVersion: "1.2.0", localVersion: "1.2.0", hasUpdate: false };
		},
		// 远端不高于当前生效版本（例如另一实例刚更新过）：没实际落盘
		updateCatalog: async () => ({ ok: true, updated: false, skipped: "already-latest", remoteVersion: "1.2.0", localVersion: "1.2.0" }),
	});
	stopAfter(t, service);

	await service.checkNow();
	// 提示必须能被兑现或消失：否则就是用户报的「老提示有更新、点更新又说已是最新」
	assert.equal(checks, 2);
	assert.equal(snapshots.at(-1).catalog.hasUpdate, false);
	assert.ok(logs.some(({ level, message }) => level === "info" && message.includes("no newer catalog")));
});

test("refreshCatalogSnapshot re-checks and pushes the new conclusion", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	// 设置页手动更新成功：目录已落地，下一次检查必然不再有更新。
	const { service, snapshots, logs } = createAutomaticService({
		updater,
		checkCatalogUpdate: async () => ({ ok: true, remoteVersion: "1.2.0", localVersion: "1.2.0", hasUpdate: false }),
		updateCatalog: async () => ({ ok: true, updated: false }),
	});
	stopAfter(t, service);

	await service.refreshCatalogSnapshot();
	// 手动路径不经过 checkNow，不回写快照的话提示与侧栏红点会留到下一轮（默认 2h）
	assert.equal(snapshots.at(-1).catalog.hasUpdate, false);
	assert.equal(snapshots.at(-1).catalog.latestVersion, "1.2.0");
	assert.equal(logs.length, 0);
});

test("refreshCatalogSnapshot without an injected checker stays silent", async (t) => {
	const updater = createFakeUpdater();
	const { service, snapshots } = createAutomaticService({ updater });
	stopAfter(t, service);

	await service.refreshCatalogSnapshot();
	assert.equal(snapshots.length, 0);
});

test("catalog auto update failure is logged and leaves the manual entry usable", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	const { service, snapshots, logs } = createAutomaticService({
		updater,
		checkCatalogUpdate: detectedCatalogCheck(),
		updateCatalog: async () => ({ ok: false, code: "network", message: "both mirrors failed" }),
	});
	stopAfter(t, service);

	await service.checkNow();
	// 失败不掩盖「有更新」：设置页仍可手动重试；日志带失败码便于定位
	assert.equal(snapshots.at(-1).catalog.hasUpdate, true);
	const warn = logs.find(({ level, message }) => level === "warn" && message === "Catalog auto update failed");
	assert.equal(warn?.details?.code, "network");
});

test("catalog auto update rejection cannot fail the whole check", async (t) => {
	const updater = createFakeUpdater();
	updater.checkImpl = async () => {
		updater.emitChecking();
		updater.emitNotAvailable();
	};
	const { service, snapshots, logs } = createAutomaticService({
		updater,
		checkPiUpdate: async () => ({ hasUpdate: false, latestVersion: "0.9.0" }),
		checkCatalogUpdate: detectedCatalogCheck(),
		updateCatalog: async () => {
			throw new Error("download exploded");
		},
	});
	stopAfter(t, service);

	await service.checkNow();
	// 自动更新在后台跑，异常不得冒泡打断本轮检查（app/pi 两路结果照常入快照）
	const snapshot = snapshots.at(-1);
	assert.equal(snapshot.catalog.hasUpdate, true);
	assert.equal(snapshot.piCli.latestVersion, "0.9.0");
	assert.ok(logs.some(({ level, message, details }) => level === "warn" && message === "Catalog auto update failed" && /download exploded/.test(String(details?.error))));
});

// --- manual delivery (unsigned macOS / Linux arm64 / deb / tar.gz) ------

const MANUAL_RELEASE = {
	version: "0.8.0",
	assetName: "PiDeck-0.8.0-arm64.dmg",
	assetUrl: "https://github.com/ayuayue/PiDeck/releases/download/v0.8.0/PiDeck-0.8.0-arm64.dmg",
	assetSize: 120_000_000,
	kind: "dmg",
	platform: "darwin",
	arch: "arm64",
	translated: false,
	releasePageUrl: "https://github.com/ayuayue/PiDeck/releases/tag/v0.8.0",
};

test("manual delivery exposes the device installer, downloads it, and opens the package without quitting", async (t) => {
	const opened = [];
	const progressEvents = [];
	const { service, snapshots } = createManualService(
		async () => ({
			latestVersion: "0.8.0",
			hasUpdate: true,
			recommendedDownload: MANUAL_RELEASE,
		}),
		{
			downloadManualUpdate: async (release, options) => {
				assert.equal(release.assetName, MANUAL_RELEASE.assetName);
				assert.ok(options.signal, "manual download should pass an AbortSignal");
				options.onProgress?.({ percent: 42, transferred: 42, total: 100, bytesPerSecond: 1024 });
				progressEvents.push(release.assetName);
				return "/tmp/PiDeck-0.8.0-arm64.dmg";
			},
			openManualInstaller: async (filePath) => {
				opened.push(filePath);
			},
		},
	);
	stopAfter(t, service);

	await service.checkNow();
	let snapshot = service.getSnapshot();
	assert.equal(snapshot.deliveryMode, "manual");
	assert.equal(snapshot.deliveryReason, "mac-unsigned");
	assert.equal(snapshot.autoDownload, null);
	assert.equal(snapshot.app.latestVersion, "0.8.0");
	assert.equal(snapshot.app.download.phase, "available");
	assert.equal(snapshot.app.recommendedDownload.assetName, MANUAL_RELEASE.assetName);

	await service.downloadNow();
	snapshot = service.getSnapshot();
	assert.equal(snapshot.app.download.phase, "ready");
	assert.equal(snapshot.app.download.percent, 100);
	assert.deepEqual(progressEvents, [MANUAL_RELEASE.assetName]);
	assert.ok(snapshots.some((entry) => entry.app?.download.phase === "downloading" && entry.app.download.percent === 42));

	service.installNow();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(opened, ["/tmp/PiDeck-0.8.0-arm64.dmg"]);
	// manual 打开安装包不能进入 installing（应用不退出）。
	assert.equal(service.getSnapshot().app.download.phase, "ready");
});

test("manual check keeps an already downloaded package when the version is unchanged", async (t) => {
	const { service } = createManualService(
		async () => ({
			latestVersion: "0.8.0",
			hasUpdate: true,
			recommendedDownload: MANUAL_RELEASE,
		}),
		{
			downloadManualUpdate: async () => "/tmp/PiDeck-0.8.0-arm64.dmg",
			openManualInstaller: async () => undefined,
		},
	);
	stopAfter(t, service);

	await service.checkNow();
	await service.downloadNow();
	assert.equal(service.getSnapshot().app.download.phase, "ready");

	// 再次检查（同一版本）不能吞掉「打开安装包」入口。
	await service.checkNow();
	const snapshot = service.getSnapshot();
	assert.equal(snapshot.app.download.phase, "ready");
	assert.equal(snapshot.app.recommendedDownload.assetName, MANUAL_RELEASE.assetName);
});

test("manual check with a newer version resets a previously downloaded ready package", async (t) => {
	let latest = "0.8.0";
	const { service } = createManualService(
		async () => ({
			latestVersion: latest,
			hasUpdate: true,
			recommendedDownload: { ...MANUAL_RELEASE, version: latest, assetName: `PiDeck-${latest}-arm64.dmg` },
		}),
		{
			downloadManualUpdate: async () => "/tmp/PiDeck-0.8.0-arm64.dmg",
			openManualInstaller: async () => undefined,
		},
	);
	stopAfter(t, service);

	await service.checkNow();
	await service.downloadNow();
	assert.equal(service.getSnapshot().app.download.phase, "ready");

	// 远端出了 0.8.1：旧安装包路径必须丢弃，回到 available + 新推荐包。
	latest = "0.8.1";
	await service.checkNow();
	const snapshot = service.getSnapshot();
	assert.equal(snapshot.app.download.phase, "available");
	assert.equal(snapshot.app.download.version, "0.8.1");
});

test("manual download without a matched installer is a download error", async (t) => {
	const { service } = createManualService(async () => ({
		latestVersion: "0.8.0",
		hasUpdate: true,
		recommendedDownload: null,
	}));
	stopAfter(t, service);

	await service.checkNow();
	await service.downloadNow();
	const snapshot = service.getSnapshot();
	assert.equal(snapshot.app.download.phase, "error");
	assert.equal(snapshot.app.download.errorKind, "download");
	assert.match(snapshot.app.download.error, /No installer matches/);
});

test("manual download failure is reported as a download error and stays retryable", async (t) => {
	const { service } = createManualService(
		async () => ({
			latestVersion: "0.8.0",
			hasUpdate: true,
			recommendedDownload: MANUAL_RELEASE,
		}),
		{
			downloadManualUpdate: async () => {
				throw new Error("disk full");
			},
		},
	);
	stopAfter(t, service);

	await service.checkNow();
	await service.downloadNow();
	const snapshot = service.getSnapshot();
	assert.equal(snapshot.app.download.phase, "error");
	assert.equal(snapshot.app.download.errorKind, "download");
	assert.match(snapshot.app.download.error, /disk full/);
	// 推荐包仍在快照里，UI 可显示「重试下载」。
	assert.equal(snapshot.app.recommendedDownload.assetName, MANUAL_RELEASE.assetName);
});

// --- lifecycle ----------------------------------------------------------

test("defaults use a 10-second initial delay and two-hour interval", () => {
	assert.equal(DEFAULT_START_DELAY_MS, 10_000);
	assert.equal(DEFAULT_CHECK_INTERVAL_MS, 2 * 60 * 60 * 1000);
});

test("start schedules the first check when jitter is zero", async (t) => {
	const originalRandom = Math.random;
	Math.random = () => 0;
	const { service, updater } = createAutomaticService();
	t.after(() => {
		Math.random = originalRandom;
		service.stop();
	});

	service.start({ startDelayMs: 10, intervalMs: 1_000_000 });
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(updater.checkCalls, 1);
});

test("stop unsubscribes updater events and clears pending work", (t) => {
	const { service, updater } = createAutomaticService();
	stopAfter(t, service);
	service.start({ startDelayMs: 1_000_000, intervalMs: 1_000_000 });
	service.stop();

	updater.emitAvailable("9.9.9");
	assert.equal(service.getSnapshot().app, null);
});

// --- update source ------------------------------------------------------

test("start applies the configured update source feed URL (default github → no feed)", async (t) => {
	const { service, updater } = createAutomaticService({ settings: { updateSource: "github" } });
	stopAfter(t, service);
	service.start({ startDelayMs: 0, intervalMs: 60_000 });
	// github 官方源：不设置 feed URL（走 app-update.yml 原生通道）
	assert.equal(updater.feedUrl, null);
});

test("switching update source rebuilds the generic feed URL immediately", async (t) => {
	const { service, updater, settings } = createAutomaticService({ settings: { updateSource: "github" } });
	stopAfter(t, service);
	service.start({ startDelayMs: 0, intervalMs: 60_000 });
	assert.equal(updater.feedUrl, null);

	// 设置页切换到 atomgit 更新源：保存即生效（无需重启）
	await settings.update({ updateSource: "atomgit" });
	service.applyUpdateSource();
	assert.equal(updater.feedUrl, "https://atomgit.com/ayuayue/PiDeck/releases/download/latest");

	// 回到官方源：重置 feed，恢复原生 GitHub provider
	await settings.update({ updateSource: "github" });
	service.applyUpdateSource();
	assert.equal(updater.feedUrl, null);
});

// 真实 updater 路径（createRealAutoUpdater）：fake updater 测不到 currentFeedUrl 去重守卫。
// 桩注入 electron / node:fs / electron-updater，验证源切换往返不被 early-return 吞掉。
test("real updater setFeedUrl: github -> mirror -> github round trip rebuilds the github provider", (t) => {
	const setFeedURLCalls = [];
	const electronUpdaterStub = {
		autoUpdater: {
			autoDownload: true,
			setFeedURL: (config) => setFeedURLCalls.push(config),
			on: () => {},
			off: () => {},
		},
	};
	// feedOverride 必须为 null：显式 options.feedUrl / env 注入会让 setFeedUrl 恒 early-return。
	const savedE2E = process.env.PIDECK_E2E;
	const savedFeedEnv = process.env.PIDEK_UPDATE_FEED_URL;
	delete process.env.PIDECK_E2E;
	delete process.env.PIDEK_UPDATE_FEED_URL;
	t.after(() => {
		if (savedE2E === undefined) delete process.env.PIDECK_E2E;
		else process.env.PIDECK_E2E = savedE2E;
		if (savedFeedEnv === undefined) delete process.env.PIDEK_UPDATE_FEED_URL;
		else process.env.PIDEK_UPDATE_FEED_URL = savedFeedEnv;
	});

	// existsSync→true：跳过兜底 app-update.yml 写盘分支，测试零文件副作用。
	const { createRealAutoUpdater } = loadTsCommonJs("src/main/update/createAutoUpdater.ts", {
		stubs: {
			electron: { app: { isPackaged: false, getAppPath: () => "/test-app", getPath: () => "/test-userdata" } },
			"node:fs": { existsSync: () => true, mkdirSync: () => undefined, writeFileSync: () => undefined },
			"electron-updater": electronUpdaterStub,
		},
	});
	const real = createRealAutoUpdater();
	const atomgitUrl = "https://atomgit.com/ayuayue/PiDeck/releases/download/latest";

	// 初始 github 源：currentFeedUrl 初始即 null，early-return，不触碰 provider。
	real.setFeedUrl(null);
	assert.deepEqual(setFeedURLCalls, []);

	// 切到镜像：generic provider 整体接管。（vm 沙箱跨 realm，不能 deepEqual 对象，逐字段断言。）
	real.setFeedUrl(atomgitUrl);
	assert.equal(setFeedURLCalls.length, 1);
	assert.equal(setFeedURLCalls[0].provider, "generic");
	assert.equal(setFeedURLCalls[0].url, atomgitUrl);

	// 回归点：切回 github 官方源必须重建 github provider。若 currentFeedUrl 缺少赋值，
	// 这里命中 null === null early-return，镜像 provider 残留（stable 既有功能回归）。
	real.setFeedUrl(null);
	assert.equal(setFeedURLCalls.length, 2);
	assert.equal(setFeedURLCalls[1].provider, "github");
	assert.equal(setFeedURLCalls[1].owner, "ayuayue");
	assert.equal(setFeedURLCalls[1].repo, "PiDeck");
	assert.equal(electronUpdaterStub.autoUpdater.forceDevUpdateConfig, true);

	// 去重守卫仍有效：重复 setFeedUrl(null) 不得再次触发 setFeedURL。
	real.setFeedUrl(null);
	assert.equal(setFeedURLCalls.length, 2);
});

test("atomgit source is applied as generic feed URL on start", async (t) => {
	const { service, updater } = createAutomaticService({
		settings: { updateSource: "atomgit" },
	});
	stopAfter(t, service);
	service.start({ startDelayMs: 0, intervalMs: 60_000 });
	assert.equal(updater.feedUrl, "https://atomgit.com/ayuayue/PiDeck/releases/download/latest");
});

test("dev channel: feed is forced to GitHub and allowPrerelease=true regardless of the configured source", async (t) => {
	const { service, updater, settings } = createAutomaticService({
		channel: "dev",
		settings: { updateSource: "atomgit" },
	});
	stopAfter(t, service);
	service.start({ startDelayMs: 0, intervalMs: 60_000 });
	// dev 恒官方 GitHub：null = 恢复原生 provider；预发布恒开启。
	assert.equal(updater.feedUrl, null);
	assert.deepEqual(updater.allowPrereleaseCalls, [true]);

	// 设置项切换后重新应用：dev 语义不随 updateSource 漂移。
	await settings.update({ updateSource: "atomgit" });
	service.applyUpdateSource();
	assert.equal(updater.feedUrl, null);
	assert.deepEqual(updater.allowPrereleaseCalls, [true, true]);
});

test("stable channel behavior is unchanged: atomgit feed applies and prerelease stays explicitly false", async (t) => {
	const { service, updater } = createAutomaticService({
		channel: "stable",
		settings: { updateSource: "atomgit" },
	});
	stopAfter(t, service);
	service.start({ startDelayMs: 0, intervalMs: 60_000 });
	assert.equal(updater.feedUrl, "https://atomgit.com/ayuayue/PiDeck/releases/download/latest");
	// 显式重置 false（声明式保障，防残留）；绝不为 stable 开启预发布。
	assert.deepEqual(updater.allowPrereleaseCalls, [false]);
});

test("manual delivery on dev channel checks GitHub even when atomgit source is configured", async (t) => {
	let receivedUrl;
	const { service, settings } = createManualService(
		(latestReleaseUrl) => {
			receivedUrl = latestReleaseUrl;
			return Promise.resolve({ hasUpdate: false, latestVersion: "0.7.3-beta" });
		},
		{ channel: "dev" },
	);
	stopAfter(t, service);
	await settings.update({ updateSource: "atomgit" });
	await service.checkNow();
	// dev 强制官方 GitHub：latestReleaseUrl 为 undefined（镜像 URL 不得传入检查器）。
	assert.equal(receivedUrl, undefined);
});

test("manual delivery uses latestReleaseUrl from the configured atomgit source per check", async (t) => {
	let receivedUrl;
	const { service, settings } = createManualService((latestReleaseUrl) => {
		receivedUrl = latestReleaseUrl;
		return Promise.resolve({ hasUpdate: false, latestVersion: null });
	});
	stopAfter(t, service);
	await settings.update({ updateSource: "atomgit" });
	await service.checkNow();
	// macOS manual 检查：AtomGit 源 URL 传进检查器（GitHub 源时为 undefined）
	assert.equal(receivedUrl, "https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases/latest");
});

test("manual check rejection is a check error, not a download error", async (t) => {
	const { service } = createManualService(async () => {
		throw new Error("Latest release response did not resolve to a release tag.");
	});
	stopAfter(t, service);
	await service.checkNow();
	const snapshot = service.getSnapshot();
	assert.equal(snapshot.app.download.phase, "error");
	assert.equal(snapshot.app.download.errorKind, "check");
});

test("download rejection is a download error", async (t) => {
	const { service, updater } = createAutomaticService();
	stopAfter(t, service);
	updater.setAutoDownload(false);
	updater.emitAvailable("0.7.4");
	updater.downloadImpl = async () => {
		throw new Error("disk full");
	};
	await service.downloadNow();
	const snapshot = service.getSnapshot();
	assert.equal(snapshot.app.download.phase, "error");
	assert.equal(snapshot.app.download.errorKind, "download");
	assert.match(snapshot.app.download.error, /disk full/);
});
