import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const { QuickTaskController, compactTaskBounds, validateQuickTaskPath } = loadTsCommonJs("src/main/quickTask/QuickTaskController.ts");
const { extractFocusTargetFromArgv } = loadTsCommonJs("src/main/utils/focusTarget.ts");
const { quickTaskIntent } = loadTsCommonJs("src/renderer/src/utils/quickTaskIntent.ts");

test("launch arguments preserve spaces, Chinese, special characters and UNC without executing them", () => {
	for (const path of ["C:\\中文 project & task", "\\\\server\\共享\\my project", "C:\\folder\\"]) {
		assert.equal(extractFocusTargetFromArgv(["PiDeck.exe", "--quick-task", path]).quickTaskPath, path);
		assert.equal(extractFocusTargetFromArgv([`--quick-task=${path}`]).quickTaskPath, path);
	}
	assert.equal(extractFocusTargetFromArgv(["--quick-task-desktop"]).quickTaskDesktop, true);
	assert.equal(extractFocusTargetFromArgv(["--quick-task"]), undefined);
	assert.equal(extractFocusTargetFromArgv(["--quick-task", "--bad"]), undefined);
	assert.equal(extractFocusTargetFromArgv(["--open-project", "C:\\old"]).projectPath, "C:\\old");
});

test("path validation rejects relative, non-directory and missing paths, accepting accessible directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-quick-task-unit-"));
	try {
		const path = join(root, "中文 space & task");
		await mkdir(path);
		assert.equal(await validateQuickTaskPath(path), path);
		// 失败一律带稳定错误码（渲染层据此映射 i18n），不再抛 QUICK_TASK_* 这类内部串。
		await assert.rejects(validateQuickTaskPath("relative"), (error) => error.code === "invalidPath");
		await assert.rejects(validateQuickTaskPath(path + "\u0000"), (error) => error.code === "invalidPath");
		await assert.rejects(validateQuickTaskPath(join(root, "missing")), (error) => error.code === "notFound");
		const file = join(root, "plain.txt");
		await writeFile(file, "x");
		await assert.rejects(validateQuickTaskPath(file), (error) => error.code === "notDirectory");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function windowStub() {
	const events = new EventEmitter();
	const original = { x: 200, y: 100, width: 1280, height: 900 };
	let bounds = { ...original };
	let minimum = [880, 600];
	let maximized = true;
	let fullscreen = false;
	return {
		once: events.once.bind(events),
		removeListener: events.removeListener.bind(events),
		emit: events.emit.bind(events),
		listenerCount: events.listenerCount.bind(events),
		original,
		isDestroyed: () => false,
		getNormalBounds: () => ({ ...bounds }),
		getMinimumSize: () => [...minimum],
		isMaximized: () => maximized,
		isFullScreen: () => fullscreen,
		setFullScreen: (v) => {
			fullscreen = v;
		},
		unmaximize: () => {
			maximized = false;
		},
		maximize: () => {
			maximized = true;
		},
		setMinimumSize: (w, h) => {
			minimum = [w, h];
		},
		setBounds: (v) => {
			bounds = { ...v };
		},
		isMinimized: () => false,
		show() {},
		focus() {},
		restore() {},
	};
}

test("compact geometry restores original maximized workbench after repeated launches", async () => {
	const win = windowStub();
	const events = [];
	const controller = new QuickTaskController({ getWindow: () => win, workArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), publish: (s) => events.push(s), validatePath: async (p) => p });
	await controller.open("C:\\first");
	assert.equal(win.getNormalBounds().width, 720);
	await controller.open("C:\\second");
	assert.equal(controller.getWorkbenchBounds().width, 1280);
	controller.exit();
	assert.deepEqual(win.getNormalBounds(), win.original);
	assert.deepEqual(win.getMinimumSize(), [880, 600]);
	assert.equal(win.isMaximized(), true);
	assert.equal(events.at(-1).active, false);
});

test("validation is not bypassed by renderer state replay and stale validation cannot replace latest intent", async () => {
	const resolvers = [];
	const events = [];
	const controller = new QuickTaskController({ getWindow: () => null, workArea: () => ({}), publish: (s) => events.push(s), validatePath: (p) => new Promise((resolve) => resolvers.push(() => resolve(p))) });
	const first = controller.open("C:\\first");
	assert.equal(controller.getState().path, undefined);
	const second = controller.open("C:\\second");
	resolvers[1]();
	await second;
	resolvers[0]();
	await first;
	assert.equal(controller.getState().path, "C:\\second");
	assert.equal(events.length, 1);
	const third = controller.open("C:\\third");
	controller.exit();
	resolvers[2]();
	await third;
	assert.equal(controller.getState().active, false);
});

test("fullscreen geometry waits for transition and close cancels late geometry changes", async () => {
	const win = windowStub();
	win.setFullScreen(true);
	const controller = new QuickTaskController({ getWindow: () => win, workArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), publish() {}, validatePath: async (p) => p });
	await controller.open("C:\\first");
	assert.equal(win.getNormalBounds().width, 1280);
	win.emit("leave-full-screen");
	assert.equal(win.getNormalBounds().width, 720);
	controller.exit();
	assert.equal(win.isFullScreen(), true);
	await controller.open("C:\\second");
	assert.equal(win.listenerCount("leave-full-screen"), 1);
	controller.exit();
	assert.equal(win.listenerCount("leave-full-screen"), 0);
	win.emit("leave-full-screen");
	assert.equal(win.getNormalBounds().width, 1280);
});

