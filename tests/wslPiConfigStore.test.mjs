import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * WslPiConfigStore（P1-1 + W3）：hostId → WslHostStore 档案 → resolveWslEnvironment → 发行版 HOME 的
 * .pi/agent，读 models.json / settings.json。
 *
 * 关键契约（都是行为断言，不是源码形状）：
 * - 只认档案：档案缺失/发行版不可用/路径不可读在**读文件之前**就回稳定码，绝不回退 Windows HOME；
 * - 解析全程有截止：15s 内没解析完就是 WSL_CONFIG_DISTRO_UNAVAILABLE，不能把页面永远挂在加载态；
 * - 读仍走 UNC；写必须走发行版内 exec 端口（wsl.exe + /bin/sh 原子替换），不再把 JSON 写回 UNC 路径；
 * - 非 Windows / wsl.exe 缺失 = WSL_CONFIG_UNAVAILABLE（不假装能读能写）；
 * - models.json 保存沿用本地校验规则，settings.json 保存沿用本地「资源键以磁盘为准」的合并规则。
 */

const storeModule = loadTsCommonJs("src/main/config/WslPiConfigStore.ts");
const shared = loadTsCommonJs("src/shared/piConfig.ts");
const wslPaths = loadTsCommonJs("src/main/wsl/WslPaths.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const DISTRO = "Ubuntu-26.04";
const USER = "dev";
const LINUX_HOME = "/home/dev";
const LINUX_CONFIG_DIR = "/home/dev/.pi/agent";
const PROFILE = { id: HOST, label: "Ubuntu dev", distro: DISTRO, user: USER };
const DISTRO_ROOT = wslPaths.linuxPathToWslUnc("/", DISTRO);
const WINDOWS_HOME = wslPaths.linuxPathToWslUnc(LINUX_HOME, DISTRO);
const CONFIG_DIR = wslPaths.linuxPathToWslUnc(LINUX_CONFIG_DIR, DISTRO);

async function rejectionCode(run) {
	try {
		await run();
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
	throw new Error("EXPECTED_REJECTION");
}

/** 注入式 fs：只记录调用、只认测试给的目录集合，用来证明「不读别处」。 */
function createFakeFs(options = {}) {
	const files = new Map(Object.entries(options.files ?? {}));
	const dirs = new Set(options.dirs ?? [DISTRO_ROOT, WINDOWS_HOME]);
	const calls = [];
	const fs = {
		async statDirectory(path) {
			calls.push(["stat", path]);
			if (options.statError === path) throw Object.assign(new Error("stat failed"), { code: "EACCES" });
			return dirs.has(path) ? { isDirectory: true } : null;
		},
		async readTextFile(path) {
			calls.push(["read", path]);
			if (options.readError === path) throw Object.assign(new Error("read failed"), { code: "EACCES" });
			return files.has(path) ? files.get(path) : null;
		},
		// 旧实现的 UNC 写入口：保留在 fake 里只为了证明新实现不再调用它（调用即记录）。
		async writeTextFile(path, content) {
			calls.push(["write", path, content]);
		},
	};
	return { fs, calls, files };
}

/** 发行版内写入口：记录每一份 stdin 与目标位置；失败模式由 options.error 控制。 */
function createFakeExec(options = {}) {
	const calls = [];
	const exec = async (input) => {
		calls.push(input);
		if (options.error !== undefined) throw options.error;
	};
	return { exec, calls };
}

function createStore(fsPort, options = {}) {
	const execInDistro = options.execInDistro ?? options.exec ?? createFakeExec().exec;
	return storeModule.createWslPiConfigStore({
		listProfiles: async () => options.profiles ?? [PROFILE],
		resolveEnvironment: async (distro, user) => options.environment ?? { distro, user, linuxHome: LINUX_HOME, windowsHome: WINDOWS_HOME },
		fs: fsPort,
		execInDistro,
		platform: options.platform ?? "win32",
		...(options.timer === undefined ? {} : { timer: options.timer }),
		...(options.resolveTimeoutMs === undefined ? {} : { resolveTimeoutMs: options.resolveTimeoutMs }),
		translate: (key, params) => key + (params?.provider ? ":" + params.provider : ""),
	});
}

function plainExecCalls(calls) {
	return JSON.parse(JSON.stringify(calls));
}

test("读取路径只来自档案环境：发行版 HOME 下的 .pi/agent（UNC 拼接）", async () => {
	const { fs, calls } = createFakeFs({ files: { [CONFIG_DIR + "\\models.json"]: '{"providers":{"openai":{"models":[]}}}' } });
	const snapshot = await createStore(fs).read({ hostId: HOST, file: "models" });
	assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
		kind: "wsl",
		hostId: HOST,
		file: "models",
		label: "Ubuntu dev",
		distro: DISTRO,
		user: USER,
		data: { providers: { openai: { models: [] } } },
	});
	// 先判定发行版根与 HOME（在读文件之前），再读 allowlist 里的单个文件。
	assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
		["stat", DISTRO_ROOT],
		["stat", WINDOWS_HOME],
		["read", CONFIG_DIR + "\\models.json"],
	]);
	assert.ok(CONFIG_DIR.startsWith("\\\\wsl.localhost\\" + DISTRO), "配置目录必须落在发行版 UNC 路径下: " + CONFIG_DIR);
});

