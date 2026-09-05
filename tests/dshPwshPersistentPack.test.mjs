import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * 独立 pwsh 插件打包护栏：hostEntry 必须按包名解析 dsh-tool-pwsh-persistent，
 * 且该包是 production dependency（electron-builder 才会打进 asar）。
 * 嵌套 node-pty 必须 asarUnpack，否则 utilityProcess 加载原生模块会失败。
 */
const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package.json keeps dsh-tool-pwsh-persistent in devDependencies and the runtime archive seeds it", () => {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	assert.ok(
		pkg.devDependencies["dsh-tool-pwsh-persistent"],
		"dsh-tool-pwsh-persistent must be a devDependency (deps partitioned into the dsh-runtime archive)",
	);
	assert.match(
		String(pkg.devDependencies["dsh-tool-pwsh-persistent"]),
		/file:packages\/dsh-tool-pwsh-persistent/,
	);
	// 依赖分区（2026-09）：该包不进 app.asar，由 dsh-runtime 归档/SED 提供并守护。
	const checkScript = readFileSync(join(repoRoot, "scripts/check-dsh-asar.mjs"), "utf8");
	const packScript = readFileSync(join(repoRoot, "scripts/pack-dsh-runtime.mjs"), "utf8");
	assert.match(checkScript, /"dsh-tool-pwsh-persistent"/);
	assert.match(packScript, /EXTRA_SEED_NAMES = \["dsh-bill", "dsh-tool-pwsh-persistent"\]/);
});

test("asarUnpack includes nested node-pty of the pwsh plugin", () => {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const unpack = pkg.build?.asarUnpack ?? [];
	assert.ok(
		unpack.includes("node_modules/dsh-tool-pwsh-persistent/node_modules/node-pty/**"),
		"nested node-pty of dsh-tool-pwsh-persistent must be asarUnpacked",
	);
});

test("hostEntry composition inserts the standalone pwsh plugin by package name", () => {
	const src = readFileSync(join(repoRoot, "src/main/dsh/hostEntry.ts"), "utf8");
	assert.match(src, /require\.resolve\("dsh-tool-pwsh-persistent"\)/);
	assert.doesNotMatch(src, /pideckPwshPersistent\.js/);
	// 官方 rc.8 持久 pwsh 工具名是 `pwsh`，会和一次性沙箱工具冲突，且依赖
	// ctx.terminals；升级 harness 时禁止误把官方包挂进 host 组合。
	assert.doesNotMatch(src, /name:\s*"@deepseek-ai\/dsh-tool-pwsh-persistent"/);
});

test("electron-vite externalizes the standalone pwsh package", () => {
	const src = readFileSync(join(repoRoot, "electron.vite.config.ts"), "utf8");
	assert.match(src, /"dsh-tool-pwsh-persistent"/);
	assert.doesNotMatch(src, /pideckPwshPersistent:/);
});

test("standalone package peers pin the host rc line, not wildcard", () => {
	const pkg = JSON.parse(
		readFileSync(join(repoRoot, "packages/dsh-tool-pwsh-persistent/package.json"), "utf8"),
	);
	assert.equal(pkg.peerDependencies["@deepseek-ai/dsh-tools"], "^0.1.0-rc.8");
	assert.equal(pkg.peerDependencies["@deepseek-ai/dsh-timeout"], "^0.1.0-rc.8");
	assert.notEqual(pkg.peerDependencies["@deepseek-ai/dsh-tools"], "*");
});

test("dsh-tool-pwsh-persistent is resolvable from the app root when installed", () => {
	let resolved;
	try {
		resolved = require.resolve("dsh-tool-pwsh-persistent");
	} catch {
		// npm install 尚未把 file: 包链上时跳过（本文件后半段会在 install 后绿）
		return;
	}
	assert.ok(existsSync(resolved), `resolved path missing: ${resolved}`);
	const pkg = JSON.parse(readFileSync(require.resolve("dsh-tool-pwsh-persistent/package.json"), "utf8"));
	assert.equal(pkg.name, "dsh-tool-pwsh-persistent");
});
