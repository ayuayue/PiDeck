import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 「实时探测结果 > 持久化缓存」的版本校正规则。
 *
 * 背景（真实缺陷）：应用运行期间用户用命令行把 pi 升到 1.2.0，顶部「Pi CLI 已找到」还停在缓存里的
 * 1.1.0，而同屏的安装列表（真跑 `pi --version`）已经是 v1.2.0，点「检查 Pi 更新」又提示「Pi 已是最新版本」。
 * 规则一旦写错，要么顶部继续显示旧版本，要么把可用缓存清成「未安装」，所以这里逐条钉住。
 */

const load = createTsSandbox();
const { resolvePiStatusFromProbe } = load("src/renderer/src/utils/piStatusSync.ts");

/** vm 沙箱里造出的对象原型与宿主不同，deepStrictEqual 会因原型不一致失败——统一转成宿主对象再比。 */
function plain(value) {
	return value === null ? null : JSON.parse(JSON.stringify(value));
}

/** 工厂：只关心被测字段，其余给默认值。 */
function status(overrides = {}) {
	return { installed: true, command: "/home/u/.nvm/versions/node/v24/bin/pi", version: "1.1.0", searchedDirs: ["/home/u/.nvm/versions/node/v24/bin"], ...overrides };
}

test("版本与命令都没变时不回写（避免每次探测都写一次 settings）", () => {
	assert.equal(resolvePiStatusFromProbe(status(), { command: "/home/u/.nvm/versions/node/v24/bin/pi", version: "1.1.0" }), null);
});

test("外部升级后以探测结果为准，并保留 searchedDirs", () => {
	const next = resolvePiStatusFromProbe(status(), { command: "/home/u/.nvm/versions/node/v24/bin/pi", version: "1.2.0" });
	assert.deepEqual(plain(next), { installed: true, command: "/home/u/.nvm/versions/node/v24/bin/pi", version: "1.2.0", searchedDirs: ["/home/u/.nvm/versions/node/v24/bin"] });
});

test("命令换了（切到另一份安装）也要回写", () => {
	const next = resolvePiStatusFromProbe(status(), { command: "/home/u/.pi/agent/bin/pi", version: "1.1.0" });
	assert.equal(next.command, "/home/u/.pi/agent/bin/pi");
});

test("探测没给出命令时沿用当前路径（安装列表只保证版本）", () => {
	const next = resolvePiStatusFromProbe(status(), { version: "1.2.0" });
	assert.equal(next.command, "/home/u/.nvm/versions/node/v24/bin/pi");
});

test("没有版本或没有路径一律不回写：不能凭空把缓存清成「未安装」", () => {
	// persistPiInstall 在缺 command/version 时会写 piInstall: undefined，残缺探测不得触发它
	assert.equal(resolvePiStatusFromProbe(status(), {}), null);
	assert.equal(resolvePiStatusFromProbe(status(), { command: "/home/u/.nvm/versions/node/v24/bin/pi" }), null);
	assert.equal(resolvePiStatusFromProbe(status({ command: undefined }), { version: "1.2.0" }), null);
	assert.equal(resolvePiStatusFromProbe(null, { command: "/home/u/pi", version: "" }), null);
});

test("探测成功会把「未安装/带错误」的旧状态纠正成已安装且无错误", () => {
	// 上一轮检测失败留下的错误态不该跟着新版本进缓存
	const next = resolvePiStatusFromProbe(status({ installed: false, version: undefined, error: "ENOENT" }), { command: "/home/u/pi", version: "1.2.0" });
	assert.deepEqual(plain(next), { installed: true, command: "/home/u/pi", version: "1.2.0", searchedDirs: ["/home/u/.nvm/versions/node/v24/bin"] });
	assert.equal("error" in next, false);
});

test("无当前状态（首次探测）时也能建立状态", () => {
	assert.deepEqual(plain(resolvePiStatusFromProbe(null, { command: "/home/u/pi", version: "1.2.0" })), { installed: true, command: "/home/u/pi", version: "1.2.0", searchedDirs: [] });
});