test("文件缺失按新安装返回空配置，不报错也不回退本机", async () => {
	const { fs } = createFakeFs();
	const models = await createStore(fs).read({ hostId: HOST, file: "models" });
	assert.deepEqual(JSON.parse(JSON.stringify(models.data)), { providers: {} });
	const settings = await createStore(fs).read({ hostId: HOST, file: "settings" });
	assert.deepEqual(JSON.parse(JSON.stringify(settings.data)), {});
});

test("档案缺失/发行版未启动/HOME 不可读：读文件之前给稳定码", async () => {
	const missingProfile = createFakeFs();
	assert.equal(await rejectionCode(() => createStore(missingProfile.fs, { profiles: [] }).read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.hostNotFound);
	assert.equal(missingProfile.calls.length, 0, "档案缺失时不得触碰文件系统");

	const stopped = createFakeFs({ dirs: [] });
	assert.equal(await rejectionCode(() => createStore(stopped.fs).read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.distroUnavailable);
	assert.deepEqual(JSON.parse(JSON.stringify(stopped.calls)), [["stat", DISTRO_ROOT]]);

	const missingHome = createFakeFs({ dirs: [DISTRO_ROOT] });
	assert.equal(await rejectionCode(() => createStore(missingHome.fs).read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.pathUnreadable);
	assert.deepEqual(JSON.parse(JSON.stringify(missingHome.calls)), [
		["stat", DISTRO_ROOT],
		["stat", WINDOWS_HOME],
	]);

	const unreadable = createFakeFs({ readError: CONFIG_DIR + "\\models.json" });
	assert.equal(await rejectionCode(() => createStore(unreadable.fs).read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.pathUnreadable);

	const badHost = createFakeFs();
	assert.equal(await rejectionCode(() => createStore(badHost.fs).read({ hostId: "nope", file: "models" })), shared.WSL_CONFIG_CODES.targetInvalid);
});

test("resolve 全程 15s 截止：超时回 WSL_CONFIG_DISTRO_UNAVAILABLE，成功则清除定时器", async () => {
	const pending = [];
	const timer = {
		set(callback, ms) {
			const handle = { callback, ms, cleared: false };
			pending.push(handle);
			return handle;
		},
		clear(handle) {
			if (handle) handle.cleared = true;
		},
	};
	let releaseProfiles;
	const stuck = storeModule.createWslPiConfigStore({
		listProfiles: () =>
			new Promise((resolve) => {
				releaseProfiles = resolve;
			}),
		resolveEnvironment: async (distro, user) => ({ distro, user, linuxHome: LINUX_HOME, windowsHome: WINDOWS_HOME }),
		fs: createFakeFs().fs,
		execInDistro: createFakeExec().exec,
		platform: "win32",
		timer,
	});
	const deadline = stuck.read({ hostId: HOST, file: "models" });
	const outcome = deadline.then(
		() => "resolved",
		(error) => error.message,
	);
	assert.equal(pending.length, 1);
	assert.equal(pending[0].ms, 15000, "resolve 全程截止必须是 15s");
	pending[0].callback();
	assert.equal(await outcome, shared.WSL_CONFIG_CODES.distroUnavailable);
	// 迟到的端口结果不得让已超时的请求复活。
	releaseProfiles([PROFILE]);
	await new Promise((resolve) => setImmediate(resolve));

	const { fs } = createFakeFs();
	const setTimeoutCalls = [];
	const fastStore = storeModule.createWslPiConfigStore({
		listProfiles: async () => [PROFILE],
		resolveEnvironment: async () => ({ distro: DISTRO, user: USER, linuxHome: LINUX_HOME, windowsHome: WINDOWS_HOME }),
		fs,
		execInDistro: createFakeExec().exec,
		platform: "win32",
		timer: {
			set(callback, ms) {
				const handle = { callback, ms, cleared: false };
				setTimeoutCalls.push(handle);
				return handle;
			},
			clear(handle) {
				if (handle) handle.cleared = true;
			},
		},
	});
	await fastStore.read({ hostId: HOST, file: "models" });
	assert.equal(setTimeoutCalls[0].cleared, true, "解析成功后必须清掉截止定时器");
});

test("非 Windows 一律 WSL_CONFIG_UNAVAILABLE：不查档案、不碰 fs、不执行 wsl.exe", async () => {
	let listCalls = 0;
	const { fs, calls } = createFakeFs();
	const exec = createFakeExec();
	const store = storeModule.createWslPiConfigStore({
		listProfiles: async () => {
			listCalls += 1;
			return [PROFILE];
		},
		resolveEnvironment: async () => ({ distro: DISTRO, user: USER, linuxHome: LINUX_HOME, windowsHome: WINDOWS_HOME }),
		fs,
		execInDistro: exec.exec,
		platform: "darwin",
		translate: (key) => key,
	});
	assert.equal(await rejectionCode(() => store.read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.unavailable);
	assert.equal(await rejectionCode(() => store.saveModels({ hostId: HOST, data: { providers: {} } })), shared.WSL_CONFIG_CODES.unavailable);
	assert.equal(listCalls, 0);
	assert.deepEqual(calls, []);
	assert.deepEqual(exec.calls, []);
});

test("JSON 损坏给 WSL_CONFIG_FILE_INVALID（不把坏文件当空配置展示）", async () => {
	const { fs } = createFakeFs({ files: { [CONFIG_DIR + "\\models.json"]: "{ providers: " } });
	assert.equal(await rejectionCode(() => createStore(fs).read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.fileInvalid);

	const nonObject = createFakeFs({ files: { [CONFIG_DIR + "\\settings.json"]: "[1,2,3]" } });
	assert.equal(await rejectionCode(() => createStore(nonObject.fs).read({ hostId: HOST, file: "settings" })), shared.WSL_CONFIG_CODES.fileInvalid);

	// UTF-8 BOM（Windows 手写文件）必须兼容。
	const bom = createFakeFs({ files: { [CONFIG_DIR + "\\settings.json"]: '\uFEFF{"theme":"dark"}' } });
	const snapshot = await createStore(bom.fs).read({ hostId: HOST, file: "settings" });
	assert.deepEqual(JSON.parse(JSON.stringify(snapshot.data)), { theme: "dark" });
});

test("models.json 保存沿用本地校验：不合格内容不落盘", async () => {
	const { fs, calls } = createFakeFs();
	const exec = createFakeExec();
	const store = createStore(fs, { exec: exec.exec });
	const badName = await store.saveModels({ hostId: HOST, data: { providers: { "../evil": { models: [] } } } });
	assert.equal(badName.valid, false);
	assert.match(badName.error, /providerNameInvalid/);
	const badModel = await store.saveModels({ hostId: HOST, data: { providers: { openai: { models: [{ id: "x".repeat(300) }] } } } });
	assert.equal(badModel.valid, false);
	assert.match(badModel.error, /modelIdInvalid/);
	const noModels = await store.saveModels({ hostId: HOST, data: { providers: { openai: {} } } });
	assert.equal(noModels.valid, false);
	assert.match(noModels.error, /providerModelsRequired/);
	const missingApi = await store.saveModels({ hostId: HOST, data: { providers: { custom: { baseUrl: "https://api.example.com/v1", models: [{ id: "m1" }] } } } });
	assert.equal(missingApi.valid, false);
	assert.match(missingApi.error, /modelApiRequired/);
	assert.deepEqual(exec.calls, [], "校验失败不得执行写命令");
	assert.deepEqual(
		calls.filter((call) => call[0] === "write"),
		[],
		"校验失败不得走 UNC 写",
	);

	const data = { providers: { openai: { baseUrl: "https://api.example.com/v1", models: [{ id: "gpt-4o" }] } } };
	const saved = await store.saveModels({ hostId: HOST, data });
	assert.equal(saved.valid, true);
	assert.deepEqual(JSON.parse(JSON.stringify(saved.receipt)), { kind: "wsl", hostId: HOST, file: "models" });
	assert.deepEqual(plainExecCalls(exec.calls), [
		{
			distro: DISTRO,
			user: USER,
			configDir: LINUX_CONFIG_DIR,
			fileName: "models.json",
			content: JSON.stringify(data, null, 2) + "\n",
		},
	]);
	assert.deepEqual(
		calls.filter((call) => call[0] === "write"),
		[],
		"写盘必须走发行版内 exec，不再写 UNC 路径",
	);
});

test("写盘 stdin 是完整 JSON 字节：多字节内容不丢、带结尾换行", async () => {
	const exec = createFakeExec();
	const store = createStore(createFakeFs().fs, { exec: exec.exec });
	const data = { providers: { openai: { baseUrl: "https://api.example.com/v1?note=配置", models: [{ id: "gpt-4o" }] } } };
	const saved = await store.saveModels({ hostId: HOST, data });
	assert.equal(saved.valid, true);
	const expected = JSON.stringify(data, null, 2) + "\n";
	assert.equal(exec.calls[0].content, expected);
	assert.equal(Buffer.byteLength(exec.calls[0].content, "utf8"), Buffer.byteLength(expected, "utf8"));
	assert.ok(exec.calls[0].content.endsWith("\n"));
});

test("settings.json 保存沿用本地合并规则：资源键以磁盘为准", async () => {
	const settingsPath = CONFIG_DIR + "\\settings.json";
	const { fs, calls } = createFakeFs({ files: { [settingsPath]: JSON.stringify({ packages: ["npm:pi-x"], theme: "light" }) } });
	const exec = createFakeExec();
	const saved = await createStore(fs, { exec: exec.exec }).saveSettings({ hostId: HOST, settings: { theme: "dark" } });
	assert.equal(saved.valid, true);
	assert.equal(exec.calls.length, 1);
	assert.equal(exec.calls[0].fileName, "settings.json");
	// 表单没编辑资源键：磁盘上的 packages 不能被页面快照冲掉。
	assert.deepEqual(JSON.parse(exec.calls[0].content), { packages: ["npm:pi-x"], theme: "dark" });
	assert.deepEqual(
		calls.filter((call) => call[0] === "write"),
		[],
		"写盘必须走发行版内 exec，不再写 UNC 路径",
	);

	// 磁盘上的 settings.json 损坏时拒绝覆盖（否则用户手写内容会被静默写没）。
	const corrupt = createFakeFs({ files: { [settingsPath]: "{ oops" } });
	const corruptExec = createFakeExec();
	assert.equal(await rejectionCode(() => createStore(corrupt.fs, { exec: corruptExec.exec }).saveSettings({ hostId: HOST, settings: { theme: "dark" } })), shared.WSL_CONFIG_CODES.fileInvalid);
	assert.deepEqual(corruptExec.calls, []);
});

test("写命令失败（非零退出/超时）→ WSL_CONFIG_PATH_UNREADABLE，且不留下成功回执", async () => {
	const execError = Object.assign(new Error("Command failed"), { code: 1 });
	const exec = createFakeExec({ error: execError });
	const store = createStore(createFakeFs().fs, { exec: exec.exec });
	assert.equal(await rejectionCode(() => store.saveModels({ hostId: HOST, data: { providers: {} } })), shared.WSL_CONFIG_CODES.pathUnreadable);
	assert.equal(await rejectionCode(() => store.saveSettings({ hostId: HOST, settings: {} })), shared.WSL_CONFIG_CODES.pathUnreadable);
});

test("保存路径也要先判定环境：档案/发行版/路径不可用时回稳定码且不写", async () => {
	const exec = createFakeExec();
	const { fs, calls } = createFakeFs({ dirs: [] });
	assert.equal(await rejectionCode(() => createStore(fs, { exec: exec.exec }).saveModels({ hostId: HOST, data: { providers: {} } })), shared.WSL_CONFIG_CODES.distroUnavailable);
	assert.deepEqual(
		calls.filter((call) => call[0] === "read" || call[0] === "write"),
		[],
		"环境不可用时不得读写文件",
	);
	assert.deepEqual(exec.calls, []);

	const gone = createFakeFs();
	assert.equal(await rejectionCode(() => createStore(gone.fs, { profiles: [] }).saveSettings({ hostId: HOST, settings: {} })), shared.WSL_CONFIG_CODES.hostNotFound);
	assert.deepEqual(gone.calls, []);
});

test("两个目标实例互不污染：解析出的目录只属于各自档案", async () => {
	const homeA = wslPaths.linuxPathToWslUnc("/home/dev", DISTRO);
	const homeB = wslPaths.linuxPathToWslUnc("/root", "Ubuntu-24.04");
	const callsA = [];
	const callsB = [];
	const fsA = {
		async statDirectory(path) {
			callsA.push(path);
			return { isDirectory: true };
		},
		async readTextFile() {
			return null;
		},
	};
	const fsB = {
		async statDirectory(path) {
			callsB.push(path);
			return { isDirectory: true };
		},
		async readTextFile() {
			return null;
		},
	};
	const storeA = createStore(fsA, { environment: { distro: DISTRO, user: "dev", linuxHome: "/home/dev", windowsHome: homeA } });
	const storeB = storeModule.createWslPiConfigStore({
		listProfiles: async () => [{ id: "22222222-2222-4222-8222-222222222222", label: "root", distro: "Ubuntu-24.04", user: "root" }],
		resolveEnvironment: async () => ({ distro: "Ubuntu-24.04", user: "root", linuxHome: "/root", windowsHome: homeB }),
		fs: fsB,
		platform: "win32",
		translate: (key) => key,
	});
	await storeA.read({ hostId: HOST, file: "models" });
	await storeB.read({ hostId: "22222222-2222-4222-8222-222222222222", file: "settings" });
	assert.ok(callsA.includes(homeA), "A 只碰自己的 HOME");
	assert.ok(!callsA.includes(homeB), "A 不得读 B 的 HOME");
	assert.ok(callsB.includes(homeB), "B 只碰自己的 HOME");
	// 没有共享单例目录：再读一次 A 仍落在 A。
	await storeA.read({ hostId: HOST, file: "settings" });
	assert.equal(callsA.filter((path) => path === homeB).length, 0);
});

test("exec 端口未装配时 fail closed：WSL_CONFIG_UNAVAILABLE，不回退 UNC 写", async () => {
	const { fs, calls } = createFakeFs();
	const store = storeModule.createWslPiConfigStore({
		listProfiles: async () => [PROFILE],
		resolveEnvironment: async () => ({ distro: DISTRO, user: USER, linuxHome: LINUX_HOME, windowsHome: WINDOWS_HOME }),
		fs,
		platform: "win32",
		translate: (key) => key,
	});
	assert.equal(await rejectionCode(() => store.saveModels({ hostId: HOST, data: { providers: {} } })), shared.WSL_CONFIG_CODES.unavailable);
	assert.deepEqual(
		calls.filter((call) => call[0] === "write"),
		[],
	);
});

/**
 * 解析缓存：设置页一次点击会并行拉 models + settings，各自跑一遍 wsl.exe HOME 探测 + UNC stat
 * 就是纯重复开销（50+ 模型的供应商点开卡一下的来源）。读复用，保存必须重解析。
 */
test("TTL 内重复读只解析一次，文件仍各读各的", async () => {
	let listCalls = 0;
	let envCalls = 0;
	const { fs, calls } = createFakeFs();
	const store = storeModule.createWslPiConfigStore({
		listProfiles: async () => {
			listCalls += 1;
			return [PROFILE];
		},
		resolveEnvironment: async () => {
			envCalls += 1;
			return { distro: DISTRO, user: USER, linuxHome: LINUX_HOME, windowsHome: WINDOWS_HOME };
		},
		fs,
		platform: "win32",
		translate: (key) => key,
	});
	// 并发：设置页同时请求两份配置。
	const [models, settings] = await Promise.all([store.read({ hostId: HOST, file: "models" }), store.read({ hostId: HOST, file: "settings" })]);
	assert.equal(models.kind, "wsl");
	assert.equal(settings.file, "settings");
	assert.equal(listCalls, 1, "并发读只能解析一次档案");
	assert.equal(envCalls, 1, "并发读只能探测一次 HOME");
	assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
		["stat", DISTRO_ROOT],
		["stat", WINDOWS_HOME],
		["read", CONFIG_DIR + "\\models.json"],
		["read", CONFIG_DIR + "\\settings.json"],
	]);
	// 顺序读同样命中缓存。
	await store.read({ hostId: HOST, file: "models" });
	assert.equal(envCalls, 1);
});

test("解析失败不进缓存：下一次读重新探测", async () => {
	let listCalls = 0;
	const { fs } = createFakeFs({ dirs: [] });
	const store = storeModule.createWslPiConfigStore({
		listProfiles: async () => {
			listCalls += 1;
			return [PROFILE];
		},
		resolveEnvironment: async () => ({ distro: DISTRO, user: USER, linuxHome: LINUX_HOME, windowsHome: WINDOWS_HOME }),
		fs,
		platform: "win32",
		translate: (key) => key,
	});
	assert.equal(await rejectionCode(() => store.read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.distroUnavailable);
	assert.equal(await rejectionCode(() => store.read({ hostId: HOST, file: "models" })), shared.WSL_CONFIG_CODES.distroUnavailable);
	assert.equal(listCalls, 2, "发行版不可用不能被缓存成 5s 内的假失败");
});

test("保存绕过缓存：档案改动后写不会落到过期目录", async () => {
	let listCalls = 0;
	const targets = [];
	const exec = async (input) => {
		targets.push(input.configDir);
	};
	const { fs } = createFakeFs();
	const store = storeModule.createWslPiConfigStore({
		listProfiles: async () => {
			listCalls += 1;
			return [PROFILE];
		},
		resolveEnvironment: async () => ({ distro: DISTRO, user: USER, linuxHome: LINUX_HOME, windowsHome: WINDOWS_HOME }),
		fs,
		execInDistro: exec,
		platform: "win32",
		translate: (key) => key,
	});
	await store.read({ hostId: HOST, file: "models" });
	const saved = await store.saveModels({ hostId: HOST, data: { providers: { openai: { models: [{ id: "gpt-4o" }] } } } });
	assert.equal(saved.valid, true);
	assert.equal(listCalls, 2, "保存必须重新解析，不能复用读路径的缓存");
	assert.deepEqual(targets, [LINUX_CONFIG_DIR]);
});
