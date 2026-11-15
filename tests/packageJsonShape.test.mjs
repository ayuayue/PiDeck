import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 事故形状（2026-11-16，本 PR 内发生）：改 `scripts` 里一行时删多了两行，
 * 整个 `dependencies` 段被并进 `scripts`。JSON 依然合法，`JSON.parse` 成功，
 * 本地七个技能判据全绿——因为谁都没看 package.json 的键名单。
 * 后果是 `npm ci` 一个运行时依赖都不装，CI 三连红，日志报的是
 * `Cannot find package 'electron-updater'`：那不是 electron-updater 的问题，
 * 它是第一个撞上的受害者。
 *
 * 判据要抓的是「结构合法但语义被吞」，所以不验 JSON 能不能解析，验键名字与值形状。
 * 坏样本：
 *   一、删掉 `"dependencies": { ... }` 整段 → 第一条红（依赖数 0 或段不存在）。
 *   二、把 `"@agentclientprotocol/sdk": "1.4.0"` 塞进 scripts → 第二、三条红。
 *   两条都试过，各自点名，不是一起红。
 */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("dependencies 段存在且装的是依赖", () => {
	assert.equal(typeof pkg.dependencies, "object", "dependencies 段不见了：多半是改 scripts 时删多了");
	const keys = Object.keys(pkg.dependencies || {});
	assert.ok(keys.length >= 10, "运行时依赖只剩 " + keys.length + " 个，像是被删掉或并进了别处");
});

test("scripts 的键里没有包名", () => {
	const pkgish = Object.keys(pkg.scripts || {}).filter((k) => k.startsWith("@") || k.includes("/"));
	assert.deepEqual(pkgish, [], "scripts 里出现了包名：" + pkgish.join("、") + "——依赖段被吞进 scripts 的典型形状");
});

test("scripts 的值都是命令，不是版本号", () => {
	const versionish = Object.entries(pkg.scripts || {}).filter(([, v]) => typeof v !== "string" || /^[~^]?\d+\.\d+\.\d+/.test(v));
	assert.deepEqual(
		versionish.map(([k]) => k),
		[],
		"scripts 的值像版本号，说明依赖段被并进来了",
	);
});

test("devDependencies 段存在", () => {
	assert.ok(pkg.devDependencies && Object.keys(pkg.devDependencies).length >= 10, "devDependencies 段不见了");
});
