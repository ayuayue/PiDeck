/**
 * 每进程 CPU 归属契约：采样口径（累计 CPU 秒差分）+ 采集/展示/落盘链路。
 * 高 CPU 反馈的第一步就是「先知道是哪个进程」，这条链路错了后面全是猜。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sampleProcessCpu } from "../src/main/process/processCpuSampler.ts";

const samplerSource = readFileSync("src/main/process/processCpuSampler.ts", "utf8");
const monitor = readFileSync("src/main/diagnostics/DiagnosticsMonitor.ts", "utf8");
const panel = readFileSync("src/renderer/src/components/app/settings/DiagnosticsPanel.tsx", "utf8");

/** 去掉注释再断言代码形状：文档里解释「为什么不用 percentCPUUsage」不算依赖它。 */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

// ===== 纯函数：差分口径 =====

test("sampleProcessCpu: 首轮只建基线，不产出行", () => {
	const { rows, baseline } = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 3 }], new Map(), 1_000);
	assert.deepEqual(rows, []);
	assert.deepEqual([...baseline.keys()], [10]);
});

test("sampleProcessCpu: 1s 内用掉 0.5s CPU = 50%", () => {
	const first = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 3 }], new Map(), 1_000);
	const second = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 3.5 }], first.baseline, 2_000);
	assert.equal(second.rows.length, 1);
	assert.equal(second.rows[0].cpuPct, 50);
});

test("sampleProcessCpu: 多线程可超过 100%（占满两个核 = 200%）", () => {
	const first = sampleProcessCpu([{ pid: 10, type: "GPU", cumulativeCpuSeconds: 1 }], new Map(), 1_000);
	const second = sampleProcessCpu([{ pid: 10, type: "GPU", cumulativeCpuSeconds: 3 }], first.baseline, 2_000);
	assert.equal(second.rows[0].cpuPct, 200);
});

test("sampleProcessCpu: 按采样窗口校准，不假设固定 1s", () => {
	const first = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 1 }], new Map(), 1_000);
	// 2s 窗口用掉 0.5s → 25%
	const second = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 1.5 }], first.baseline, 3_000);
	assert.equal(second.rows[0].cpuPct, 25);
});

test("sampleProcessCpu: 读不到累计 CPU 的进程不产出行也不污染基线", () => {
	const first = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 1 }], new Map(), 1_000);
	const second = sampleProcessCpu([{ pid: 10, type: "Tab" }], first.baseline, 2_000);
	assert.deepEqual(second.rows, []);
	const third = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 1.2 }], second.baseline, 3_000);
	// 基线被丢掉了，第三轮只能重建，所以不产出行（不会把 2s 的差算成 1s 的尖峰）
	assert.deepEqual(third.rows, []);
});

test("sampleProcessCpu: 跳过负增量与时钟回拨", () => {
	const first = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 5 }], new Map(), 1_000);
	const shrunk = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 2 }], first.baseline, 2_000);
	assert.deepEqual(shrunk.rows, []);
	const backwards = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 6 }], first.baseline, 1_000);
	assert.deepEqual(backwards.rows, []);
});

test("sampleProcessCpu: pid 复用（creationTime 变化）后重新建基线", () => {
	const first = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 900, creationTime: 1 }], new Map(), 1_000);
	const reused = sampleProcessCpu([{ pid: 10, type: "Tab", cumulativeCpuSeconds: 0.1, creationTime: 2 }], first.baseline, 2_000);
	assert.deepEqual(reused.rows, []);
});

test("sampleProcessCpu: 结果按 CPU 降序、pid 升序", () => {
	const first = sampleProcessCpu(
		[
			{ pid: 3, type: "GPU", cumulativeCpuSeconds: 0 },
			{ pid: 2, type: "Tab", cumulativeCpuSeconds: 0 },
			{ pid: 1, type: "Browser", cumulativeCpuSeconds: 0 },
			{ pid: 4, type: "Tab", cumulativeCpuSeconds: 0 },
		],
		new Map(),
		1_000,
	);
	const second = sampleProcessCpu(
		[
			{ pid: 3, type: "GPU", cumulativeCpuSeconds: 0.5 },
			{ pid: 2, type: "Tab", cumulativeCpuSeconds: 0.1 },
			{ pid: 1, type: "Browser", cumulativeCpuSeconds: 0.5 },
			{ pid: 4, type: "Tab", cumulativeCpuSeconds: 0.1 },
		],
		first.baseline,
		2_000,
	);
	assert.deepEqual(
		second.rows.map((row) => row.pid),
		[1, 3, 2, 4],
	);
});

// ===== 链路契约 =====

test("sampler 保持纯函数（不 import electron），口径只用累计秒数", () => {
	const code = stripComments(samplerSource);
	assert.doesNotMatch(code, /from "electron"/);
	assert.doesNotMatch(code, /percentCPUUsage/);
	assert.match(code, /cumulativeCpuSeconds/);
});

test("DiagnosticsMonitor 采每进程 CPU 并单独落 cpu-*.jsonl", () => {
	assert.match(monitor, /app\.getAppMetrics\(\)/);
	assert.match(monitor, /cumulativeCPUUsage/);
	assert.doesNotMatch(monitor, /percentCPUUsage/);
	assert.match(monitor, /`cpu-\$\{stamp\}\.jsonl`/);
	assert.match(monitor, /sampleProcessCpu\(/);
	assert.match(monitor, /processCpu: this\.latestCpu/);
	// stop 必须两个定时器都清，否则关掉开关还在采样
	assert.match(monitor, /\[this\.lagTimer, this\.cpuTimer\]/);
});

test("DiagnosticsPanel 展示每进程 CPU 且开着才轮询", () => {
	assert.match(panel, /settings\.developerDiagnosticsProcesses/);
	assert.match(panel, /snapshot\?\.processCpu/);
	assert.match(panel, /setInterval\(\(\) => void refresh\(false\), 2000\)/);
	assert.match(panel, /clearInterval\(timer\)/);
});

test("进程 CPU 文案在 zh-CN / en-US 都存在", () => {
	for (const key of ["settings.developerDiagnosticsProcesses", "settings.developerDiagnosticsProcessPeak", "settings.developerDiagnosticsProcMain", "settings.developerDiagnosticsProcRender", "settings.developerDiagnosticsProcGpu", "settings.developerDiagnosticsProcUtility"]) {
		assert.match(zh, new RegExp(`"${key.replace(/\./g, "\\.")}"`), `zh-CN 缺 ${key}`);
		assert.match(en, new RegExp(`"${key.replace(/\./g, "\\.")}"`), `en-US 缺 ${key}`);
	}
});
