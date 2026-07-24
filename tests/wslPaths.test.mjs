import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadWslPaths() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

function loadWslEnvironment(paths) {
	const sandbox = {
		exports: {},
		process,
		require: (id) => id === "./WslPaths" ? paths : require(id),
	};
	vm.runInNewContext(transpile("src/main/wsl/WslEnvironment.ts"), sandbox, { filename: "WslEnvironment.ts" });
	return sandbox.exports;
}

function loadProjectStore(paths, dialog) {
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "electron") {
				return { app: { getPath: () => "/tmp/pideck-test" }, dialog };
			}
			if (id === "../wsl/WslPaths") return paths;
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/projects/ProjectStore.ts"), sandbox, { filename: "ProjectStore.ts" });
	return sandbox.exports;
}

const paths = loadWslPaths();
const rootEnvironment = paths.createWslEnvironment("Ubuntu-24.04", "root", "/root");

test("parses WSL UNC aliases and legacy forward-slash paths", () => {
	const cases = [
		["\\\\wsl$\\Ubuntu-24.04\\root\\ba cli", "/root/ba cli"],
		["\\\\wsl.localhost\\Ubuntu-24.04\\root\\ba_cli\\", "/root/ba_cli"],
		["//wsl.localhost/Ubuntu-24.04/root/ba_cli", "/root/ba_cli"],
		["//wsl$/Ubuntu-24.04/root/ba_cli", "/root/ba_cli"],
	];
	for (const [input, expected] of cases) {
		const parsed = paths.parseWslUncPath(input);
		assert.equal(parsed?.distro, "Ubuntu-24.04");
		assert.equal(parsed?.linuxPath, expected);
	}
});

test("converts drive, mounted-drive, Linux, and UNC paths across host boundaries", () => {
	assert.equal(paths.toWslLinuxPath("C:\\repo\\space dir", rootEnvironment), "/mnt/c/repo/space dir");
	assert.equal(paths.toWslLinuxPath("C:/repo", rootEnvironment), "/mnt/c/repo");
	assert.equal(paths.toWslLinuxPath("/mnt/d/repo", rootEnvironment), "/mnt/d/repo");
	assert.equal(
		paths.toWslLinuxPath("\\\\wsl.localhost\\Ubuntu-24.04\\root\\repo", rootEnvironment),
		"/root/repo",
	);
	assert.equal(paths.toWindowsHostPath("/mnt/d/repo", rootEnvironment), "D:\\repo");
	assert.equal(paths.toWindowsHostPath("/root/repo", rootEnvironment), "\\\\wsl.localhost\\Ubuntu-24.04\\root\\repo");
	assert.equal(paths.toWindowsHostPath("c:/repo", rootEnvironment), "C:\\repo");
	assert.equal(paths.toWslLinuxPath("C:\\", rootEnvironment), "/mnt/c");
	assert.equal(paths.toWindowsHostPath("/mnt/c/", rootEnvironment), "C:\\");
	assert.equal(paths.linuxPathToWslUnc("/", "Ubuntu-24.04"), "\\\\wsl.localhost\\Ubuntu-24.04");
});

test("normalizes selected projects without changing the existing mounted-drive convention", () => {
	assert.equal(paths.normalizeSelectedWslProjectPath("D:\\repo", rootEnvironment), "/mnt/d/repo");
	assert.equal(
		paths.normalizeSelectedWslProjectPath("//wsl$/ubuntu-24.04/root/repo/", rootEnvironment),
		"\\\\wsl.localhost\\Ubuntu-24.04\\root\\repo",
	);
});

test("rejects another distribution and unrelated network shares", () => {
	assert.throws(
		() => paths.toWslLinuxPath("\\\\wsl.localhost\\Debian\\root\\repo", rootEnvironment),
		(error) => error.code === "WSL_DISTRO_MISMATCH" && error.message.includes("Debian"),
	);
	assert.throws(
		() => paths.toWslLinuxPath("\\\\server\\share\\repo", rootEnvironment),
		(error) => error.code === "INVALID_WSL_PATH",
	);
});

