/**
 * UpdateService integration tests.
 *
 * The updater itself is faked, but these tests exercise the real main-process
 * state machine end to end: updater events -> persisted snapshot -> actions.
 * Every test registers stop() up front so a failed assertion cannot leave the
 * two-hour scheduler alive and hold the Node test process open.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadUpdateService() {
	// vm 沙箱依赖解析：UpdateService 现在依赖 updateSources（其依赖 shared/updateSources）。
	// 递归 transpile 这两个模块，按路径缓存，注入到 UpdateService 的 require 里。
	function loadTsInVm(filePath) {
		const source = readFileSync(filePath, "utf8");
		const output = ts.transpileModule(source, {
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
			},
			fileName: filePath,
		}).outputText;
		const module = { exports: {} };
		vm.runInNewContext(
			output,
			{
				module,
				exports: module.exports,
				require: (name) => {
					const resolved = name === "../../shared/updateSources" ? "src/shared/updateSources.ts" : null;
					const next = cache[resolved];
					if (!next) {
						if (!resolved || !existsSync(resolved)) {
							throw new Error(`unexpected require in vm: ${name}`);
						}
						cache[resolved] = loadTsInVm(resolved);
					}
					return cache[resolved]?.exports;
				},
				console,
				Date,
				Error,
				Math,
				Promise,
				String,
				URL,
				clearTimeout,
				setTimeout,
			},
			{ filename: filePath },
		);
		return module;
	}
	const cache = {};
	const filePath = "src/main/update/UpdateService.ts";
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (name) => {
				const resolved = name === "./updateSources" ? "src/main/update/updateSources.ts" : null;
				const next = cache[resolved];
				if (!next) {
					if (!resolved || !existsSync(resolved)) {
						throw new Error(`unexpected require in vm: ${name}`);
					}
					cache[resolved] = loadTsInVm(resolved);
				}
				return cache[resolved]?.exports;
			},
			console,
			Date,
			Error,
			Math,
			Promise,
			String,
			URL,
			clearTimeout,
			setTimeout,
		},
		{ filename: filePath },
	);
	return module.exports;
}

const { UpdateService, DEFAULT_CHECK_INTERVAL_MS, DEFAULT_START_DELAY_MS } = loadUpdateService();

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
		channel: options.channel,
		checkManualAppUpdate,
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

// --- manual delivery (unsigned macOS) ----------------------------------

test("manual delivery only exposes availability; download and install are no-ops", async (t) => {
	const { service, logs } = createManualService(async () => ({
		latestVersion: "0.8.0",
		hasUpdate: true,
	}));
	stopAfter(t, service);

	await service.checkNow();
	let snapshot = service.getSnapshot();
	assert.equal(snapshot.deliveryMode, "manual");
	assert.equal(snapshot.autoDownload, null);
	assert.equal(snapshot.app.latestVersion, "0.8.0");
	assert.equal(snapshot.app.download.phase, "available");

	await service.downloadNow();
	service.installNow();
	snapshot = service.getSnapshot();
	assert.equal(snapshot.app.download.phase, "available");
	assert.equal(logs.filter(({ message }) => message.includes("unavailable for manual")).length, 2);
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