test("inaccessible directories are reported without any session/runtime capability", async () => {
	const controller = new QuickTaskController({
		getWindow: () => null,
		workArea: () => ({}),
		publish() {},
		validatePath: async () => {
			throw new Error("EACCES");
		},
	});
	await controller.open("C:\\denied");
	// 主进程只回稳定错误码（渲染层映射 i18n 文案）；裸 errno 文本不得跨 IPC 进 UI。
	assert.equal(controller.getState().error, "permissionDenied");
});

test("path validation failures carry stable codes instead of raw messages", async () => {
	for (const [value, expected] of [
		["relative", "invalidPath"],
		["C:\\bad\u0000name", "invalidPath"],
	]) {
		await assert.rejects(validateQuickTaskPath(value), (error) => error.code === expected);
	}
	const root = await mkdtemp(join(tmpdir(), "pideck-quick-task-code-"));
	try {
		await assert.rejects(validateQuickTaskPath(join(root, "missing")), (error) => error.code === "notFound");
		const file = join(root, "a.txt");
		await writeFile(file, "x");
		await assert.rejects(validateQuickTaskPath(file), (error) => error.code === "notDirectory");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("small displays clamp size and position inside work area", () => {
	const bounds = compactTaskBounds({ x: 1800, y: -600, width: 1280, height: 900 }, { x: -400, y: 0, width: 400, height: 300 });
	assert.equal(bounds.width, 400);
	assert.equal(bounds.height, 300);
	assert.equal(bounds.x, -400);
	assert.equal(bounds.y, 0);
});

test("repeated invocations preserve an existing task and require explicit consent for another directory", () => {
	assert.equal(quickTaskIntent("", "C:\\project"), "prepare");
	assert.equal(quickTaskIntent("C:\\project", "c:/PROJECT/"), "resume");
	assert.equal(quickTaskIntent("C:\\project", "C:\\other"), "offer-new");
});

test("registry registration covers three HKCU contexts with quoted commands and no cmd shell", async () => {
	const calls = [];
	const { registerQuickTaskShellMenu, quickTaskMenuEntries, unregisterQuickTaskShellMenu } = loadTsCommonJs("src/main/integrations/quickTaskShellMenu.ts", {
		stubs: {
			"node:child_process": {
				execFile: (...args) => {
					const cb = args.pop();
					calls.push(args);
					cb(null, "", "");
				},
			},
		},
	});
	const entries = quickTaskMenuEntries("C:\\Program Files\\PiDeck.exe", "", "Quick task");
	assert.equal(entries.length, 3);
	assert.equal(entries[0].command, '"C:\\Program Files\\PiDeck.exe" --quick-task "%1\\."');
	assert.equal(entries[1].command.endsWith('"%V\\."'), true);
	assert.equal(entries[2].command.endsWith("--quick-task-desktop"), true);
	assert.match(quickTaskMenuEntries("electron.exe", "C:\\dev space", "Task")[0].command, /"C:\\dev space" --quick-task/);
	await registerQuickTaskShellMenu("C:\\PiDeck.exe", "", "Task");
	assert.equal(calls.length, 9);
	assert.ok(calls.every(([exe, args, options]) => exe === "reg" && args[1].startsWith("HKCU\\Software\\Classes\\") && options.windowsHide));
	await unregisterQuickTaskShellMenu();
	assert.equal(calls.filter(([, args]) => args[0] === "delete").length, 3);
});

test("Windows parses Explorer command arguments including drive roots without a shell", { skip: process.platform !== "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-argv-"));
	try {
		const script = join(root, "argv.cjs");
		await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
		const { quickTaskMenuEntries } = loadTsCommonJs("src/main/integrations/quickTaskShellMenu.ts");
		for (const path of ["C:\\", "C:\\中文 project & task", "\\\\server\\共享\\", "C:\\folder\\"]) {
			const command = quickTaskMenuEntries(process.execPath, script, "Task")[0].command.replace("%1", path);
			// Pass Explorer's expanded raw command line through Windows argv parsing, not libuv quoting.
			const suffix = command.slice(`"${process.execPath}" `.length);
			const result = spawnSync(process.execPath, [suffix], { argv0: `"${process.execPath}"`, windowsVerbatimArguments: true, windowsHide: true, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			const argv = JSON.parse(result.stdout);
			assert.equal(argv.length, 2);
			assert.equal(win32.resolve(extractFocusTargetFromArgv(argv).quickTaskPath), win32.resolve(path));
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("quick task settings IPC rejects non-boolean inputs and reports actual registration", async () => {
	const handlers = new Map();
	let registered = false;
	const load = createTsSandbox({
		globals: { process: { platform: "win32", execPath: "C:\\PiDeck.exe" } },
		stubs: {
			electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, app: { isPackaged: true } },
			"../integrations/quickTaskShellMenu": {
				quickTaskShellMenuRegistered: async () => registered,
				registerQuickTaskShellMenu: async () => {
					registered = true;
				},
				unregisterQuickTaskShellMenu: async () => {
					registered = false;
				},
			},
			"../integrations/shellContextMenu": {},
		},
	});
	load("src/main/ipc/shellMenuIpc.ts").registerShellMenuIpc({ appLogger: { warn() {} }, menuTitle: "Open", quickTaskTitle: "Task" });
	const set = handlers.get("shell-menu:quick-task-set-enabled");
	await assert.rejects(set({}, "true"), /INVALID_ENABLED/);
	assert.equal((await set({}, true)).registered, true);
	assert.equal((await set({}, false)).registered, false);
});
