import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function put(path, content) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

function packageFixture(root, packageRoot, name = "tool") {
	put(join(packageRoot, "package.json"), JSON.stringify({ name, pi: { extensions: ["index.ts"] } }));
	put(join(packageRoot, "index.ts"), "export default () => {};\n");
}

function resolveExtensions(resolveConfiguredPackageResources, options) {
	return resolveConfiguredPackageResources({
		resourceType: "extensions",
		collectDirectory: () => [],
		...options,
	});
}

test("package resources 带出就近 package.json 的版本", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-package-version-"));
	try {
		const agentDir = join(root, "agent");
		const packageRoot = join(root, "shared-package");
		put(join(packageRoot, "package.json"), JSON.stringify({ name: "shared-package", version: "1.2.3", pi: { extensions: ["index.ts"] } }));
		put(join(packageRoot, "index.ts"), "export default () => {};\n");
		const userSettingsFile = join(agentDir, "settings.json");
		put(userSettingsFile, JSON.stringify({ packages: [packageRoot] }));
		const { resolveConfiguredPackageResources } = loadTsCommonJs("src/main/packageResourceResolver.ts");
		const resources = resolveExtensions(resolveConfiguredPackageResources, { userSettingsFile, userBaseDir: agentDir });
		assert.equal(resources.length, 1);
		assert.equal(resources[0].version, "1.2.3");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("包无 version 字段时不向上串版本（遇到第一个 package.json 即停）", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-package-noversion-"));
	try {
		const agentDir = join(root, "agent");
		const packageRoot = join(root, "shared-package");
		// 包自身无 version，但祖先目录故意放一个带版本的 package.json——不许被串报
		put(join(packageRoot, "package.json"), JSON.stringify({ name: "shared-package", pi: { extensions: ["index.ts"] } }));
		put(join(packageRoot, "index.ts"), "export default () => {};\n");
		put(join(root, "package.json"), JSON.stringify({ name: "ancestor", version: "9.9.9" }));
		const userSettingsFile = join(agentDir, "settings.json");
		put(userSettingsFile, JSON.stringify({ packages: [packageRoot] }));
		const { resolveConfiguredPackageResources } = loadTsCommonJs("src/main/packageResourceResolver.ts");
		const resources = resolveExtensions(resolveConfiguredPackageResources, { userSettingsFile, userBaseDir: agentDir });
		assert.equal(resources.length, 1);
		assert.equal(resources[0].version, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("package resources deduplicate symlink aliases while keeping the project winner", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck-package-alias-"));
	try {
		const agentDir = join(root, "agent");
		const projectPiDir = join(root, "project", ".pi");
		const packageRoot = join(root, "shared-package");
		const userAlias = join(root, "user-alias");
		const projectAlias = join(root, "project-alias");
		packageFixture(root, packageRoot, "shared-package");
		try {
			symlinkSync(packageRoot, userAlias, process.platform === "win32" ? "junction" : "dir");
			symlinkSync(packageRoot, projectAlias, process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit directory link creation");
				return;
			}
			throw error;
		}
		const userSettingsFile = join(agentDir, "settings.json");
		const projectSettingsFile = join(projectPiDir, "settings.json");
		put(userSettingsFile, JSON.stringify({ packages: [userAlias] }));
		put(projectSettingsFile, JSON.stringify({ packages: [projectAlias] }));
		const { resolveConfiguredPackageResources } = loadTsCommonJs("src/main/packageResourceResolver.ts");
		const resources = resolveExtensions(resolveConfiguredPackageResources, {
			userSettingsFile,
			userBaseDir: agentDir,
			projectSettingsFile,
			projectBaseDir: projectPiDir,
		});
		assert.equal(resources.length, 1);
		assert.equal(resources[0].scope, "project");
		assert.equal(resources[0].path, join(projectAlias, "index.ts"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("user npm legacy fallback uses configured command and caches the global root", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-package-npm-"));
	try {
		const agentDir = join(root, "agent");
		const settingsFile = join(agentDir, "settings.json");
		const globalRoot = join(root, "legacy", "node_modules");
		packageFixture(root, join(globalRoot, "tool"), "tool");
		packageFixture(root, join(globalRoot, "tool-two"), "tool-two");
		put(settingsFile, JSON.stringify({ npmCommand: ["custom-npm"], packages: ["npm:tool"] }));
		const calls = [];
		const { resolveConfiguredPackageResources } = loadTsCommonJs("src/main/packageResourceResolver.ts", {
			stubs: {
				"node:child_process": {
					execFileSync(command, args) {
						calls.push({ command, args: [...args] });
						return `${globalRoot}\n`;
					},
				},
			},
		});
		const first = resolveExtensions(resolveConfiguredPackageResources, {
			userSettingsFile: settingsFile,
			userBaseDir: agentDir,
		});
		assert.equal(first.length, 1);
		assert.equal(first[0].path, join(globalRoot, "tool", "index.ts"));
		assert.equal(first[0].physicalScope, "user");

		put(settingsFile, JSON.stringify({ npmCommand: ["custom-npm"], packages: ["npm:tool-two"] }));
		const second = resolveExtensions(resolveConfiguredPackageResources, {
			userSettingsFile: settingsFile,
			userBaseDir: agentDir,
		});
		assert.equal(second[0].path, join(globalRoot, "tool-two", "index.ts"));
		assert.equal(calls.length, 1);
		assert.equal(calls[0].command, "custom-npm");
		assert.deepEqual(calls[0].args, ["root", "-g"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("project npm packages never fall back to a user-global installation", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-package-project-"));
	try {
		const agentDir = join(root, "agent");
		const projectPiDir = join(root, "project", ".pi");
		const userSettingsFile = join(agentDir, "settings.json");
		const projectSettingsFile = join(projectPiDir, "settings.json");
		put(userSettingsFile, "{}");
		put(projectSettingsFile, JSON.stringify({ packages: ["npm:project-only"] }));
		let commandCalls = 0;
		const { resolveConfiguredPackageResources } = loadTsCommonJs("src/main/packageResourceResolver.ts", {
			stubs: {
				"node:child_process": {
					execFileSync() {
						commandCalls += 1;
						return join(root, "global", "node_modules");
					},
				},
			},
		});
		const resources = resolveExtensions(resolveConfiguredPackageResources, {
			userSettingsFile,
			userBaseDir: agentDir,
			projectSettingsFile,
			projectBaseDir: projectPiDir,
		});
		assert.equal(resources.length, 0);
		assert.equal(commandCalls, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pnpm legacy fallback reads the configured global dependency path", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-package-pnpm-"));
	try {
		const agentDir = join(root, "agent");
		const settingsFile = join(agentDir, "settings.json");
		const packageRoot = join(root, "pnpm-global", "tool");
		packageFixture(root, packageRoot, "tool");
		put(
			settingsFile,
			JSON.stringify({
				npmCommand: ["corepack", "--", "pnpm"],
				packages: ["npm:tool"],
			}),
		);
		const calls = [];
		const { resolveConfiguredPackageResources } = loadTsCommonJs("src/main/packageResourceResolver.ts", {
			stubs: {
				"node:child_process": {
					execFileSync(command, args) {
						calls.push({ command, args: [...args] });
						return JSON.stringify([{ dependencies: { tool: { path: packageRoot } } }]);
					},
				},
			},
		});
		const resources = resolveExtensions(resolveConfiguredPackageResources, {
			userSettingsFile: settingsFile,
			userBaseDir: agentDir,
		});
		assert.equal(resources[0].path, join(packageRoot, "index.ts"));
		assert.equal(calls[0].command, "corepack");
		assert.deepEqual(calls[0].args, ["--", "pnpm", "list", "-g", "--depth", "0", "--json"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bun legacy fallback derives its global node_modules directory from pm bin", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-package-bun-"));
	try {
		const agentDir = join(root, "agent");
		const settingsFile = join(agentDir, "settings.json");
		const binDir = join(root, "bun", "bin");
		const packageRoot = join(root, "bun", "install", "global", "node_modules", "tool");
		packageFixture(root, packageRoot, "tool");
		put(settingsFile, JSON.stringify({ npmCommand: ["bun"], packages: ["npm:tool"] }));
		const calls = [];
		const { resolveConfiguredPackageResources } = loadTsCommonJs("src/main/packageResourceResolver.ts", {
			stubs: {
				"node:child_process": {
					execFileSync(command, args) {
						calls.push({ command, args: [...args] });
						return `${binDir}\n`;
					},
				},
			},
		});
		const resources = resolveExtensions(resolveConfiguredPackageResources, {
			userSettingsFile: settingsFile,
			userBaseDir: agentDir,
		});
		assert.equal(resources[0].path, join(packageRoot, "index.ts"));
		assert.equal(calls[0].command, "bun");
		assert.deepEqual(calls[0].args, ["pm", "bin", "-g"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
