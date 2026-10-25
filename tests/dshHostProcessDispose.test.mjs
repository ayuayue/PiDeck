/**
 * DshHostProcess 生命周期终态门控：dispose 后必须拒绝一切 fork。
 *
 * 竞态回归（本轮红测复现）：
 * 1. host 崩溃 exit → exit handler 里 `void restartAfterCrash(n)` 排队（退避 0.5~2s）；
 * 2. 退避窗口内应用调用 dispose() → kill() 发现 child===null 直接 return；
 * 3. 退避结束 → restartAfterCrash 复位 stopping → start(false) 重新 fork；
 * 4. 此时 DshHost.dispose 早已返回（apiClient/hostProcess 引用已置 null）——
 *    新 fork 的 host 成为无人认领的孤儿进程（同 DSH_HOME 下被锁挡住则形成
 *    最多 3 次的重启风暴空转 + 日志噪音）。
 *
 * 契约：dispose() 是不可逆终态；之后任何 start（含自动重启内部的 start(false)）
 * 必须拒绝且错误可辨识（既不是手动停止拒绝，也不是 boot 失败——不能混入
 * 「重启失败」warn 假故障信号）。跨 realm 文案精确匹配（同 dshManualStop 测试先例）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DshHostProcess } = loadTsCommonJs("src/main/dsh/DshHostProcess.ts");
const { DSH_MANUALLY_STOPPED_ERROR } = loadTsCommonJs("src/main/dsh/dshManualStop.ts");

const DSH_HOST_DISPOSED_ERROR = "DSH host process was disposed";

const NOOP = () => {};

test("DshHostProcess.start: dispose 后拒绝 fork（终态门控，错误可辨识）", async () => {
	const proc = new DshHostProcess("entry.js", [], {}, NOOP);
	await proc.dispose();
	await assert.rejects(
		() => proc.start(),
		(error) => error?.message === DSH_HOST_DISPOSED_ERROR,
		"dispose 后 start 必须以可辨识文案拒绝，而不是继续 fork",
	);
});

test("DshHostProcess.start: dispose 拒绝不是手动停止、不是 boot 失败（不得混淆三类失败）", async () => {
	const proc = new DshHostProcess("entry.js", [], {}, NOOP);
	await proc.dispose();
	let message = null;
	try {
		await proc.start();
	} catch (error) {
		message = error?.message ?? String(error);
	}
	assert.notEqual(message, DSH_MANUALLY_STOPPED_ERROR);
	// 不是笼统 boot 失败前缀（渲染层按它归因为「起不来」会误导用户去点重启）。
	assert.ok(!String(message).startsWith("DSH host process exited before ready"));
});

test("DshHostProcess.restartAfterCrash: dispose 后静默放弃且不算失败信号（无 warn 假故障）", async () => {
	const logs = [];
	const proc = new DshHostProcess("entry.js", [], {}, (scope, msg) => logs.push(`${scope}: ${msg}`));
	await proc.dispose();
	// attempt=1 无退避等待；内部 start(false) 被 disposed 门控拒绝 → 必须返回 false。
	assert.equal(await proc.restartAfterCrash(1), false);
	// 静默语义与手动停止一致：只有一条 info，不产生「restart failed」warn 假故障。
	assert.ok(!logs.some((line) => line.includes("restart failed")));
	const skipped = logs.filter((line) => line.includes("disposed"));
	assert.equal(skipped.length, 1);
});
