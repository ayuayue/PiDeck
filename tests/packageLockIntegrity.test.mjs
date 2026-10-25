import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
const ALLOWED_TARBALL_HOSTS = new Set(["registry.npmjs.org", "registry.npmmirror.com"]);

function getLockedPackage(packagePath) {
	const lockedPackage = lockfile.packages[packagePath];
	assert.ok(lockedPackage, `missing ${packagePath} from package-lock.json`);
	return lockedPackage;
}

test("lockfile bundles emnapi packages required by native wasm dependencies", () => {
	// @emnapi/core / @emnapi/runtime 等 wasm 原生依赖以 bundleDependencies 形式随
	// @tailwindcss/oxide-wasm32-wasi 发布（npm 对 bundled 依赖不单独写入 packages 表，
	// 也不展开到 node_modules——旧断言期待独立 lockfile 条目已过时，2026 年起改为
	// 校验 bundle 声明 + 平台变体 optional 标记，打包后才不会缺 wasm 依赖）。
	const wasmOxide = getLockedPackage("node_modules/@tailwindcss/oxide-wasm32-wasi");
	assert.equal(wasmOxide.optional, true, "wasm 平台变体必须是 optional（非目标平台不安装）");
	assert.ok(Array.isArray(wasmOxide.cpu) && wasmOxide.cpu.includes("wasm32"), "wasm 平台变体必须声明 cpu=wasm32");
	const bundled = wasmOxide.bundleDependencies ?? [];
	for (const name of ["@emnapi/core", "@emnapi/runtime", "@emnapi/wasi-threads", "@napi-rs/wasm-runtime", "@tybys/wasm-util"]) {
		assert.ok(bundled.includes(name), `wasm bundle missing ${name}`);
	}
});

test("lockfile only resolves tarballs from approved npm registries", () => {
	for (const [packagePath, lockedPackage] of Object.entries(lockfile.packages)) {
		if (!lockedPackage || typeof lockedPackage.resolved !== "string") continue;
		if (!lockedPackage.resolved.startsWith("http")) continue;

		assert.ok(ALLOWED_TARBALL_HOSTS.has(new URL(lockedPackage.resolved).host), `${packagePath} resolves from an unapproved registry: ${lockedPackage.resolved}`);
	}
});
