/**
 * dataEnv IPC 域纯决策函数单测（不测 ipcMain 注册本身）：
 * - applyDataEnvChoice：写决策指针 + restartRequired / importAvailable 判定；
 * - R6 空决策目录守卫：stable 通道（decisionDir 为空串）拒绝读写，防 path.join("", …)
 *   落成相对 cwd 的同名 pideck-env.json；
 * - getDataEnvInfo：无决策 → decided:false（dev 首启弹窗判定），有决策 → dataMode 透出。
 * 读写桩形状对齐 applyDataEnvChoice 的 io 参数（R4）：{ read, write }。
 * 导入 handler（start/cancel/preview）经同一 electron 桩捕获 handler 表后直测：
 * busy 互斥、取消推送 cancelled 进度且完成后可再次 start、stable 通道 unavailable。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// electron 桩：捕获 ipcMain.handle 注册表，除纯函数外可直测 handler 行为。
const handlers = new Map();
const load = createTsSandbox({ stubs: { electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } } } });
const { applyDataEnvChoice, getDataEnvInfo, registerDataEnvIpc } = load("src/main/ipc/dataEnvIpc.ts");
const { DATA_ENV_DECISION_FILENAME } = load("src/main/dataEnv/dataEnvMarker.ts");
const { ipcChannels } = load("src/shared/ipc.ts");

/** io 读写桩：内存 Map 承载，writes 记录每次写盘（空目录守卫断言「不落任何文件」用）。 */
function makeMemIo() {
	const store = new Map();
	const writes = [];
	return {
		store,
		writes,
		read: (dir) => store.get(dir) ?? null,
		write: (dir, dataMode, appVersion) => {
			const file = { schemaVersion: 1, dataMode, lastAppVersion: appVersion, createdAt: "2026-09-25T00:00:00.000Z" };
			store.set(dir, file);
			writes.push({ dir, dataMode });
			return file;
		},
	};
}

/** 建一次性临时目录，测试结束后清理。 */
function makeTempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-dataenv-ipc-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("chooseShared：写决策指针 dataMode=shared，不需重启", () => {
	const io = makeMemIo();
	const dir = "/fake/pi-desktop-channel-dev";
	const effects = applyDataEnvChoice({ mode: "shared", decisionDir: dir, appVersion: "0.8.0-beta.1" }, io);
	assert.equal(effects.restartRequired, false);
	assert.equal(effects.importAvailable, false);
	assert.equal(io.store.get(dir).dataMode, "shared");
});

test("chooseChannelDev：写决策指针 dataMode=channel-dev，需重启（setPath 下次 ready 前生效）", () => {
	const io = makeMemIo();
	const dir = "/fake/pi-desktop-channel-dev";
	const effects = applyDataEnvChoice({ mode: "channel-dev", decisionDir: dir, appVersion: "0.8.0-beta.1" }, io);
	assert.equal(effects.restartRequired, true);
	assert.equal(effects.importAvailable, true);
	assert.equal(io.store.get(dir).dataMode, "channel-dev");
});

test("重复选择以最后一次为准（决策指针整体覆盖）", () => {
	const io = makeMemIo();
	const dir = "/fake/pi-desktop-channel-dev";
	applyDataEnvChoice({ mode: "shared", decisionDir: dir, appVersion: "0.8.0-beta.1" }, io);
	applyDataEnvChoice({ mode: "channel-dev", decisionDir: dir, appVersion: "0.8.0-beta.2" }, io);
	assert.equal(io.store.get(dir).dataMode, "channel-dev");
	assert.equal(io.store.get(dir).lastAppVersion, "0.8.0-beta.2");
});

test("R6：空决策目录（stable 通道）chooseMode 拒绝且不落任何文件", () => {
	const io = makeMemIo();
	const effects = applyDataEnvChoice({ mode: "shared", decisionDir: "", appVersion: "0.8.0-beta.1" }, io);
	assert.equal(effects.ok, false);
	assert.equal(effects.error, "invalid-mode");
	assert.equal(io.writes.length, 0);
});

test("R6：非法模式 chooseMode 拒绝且不落任何文件", () => {
	const io = makeMemIo();
	const effects = applyDataEnvChoice({ mode: "magic", decisionDir: "/fake/x", appVersion: "0.8.0-beta.1" }, io);
	assert.equal(effects.ok, false);
	assert.equal(effects.error, "invalid-mode");
	assert.equal(io.writes.length, 0);
});

test("getDataEnvInfo：目录无决策 → decided:false（dev 首启弹窗判定）", (t) => {
	const dir = makeTempDir(t);
	const info = getDataEnvInfo({ channel: "dev", decisionDir: dir, activeDirectory: "shared" });
	assert.equal(info.channel, "dev");
	assert.equal(info.decided, false);
	assert.equal(info.dataMode, null);
	assert.equal(info.activeDirectory, "shared");
});

test("getDataEnvInfo：已有决策 → decided:true + dataMode 透出", (t) => {
	const dir = makeTempDir(t);
	writeFileSync(join(dir, DATA_ENV_DECISION_FILENAME), JSON.stringify({ schemaVersion: 1, dataMode: "channel-dev", lastAppVersion: "0.8.0-beta.1", createdAt: "2026-09-25T00:00:00.000Z" }), "utf8");
	const info = getDataEnvInfo({ channel: "dev", decisionDir: dir, activeDirectory: "channel-dev" });
	assert.equal(info.decided, true);
	assert.equal(info.dataMode, "channel-dev");
	assert.equal(info.channel, "dev");
});

