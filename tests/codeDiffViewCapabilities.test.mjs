import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * CodeDiffView 大文件渲染能力回归测试（源码级）。
 *
 * 约束：diff 视图必须保持「GitHub 式 hunk 折叠 + 虚拟化 + worker 高亮」的组合，
 * 否则 17k 行文件会退回纯文本提示或阻塞主线程。这些能力是结构性配置，
 * 通过源码断言防止未来重构时被静默移除。
 */

const source = readFileSync("src/renderer/src/components/app/CodeDiffView.tsx", "utf8");

test("renders diff computation and highlighting in a worker pool", () => {
	// WorkerPoolContextProvider：diff 计算 + Shiki tokenize 不占主线程；
	// 池为单例，最后一个使用方卸载时 terminate（见库 WorkerPoolContext）
	assert.match(source, /WorkerPoolContextProvider/);
	assert.match(source, /poolSize:/);
	assert.match(source, /workerFactory:/);
});

test("virtualizes rows so off-screen lines are not in the DOM", () => {
	assert.match(source, /Virtualizer/);
	assert.match(source, /overflow-auto/);
});

test("collapses unchanged regions into expandable separators (GitHub style)", () => {
	assert.match(source, /collapsedContextThreshold/);
	assert.match(source, /expandUnchanged:\s*true/);
	assert.match(source, /expansionLineCount/);
});

test("limits syntax highlighting quota so huge files degrade to plain text", () => {
	assert.match(source, /tokenizeMaxLength/);
});

test("no longer hard-cuts files above 5000 lines", () => {
	assert.doesNotMatch(source, /5_000|5000/);
});

test("line counts feed the tiered render plan instead of a hard cutoff", () => {
	assert.match(source, /getDiffRenderPlan/);
	assert.match(source, /countLines\(props\.oldContent\)/);
	assert.match(source, /countLines\(props\.newContent\)/);
});

test("fallback hint is kept only for the beyond-limit tier", () => {
	assert.match(source, /plan\.mode === "fallback"/);
	assert.match(source, /editor\.diffTooLarge/);
});

test("worker theme registration matches the render theme", () => {
	// worker 高亮器必须注册与渲染 options.theme 相同的主题，
	// 否则 worker 端拿不到 one-dark-pro / one-light 的颜色映射
	assert.match(source, /highlighterOptions=\{\{[\s\S]*one-dark-pro/);
	assert.match(source, /one-light/);
});
