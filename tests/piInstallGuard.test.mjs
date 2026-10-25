import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 引导安装的前置守卫：本机已有 pi 就不再装第二份（用户明确要求）。
 *
 * 为什么单独测：这是「避免重复安装」的最后一道硬约束——UI 不展示引导只是第一道，
 * 检测总有覆盖不到的地方（自定义目录、别名、GUI 看不见的 shell PATH），
 * 一旦这里放行，用户点一下就会真的多出一份 pi，之后终端与 PiDeck 各用各的。
 */

const load = createTsSandbox();
const { resolvePiInstallGuard } = load("src/main/pi/piInstallGuard.ts");

function installation(overrides = {}) {
	return { path: "/opt/pi/pi", realPath: "/opt/pi/pi", source: "path", isActive: true, ...overrides };
}

test("一份 pi 都没有时放行安装", () => {
	const guard = resolvePiInstallGuard([]);
	assert.equal(guard.skip, false);
	assert.deepEqual(JSON.parse(JSON.stringify(guard.installations)), []);
});

test("已经装了 pi 就跳过安装，并把现场带回去（哪怕只是 shell 里反查到的）", () => {
	const shellOnly = installation({ path: "/custom/shell/pi", source: "custom", shellDefault: true });
	const guard = resolvePiInstallGuard([shellOnly]);
	assert.equal(guard.skip, true);
	assert.equal(guard.installations.length, 1);
	assert.equal(guard.installations[0].path, "/custom/shell/pi");
});

test("跳过时回传的是副本，调用方改它不会污染探测结果", () => {
	const source = [installation({ version: "1.2.3" })];
	const guard = resolvePiInstallGuard(source);
	assert.equal(guard.skip, true);
	guard.installations.push(installation({ path: "/another/pi" }));
	assert.equal(source.length, 1);
});
