// tests/buildOrigin.test.mjs
// 构建来源判定（三态，与更新通道正交）：未打包 = dev-run；打包且无发布标记 = local-package；
// 打包且有发布标记 = release。判定错了的表现：本机包/发布包在设置页被当成另一种身份。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadConfigFromFile } from "electron-vite";

/**
 * 加载 buildIdentity 并覆盖两个判定输入。
 * electron 必须走 stubs：沙箱里裸 require("electron") 拿到的是 npm electron 包的
 * 二进制路径字符串，解构 app 得到 undefined。
 */
function loadBuildIdentity({ isPackaged, releaseBuild }) {
	const load = createTsSandbox({
		stubs: { electron: { app: { isPackaged } } },
		globals: { __PIDECK_RELEASE_BUILD__: releaseBuild },
	});
	return load("src/main/buildIdentity.ts");
}

test("未打包运行恒为 dev-run（与发布标记无关）", () => {
	for (const releaseBuild of [false, true]) {
		assert.equal(loadBuildIdentity({ isPackaged: false, releaseBuild }).resolveBuildOrigin(), "dev-run");
	}
});

test("打包但没有发布标记 → local-package（本机打包）", () => {
	assert.equal(loadBuildIdentity({ isPackaged: true, releaseBuild: false }).resolveBuildOrigin(), "local-package");
});

test("打包且有发布标记 → release（CI 发布产物）", () => {
	assert.equal(loadBuildIdentity({ isPackaged: true, releaseBuild: true }).resolveBuildOrigin(), "release");
});

test("完整与主进程子构建均可启动并正确识别构建来源", async () => {
	const previous = process.env.PIDECK_RELEASE_BUILD;
	try {
		for (const releaseBuild of [false, true]) {
			process.env.PIDECK_RELEASE_BUILD = releaseBuild ? "1" : "0";
			for (const configFile of ["electron.vite.config.ts", "electron.vite.main.mjs"]) {
				const { config } = await loadConfigFromFile({ command: "build", mode: "production" }, configFile);
				const globals = Object.fromEntries(Object.entries(config.main.define).map(([key, value]) => [key, JSON.parse(value)]));
				assert.ok(Object.hasOwn(globals, "__PIDECK_RELEASE_BUILD__"), `${configFile} must replace the build origin constant`);
				const load = createTsSandbox({ stubs: { electron: { app: { isPackaged: true } } }, globals });
				assert.equal(load("src/main/buildIdentity.ts").resolveBuildOrigin(), releaseBuild ? "release" : "local-package", configFile);
			}
		}
	} finally {
		if (previous === undefined) delete process.env.PIDECK_RELEASE_BUILD;
		else process.env.PIDECK_RELEASE_BUILD = previous;
	}
});
