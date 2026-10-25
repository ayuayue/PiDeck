import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const mod = loadTsCommonJs("src/shared/piPackageSource.ts");

test("isPathLikePackageSource 识别本地目录形态", () => {
	for (const value of ["F:\\dsh-office-skills", "C:/pkg", "\\\\server\\share\\pkg", "/opt/pkg", "./pkg", "../pkg"]) {
		assert.equal(mod.isPathLikePackageSource(value), true, value + " 应判定为路径型包");
	}
});

test("isPathLikePackageSource 不误判协议源与裸文件名", () => {
	for (const value of ["npm:pi-tracker", "file:./x", "github:owner/repo", "git:https://x", "https://x/y", "pi-deck-demo-plugin.ts", "context-mode.ts"]) {
		assert.equal(mod.isPathLikePackageSource(value), false, value + " 不应判定为路径型包");
	}
});

test("isPackageSource 覆盖协议源与路径型包，排除裸文件名", () => {
	assert.equal(mod.isPackageSource("npm:pi-tracker"), true);
	assert.equal(mod.isPackageSource("F:\\dsh-office-skills"), true);
	assert.equal(mod.isPackageSource("./local-pkg"), true);
	assert.equal(mod.isPackageSource("pi-deck-demo-plugin.ts"), false);
	assert.equal(mod.isPackageSource("  "), false);
});
