/**
 * memoryProfileCsv 单测 —— 覆盖 CSV 序列化/解析/聚合 + analyze-memory.mjs 脚本行为。
 * 数据底座错了，分析结论就全错，所以这层测试按“门禁”标准写。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

// 用 esbuild 不行（无依赖），直接用 vite 的构建产物不可行 —— 这里用 node --experimental-strip-types?
// 项目 tsconfig 是 Electron 主进程 TS；node 24 支持 --experimental-strip-types 直接跑 .ts（仅类型剥离）。
// 但 memoryProfileCsv.ts 用了 interface 等类型语法，strip-types 可以处理（无 enum/namespace）。
import { toProfileCsvRow, parseMemoryCsv, aggregateMemoryProfile, totalRssSeries, sanitizeRssReadings, MEMORY_PROFILE_HEADER } from "../src/main/memory/memoryProfileCsv.ts";

test("toProfileCsvRow 输出表头一致的 10 字段行", () => {
	const row = {
		ts: 1700000000000,
		type: "Tab",
		pid: 123,
		label: "渲染窗口#1",
		rssKB: 1024,
		privateKB: 512,
		sharedKB: null,
		peakRssKB: null,
		heapUsedKB: null,
		jsHeapKB: 256,
		domNodes: 12345,
		imgCount: 3,
		imgPixels: 9000000,
		canvasPixels: null,
		workerCount: 2,
		workerJSHeapKB: 8192,
	};
	assert.equal(toProfileCsvRow(row), "1700000000000,Tab,123,渲染窗口#1,1024,512,,,,256,,12345,3,9000000,,2,8192,,,,");
});

test("21 列完整行 roundtrip：主进程 heapTotal/external/arrayBuffers 往返一致", () => {
	const row = {
		ts: 1700000000000,
		type: "Browser",
		pid: 42,
		label: "主进程",
		rssKB: 102400,
		privateKB: null,
		sharedKB: null,
		peakRssKB: null,
		heapUsedKB: 51200,
		jsHeapKB: null,
		totalJSHeapKB: null,
		domNodes: null,
		imgCount: null,
		imgPixels: null,
		canvasPixels: null,
		workerCount: null,
		workerJSHeapKB: null,
		streaming: null,
		heapTotalKB: 71680,
		externalKB: 4096,
		arrayBuffersKB: 2048,
	};
	const csv = toProfileCsvRow(row);
	// 行尾 3 列 = 新补采列，不能丢；期望串用代码构造，避免手数逗号
	const expected = ["1700000000000", "Browser", "42", "主进程", "102400", "", "", "", "51200", ...Array.from({ length: 9 }, () => ""), "71680", "4096", "2048"].join(",");
	assert.equal(csv, expected);
	const [parsed] = parseMemoryCsv(MEMORY_PROFILE_HEADER + "\n" + csv);
	assert.equal(parsed.heapTotalKB, 71680);
	assert.equal(parsed.externalKB, 4096);
	assert.equal(parsed.arrayBuffersKB, 2048);
	// 空列还原为 null（渲染行新列为空）；用代码构造 21 列，避免手数逗号
	const tabLine = ["1700000000000", "Tab", "1", "渲染窗口#1", "102400", ...Array.from({ length: 4 }, () => ""), "10240", ...Array.from({ length: 11 }, () => "")].join(",");
	assert.equal(tabLine.split(",").length, 21);
	const [tabRow] = parseMemoryCsv(MEMORY_PROFILE_HEADER + "\n" + tabLine);
	assert.equal(tabRow.heapTotalKB, null);
	assert.equal(tabRow.arrayBuffersKB, null);
});

test("parseMemoryCsv 兼容 10 列旧格式（domNodes 缺省为 null）", () => {
	const rows = parseMemoryCsv(
		[
			MEMORY_PROFILE_HEADER,
			"1,Tab,1,老窗口,100,,,,,20", // 旧格式：无 domNodes 列
		].join("\n"),
	);
	assert.equal(rows[0].domNodes, null);
	assert.equal(rows[0].jsHeapKB, 20);
});

test("toProfileCsvRow 对 label 中的逗号/引号做 CSV 转义", () => {
	const row = {
		ts: 1,
		type: "webview",
		pid: 1,
		label: '浏览器面板, "主", #2',
		rssKB: null,
		privateKB: null,
		sharedKB: null,
		peakRssKB: null,
		heapUsedKB: null,
		jsHeapKB: null,
		domNodes: null,
		imgCount: null,
		imgPixels: null,
		canvasPixels: null,
	};
	const csv = toProfileCsvRow(row);
	// 引号包裹 + 内部引号翻倍
	assert.ok(csv.includes('"浏览器面板, ""主"", #2"'), `实际输出: ${csv}`);
	// 往返一致
	const parsed = parseMemoryCsv(MEMORY_PROFILE_HEADER + "\n" + csv);
	assert.equal(parsed[0].label, '浏览器面板, "主", #2');
});

test("parseMemoryCsv 跳过表头/空行，null 字段还原", () => {
	const csv = [MEMORY_PROFILE_HEADER, "100,Tab,1,渲染窗口#1,10,5,,,,", "", "200,Browser,2,主进程,20,,,30,8,"].join("\n");
	const rows = parseMemoryCsv(csv);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].rssKB, 10);
	assert.equal(rows[0].jsHeapKB, null);
	assert.equal(rows[1].type, "Browser");
	assert.equal(rows[1].heapUsedKB, 8);
});

test("parseMemoryCsv 对字段数不对的行抛错（防静默错位）", () => {
	assert.throws(() => parseMemoryCsv("1,Tab,1,label,10\n"), /malformed/);
	// 19/20 列：多列但不足 21，同样拒绝（半新格式 = 采集中断，静默错位比报错更糟）
	// 用代码构造列数，避免手数逗号出错
	const row19 = ["1", "Tab", "1", "label", "10", ...Array.from({ length: 13 }, () => ""), "x"].join(",");
	const row20 = ["1", "Tab", "1", "label", "10", ...Array.from({ length: 14 }, () => ""), "x"].join(",");
	assert.equal(row19.split(",").length, 19);
	assert.equal(row20.split(",").length, 20);
	assert.throws(() => parseMemoryCsv(row19 + "\n"), /malformed/);
	assert.throws(() => parseMemoryCsv(row20 + "\n"), /malformed/);
});

test("aggregateMemoryProfile 按 pid 聚合：首末 RSS、峰值、增长、排序", () => {
	const csv = [
		MEMORY_PROFILE_HEADER,
		"100,Tab,1,渲染窗口#1,100,,,,,10", // 进程1：100→200，峰值200
		"100,Browser,2,主进程,300,,,,50,",
		"200,Tab,1,渲染窗口#1,200,,,,,20", // 进程1 jsHeap 10→20
		"200,Browser,2,主进程,250,,,,60,", // 进程2：300→250（回收了）
	].join("\n");
	const aggs = aggregateMemoryProfile(parseMemoryCsv(csv));
	assert.equal(aggs.length, 2);
	// 增长大的排前：进程1 涨 100，进程2 降 50
	assert.equal(aggs[0].pid, 1);
	assert.equal(aggs[0].growthKB, 100);
	assert.equal(aggs[0].peakRssKB, 200);
	assert.equal(aggs[0].endJsHeapKB, 20); // 取末值
	assert.equal(aggs[1].pid, 2);
	assert.equal(aggs[1].growthKB, -50);
	assert.equal(aggs[1].endHeapUsedKB, 60);
});

test("aggregateMemoryProfile 聚合主进程 V8 补采列取末值", () => {
	const csv = [MEMORY_PROFILE_HEADER, "100,Browser,2,主进程,300,,,,50,,,,,,,,,,61440,2048,1024", "200,Browser,2,主进程,250,,,,60,,,,,,,,,,71680,4096,2048"].join("\n");
	const [agg] = aggregateMemoryProfile(parseMemoryCsv(csv));
	assert.equal(agg.endHeapTotalKB, 71680); // 取末值
	assert.equal(agg.endExternalKB, 4096);
	assert.equal(agg.endArrayBuffersKB, 2048);
});

test("totalRssSeries 按时间戳求和并升序", () => {
	const csv = [MEMORY_PROFILE_HEADER, "200,Tab,1,a,50,,,,,", "100,Browser,2,b,30,,,,,", "100,Tab,3,c,20,,,,,", "200,Browser,2,b,40,,,,,"].join("\n");
	const series = totalRssSeries(parseMemoryCsv(csv));
	assert.deepEqual(series, [
		{ ts: 100, totalKB: 50 },
		{ ts: 200, totalKB: 90 },
	]);
});

test("sanitizeRssReadings 剔除启动/退出瞬间的假读数", () => {
	// 正常值 100 附近 + 一个 5 倍于中位数的退出瞬间假值
	const clean = sanitizeRssReadings([100, 110, 105, 108, 500]);
	assert.deepEqual(clean, [100, 110, 105, 108]);
});

test("sanitizeRssReadings 真实大增长时只剔除退出假值，不误杀正常增长", () => {
	// 239MB → 1.4GB 的真实增长（操作场景）+ 1.8GB 的退出瞬间假值
	const values = [
		245,
		250,
		255,
		370,
		470,
		540,
		660,
		740,
		800,
		957,
		990,
		1110,
		1151,
		1220,
		1308,
		1388,
		1403,
		1403,
		1418,
		1402,
		1830, // 1.8GB 退出假值
	];
	const clean = sanitizeRssReadings(values);
	// 真实增长全部保留（含 1.4GB 量级），只有退出瞬间的 1.8GB 被剔除
	assert.ok(clean.includes(1403));
	assert.ok(clean.includes(245));
	assert.ok(!clean.includes(1830));
	assert.equal(clean.length, values.length - 1);
});

test("aggregateMemoryProfile 聚合时先清洗 RSS（退出瞬间的假峰值不污染结果）", () => {
	const csv = [
		MEMORY_PROFILE_HEADER,
		"100,Tab,1,渲染窗口#1,100,,,,,",
		"200,Tab,1,渲染窗口#1,110,,,,,",
		"300,Tab,1,渲染窗口#1,120,,,,,",
		"400,Tab,1,渲染窗口#1,1403684,,,,,", // 进程退出瞬间的假读数（~1.4GB）
	].join("\n");
	const [agg] = aggregateMemoryProfile(parseMemoryCsv(csv));
	// 假读数被清洗：末尾回到正常区间的最后一个真值
	assert.equal(agg.endRssKB, 120);
	assert.equal(agg.peakRssKB, 120);
	assert.equal(agg.growthKB, 20);
});

test("totalRssSeries 清洗异常读数后再求和（单点假值不拉高整轮总和）", () => {
	const csv = [
		MEMORY_PROFILE_HEADER,
		"100,Tab,1,a,100,,,,,",
		"150,Tab,1,a,105,,,,,",
		"200,Tab,1,a,1403684,,,,,", // 退出瞬间假值
		"200,Browser,2,b,300,,,,,",
	].join("\n");
	const series = totalRssSeries(parseMemoryCsv(csv));
	// ts=150 只有 pid1 的正常值；ts=200 只计入 Browser 的 300，不含假值
	assert.deepEqual(series, [
		{ ts: 100, totalKB: 100 },
		{ ts: 150, totalKB: 105 },
		{ ts: 200, totalKB: 300 },
	]);
});

test("analyze-memory.mjs 对 fixture 输出聚合报告（脚本侧回归）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "memprof-"));
	try {
		const csvPath = join(dir, "profile-test.csv");
		// 21 列格式（含 2026-12 补采的主进程 heapTotal/external/arrayBuffers）；用代码构造避免手数逗号
		const empty = (n) => Array.from({ length: n }, () => "");
		const csv = [
			MEMORY_PROFILE_HEADER,
			["100", "Tab", "1", "渲染窗口#1", "102400", ...empty(4), "10240", ...empty(11)].join(","),
			["100", "Browser", "2", "主进程", "204800", ...empty(3), "51200", ...empty(9), "71680", "4096", "2048"].join(","),
			["200", "Tab", "1", "渲染窗口#1", "204800", ...empty(4), "20480", ...empty(11)].join(","),
			["200", "Browser", "2", "主进程", "204800", ...empty(3), "51200", ...empty(9), "71680", "4096", "2048"].join(","),
		].join("\n");
		await writeFile(csvPath, csv);
		const { stdout } = await execFileAsync(process.execPath, ["scripts/analyze-memory.mjs", csvPath]);
		// 增长排行：渲染窗口#1 涨 100MB 排第一，主进程持平
		assert.ok(stdout.includes("渲染窗口#1#1 (Tab)"), `缺进程行: ${stdout}`);
		assert.ok(stdout.includes("100.0 MB"), `缺增长数值: ${stdout}`);
		assert.ok(stdout.includes("20.0 MB"), `缺 JS 堆数值: ${stdout}`);
		assert.ok(stdout.includes("全体进程 RSS"), `缺总览: ${stdout}`);
		// 主进程 V8 明细行：heap used/total + external + arrayBuffers
		assert.ok(stdout.includes("主进程 V8（末）"), `缺 V8 明细行: ${stdout}`);
		assert.ok(stdout.includes("50.0 MB / 70.0 MB"), `缺 heap used/total: ${stdout}`);
		assert.ok(stdout.includes("arrayBuffers 2.0 MB"), `缺 arrayBuffers: ${stdout}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
