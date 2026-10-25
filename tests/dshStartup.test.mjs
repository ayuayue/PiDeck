import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { startDshHostInBackground } = loadTsCommonJs("src/main/dsh/startDshHostInBackground.ts");
const main = readFileSync("src/main/index.ts", "utf8");
const configTab = readFileSync("src/renderer/src/config/DshConfigTab.tsx", "utf8");

test("startDshHostInBackground starts immediately without awaiting host readiness", async () => {
	let resolveStart;
	let started = false;
	const startup = new Promise((resolve) => {
		resolveStart = resolve;
	});
	const warnings = [];

	const result = startDshHostInBackground(
		{
			ensureStarted() {
				started = true;
				return startup;
			},
		},
		{ warn: (...args) => warnings.push(args) },
	);

	assert.equal(result, undefined, "启动入口不能等待 host boot");
	assert.equal(started, true, "调用后应立即开始 boot");
	assert.equal(warnings.length, 0);
	resolveStart();
	await startup;
});

test("startDshHostInBackground skips warmup when enabled is false", () => {
	let started = false;
	startDshHostInBackground(
		{
			ensureStarted() {
				started = true;
				return Promise.resolve();
			},
		},
		{ warn: () => undefined },
		{ enabled: false },
	);
	assert.equal(started, false, "默认后端为 pi 时不应 fork DSH host");
});

test("startup integration warms DSH after the main window whenever the runtime is installed and the host was not stopped", () => {
	// AgentRuntimeProvider 阶段 1：预热再加一道 runtime 门控——runtime 不在时 boot 必然失败，
	// 白起一个 utilityProcess（约 200MB）没有意义。
	// 43f8b7c2 起 createWindow 与直连预热之间插入了 runtime 版本错配自动更新块
	// （其 onRuntimeReady 也用同一门控补预热），窗口放宽到 2400 字符。
	// 门控条件收敛到 dshWarmupEnabled()：canCreateDshSession + 未手动停止
	// （dshManualStopped，见 tests/dshManualStopWiring.test.mjs）；**不再要求默认后端是 dsh**——
	// 装好 runtime 本身就是用户要用 DSH 的显式信号，host boot 约 20s，装了就该提前拉起来。
	assert.match(main, /await createWindow\(\);[\s\S]{0,2400}startDshHostInBackground\(dshHost, appLogger, \{\s*enabled:\s*dshWarmupEnabled\(\),\s*\}\)/);
	assert.match(main, /function dshWarmupEnabled\(\): boolean[\s\S]{0,400}dshManualStopped !== true/);
	assert.match(main, /function dshWarmupEnabled\(\): boolean[\s\S]{0,400}canCreateDshSession\(\)/);
	// 默认后端不再是预热门控：纯 pi 用户只要装了 runtime 也应该预热 DSH host。
	assert.doesNotMatch(main, /function dshWarmupEnabled\(\): boolean[\s\S]{0,300}defaultAgentBackend/);
	assert.match(main, /function dshWarmupEnabled\(\): boolean\s*\{\s*return dshRuntimeStatus\.canCreateDshSession\(\) && settingsStore\.get\(\)\.dshManualStopped !== true;\s*\}/);
	assert.match(configTab, /const restartHost = async \(\) =>/);
	assert.match(configTab, /desktopApi\.sessions\.restartDshHost\(\)/);
	assert.match(configTab, /t\("config\.dsh\.restartHost"\)/);
	assert.match(configTab, /const startHost = async \(\) =>/);
	assert.match(configTab, /desktopApi\.sessions\.startDshHost\(\)/);
	assert.match(configTab, /t\("config\.dsh\.startHost"\)/);
	// 启动后回读状态：手动停止标记清除后徽标要变成「运行中」（不同步成 started 会停在已停止）
	assert.match(configTab, /setStatus\(statusResult\)/);
});

test("startDshHostInBackground logs failures without surfacing an unhandled rejection", async () => {
	const warnings = [];
	startDshHostInBackground(
		{
			ensureStarted: async () => {
				throw new Error("host boot failed");
			},
		},
		{ warn: (...args) => warnings.push(args) },
	);

	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0]?.[0], "dsh-host");
	assert.equal(warnings[0]?.[1], "Background DSH host startup failed");
	// 生产侧只记 error.message（结构化日志不再带 "Error: " 前缀）；用例关心的是
	// rejection 被捕获并记录，不关心字符串形态。
	assert.equal(warnings[0]?.[2]?.error, "host boot failed");
});
