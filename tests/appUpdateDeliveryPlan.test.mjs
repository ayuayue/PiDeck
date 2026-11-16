/**
 * 更新交付模式判定：只有能稳定完成应用内替换的组合才 automatic。
 * 重点是 Linux arm64 / deb / tar.gz 不再错误地走 electron-updater。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";

const { resolveAppUpdateDeliveryPlan } = loadTsCommonJs("src/main/update/deliveryPlan.ts");
const { detectMacDeveloperIdSignature, parseDeveloperIdSignature, resolveAppBundlePath } = loadTsCommonJs("src/main/update/macCodeSignature.ts");

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

test("macOS 无 Developer ID 签名走 manual；未探测（省略字段）同样保守走 manual", () => {
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "darwin", arch: "arm64" }), "manual", "mac-unsigned");
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "darwin", arch: "x64", macDeveloperIdSigned: false }), "manual", "mac-unsigned");
});

test("macOS Developer ID 签名包走 automatic（electron-updater MacUpdater）", () => {
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "darwin", arch: "arm64", macDeveloperIdSigned: true }), "automatic", "automatic");
	assertPlan(resolveAppUpdateDeliveryPlan({ platform: "darwin", arch: "x64", macDeveloperIdSigned: true }), "automatic", "automatic");
});

const DEVELOPER_ID_OUTPUT = [
	"Executable=/Applications/PiDeck.app/Contents/MacOS/PiDeck",
	"Identifier=com.ayuayue.pi-desktop",
	"CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+0 location=embedded",
	"Signature size=9000",
	"Authority=Developer ID Application: Example Co (ABCDE12345)",
	"Authority=Developer ID Certification Authority",
	"Authority=Apple Root CA",
	"TeamIdentifier=ABCDE12345",
].join("\n");
const ADHOC_OUTPUT = ["Executable=/Applications/PiDeck.app/Contents/MacOS/PiDeck", "Identifier=com.ayuayue.pi-desktop", "CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded", "Signature=adhoc", "TeamIdentifier=not set"].join("\n");

test("macCodeSignature：按 codesign Authority 链识别 Developer ID，ad-hoc / 未签名判否", () => {
	assert.equal(parseDeveloperIdSignature(DEVELOPER_ID_OUTPUT), true);
	assert.equal(parseDeveloperIdSignature(ADHOC_OUTPUT), false);
	assert.equal(parseDeveloperIdSignature("code object is not signed at all"), false);
	// 开发者证书（Apple Development / Mac Developer）不算：Squirrel.Mac 换包后 Gatekeeper 不认。
	assert.equal(parseDeveloperIdSignature("Authority=Apple Development: someone (ABCDE12345)"), false);
});

test("macCodeSignature：只在 macOS 且已打包时跑 codesign，其它情况与异常一律 false（fail-closed 到 manual）", () => {
	const calls = [];
	const runCodesign = (appPath) => {
		calls.push(appPath);
		return DEVELOPER_ID_OUTPUT;
	};
	const execPath = "/Applications/PiDeck.app/Contents/MacOS/PiDeck";
	assert.equal(detectMacDeveloperIdSignature({ platform: "darwin", isPackaged: true, execPath, runCodesign }), true);
	assert.deepEqual(calls, ["/Applications/PiDeck.app"]);
	assert.equal(detectMacDeveloperIdSignature({ platform: "win32", isPackaged: true, execPath, runCodesign }), false);
	assert.equal(detectMacDeveloperIdSignature({ platform: "darwin", isPackaged: false, execPath, runCodesign }), false);
	// 非 bundle 布局（如 node_modules/electron 开发二进制）不探测
	assert.equal(detectMacDeveloperIdSignature({ platform: "darwin", isPackaged: true, execPath: "/usr/local/bin/electron", runCodesign }), false);
	assert.equal(calls.length, 1);
	assert.equal(
		detectMacDeveloperIdSignature({
			platform: "darwin",
			isPackaged: true,
			execPath,
			runCodesign: () => {
				throw new Error("spawn ENOENT");
			},
		}),
		false,
	);
});

test("resolveAppBundlePath 从可执行文件回推 .app", () => {
	assert.equal(resolveAppBundlePath("/Applications/PiDeck Dev.app/Contents/MacOS/PiDeck Dev"), "/Applications/PiDeck Dev.app");
	assert.equal(resolveAppBundlePath("/opt/pideck/bin/pideck"), null);
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
	const source = mainIpcSource;
	assert.match(source, /resolveAppUpdateDeliveryPlan\(\s*\{/);
	// mac 签名探测必须接进判定，且按 app.isPackaged 门控（开发态不跑 codesign）。
	assert.match(source, /macDeveloperIdSigned:\s*detectMacDeveloperIdSignature\(\s*\{\s*isPackaged:\s*app\.isPackaged\s*\}\s*\)/);
	assert.match(source, /createManualUpdateChecker\(\s*\{\s*channel:\s*updateChannel,\s*target:\s*manualUpdateTarget\s*\}/);
	assert.match(source, /deliveryReason:\s*appUpdateDelivery\.reason/);
	assert.match(source, /downloadManualUpdate:[\s\S]*?downloadInstallerAsset\(\s*\{/);
	assert.match(source, /openManualInstaller:\s*async/);
});
