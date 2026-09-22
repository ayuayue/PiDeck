/**
 * DSH host 手动停止门控（用户不想让它运行：停止后只有显式「启动」才能再运行）。
 *
 * 覆盖三层契约：
 * - dshManualStop.ts：拒绝错误的构造/判定（单一数据源，错误必须可辨识，不混同 boot 失败）；
 * - DshHost.ensureStarted / startManually：策略层门控——手动停止时自动路径拒绝 fork，
 *   显式启动幂等且不再受门控影响；
 * - DshHostProcess.start / restartAfterCrash：进程层门控——fork 被拒不算崩溃重启失败。
 *
 * 门控判定按注入函数读取（isManualStopped），用可变闭包变量模拟设置项翻转。
 * 两个构造函数都是位置参数：中间依赖给最小桩（不会被门控分支触达）。
 * 注意：loadTsCommonJs 每次调用是独立 vm realm，DshHost/DshHostProcess 内部用的是
 * 它们自己 realm 里的 dshManualStop 副本，跨 realm instanceof 会失效，因此除同
 * realm 单测外，行为断言一律用稳定错误文案精确匹配（这正是「可辨识」契约的本质）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DshHost } = loadTsCommonJs("src/main/dsh/DshHost.ts");
const { DshHostProcess } = loadTsCommonJs("src/main/dsh/DshHostProcess.ts");
const { DSH_MANUALLY_STOPPED_ERROR, dshManuallyStoppedError, dshUnavailablePageFor, isDshManuallyStoppedError } = loadTsCommonJs("src/main/dsh/dshManualStop.ts");

/** 跨 realm 安全断言：错误是「手动停止拒绝」（稳定文案精确匹配；不用 instanceof——错误在 vm realm 内构造，跨 realm instanceof 恒 false）。 */
const rejectsManuallyStopped = (fn) => assert.rejects(fn, (error) => error?.message === DSH_MANUALLY_STOPPED_ERROR);
/** 跨 realm 安全断言：错误不是「手动停止拒绝」（不掩盖真实 boot 失败）。 */
const rejectsNotManuallyStopped = (fn) => assert.rejects(fn, (error) => error?.message !== DSH_MANUALLY_STOPPED_ERROR);

/** DshHost 位置参数的中间桩（门控分支不触达真实文件系统/进程）。 */
const NOOP = () => {};
const hostDeps = (isManualStopped) => [
	() => "/tmp/userData", // getUserDataDir
	() => "/tmp/app", // getAppPath
	NOOP, // log
	() => undefined, // getDshHomeOverride
	() => undefined, // resolveHostProxyEnvPatch
	() => undefined, // resolveRuntimeAppRoot
	() => Promise.reject(new Error("not injected")), // trashPath
	() => undefined, // getDshRunnerNodePath
	isManualStopped, // isManualStopped（本测试目标）
];

test("dshManualStop: 错误文案是稳定常量且判定只认精确匹配", () => {
	assert.equal(typeof DSH_MANUALLY_STOPPED_ERROR, "string");
	assert.ok(DSH_MANUALLY_STOPPED_ERROR.length > 0);
	const err = dshManuallyStoppedError();
	assert.ok(isDshManuallyStoppedError(err));
	// 非 Error / 普通错误 / 相近文案都不能误判为手动停止（避免掩盖真实 boot 失败）。
	assert.equal(isDshManuallyStoppedError("DSH host is manually stopped"), false);
	assert.equal(isDshManuallyStoppedError(new Error("boot failed: port in use")), false);
	assert.equal(isDshManuallyStoppedError(new Error(DSH_MANUALLY_STOPPED_ERROR + " (extra)")), false);
});

test("dshManualStop: 手动停止降级为带原因的不可读页；其他错误不伪装", () => {
	// DSH 会话没有 pi 会话文件：读取失败必须带可解释原因，渲染层才能出「启动 host」专态。
	const page = dshUnavailablePageFor(dshManuallyStoppedError());
	// 跨 realm 对象不能 deepStrictEqual（原型不同），逐字段断言。
	assert.equal(page?.unavailable, "dsh-host-stopped");
	assert.equal(page?.messages.length, 0);
	assert.equal(page?.total, 0);
	assert.equal(page?.nextBefore, null);
	// 真实读取故障（host 崩溃 / 文件损坏）不能降级成「点一下就能好」的状态。
	assert.equal(dshUnavailablePageFor(new Error("host crashed")), null);
	assert.equal(dshUnavailablePageFor("DSH host is manually stopped"), null);
	assert.equal(dshUnavailablePageFor(undefined), null);
});

test("DshHost.ensureStarted: 手动停止时拒绝自动拉起", async () => {
	let stopped = true;
	const host = new DshHost(...hostDeps(() => stopped));
	await rejectsManuallyStopped(() => host.ensureStarted());
	// 清除标记后同一路径恢复放行（幂等兜底语义不变；此处 boot 失败但错误不是门控拒绝）。
	stopped = false;
	await rejectsNotManuallyStopped(() => host.ensureStarted());
});

test("DshHost.startManually: 门控不影响显式启动路径", async () => {
	const host = new DshHost(...hostDeps(() => false));
	// 未注入真实进程时 boot 必然失败，但失败必须是普通失败而非手动停止拒绝。
	assert.equal(await host.startManually(), false);
});

test("DshHostProcess.start: 手动停止时拒绝 fork", async () => {
	let stopped = true;
	const proc = new DshHostProcess("entry.js", [], {}, NOOP, () => stopped);
	await rejectsManuallyStopped(() => proc.start());
	// 标记翻转为 false 后允许继续走 fork（此处 entry 无效会失败，但错误不是门控拒绝）。
	stopped = false;
	await rejectsNotManuallyStopped(() => proc.start());
});

test("DshHostProcess.restartAfterCrash: 手动停止时静默放弃且不算失败信号", async () => {
	const logs = [];
	let stopped = true;
	const proc = new DshHostProcess(
		"entry.js",
		[],
		{},
		(scope, msg) => logs.push(`${scope}: ${msg}`),
		() => stopped,
	);
	assert.equal(await proc.restartAfterCrash(), false);
	// 静默语义：只留一条「manually stopped」info 日志，不产生「restart failed」假故障。
	const manualLogs = logs.filter((line) => line.includes("manually stopped"));
	assert.equal(manualLogs.length, 1);
	assert.ok(!logs.some((line) => line.includes("restart failed")));
});
