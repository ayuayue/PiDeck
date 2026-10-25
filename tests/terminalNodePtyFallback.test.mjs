import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * node-pty 原生模块缺失回归测试（2026-10 统信 UOS aarch64 反馈）。
 *
 * 背景：`import * as pty from "node-pty"` 是模块求值期同步 dlopen，原生模块不可用
 * （打包缺件、或目标发行版 glibc 低于 pty.node 要求——UOS aarch64 是 glibc < 2.34，
 * 而 pty.node 需要 openpty/forkpty@GLIBC_2.34）时主进程启动即崩，终端以外的功能
 * 全部不可用。约束：src/main 下 node-pty 只能经 ./nodePtyRuntime 在函数内
 * createRequire 惰性加载，失败时终端能力降级为「调用期报错 + 原因」，不得影响启动。
 */

const LOADER_FILE = "src/main/terminal/nodePtyRuntime.ts";
const MANAGER_FILE = "src/main/terminal/TerminalSessionManager.ts";

/** 收集 src/main 下所有 .ts 文件（含子目录）。 */
function collectMainTsFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			files.push(...collectMainTsFiles(full));
			continue;
		}
		if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(full.replace(/\\/g, "/"));
	}
	return files;
}

// ── 源码契约：唯一的加载边界 ────────────────────────────────────

