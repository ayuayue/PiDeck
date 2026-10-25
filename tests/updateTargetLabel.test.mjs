/**
 * 推荐安装包的设备标签选择（纯函数）：主进程只给结构化字段，UI 按平台/架构/格式选 i18n key。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { manualUpdateTargetLabel } = loadTsCommonJs("src/renderer/src/utils/updateTargetLabel.ts");

test("macOS: arm64 / Rosetta / Intel 分别命中对应标签", () => {
	assert.equal(manualUpdateTargetLabel({ platform: "darwin", arch: "arm64", kind: "dmg", translated: false }).key, "settings.updateTargetMacArm64");
	assert.equal(manualUpdateTargetLabel({ platform: "darwin", arch: "arm64", kind: "dmg", translated: true }).key, "settings.updateTargetMacArm64Rosetta");
	assert.equal(manualUpdateTargetLabel({ platform: "darwin", arch: "x64", kind: "dmg", translated: false }).key, "settings.updateTargetMacX64");
});

test("Windows: 便携/安装/zip 分别命中对应标签", () => {
	assert.equal(manualUpdateTargetLabel({ platform: "win32", arch: "x64", kind: "portable", translated: false }).key, "settings.updateTargetWinPortable");
	assert.equal(manualUpdateTargetLabel({ platform: "win32", arch: "x64", kind: "nsis", translated: false }).key, "settings.updateTargetWinInstalled");
	assert.equal(manualUpdateTargetLabel({ platform: "win32", arch: "x64", kind: "zip", translated: false }).key, "settings.updateTargetWinZip");
});

test("Linux: AppImage / deb / tar.gz 带 arch 参数", () => {
	assert.equal(manualUpdateTargetLabel({ platform: "linux", arch: "arm64", kind: "appimage", translated: false }).key, "settings.updateTargetLinuxAppImage");
	assert.equal(manualUpdateTargetLabel({ platform: "linux", arch: "arm64", kind: "appimage", translated: false }).params.arch, "arm64");
	assert.equal(manualUpdateTargetLabel({ platform: "linux", arch: "x64", kind: "deb", translated: false }).params.arch, "x64");
	assert.equal(manualUpdateTargetLabel({ platform: "linux", arch: "x64", kind: "tar.gz", translated: false }).key, "settings.updateTargetLinuxArchive");
});
