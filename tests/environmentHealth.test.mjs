/**
 * 环境体检判定规则：healthProbes.ts 纯函数。
 *
 * 阈值争议（磁盘剩多少算 error、内存多高算告警）用测试锁定，避免后续调整时
 * 无意的回归改变告警语义。采集（副作用）不在本测试范围，只测判定与汇总。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DISK_ERROR_BYTES, DISK_WARN_BYTES, RSS_ERROR_BYTES, RSS_WARN_BYTES, checkPiInstalled, checkConfigParsable, checkDiskSpace, checkAppMemory, checkLogErrors, checkProxyConfig, checkWslConfig, checkInstanceLocks, tallyChecks, sortChecksBySeverity } = loadTsCommonJs("src/main/health/healthProbes.ts");

const MB = 1024 * 1024;
const GB = 1024 * MB;

function settings(overrides = {}) {
	return {
		wslEnabled: false,
		wslDistro: "",
		wslUser: "",
		piProxyEnabled: false,
		piProxyUrl: "",
		desktopProxyEnabled: false,
		desktopProxyUrl: "",
		customPiPath: "",
		electronChromiumSandbox: true,
		developerDiagnostics: false,
		webServiceEnabled: false,
		...overrides,
	};
}

test("checkPiInstalled: no probe -> error", () => {
	assert.equal(checkPiInstalled(null).status, "error");
});

test("checkPiInstalled: installed with version -> ok", () => {
	const result = checkPiInstalled({ installed: true, version: "1.0.0", searchedDirs: [] });
	assert.equal(result.status, "ok");
	assert.equal(result.detail, "1.0.0");
});

test("checkPiInstalled: installed but no version -> warn", () => {
	const result = checkPiInstalled({ installed: true, error: "version failed", searchedDirs: [] });
	assert.equal(result.status, "warn");
});

test("checkDiskSpace: below error threshold -> error", () => {
	assert.equal(checkDiskSpace(DISK_ERROR_BYTES - 1).status, "error");
});

test("checkDiskSpace: below warn threshold -> warn", () => {
	assert.equal(checkDiskSpace(DISK_WARN_BYTES - 1).status, "warn");
});

test("checkDiskSpace: plenty -> ok", () => {
	assert.equal(checkDiskSpace(DISK_WARN_BYTES + 1).status, "ok");
});

test("checkDiskSpace: statfs unavailable (0) -> skipped", () => {
	assert.equal(checkDiskSpace(0).status, "skipped");
});

test("checkAppMemory: high RSS -> error", () => {
	assert.equal(checkAppMemory(RSS_ERROR_BYTES + 1).status, "error");
	assert.equal(checkAppMemory(RSS_WARN_BYTES + 1).status, "warn");
	assert.equal(checkAppMemory(0).status, "skipped");
});

test("checkLogErrors: zero errors -> ok, high errors -> error", () => {
	assert.equal(checkLogErrors(0, 2).status, "ok");
	assert.equal(checkLogErrors(10, 0).status, "error");
	assert.equal(checkLogErrors(3, 0).status, "warn");
});

test("checkConfigParsable: empty -> ok, diagnostics -> error", () => {
	assert.equal(checkConfigParsable([]).status, "ok");
	assert.equal(checkConfigParsable([{ fileName: "models.json", message: "parse failed" }]).status, "error");
});

test("checkProxyConfig: enabled without url -> warn", () => {
	const result = checkProxyConfig(settings({ piProxyEnabled: true, piProxyUrl: " " }));
	assert.equal(result.status, "warn");
});

test("checkProxyConfig: enabled with url -> ok", () => {
	const result = checkProxyConfig(settings({ piProxyEnabled: true, piProxyUrl: "http://proxy:8080" }));
	assert.equal(result.status, "ok");
});

test("checkWslConfig: only meaningful on win32", () => {
	const off = checkWslConfig(settings({ wslEnabled: false }), "win32", false);
	assert.equal(off.status, "ok");
	assert.equal(checkWslConfig(settings({ wslEnabled: true }), "darwin", false).status, "skipped");
	const missing = checkWslConfig(settings({ wslEnabled: true }), "win32", false);
	assert.equal(missing.status, "warn");
});

test("checkInstanceLocks: stale/corrupt locks are reported, live lock is ok", () => {
	const own = { version: "0.7.6", pid: 100 };
	const options = { ownPid: 100, singleInstanceEnabled: true };

	assert.equal(checkInstanceLocks([{ ...own, state: "live" }], options).status, "ok");
	// 残留锁（升级被中断）必须报出来，用户才能不用手删文件就定位「没反应」
	const stale = checkInstanceLocks([{ version: "0.7.5", pid: 3679, state: "stale" }], options);
	assert.equal(stale.status, "warn");
	assert.match(stale.detail, /0\.7\.5\(pid 3679\)/);
	assert.equal(checkInstanceLocks([{ version: "0.7.5", pid: 0, state: "corrupt" }], options).status, "warn");
	// 单实例开着却没有自己的锁 = 写锁失败降级启动（同版本可多开、会话被抢）
	const noOwn = checkInstanceLocks([{ version: "0.7.4", pid: 55, state: "live" }], options);
	assert.equal(noOwn.status, "warn");
	// 关掉单实例时不写锁，不是故障
	assert.equal(checkInstanceLocks([], { ownPid: 100, singleInstanceEnabled: false }).status, "ok");
	// 采集失败降级 skipped，不能报成 ok
	assert.equal(checkInstanceLocks(null, options).status, "skipped");
});

test("tallyChecks: computes counts and score from checks", () => {
	const tally = tallyChecks([
		{ id: "a", status: "ok", detail: "" },
		{ id: "b", status: "error", detail: "" },
		{ id: "c", status: "skipped", detail: "" },
	]);
	assert.equal(tally.ok, 1);
	assert.equal(tally.error, 1);
	assert.equal(tally.skipped, 1);
	assert.equal(tally.score, 50);
});

test("sortChecksBySeverity: error first, then warn, ok, skipped", () => {
	const sorted = sortChecksBySeverity([
		{ id: "ok1", status: "ok", detail: "" },
		{ id: "err1", status: "error", detail: "" },
		{ id: "skip1", status: "skipped", detail: "" },
		{ id: "warn1", status: "warn", detail: "" },
	]);
	const statuses = sorted.map((item) => item.status);
	assert.equal(statuses.join(","), "error,warn,ok,skipped");
});
