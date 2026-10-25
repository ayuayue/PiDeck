import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 「一键安装 pi」编排的回归测试。
 *
 * 守的是产品要求：没有 pi 的用户点一次就要走完「Node → npm → 安装 pi → 重新检测」，
 * 装完自动检测（不用再点「重新检测」）。这里只测流程决策，不碰真实 npm/网络/pi：
 * - 系统已有 node 必须跳过便携下载（不能无谓拉 30 MB 并改写用户环境）；
 * - 平台不支持安装时必须停在 Node 步，后面的 npm/pi 一次都不能调；
 * - 主进程「本机已有 pi」拦截不是失败：要重新检测并交出已有安装列表；
 * - 安装成功但重新检测不到必须报出来，不能显示「安装完成」骗用户。
 */

const { runPiOneClickInstall } = loadTsCommonJs("src/renderer/src/utils/piOneClickInstall.ts");

const NODE_OK = { installed: false, systemNodeAvailable: true, systemNodeVersion: "v24.14.0", installSupported: true };
const NPM_OK = { available: true, version: "11.6.2" };
const INSTALL_OK = { success: true, exitCode: 0, stdout: "+ @earendil-works/pi-coding-agent", stderr: "" };

/**
 * 假依赖：默认全部成功，并把每次调用（含参数）按顺序记进 calls。
 * 记录层包在最外面，overrides 里只写行为，避免各用例重复 push。
 */
function makeDeps(overrides = {}) {
	const calls = [];
	const implementations = {
		runtimeNodeCheck: async () => NODE_OK,
		runtimeNodeInstall: async () => ({ ok: true, version: "v24.13.0" }),
		checkNpm: async () => NPM_OK,
		runtimePiInstall: async () => INSTALL_OK,
		recheck: async () => true,
		...overrides,
	};
	const deps = {};
	for (const name of Object.keys(implementations)) {
		deps[name] = async (...args) => {
			calls.push([name, ...args]);
			return implementations[name](...args);
		};
	}
	return { deps, calls };
}

/** 按顺序取某一步的调用，便于断言「没被调用」。 */
function called(calls, name) {
	return calls.filter(([calledName]) => calledName === name);
}

test("系统已有 node：跳过便携下载，依次 npm → 安装 pi → 重新检测", async () => {
	const { deps, calls } = makeDeps();
	const progress = [];
	const outcome = await runPiOneClickInstall(deps, { useMirror: false, onProgress: (item) => progress.push(item) });

	assert.equal(outcome.status, "installed");
	assert.deepEqual(
		calls.map(([name]) => name),
		["runtimeNodeCheck", "checkNpm", "runtimePiInstall", "recheck"],
	);
	// 每一步都有 running + done 两个事件，顺序与流程一致
	assert.deepEqual(
		progress.map((item) => `${item.step}:${item.status}`),
		["node:running", "node:done", "npm:running", "npm:done", "pi:running", "pi:done", "recheck:running", "recheck:done"],
	);
	assert.equal(progress.length, 8);
});

test("没有 node 且平台支持：先装便携 Node，再继续后面的步骤", async () => {
	const { deps, calls } = makeDeps({
		runtimeNodeCheck: async () => ({ installed: false, systemNodeAvailable: false, installSupported: true }),
	});
	const outcome = await runPiOneClickInstall(deps, { useMirror: true });

	assert.equal(outcome.status, "installed");
	assert.deepEqual(
		calls.map(([name]) => name),
		["runtimeNodeCheck", "runtimeNodeInstall", "checkNpm", "runtimePiInstall", "recheck"],
	);
	// 镜像意图必须原样透传给主进程（命令仍由主进程拼接）
	assert.deepEqual(called(calls, "runtimePiInstall")[0][1], true);
});

test("平台不支持一键安装且没有系统 node：停在 Node 步，不调用 npm/pi", async () => {
	const { deps, calls } = makeDeps({
		runtimeNodeCheck: async () => ({ installed: false, systemNodeAvailable: false, installSupported: false, error: "unsupported platform" }),
	});
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "failed");
	assert.equal(outcome.step, "node");
	assert.equal(outcome.reason, "node-unsupported");
	assert.equal(called(calls, "runtimeNodeInstall").length, 0);
	assert.equal(called(calls, "checkNpm").length, 0);
	assert.equal(called(calls, "runtimePiInstall").length, 0);
	assert.equal(called(calls, "recheck").length, 0);
});

test("便携 Node 安装失败：把错误原因带回，不继续装 pi", async () => {
	const { deps, calls } = makeDeps({
		runtimeNodeCheck: async () => ({ installed: false, systemNodeAvailable: false, installSupported: true }),
		runtimeNodeInstall: async () => ({ ok: false, error: "sha256 mismatch" }),
	});
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "failed");
	assert.equal(outcome.step, "node");
	assert.equal(outcome.reason, "node-prepare");
	assert.equal(outcome.detail, "sha256 mismatch");
	assert.equal(called(calls, "runtimePiInstall").length, 0);
});

test("npm 不可用：停在 npm 步，不装 pi", async () => {
	const { deps, calls } = makeDeps({ checkNpm: async () => ({ available: false, error: "npm: command not found" }) });
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "failed");
	assert.equal(outcome.step, "npm");
	assert.equal(outcome.reason, "npm-missing");
	assert.equal(outcome.detail, "npm: command not found");
	assert.equal(called(calls, "runtimePiInstall").length, 0);
});