test("src/main 下没有模块求值期的 node-pty 加载（值 import / require 调用）", () => {
	// 值 import 与 require() 都在模块求值时执行；`import("node-pty").IPty` 这类
	// 类型查询编译后擦除，是允许的（manager 用它标注 PTY 句柄类型）。
	const valueImport = /^\s*import\s+(?!type\s)[^;\n]*from\s*["']node-pty["']/m;
	const requireCall = /require\(\s*["']node-pty["']\s*\)/;
	const offenders = collectMainTsFiles("src/main").filter((file) => {
		if (file === LOADER_FILE) return false;
		const source = readFileSync(file, "utf8");
		return valueImport.test(source) || requireCall.test(source);
	});
	assert.deepEqual(offenders, [], "node-pty 只能经 ./nodePtyRuntime 惰性加载（原生模块禁止顶层静态 import）");
});

test("加载边界只经 createRequire，不在模块求值期加载 node-pty", () => {
	const source = readFileSync(LOADER_FILE, "utf8");
	assert.match(source, /createRequire\(__filename\)\("node-pty"\)/, "加载必须走 createRequire(__filename)（沙箱可 stub 的模块边界）");
	assert.doesNotMatch(source, /^\s*import\s[^;\n]*from\s*["']node-pty["']/m, "加载器不得 import node-pty：值 import 同样在模块求值期 dlopen");
});

// ── 加载器行为：包装 + 缓存失败 ────────────────────────────────

function loadLoader(createRequireImpl) {
	// globals.Error 用宿主 Error：沙箱内 `error instanceof Error` 与生产同 realm，
	// 否则替身抛出的宿主 Error 会被当成未知类型走 String(error)，detail 多一个前缀。
	return createTsSandbox({ stubs: { "node:module": { createRequire: createRequireImpl } }, globals: { Error } })(LOADER_FILE);
}

/** 捕获同步抛出（assert.throws 不返回错误对象，缓存断言需要拿到实例本身）。 */
function captureThrow(run) {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

test("原生模块加载失败：包装成带原因的错误，且失败结果被缓存", () => {
	const raw = "Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-arm64";
	const { loadNodePty, NodePtyUnavailableError } = loadLoader(() => () => {
		throw new Error(raw);
	});

	const first = captureThrow(() => loadNodePty());
	assert.ok(first instanceof NodePtyUnavailableError, "失败必须包装成 NodePtyUnavailableError");
	assert.equal(first.detail, raw, "detail 必须保留底层原因（用户/日志据此定位 glibc 或打包缺件）");
	assert.match(first.message, /node-pty native module failed to load/);

	// 原生模块在进程内不会「恢复」：第二次调用复用同一错误实例，不重跑 loader
	const second = captureThrow(() => loadNodePty());
	assert.equal(second, first, "失败结果必须缓存，避免每次开终端都重跑 loader");
});

test("原生模块可用时返回模块本身", () => {
	const fakeModule = { spawn: () => ({}) };
	const { loadNodePty } = loadLoader(() => () => fakeModule);
	assert.equal(loadNodePty(), fakeModule);
});

// ── 降级行为：模块可加载、其余能力不受影响 ───────────────────────

const makeFakePty = () => ({
	onData: () => {},
	onExit: () => {},
	write: () => {},
	resize: () => {},
	kill: () => {},
	process: "bash",
});

/** 加载 manager，loadNodePty 的成败由 ptyFailure 实时决定（模拟运行中不可用/恢复）。 */
function loadManagerWithPtyGate() {
	const state = { failure: null };
	const load = createTsSandbox({
		stubs: {
			"./nodePtyRuntime": {
				loadNodePty: () => {
					if (state.failure) throw state.failure;
					return { spawn: () => makeFakePty() };
				},
			},
		},
	});
	return { state, TerminalSessionManager: load(MANAGER_FILE).TerminalSessionManager };
}

function newManager(TerminalSessionManager) {
	return new TerminalSessionManager(
		() => "/proj/agent",
		() => {},
		() => ({}),
	);
}

const projectTarget = { kind: "project", cwd: "/proj" };

/** vm 沙箱产出的数组/对象带另一套原型，deepStrictEqual 会因原型不同失败（同 terminalShell 的 plain）。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("node-pty 不可用时模块仍可加载：终端操作在调用期报错，其余功能照常", () => {
	// 模块求值成功（启动不再崩）——这是本 issue 的核心断言
	const TerminalSessionManager = loadTsCommonJs(MANAGER_FILE, {
		stubs: {
			"./nodePtyRuntime": {
				loadNodePty: () => {
					throw new Error("node-pty native module failed to load: version 'GLIBC_2.34' not found");
				},
			},
		},
	}).TerminalSessionManager;

	// 不触达原生层的纯函数与只读查询仍可用
	assert.ok(TerminalSessionManager.prototype.listShells, "shell 候选探测不需要 node-pty");
	assert.doesNotThrow(() =>
		new TerminalSessionManager(
			() => "/proj",
			() => {},
			() => ({}),
		).closeAll(),
	);

	const manager = newManager(TerminalSessionManager);
	assert.throws(() => manager.create(projectTarget), /GLIBC_2\.34' not found/);
	assert.deepEqual(plain(manager.list(projectTarget)), [], "失败不得留下半成品 tab");
});

test("spawn 失败不消耗标题序号：node-pty 恢复后仍从 1 开始编号", () => {
	const { state, TerminalSessionManager } = loadManagerWithPtyGate();
	const manager = newManager(TerminalSessionManager);

	state.failure = new Error("node-pty native module failed to load: dlopen failed");
	assert.throws(() => manager.create(projectTarget), /dlopen failed/);
	assert.throws(() => manager.ensure(projectTarget), /dlopen failed/);

	// 失败路径不能留下空桶，也不能把序号推到 2
	state.failure = null;
	const tab = manager.create(projectTarget);
	assert.match(tab.title, / 1$/, `失败的 create 不得消耗序号（实际 ${tab.title}）`);
	assert.deepEqual(plain(manager.list(projectTarget).map((item) => item.title)), [tab.title]);
});

test("node-pty 加载失败时错误不被候选 shell 的 lastError 掩盖", () => {
	const { state, TerminalSessionManager } = loadManagerWithPtyGate();
	const manager = newManager(TerminalSessionManager);
	state.failure = new Error("node-pty native module failed to load: Cannot find module './prebuilds/linux-arm64//pty.node'");

	// 旧实现在候选循环内 spawn，逐候选 catch 会把真实原因覆盖成「No supported shell found」
	const error = captureThrow(() => manager.create(projectTarget));
	assert.match(error.message, /node-pty native module failed to load/);
	assert.doesNotMatch(error.message, /No supported shell found/);
});
