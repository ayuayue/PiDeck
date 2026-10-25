import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildDevConfig } from "../scripts/dist-dev.js";
// 先加载官方入口，避免直接加载内部 packager 时触发其 CommonJS 循环依赖。
import "app-builder-lib";
import { LinuxPackager } from "app-builder-lib/out/linuxPackager.js";
import { validateConfiguration } from "app-builder-lib/out/util/config/config.js";
import { Arch, DebugLogger } from "builder-util";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

test("三平台打包元数据统一 PiDeck，npm 与锁文件不再派生旧名", () => {
	assert.equal(pkg.name, "pideck");
	assert.equal(lock.name, pkg.name);
	assert.equal(lock.packages[""].name, pkg.name);
	assert.equal(pkg.build.productName, "PiDeck");
	assert.equal(pkg.build.extraMetadata.productName, "PiDeck");
	for (const config of [pkg.build.win, pkg.build.nsis, pkg.build.portable, pkg.build.mac, pkg.build.linux, pkg.build.deb, pkg.build.appImage]) {
		assert.ok(config.artifactName.startsWith("${productName}"), config.artifactName);
	}
});

test("Linux deb 与可执行文件使用新品牌，声明替代历史 Debian 包", () => {
	assert.equal(pkg.build.linux.executableName, "pideck");
	assert.equal(pkg.build.deb.packageName, "pideck");
	assert.equal(pkg.build.deb.artifactName, "${productName}_${version}_${arch}.${ext}");
	assert.ok(pkg.build.deb.fpm.includes("--replaces=pi-desktop"));
	assert.ok(pkg.build.deb.fpm.includes("--conflicts=pi-desktop"));
	assert.equal(pkg.build.appId, "com.ayuayue.pi-desktop", "保留 Windows/macOS 的升级身份，不因改品牌成为另一应用");
});

test("electron-builder 实际解析生成 PiDeck Debian 文件名和品牌更新缓存，无需全量构建", async () => {
	for (const config of [pkg.build, buildDevConfig()]) {
		await validateConfiguration(config, new DebugLogger(false));
		const packager = new LinuxPackager({ metadata: { ...pkg, ...config.extraMetadata }, config });
		assert.equal(packager.executableName, config.linux.executableName);
		assert.equal(packager.appInfo.updaterCacheDirName, "pideck-updater");
		const prefix = config.productName === "PiDeck" ? "PiDeck_" : "PiDeck-Dev-";
		for (const [arch, debArch] of [
			[Arch.x64, "amd64"],
			[Arch.arm64, "arm64"],
		]) {
			const name = packager.expandArtifactNamePattern(config.deb, "deb", arch, "${name}_${version}_${arch}.${ext}", false);
			assert.ok(name.startsWith(prefix), name);
			assert.ok(name.endsWith(`${debArch}.deb`), name);
			assert.ok(!name.includes("pi-desktop") && !name.includes(" "), name);
		}
	}
});

test("Dev 的 deb/AppImage 不继承稳定版名称或替代关系，可与稳定版并存", () => {
	const config = buildDevConfig();
	assert.equal(config.extraMetadata.productName, "PiDeck Dev");
	assert.equal(config.linux.executableName, "pideck-dev");
	assert.equal(config.deb.packageName, "pideck-dev");
	assert.deepEqual(config.deb.fpm, []);
	for (const target of [config.linux, config.deb, config.appImage]) {
		assert.match(target.artifactName, /^PiDeck-Dev-/);
		assert.ok(target.artifactName.includes("${arch}"));
		assert.ok(!target.artifactName.includes(" "));
	}
});