test("pi 安装失败：带回 stderr 片段，且不触发重新检测", async () => {
	const { deps, calls } = makeDeps({
		runtimePiInstall: async () => ({ success: false, exitCode: 1, stdout: "", stderr: "npm ERR! code EACCES\nnpm ERR! permission denied" }),
	});
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "failed");
	assert.equal(outcome.step, "pi");
	assert.equal(outcome.reason, "pi-install");
	assert.match(outcome.detail, /EACCES/);
	assert.equal(called(calls, "recheck").length, 0);
});

test("主进程拦下安装（本机已有 pi）：重新检测并交回已有安装，不报失败", async () => {
	const existing = [{ path: "/home/u/.nvm/versions/node/v24/bin/pi", realPath: "/home/u/.nvm/versions/node/v24/bin/pi", source: "package-manager", isActive: false }];
	const { deps, calls } = makeDeps({ runtimePiInstall: async () => ({ success: false, exitCode: null, stdout: "", stderr: "", alreadyInstalled: existing }) });
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "already-installed");
	assert.equal(outcome.detected, true);
	assert.equal(outcome.installations.length, 1);
	assert.equal(outcome.installations[0].path, existing[0].path);
	assert.deepEqual(
		calls.map(([name]) => name),
		["runtimeNodeCheck", "checkNpm", "runtimePiInstall", "recheck"],
	);
});

test("主进程拦下安装但重新检测仍找不到：detected=false，交给界面提示手动指定路径", async () => {
	const { deps } = makeDeps({
		runtimePiInstall: async () => ({ success: false, exitCode: null, stdout: "", stderr: "", alreadyInstalled: [{ path: "/usr/local/bin/pi", realPath: "/usr/local/bin/pi", source: "path", isActive: false }] }),
		recheck: async () => false,
	});
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "already-installed");
	assert.equal(outcome.detected, false);
});

test("安装成功但重新检测不到：必须报「未检测到」，不能显示安装完成", async () => {
	const { deps } = makeDeps({ recheck: async () => false });
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "failed");
	assert.equal(outcome.step, "recheck");
	assert.equal(outcome.reason, "pi-undetected");
});

test("依赖抛异常：转成对应步骤的结构化失败，不向上冒泡", async () => {
	const { deps } = makeDeps({
		runtimeNodeCheck: async () => {
			throw new Error("ipc closed");
		},
	});
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "failed");
	assert.equal(outcome.step, "node");
	assert.equal(outcome.reason, "node-prepare");
	assert.equal(outcome.detail, "ipc closed");
});

test("重新检测抛异常按「未检测到」处理：安装本身成功不能被当成安装失败", async () => {
	const { deps } = makeDeps({
		recheck: async () => {
			throw new Error("boom");
		},
	});
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "failed");
	assert.equal(outcome.step, "recheck");
	assert.equal(outcome.reason, "pi-undetected");
});

test("系统有 node 但 npm 缺失：回退安装一次便携 Node 再重试 npm，不因此失败", async () => {
	// 系统 node 存在（NODE_OK），但 npm 探测先失败、装上便携 Node 后可用。
	let npmChecks = 0;
	const { deps, calls } = makeDeps({
		checkNpm: async () => {
			npmChecks += 1;
			return npmChecks === 1 ? { available: false, error: "npm missing" } : NPM_OK;
		},
	});
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "installed");
	assert.equal(npmChecks, 2);
	assert.deepEqual(
		calls.map(([name]) => name),
		["runtimeNodeCheck", "checkNpm", "runtimeNodeInstall", "checkNpm", "runtimePiInstall", "recheck"],
	);
});

test("npm 缺失且便携 Node 回退安装失败：停在 npm 步并带回安装错误", async () => {
	const { deps, calls } = makeDeps({
		checkNpm: async () => ({ available: false, error: "npm missing" }),
		runtimeNodeInstall: async () => ({ ok: false, error: "download blocked" }),
	});
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "failed");
	assert.equal(outcome.step, "npm");
	assert.equal(outcome.reason, "npm-missing");
	assert.equal(outcome.detail, "download blocked");
	assert.equal(called(calls, "runtimePiInstall").length, 0);
});

test("已有便携 Node 时 npm 缺失不再重复安装便携 Node", async () => {
	const { deps, calls } = makeDeps({
		runtimeNodeCheck: async () => ({ installed: true, path: "/data/node", version: "v24.13.0", systemNodeAvailable: true, installSupported: true }),
		checkNpm: async () => ({ available: false, error: "npm missing" }),
	});
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "failed");
	assert.equal(outcome.step, "npm");
	assert.equal(called(calls, "runtimeNodeInstall").length, 0);
});

test("本次刚装完便携 Node 仍然没有 npm：不重复下载，停在 npm 步", async () => {
	let nodeInstalls = 0;
	const { deps, calls } = makeDeps({
		runtimeNodeCheck: async () => ({ installed: false, systemNodeAvailable: false, installSupported: true }),
		runtimeNodeInstall: async () => {
			nodeInstalls += 1;
			return { ok: true, version: "v24.13.0" };
		},
		checkNpm: async () => ({ available: false, error: "npm missing" }),
	});
	const outcome = await runPiOneClickInstall(deps, { useMirror: false });

	assert.equal(outcome.status, "failed");
	assert.equal(outcome.step, "npm");
	assert.equal(outcome.reason, "npm-missing");
	assert.equal(nodeInstalls, 1);
	assert.equal(called(calls, "runtimePiInstall").length, 0);
});
