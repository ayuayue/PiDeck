import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * Tab 徽章状态映射纯函数（sessionStatusBadge）。
 * 核心不变量：重启/停止/重载进行中优先级最高，统一切 loading；
 * 无操作时按 status 映射，detached/closed/未启动返回 undefined。
 */

function loadSessionStatusBadge() {
	const source = readFileSync("src/renderer/src/utils/sessionStatusBadge.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "sessionStatusBadge.ts",
	}).outputText;
	// import type { AnimatedBadgeStatus } 会被 transpile 擦除，无需真实依赖。
	const sandbox = { exports: {}, require: () => ({}) };
	vm.runInNewContext(output, sandbox, { filename: "sessionStatusBadge.ts" });
	return sandbox.exports;
}

const json = (value) => JSON.stringify(value);

// —— 操作进行中优先级（busy 优先于 status，且不依赖 runtime 存在）——

test("sessionStatusBadge: 停止中覆盖 running，统一 loading 且不带运行黄", () => {
	const { sessionStatusBadge } = loadSessionStatusBadge();
	const badge = sessionStatusBadge("running", { isStopping: true });
	assert.equal(json(badge), json({ status: "loading" }));
});

test("sessionStatusBadge: 重载中在无 runtime（未启动）时也显示 loading 徽章", () => {
	const { sessionStatusBadge } = loadSessionStatusBadge();
	const badge = sessionStatusBadge(undefined, { isReloading: true });
	assert.equal(json(badge), json({ status: "loading" }));
});

test("sessionStatusBadge: 重启中覆盖 idle，显示 loading", () => {
	const { sessionStatusBadge } = loadSessionStatusBadge();
	const badge = sessionStatusBadge("idle", { isRestarting: true });
	assert.equal(json(badge), json({ status: "loading" }));
});

test("sessionStatusBadge: busy 全 false 时回落 status 映射", () => {
	const { sessionStatusBadge } = loadSessionStatusBadge();
	const badge = sessionStatusBadge("running", { isRestarting: false, isStopping: false, isReloading: false });
	assert.equal(json(badge), json({ status: "loading", colorClass: "text-amber-500 dark:text-amber-400" }));
});

// —— 无操作时按 status 映射 ——

test("sessionStatusBadge: error→danger / idle→neutral / starting→loading", () => {
	const { sessionStatusBadge } = loadSessionStatusBadge();
	assert.equal(json(sessionStatusBadge("error")), json({ status: "danger" }));
	assert.equal(json(sessionStatusBadge("idle")), json({ status: "neutral" }));
	assert.equal(json(sessionStatusBadge("starting")), json({ status: "loading" }));
});

test("sessionStatusBadge: running/pending/waiting → loading + 黄色覆盖", () => {
	const { sessionStatusBadge } = loadSessionStatusBadge();
	const amber = { status: "loading", colorClass: "text-amber-500 dark:text-amber-400" };
	assert.equal(json(sessionStatusBadge("running")), json(amber));
	assert.equal(json(sessionStatusBadge("pending")), json(amber));
	assert.equal(json(sessionStatusBadge("waiting")), json(amber));
});

test("sessionStatusBadge: 未启动/detached/未知状态返回 undefined（不渲染徽章）", () => {
	const { sessionStatusBadge } = loadSessionStatusBadge();
	assert.equal(sessionStatusBadge(), undefined);
	assert.equal(sessionStatusBadge(null), undefined);
	assert.equal(sessionStatusBadge("detached"), undefined);
	assert.equal(sessionStatusBadge("closed"), undefined);
	assert.equal(sessionStatusBadge("some-unknown-status"), undefined);
});
