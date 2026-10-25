/**
 * issue #376 守卫：渲染层噪音的「判定 / 去重 / 聚合 / 级别口径」单一策略。
 *
 * 背景：0.9.x 里 ResizeObserver loop 这类良性通知被 renderer 的 window.onerror 与
 * main 的 webContents console-message 两条管道各写一遍（单日 500+ 行），
 * EnvironmentDoctor 的「最近 7 天报错」统计被灌满，真实失败信号被淹没。
 *
 * 这些断言是回归闸门：把聚合器退回「逐条落盘」、或让良性事件重新双写，都必须在这里先红。
 */
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadTsCommonJs } = require("./helpers/loadTsCommonJs.mjs");

let now = 0;
const noise = loadTsCommonJs("src/shared/rendererNoise.ts", {
	globals: {
		Date: { now: () => now },
	},
});
const { RendererNoiseAggregator, classifyRendererNoise, toRendererNoiseLog, toRendererNoiseSummaryLevel, RENDERER_NOISE_KINDS, RENDERER_NOISE_WINDOW_MS } = noise;

test("classifyRendererNoise 只认 ResizeObserver loop，其它一律非良性", () => {
	// 沙箱 realm 与宿主不共享原型，逐字段断言而不是 deepEqual 对象
	const verdict = (message) => {
		const result = classifyRendererNoise(message);
		return { benign: result.benign, kind: result.kind };
	};
	assert.deepEqual(verdict("ResizeObserver loop completed with undelivered notifications."), { benign: true, kind: "resize-observer-loop" });
	assert.deepEqual(verdict("ResizeObserver loop limit exceeded"), { benign: true, kind: "resize-observer-loop" });
	assert.deepEqual(verdict("Module not found: xxx"), { benign: false, kind: null });
	// 非字符串（Error 对象、undefined）不能误判为良性
	assert.deepEqual(verdict(new Error("ResizeObserver loop")), { benign: false, kind: null });
	assert.deepEqual(verdict(undefined), { benign: false, kind: null });
});

test("良性类别一律 info：不进健康体检的 error/warn 统计", () => {
	for (const meta of Object.values(RENDERER_NOISE_KINDS)) {
		assert.equal(meta.level, "info");
		assert.ok(meta.message.length > 0);
	}
	assert.equal(toRendererNoiseSummaryLevel("error"), "warn");
	assert.equal(toRendererNoiseSummaryLevel("warn"), "info");
	assert.equal(toRendererNoiseSummaryLevel("info"), "info");
});

test("良性事件整窗口只落一条 info，且带总计数", () => {
	now = 1_000;
	const agg = new RendererNoiseAggregator();
	const meta = RENDERER_NOISE_KINDS["resize-observer-loop"];
	let flushes = [];
	for (let i = 0; i < 500; i += 1) {
		flushes = flushes.concat(agg.record(meta.kind, meta.level, meta.message, { windowMs: meta.windowMs, deferFirst: true }));
	}
	// 窗口内 500 条良性通知：一条都不该写，避免 500 行噪音
	assert.equal(flushes.length, 0);
	// 窗口结束才落一条，带总条数
	now += meta.windowMs;
	const settled = agg.flushAll();
	assert.equal(settled.length, 1);
	assert.equal(settled[0].count, 500);
	assert.equal(settled[0].level, "info");
	const log = toRendererNoiseLog(settled[0]);
	assert.equal(log.level, "info");
	assert.match(log.message, /\(500 in/);
	assert.equal(log.detail.count, 500);
});

test("非良性首条即时落盘、重复折叠成降档汇总（真实报错不被延迟）", () => {
	now = 10_000;
	const agg = new RendererNoiseAggregator();
	const first = agg.record("uncaught|boom", "error", "Renderer uncaught error", { detail: { message: "boom" } });
	assert.equal(first.length, 1);
	assert.equal(first[0].level, "error");
	assert.equal(first[0].summary, false);
	// 窗口内重复 99 条：不再逐条写
	let flushes = [];
	for (let i = 0; i < 99; i += 1) flushes = flushes.concat(agg.record("uncaught|boom", "error", "Renderer uncaught error", { detail: { message: "boom" } }));
	assert.equal(flushes.length, 0);
	now += RENDERER_NOISE_WINDOW_MS;
	const settled = agg.flushAll();
	assert.equal(settled.length, 1);
	assert.equal(settled[0].count, 99);
	// 重复汇总降一档：error → warn，logs.errors 只算首次发生
	assert.equal(settled[0].level, "warn");
	assert.equal(settled[0].summary, true);
	assert.match(toRendererNoiseLog(settled[0]).message, /suppressed|\(99 in/);
});

test("单条非良性不产生多余的汇总行", () => {
	now = 20_000;
	const agg = new RendererNoiseAggregator();
	agg.record("uncaught|once", "error", "Renderer uncaught error");
	now += RENDERER_NOISE_WINDOW_MS;
	assert.equal(agg.flushAll().length, 0);
});

test("不同 key 的真实报错互不吞并", () => {
	now = 30_000;
	const agg = new RendererNoiseAggregator();
	const a = agg.record("uncaught|aaa", "error", "Renderer uncaught error");
	const b = agg.record("uncaught|bbb", "error", "Renderer uncaught error");
	assert.equal(a.length, 1);
	assert.equal(b.length, 1);
	assert.notEqual(a[0].key, b[0].key);
});

test("持续刷屏时聚合窗口增长，不把日志重新堆满", () => {
	now = 40_000;
	const agg = new RendererNoiseAggregator();
	agg.record("console|boom", "warn", "Main window renderer console error", { deferFirst: true });
	now += RENDERER_NOISE_WINDOW_MS;
	const settled = agg.flushAll();
	assert.ok(settled[0].windowMs > RENDERER_NOISE_WINDOW_MS, "窗口应随结算增长");
	assert.ok(settled[0].windowMs <= 3_600_000);
});

test("main 侧 console-message 镜像跳过良性事件（不与 renderer 双写）", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.match(source, /mainWindow\.webContents\.on\(\s*"console-message"/);
	// 良性判定后直接 return，良性噪音只由 renderer 的全局处理器写一条
	assert.match(source, /if \(classifyRendererNoise\(event\.message\)\.benign\) return;/);
	// 聚合器与 renderer 同源（shared），保证两条管道口径一致
	assert.match(source, /from "\.\.\/shared\/rendererNoise"/);
	const pet = readFileSync("src/main/pet/PetWindow.ts", "utf8");
	assert.match(pet, /if \(classifyRendererNoise\(event\.message\)\.benign\) return;/);
});

test("renderer 侧聚合口径与 shared 一致，不再内联判定", () => {
	const source = readFileSync("src/renderer/src/main.tsx", "utf8");
	assert.match(source, /new RendererNoiseAggregator\(\)/);
	assert.match(source, /RENDERER_NOISE_KINDS\[verdict\.kind\]/);
	// 内联的 includes("ResizeObserver loop") 判定必须消失（口径两处会漂移）
	assert.doesNotMatch(source, /message\.includes\("ResizeObserver loop"\)/);
});
