/**
 * 本地打包脚本的 Electron 下载源守卫（2026-10 事故）：
 * `npm run pack:dev` 卡在 `connect ETIMEDOUT 20.205.243.166:443`（github.com）。
 * 根因不是 zip 没缓存，而是 @electron/get 的 validateArtifact 每次都以
 * `cacheMode: Bypass` 重新拉 SHASUMS256.txt，那一步同样走 github.com；CI 早已在
 * workflow 注入 ELECTRON_MIRROR，本地脚本此前没有 → 只有本地打包必挂。
 *
 * 断言两层：解析函数语义（默认镜像 / 显式覆盖 / 显式空 = 走 GitHub）+ 每个本地
 * 打包脚本真的把 env 传给了 electron-builder（漏传 = 静默退回 GitHub）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { createElectronDownloadEnv, electronBuilderEnv, ELECTRON_MIRROR_DEFAULT, ELECTRON_BUILDER_BINARIES_MIRROR_DEFAULT } = await import("../scripts/electronBuilderEnv.js");

const ELECTRON_BUILDER_SCRIPTS = ["pack-dev.js", "dist-fast.js", "dist-win.js", "dist-dev.js"];

test("未配置任何下载源时补 npmmirror（Electron + electron-builder-binaries 双源）", () => {
	const env = createElectronDownloadEnv({ env: {} });
	assert.equal(env.ELECTRON_MIRROR, ELECTRON_MIRROR_DEFAULT);
	assert.equal(env.ELECTRON_BUILDER_BINARIES_MIRROR, ELECTRON_BUILDER_BINARIES_MIRROR_DEFAULT);
	assert.match(env.ELECTRON_MIRROR, /^https:\/\/npmmirror\.com\/mirrors\/electron\/$/);
});

test('显式空字符串 = 走 GitHub 默认源（CI 的 ELECTRON_MIRROR: "" 语义不变）', () => {
	const env = createElectronDownloadEnv({ env: { ELECTRON_MIRROR: "", ELECTRON_BUILDER_BINARIES_MIRROR: "" } });
	assert.equal(env.ELECTRON_MIRROR, "");
	assert.equal(env.ELECTRON_BUILDER_BINARIES_MIRROR, "");
});

test("已有配置优先：任意一套镜像键名都保留原值并回写到规范键", () => {
	for (const key of ["ELECTRON_MIRROR", "npm_config_electron_mirror", "NPM_CONFIG_ELECTRON_MIRROR", "npm_package_config_electron_mirror"]) {
		const env = createElectronDownloadEnv({ env: { [key]: "https://mirror.example/electron/" } });
		assert.equal(env.ELECTRON_MIRROR, "https://mirror.example/electron/", key);
	}
	for (const key of ["ELECTRON_BUILDER_BINARIES_MIRROR", "npm_config_electron_builder_binaries_mirror", "NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR"]) {
		const env = createElectronDownloadEnv({ env: { [key]: "https://mirror.example/binaries/" } });
		assert.equal(env.ELECTRON_BUILDER_BINARIES_MIRROR, "https://mirror.example/binaries/", key);
	}
});

test("不修改入参 env，且保留其余环境变量", () => {
	const source = { PATH: "/usr/bin", ELECTRON_MIRROR: "https://z/" };
	const env = createElectronDownloadEnv({ env: source });
	assert.equal(source.ELECTRON_MIRROR, "https://z/");
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(electronBuilderEnv(source).PATH, "/usr/bin");
});

test("每个本地打包脚本都把下载源 env 传给 electron-builder", () => {
	for (const script of ELECTRON_BUILDER_SCRIPTS) {
		const source = readFileSync(new URL(`../scripts/${script}`, import.meta.url), "utf8");
		assert.match(source, /require\("\.\/electronBuilderEnv\.js"\)/, `${script} 应引入 electronBuilderEnv`);
		// npx electron-builder 的 execSync 选项里必须出现 env: electronBuilderEnv(...)，
		// 否则镜像只补在本进程、子进程仍走 github。
		const builderCall = source.slice(source.indexOf("npx electron-builder"));
		assert.match(builderCall, /env:\s*electronBuilderEnv\(/, `${script} 的 electron-builder 调用应传 env`);
	}
});
