import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 系统默认打开路径的统一入口（src/main/fs/openPath.ts）行为测试。
 *
 * 回归（issue #396）：Electron 自 37.5 起 Linux 的 shell.openPath 走
 * wait_for_exit=false，XDGUtil 只在该标志为 true 时执行回调 —— Promise 永不
 * settle。所有 await shell.openPath(...) 的 IPC handler 因此不回包，
 * Electron 补发 "reply was never sent"，而目录其实已经打开。
 * openSystemPath 必须给调用方一个确定结果，永不挂住。
 */

/** 加载生产模块，注入 electron 替身；warn 缺省时不注册 logger（静默路径也要可跑）。 */
function loadOpenSystemPath({ openPath, warn }) {
	const logged = [];
	return {
		logged,
		...loadTsCommonJs("src/main/fs/openPath.ts", {
			stubs: {
				electron: { shell: { openPath } },
				"../logging/sharedLogger": {
					getAppLogger: () => (warn ? { warn: (...args) => (logged.push(args), warn(...args)) } : null),
				},
			},
		}),
	};
}

test("openSystemPath 返回空串表示已交给系统（成功路径）", async () => {
	const { openSystemPath } = loadOpenSystemPath({ openPath: async () => "" });
	assert.equal(await openSystemPath("/tmp/dir"), "");
});

test("openSystemPath 把系统错误字符串原样回传（调用方据此抛错提示用户）", async () => {
	const { openSystemPath } = loadOpenSystemPath({ openPath: async () => "No application found" });
	assert.equal(await openSystemPath("/tmp/nope.xyz"), "No application found");
});

test("openSystemPath 在 shell.openPath 永不 settle 时按成功返回（issue #396 Linux 实况）", async () => {
	// 永不 settle 的 Promise = Electron Linux 上被丢弃的回调；handler 不能跟着挂住。
	const { openSystemPath, logged } = loadOpenSystemPath({
		openPath: () => new Promise(() => {}),
		warn: () => {},
	});
	const result = await openSystemPath("/home/u/project", { timeoutMs: 5 });
	assert.equal(result, "", "超时必须按「已交给系统」结算，不能报错——目录其实已经打开了");
	assert.equal(logged.length, 1, "超时要留一条 warn，便于定位上游缺陷");
	assert.match(logged[0][1], /超时/);
});

test("openSystemPath 把 rejection 转成错误字符串，不向上抛异常", async () => {
	const { openSystemPath } = loadOpenSystemPath({
		openPath: async () => {
			throw new Error("open failed");
		},
	});
	assert.equal(await openSystemPath("/tmp/x"), "open failed");
});

test("openSystemPath 超时后 openPath 才 reject 不产生 unhandled rejection", async () => {
	const { openSystemPath } = loadOpenSystemPath({
		openPath: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 30)),
	});
	assert.equal(await openSystemPath("/tmp/x", { timeoutMs: 5 }), "");
	// 等过迟到的 rejection：若未吞掉，node --test 会因 unhandledRejection 判红。
	await new Promise((resolve) => setTimeout(resolve, 60));
});

/** 收集 src/main 下所有 .ts 文件（守卫测试用）。 */
function collectMainTs(dir, acc = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectMainTs(full, acc);
		} else if (entry.name.endsWith(".ts")) {
			acc.push(full);
		}
	}
	return acc;
}

test("主进程不得再直接调用 shell.openPath（统一入口守卫）", async () => {
	// 唯一允许的真实调用点是 src/main/fs/openPath.ts 自身；注释里的说明文字放行。
	const offenders = [];
	for (const file of collectMainTs("src/main")) {
		if (file.split("\\").join("/").endsWith("src/main/fs/openPath.ts")) continue;
		readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, index) => {
				// 只拦真实调用：去掉行注释后再匹配调用形态。
				const code = line.replace(/\/\/.*$/, "");
				if (/shell\.openPath\s*\(/.test(code)) offenders.push(`${file}:${index + 1}`);
			});
	}
	assert.deepEqual(offenders, [], "主进程所有打开路径必须走 fs/openPath.ts 的 openSystemPath");
});