test("R6：空决策目录 getInfo 直接按未决策返回（不读 cwd 下同名文件）", () => {
	const info = getDataEnvInfo({ channel: "stable", decisionDir: "", activeDirectory: "shared" });
	assert.equal(info.decided, false);
	assert.equal(info.dataMode, null);
	assert.equal(info.activeDirectory, "shared");
});

// —— 数据导入 handler（start / cancel / preview）——

/** 导入 handler 的 deps：真实 tmp 目录 + 进度收集器；每测试独立 register，互不串状态。 */
function makeImportDeps(overrides = {}) {
	const progress = [];
	const sourceDir = mkdtempSync(join(tmpdir(), "pideck-import-src-"));
	const targetDir = mkdtempSync(join(tmpdir(), "pideck-import-dst-"));
	const cleanup = () => {
		rmSync(sourceDir, { recursive: true, force: true });
		rmSync(targetDir, { recursive: true, force: true });
	};
	const deps = {
		getChannel: () => "dev",
		getDecisionDir: () => targetDir,
		getActiveDirectory: () => "channel-dev",
		getAppVersion: () => "0.8.0-beta.1",
		relaunchApp: () => {},
		quitApp: () => {},
		getSharedDataDir: () => sourceDir,
		getChannelDevDataDir: () => targetDir,
		sendProgress: (p) => progress.push(p),
		...overrides,
	};
	return { deps, sourceDir, targetDir, progress, cleanup };
}

const startImport = () => handlers.get(ipcChannels.dataEnvImportStart)();
const cancelImport = () => handlers.get(ipcChannels.dataEnvImportCancel)();
const previewImport = () => handlers.get(ipcChannels.dataEnvGetImportPreview)();

// handler 返回对象创建在 vm 沙箱 realm，deepStrictEqual 会因原型不同而误报；逐字段断言。
const assertImportOk = (result) => {
	assert.equal(result.ok, true);
};
const assertImportFailure = (result, error) => {
	assert.equal(result.ok, false);
	assert.equal(result.error, error);
};

test("importStart：逐项复制 + 进度推送至 done，完成后可再次 start", async (t) => {
	const { deps, sourceDir, targetDir, progress, cleanup } = makeImportDeps();
	t.after(cleanup);
	registerDataEnvIpc(deps);
	writeFileSync(join(sourceDir, "settings.json"), "{}", "utf8");
	writeFileSync(join(sourceDir, "session-catalog.json"), "{}", "utf8");
	assertImportOk(await startImport());
	const copied = readdirSync(targetDir);
	assert.ok(copied.includes("settings.json"));
	assert.ok(copied.includes("session-catalog.json"));
	assert.equal(progress.at(-1).phase, "done");
	assert.ok(progress.every((p) => p.phase === "copying" || p.phase === "done"));
	// 完成（或取消）后允许再次 start（规格 §6 可重复触发）
	assertImportOk(await startImport());
});

test("importStart：进行中重复调用返回 busy", async (t) => {
	const { deps, sourceDir, cleanup } = makeImportDeps();
	t.after(cleanup);
	registerDataEnvIpc(deps);
	writeFileSync(join(sourceDir, "settings.json"), "{}", "utf8");
	writeFileSync(join(sourceDir, "session-catalog.json"), "{}", "utf8");
	const first = startImport();
	// 首个 start 已在首个 await cp 处挂起，运行标志为真
	assertImportFailure(await startImport(), "busy");
	assertImportOk(await first);
});

test("importCancel：置取消标志 → cancelled 进度 + 已复制保留 + 可再次 start", async (t) => {
	const { deps, sourceDir, targetDir, progress, cleanup } = makeImportDeps();
	t.after(cleanup);
	registerDataEnvIpc(deps);
	writeFileSync(join(sourceDir, "settings.json"), "{}", "utf8");
	writeFileSync(join(sourceDir, "session-catalog.json"), "{}", "utf8");
	const first = startImport();
	await cancelImport();
	assertImportFailure(await first, "cancelled");
	assert.equal(progress.at(-1).phase, "cancelled");
	// 已复制内容保留（第 1 项 settings.json 落盘，规格 §6）
	assert.ok(readdirSync(targetDir).includes("settings.json"));
	// 取消后可再次导入
	assertImportOk(await startImport());
});

test("importStart：stable 通道（独立目录为空串）拒绝且不推送进度", async (t) => {
	const { deps, progress, cleanup } = makeImportDeps({ getChannelDevDataDir: () => "" });
	t.after(cleanup);
	registerDataEnvIpc(deps);
	assertImportFailure(await startImport(), "unavailable");
	assert.equal(progress.length, 0);
});

test("getImportPreview：返回迁移清单与总体积（体积预估）", async (t) => {
	const { deps, sourceDir, cleanup } = makeImportDeps();
	t.after(cleanup);
	registerDataEnvIpc(deps);
	writeFileSync(join(sourceDir, "settings.json"), "0123456789", "utf8");
	const preview = await previewImport();
	assert.equal(preview.ok, true);
	const rels = Array.from(preview.items, (item) => item.relPath);
	assert.ok(rels.includes("settings.json"));
	assert.equal(preview.totalBytes, 10);
});

test("getImportPreview：stable 通道（独立目录为空串）拒绝预估，返回 unavailable", async (t) => {
	const { deps, cleanup } = makeImportDeps({ getChannelDevDataDir: () => "" });
	t.after(cleanup);
	registerDataEnvIpc(deps);
	assertImportFailure(await previewImport(), "unavailable");
});
