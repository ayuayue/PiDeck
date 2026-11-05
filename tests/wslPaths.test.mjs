import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const paths = loadTsCommonJs("src/main/wsl/WslPaths.ts");
const rootEnvironment = paths.createWslEnvironment("Ubuntu-24.04", "root", "/root");

function loadWslEnvironment() {
	return loadTsCommonJs("src/main/wsl/WslEnvironment.ts");
}

function loadProjectStore(dialog = {}) {
	return loadTsCommonJs("src/main/projects/ProjectStore.ts", {
		stubs: { electron: { app: { getPath: () => "/tmp/pideck-test" }, dialog } },
	});
}

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
	assert.equal(paths.toWslLinuxPath("\\\\wsl.localhost\\Ubuntu-24.04\\root\\repo", rootEnvironment), "/root/repo");
	assert.equal(paths.toWindowsHostPath("/mnt/d/repo", rootEnvironment), "D:\\repo");
	assert.equal(paths.toWindowsHostPath("/root/repo", rootEnvironment), "\\\\wsl.localhost\\Ubuntu-24.04\\root\\repo");
	// drvfs 在 Windows 侧不走 9P（stat EPERM / spawn cwd ENOENT）：UNC 形态同样换回盘符路径
	assert.equal(paths.toWindowsHostPath("\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\c\\repo", rootEnvironment), "C:\\repo");
	assert.equal(paths.toWindowsHostPath("//wsl$/Ubuntu-24.04/mnt/d/space dir", rootEnvironment), "D:\\space dir");
	assert.equal(paths.toWindowsHostPath("c:/repo", rootEnvironment), "C:\\repo");
	assert.equal(paths.toWslLinuxPath("C:\\", rootEnvironment), "/mnt/c");
	assert.equal(paths.toWindowsHostPath("/mnt/c/", rootEnvironment), "C:\\");
	assert.equal(paths.linuxPathToWslUnc("/", "Ubuntu-24.04"), "\\\\wsl.localhost\\Ubuntu-24.04");
});

test("normalizes selected projects: drvfs → host drive path, distro-internal keeps Linux/UNC form", () => {
	// /mnt 下的目录一律存盘符路径：UNC 与 Linux 形态在 Windows 侧都不可直接使用
	// （\\wsl.localhost\<distro>\mnt\c 的 stat 是 EPERM，当子进程 cwd 是 ENOENT）。
	assert.equal(paths.normalizeSelectedWslProjectPath("D:\\repo", rootEnvironment), "D:\\repo");
	assert.equal(paths.normalizeSelectedWslProjectPath("/mnt/d/repo", rootEnvironment), "D:\\repo");
	assert.equal(paths.normalizeSelectedWslProjectPath("\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\d\\repo", rootEnvironment), "D:\\repo");
	// 发行版内目录保持原形态：UNC 输入回规范 UNC，Linux 输入保持 Linux
	assert.equal(paths.normalizeSelectedWslProjectPath("//wsl$/ubuntu-24.04/root/repo/", rootEnvironment), "\\\\wsl.localhost\\Ubuntu-24.04\\root\\repo");
	assert.equal(paths.normalizeSelectedWslProjectPath("/root/repo", rootEnvironment), "/root/repo");
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
	assert.deepEqual(JSON.parse(JSON.stringify(rootEnvironment)), {
		distro: "Ubuntu-24.04",
		user: "root",
		linuxHome: "/root",
		windowsHome: "\\\\wsl.localhost\\Ubuntu-24.04\\root",
	});
	assert.equal(paths.createWslEnvironment("Debian", "dev", "/srv/users/dev").windowsHome, "\\\\wsl.localhost\\Debian\\srv\\users\\dev");
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
	const { resolveWslEnvironment } = loadWslEnvironment();
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
	assert.deepEqual(Array.from(calls[0].args), ["-d", "Ubuntu-24.04", "-u", "dev", "--exec", "printenv", "HOME"]);

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

test("the system folder dialog is Windows-only: no WSL default path, no WSL environment", async () => {
	const dialogCalls = [];
	const dialog = {
		showOpenDialog: async (options) => {
			dialogCalls.push(options);
			return { canceled: false, filePaths: ["C:\\repos\\ba_cli"] };
		},
	};
	const { ProjectStore } = loadProjectStore(dialog);
	const store = new ProjectStore();
	let added;
	store.add = async (...args) => {
		added = args;
		return { id: "project", path: args[0] };
	};

	const project = await store.chooseAndAdd();

	// 没有 environment 参数了：WSL 目录一律走内置选择器（projects:add-wsl-path），由主进程在发行版内
	// 校验后转规范 UNC 入库。把发行版 HOME 当 defaultPath 交给系统对话框 = root 档案报「无法访问网络资源」。
	assert.equal(ProjectStore.prototype.chooseAndAdd.length, 0);
	assert.deepEqual(Array.from(dialogCalls[0].properties), ["openDirectory"]);
	assert.equal(dialogCalls[0].defaultPath, undefined);
	assert.equal(project.path, "C:\\repos\\ba_cli");
	// environment 必须显式为 windows（不再是什么都不传）：同一目录早先在 WSL 模式下加过时，
	// 去重会命中那条旧记录，只有显式环境才能把它从 wsl 翻回 windows——否则它仍被
	// 「按当前模式过滤可见项目」整条藏掉（2026-11 WSL→Windows 切换现场）。
	assert.equal(added[2], "windows");
});

test("a canceled dialog adds nothing", async () => {
	let addCalled = false;
	const { ProjectStore } = loadProjectStore({ showOpenDialog: async () => ({ canceled: true, filePaths: [] }) });
	const store = new ProjectStore();
	store.add = async () => {
		addCalled = true;
	};

	assert.equal(await store.chooseAndAdd(), null);
	assert.equal(addCalled, false);
});

test("matches WSL UNC aliases without folding Linux path case", () => {
	const { ProjectStore } = loadProjectStore({});
	const store = new ProjectStore();

	assert.equal(store.sameProjectPath("//wsl$/ubuntu-24.04/root/Repo", "\\\\wsl.localhost\\Ubuntu-24.04\\root\\Repo"), true);
	assert.equal(store.sameProjectPath("//wsl$/Ubuntu-24.04/root/Repo", "\\\\wsl.localhost\\Ubuntu-24.04\\root\\repo"), false);
});

test("drvfs 的三种写法算同一目录（否则改成盘符路径后重加会多一条重复项目）", () => {
	const { ProjectStore } = loadProjectStore({});
	const store = new ProjectStore();

	assert.equal(store.sameProjectPath("/mnt/d/Repo", "D:\\Repo"), true);
	assert.equal(store.sameProjectPath("\\\\wsl.localhost\\Debian\\mnt\\c\\proj", "C:\\proj"), true);
	assert.equal(store.sameProjectPath("/mnt/d/repo", "/mnt/d/other"), false);
	// 非 drvfs 的发行版内路径仍区分大小写（Linux 卷）
	assert.equal(store.sameProjectPath("/home/me/Repo", "\\\\wsl.localhost\\Debian\\home\\me\\repo"), false);
});
