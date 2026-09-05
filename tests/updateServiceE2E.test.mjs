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
					const resolved =
						name === "../../shared/updateSources" ? "src/shared/updateSources.ts" : null;
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
		checkImpl: null,
		downloadImpl: null,
		installImpl: null,
		setAutoDownload(enabled) {
			updater.autoDownload = enabled;
		},
		setFeedUrl(url) {
			updater.feedUrl = url;
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
		sendToRenderer: (snapshot) => snapshots.push(structuredClone(snapshot)),
		log: (level, message, details) => logs.push({ level, message, details }),
		getCurrentVersion: () => "0.7.3-beta",
		deliveryMode: "automatic",
		autoUpdater: updater,
		prepareForInstall: options.prepareForInstall,
		rollbackInstallPreparation: options.rollbackInstallPreparation,
		installExitTimeoutMs: options.installExitTimeoutMs,
	});
	return { service, updater, settings, snapshots, logs };
}

function createManualService(checkManualAppUpdate) {
	const settings = createSettingsStore();
	const snapshots = [];
	const logs = [];
	const service = new UpdateService({
		settingsStore: settings,
		sendToRenderer: (snapshot) => snapshots.push(structuredClone(snapshot)),
		log: (level, message, details) => logs.push({ level, message, details }),
		getCurrentVersion: () => "0.7.3-beta",
		deliveryMode: "manual",
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

	// 设置页切换到 ghfast 镜像：保存即生效（无需重启）
	await settings.update({ updateSource: "ghfast" });
	service.applyUpdateSource();
	assert.equal(
		updater.feedUrl,
		"https://ghfast.top/https://github.com/ayuayue/PiDeck/releases/latest/download",
	);

	// 回到官方源：重置 feed，恢复原生 GitHub provider
	await settings.update({ updateSource: "github" });
	service.applyUpdateSource();
	assert.equal(updater.feedUrl, null);
});

test("custom mirror prefix is normalized and applied as feed URL", async (t) => {
	const { service, updater } = createAutomaticService({
		settings: { updateSource: "custom", customUpdateSourceUrl: "  https://mirror.example.com/  " },
	});
	stopAfter(t, service);
	service.start({ startDelayMs: 0, intervalMs: 60_000 });
	// 前缀 trim + 去尾斜杠后拼接到 generic feed
	assert.equal(
		updater.feedUrl,
		"https://mirror.example.com/https://github.com/ayuayue/PiDeck/releases/latest/download",
	);
});

test("manual delivery uses latestReleaseUrl from the configured mirror per check", async (t) => {
	let receivedUrl;
	const { service, settings } = createManualService((latestReleaseUrl) => {
		receivedUrl = latestReleaseUrl;
		return Promise.resolve({ hasUpdate: false, latestVersion: null });
	});
	stopAfter(t, service);
	await settings.update({ updateSource: "ghfast" });
	await service.checkNow();
	// macOS manual 检查：镜像源 URL 传进检查器（GitHub 源时为 undefined）
	assert.equal(receivedUrl, "https://ghfast.top/https://github.com/ayuayue/PiDeck/releases/latest");
});