test("builds root, regular-user, and custom HOME contexts", () => {
	assert.deepEqual(
		JSON.parse(JSON.stringify(rootEnvironment)),
		{
			distro: "Ubuntu-24.04",
			user: "root",
			linuxHome: "/root",
			windowsHome: "\\\\wsl.localhost\\Ubuntu-24.04\\root",
		},
	);
	assert.equal(
		paths.createWslEnvironment("Debian", "dev", "/srv/users/dev").windowsHome,
		"\\\\wsl.localhost\\Debian\\srv\\users\\dev",
	);
	assert.throws(
		() => paths.createWslEnvironment("Debian", "dev", ""),
		(error) => error.code === "INVALID_WSL_PATH",
	);
	assert.throws(
		() => paths.createWslEnvironment("Debian", "dev", "home/dev"),
		(error) => error.code === "INVALID_WSL_PATH",
	);
});

test("resolves HOME once and exposes an observable compatibility fallback", async () => {
	const { resolveWslEnvironment } = loadWslEnvironment(paths);
	const calls = [];
	const resolved = await resolveWslEnvironment("Ubuntu-24.04", "dev", {
		wslCommand: "wsl.exe",
		execFile: (command, args, options, callback) => {
			calls.push({ command, args, options });
			callback(null, "/srv/dev home\n", "");
		},
	});
	assert.equal(resolved.linuxHome, "/srv/dev home");
	assert.equal(resolved.windowsHome, "\\\\wsl.localhost\\Ubuntu-24.04\\srv\\dev home");
	assert.deepEqual(
		Array.from(calls[0].args),
		["-d", "Ubuntu-24.04", "-u", "dev", "--exec", "printenv", "HOME"],
	);

	const warnings = [];
	const fallback = await resolveWslEnvironment("Ubuntu-24.04", "root", {
		wslCommand: "wsl.exe",
		execFile: (_command, _args, _options, callback) => callback(new Error("offline"), "", ""),
		warn: (message, details) => warnings.push({ message, details }),
	});
	assert.equal(fallback.linuxHome, "/root");
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].details.fallback, "/root");
});

test("opens the WSL project picker at the active HOME and canonicalizes its selection", async () => {
	const dialogCalls = [];
	const dialog = {
		showOpenDialog: async (options) => {
			dialogCalls.push(options);
			return {
				canceled: false,
				filePaths: ["//wsl.localhost/Ubuntu-24.04/root/ba_cli/"],
			};
		},
	};
	const { ProjectStore } = loadProjectStore(paths, dialog);
	const store = new ProjectStore();
	let added;
	store.add = async (...args) => {
		added = args;
		return { id: "project", path: args[0] };
	};

	const project = await store.chooseAndAdd("wsl", rootEnvironment);

	assert.equal(dialogCalls[0].defaultPath, rootEnvironment.windowsHome);
	assert.deepEqual(Array.from(dialogCalls[0].properties), ["openDirectory"]);
	assert.equal(project.path, "\\\\wsl.localhost\\Ubuntu-24.04\\root\\ba_cli");
	assert.equal(added[2], "wsl");
});

test("rejects a project from another distro before adding it", async () => {
	const dialog = {
		showOpenDialog: async () => ({
			canceled: false,
			filePaths: ["\\\\wsl.localhost\\Debian\\root\\ba_cli"],
		}),
	};
	const { ProjectStore } = loadProjectStore(paths, dialog);
	const store = new ProjectStore();
	let addCalled = false;
	store.add = async () => {
		addCalled = true;
	};

	await assert.rejects(
		store.chooseAndAdd("wsl", rootEnvironment),
		(error) => error.code === "WSL_DISTRO_MISMATCH",
	);
	assert.equal(addCalled, false);
});

test("matches WSL UNC aliases without folding Linux path case", () => {
	const { ProjectStore } = loadProjectStore(paths, {});
	const store = new ProjectStore();

	assert.equal(
		store.sameProjectPath(
			"//wsl$/ubuntu-24.04/root/Repo",
			"\\\\wsl.localhost\\Ubuntu-24.04\\root\\Repo",
		),
		true,
	);
	assert.equal(
		store.sameProjectPath(
			"//wsl$/Ubuntu-24.04/root/Repo",
			"\\\\wsl.localhost\\Ubuntu-24.04\\root\\repo",
		),
		false,
	);
});
