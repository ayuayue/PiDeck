/**
 * 更新交付模式判定：只有能稳定完成应用内替换的组合才 automatic。
 * 重点是 Linux arm64 / deb / tar.gz 不再错误地走 electron-updater。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveAppUpdateDeliveryPlan } = loadTsCommonJs("src/main/update/deliveryPlan.ts");

/** loadTsCommonJs 在独立 vm realm 里执行，跨 realm 对象不能 deepStrictEqual；逐字段断言。 */
function assertPlan(plan, mode, reason) {
	assert.equal(plan.mode, mode);
	assert.equal(plan.reason, reason);
}

test("Windows 安装版走 automatic（NSIS 应用内更新）", () => {
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "win32", arch: "x64" }), "automatic", "automatic");
	// Windows 便携版仍由 electron-updater 跑 NSIS，模式不变（UI 另有便携版差异提示）。
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "win32", arch: "x64", isAppImage: false }), "automatic", "automatic");
});

test("macOS 无 Developer ID 签名走 manual", () => {
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "darwin", arch: "arm64" }), "manual", "mac-unsigned");
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "darwin", arch: "x64" }), "manual", "mac-unsigned");
});

test("Linux x64 AppImage 走 automatic；arm64 一律 manual", () => {
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "linux", arch: "x64", isAppImage: true }), "automatic", "automatic");
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "linux", arch: "arm64", isAppImage: true }), "manual", "linux-arm64");
});

test("Linux deb/tar.gz（无 APPIMAGE env）走 manual，避免下载成功但装不上", () => {
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "linux", arch: "x64", isAppImage: false }), "manual", "linux-package-format");
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "linux", arch: "x64" }), "manual", "linux-package-format");
});

test("未知平台保守走 manual，不承诺应用内替换", () => {
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "freebsd", arch: "x64" }), "manual", "unsupported");
});

test("main 装配：manual 交付注入设备推荐检查器与一键下载器", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.match(source, /resolveAppUpdateDeliveryPlan\(\s*\{/);
	assert.match(source, /createManualUpdateChecker\(\s*\{\s*channel:\s*updateChannel,\s*target:\s*manualUpdateTarget\s*\}/);
	assert.match(source, /deliveryReason:\s*appUpdateDelivery\.reason/);
	assert.match(source, /downloadManualUpdate:[\s\S]*?downloadInstallerAsset\(\s*\{/);
	assert.match(source, /openManualInstaller:\s*async/);
});
