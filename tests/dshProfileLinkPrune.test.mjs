import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { pruneStaleRuntimeLinks } = loadTsCommonJs("src/main/dsh/dshProfileLinkPrune.ts");

const CURRENT = "0.2.1-rc.1";
const PREVIOUS = "0.2.0-rc.2";

function makePackage(runtimeNodeModules, name) {
	const dir = join(runtimeNodeModules, ...name.split("/"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
	return dir;
}

function link(target, path) {
	mkdirSync(join(path, ".."), { recursive: true });
	symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/** 复现 0.2.1 升级现场：旧版 preset 包以符号链接形式残留在 profile 的 node_modules。 */
function scenario() {
	const root = mkdtempSync(join(tmpdir(), "pideck-profile-links-"));
	const runtimes = join(root, "runtimes", "dsh");
	const currentModules = join(runtimes, CURRENT, "node_modules");
	const previousModules = join(runtimes, PREVIOUS, "node_modules");
	const profile = join(root, "profile");
	const modules = join(profile, "node_modules");
	mkdirSync(join(modules, "@deepseek-ai"), { recursive: true });
	mkdirSync(join(modules, "@pideck", "dsh-host-composition"), { recursive: true });
	const currentPreset = makePackage(currentModules, "@deepseek-ai/dsh-agent-preset");
	const previousPreset = makePackage(previousModules, "@deepseek-ai/dsh-agent-preset");
	const vendor = join(root, "pnpm-store", "vendor-lib");
	mkdirSync(vendor, { recursive: true });
	link(previousPreset, join(modules, "@deepseek-ai", "dsh-agent-preset"));
	link(currentPreset, join(modules, "@deepseek-ai", "dsh-web-app"));
	link(join(runtimes, "0.1.9", "node_modules", "@deepseek-ai", "dsh-gone"), join(modules, "@deepseek-ai", "dsh-gone"));
	link(vendor, join(modules, "@scope", "vendor-lib"));
	return { root, modules, currentModules, previousModules, currentPreset, previousPreset, vendor };
}

test("removes profile links into a previous runtime install", () => {
	const { root, modules, currentModules, previousPreset } = scenario();
	try {
		const pruned = pruneStaleRuntimeLinks(join(root, "profile"), currentModules);
		assert.deepEqual([...pruned.map((entry) => entry.path)].sort(), [join(modules, "@deepseek-ai", "dsh-agent-preset"), join(modules, "@deepseek-ai", "dsh-gone")].sort());
		const previous = pruned.find((entry) => entry.path.endsWith("dsh-agent-preset"));
		assert.equal(previous.target, previousPreset);
		assert.equal(existsSync(join(modules, "@deepseek-ai", "dsh-agent-preset")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("keeps links into the current runtime, pnpm-style links and real bundle directories", () => {
	const { root, modules, currentModules } = scenario();
	try {
		pruneStaleRuntimeLinks(join(root, "profile"), currentModules);
		assert.equal(existsSync(join(modules, "@deepseek-ai", "dsh-web-app")), true);
		assert.equal(existsSync(join(modules, "@scope", "vendor-lib")), true);
		assert.equal(existsSync(join(modules, "@pideck", "dsh-host-composition")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("removes dangling links that still spell a retired runtime path", () => {
	const { root, modules, currentModules } = scenario();
	try {
		pruneStaleRuntimeLinks(join(root, "profile"), currentModules);
		assert.equal(existsSync(join(modules, "@deepseek-ai", "dsh-gone")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("is idempotent and tolerates a profile without node_modules", () => {
	const { root, currentModules } = scenario();
	try {
		const profile = join(root, "profile");
		pruneStaleRuntimeLinks(profile, currentModules);
		assert.equal(pruneStaleRuntimeLinks(profile, currentModules).length, 0);
		assert.equal(pruneStaleRuntimeLinks(join(root, "absent"), currentModules).length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
