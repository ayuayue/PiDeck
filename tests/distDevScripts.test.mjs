/**
 * dist:*:dev 脚本与通道标记注入守卫（2026-09 channel-switch）：
 * dev 通道只经 scripts/dist-dev.js 构建（注入 PIDECK_DEV_BUILD=1 →
 * electron.vite.config.ts define __PIDECK_DEV_BUILD__ → channelIdentity 判 dev）。
 * stable 系打包脚本一旦误接 dist-dev.js，就会把 stable 包发成 dev 通道，
 * 这里逐脚本钉死接线，防止回归。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const viteConfigSource = readFileSync(new URL("../electron.vite.config.ts", import.meta.url), "utf8");
const distDevSource = readFileSync(new URL("../scripts/dist-dev.js", import.meta.url), "utf8");

test("四个 dev 打包脚本存在且各自接 dist-dev.js", () => {
	for (const name of ["dist:win:dev", "dist:mac:dev", "dist:linux:dev", "dist:linux:dev:arm64"]) {
		assert.match(pkg.scripts[name], /dist-dev\.js/, name);
	}
});

test("stable 系打包脚本不含 dist-dev.js（通道不得误接）", () => {
	for (const name of ["dist", "dist:win", "dist:mac", "dist:linux", "dist:linux:arm64", "dist:fast", "pack", "pack:dev"]) {
		assert.ok(pkg.scripts[name], `脚本 ${name} 应存在`);
		assert.doesNotMatch(pkg.scripts[name], /dist-dev/, name);
	}
});

test('electron.vite.config.ts 的 __PIDECK_DEV_BUILD__ define 绑定 PIDECK_DEV_BUILD === "1"', () => {
	assert.match(viteConfigSource, /__PIDECK_DEV_BUILD__\s*:\s*JSON\.stringify\(\s*process\.env\.PIDECK_DEV_BUILD\s*===\s*"1"\s*\)/);
});

test('scripts/dist-dev.js 注入 PIDECK_DEV_BUILD: "1"', () => {
	assert.match(distDevSource, /PIDECK_DEV_BUILD:\s*"1"/);
});
