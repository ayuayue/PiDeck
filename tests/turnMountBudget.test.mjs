import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// boundMountedSteps：单轮步骤的挂载预算（2026-08 #213）。
// 回归背景：turnRenderWindow 只按轮数裁剪，极端会话里「一轮」可以含上百个
// 工具/思考条目，一次全挂进 DOM 就是上千个 ToolStep 子树 → 渲染进程 OOM。
// 契约：默认只挂尾部预算条，更早的靠「显示更早 N 条步骤」显式展开（内容不丢）。

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: () => ({}),
		},
		{ filename: filePath },
	);
	return module.exports;
}

const { boundMountedSteps, TIMELINE_MOUNTED_STEP_LIMIT } = compile("src/renderer/src/components/session/timeline/turnMountBudget.ts");

const items = (count) => Array.from({ length: count }, (_, index) => `step-${index}`);

test("默认预算是一个有限的正数", () => {
	assert.ok(Number.isFinite(TIMELINE_MOUNTED_STEP_LIMIT));
	assert.ok(TIMELINE_MOUNTED_STEP_LIMIT > 0);
});

test("未超预算时原样返回（保留数组引用，避免无谓重渲染）", () => {
	const source = items(5);
	const windowed = boundMountedSteps(source, 120);
	assert.equal(windowed.items, source);
	assert.equal(windowed.hiddenCount, 0);
});

test("超预算时保留尾部、并报告被折叠的条目数", () => {
	const windowed = boundMountedSteps(items(500), 120);
	assert.equal(windowed.items.length, 120);
	assert.equal(windowed.hiddenCount, 380);
	// 步骤是时序的：保留的必须是最后 120 条
	assert.equal(windowed.items[0], "step-380");
	assert.equal(windowed.items[119], "step-499");
});

test("expansion 每加一档只多挂一批（不再有一次全量）", () => {
	const source = items(500);
	// 首次点击锚在 len=500：batches 0/1/2/3 → 120/240/360/480；第 4 档覆盖全量、返回原引用。
	const tiers = [
		[0, 120, 380],
		[1, 240, 260],
		[2, 360, 140],
		[3, 480, 20],
	];
	for (const [batches, mounted, hidden] of tiers) {
		const windowed = boundMountedSteps(source, 120, batches === 0 ? undefined : { anchor: 500, batches });
		assert.equal(windowed.items.length, mounted, `batches=${batches} 应挂 ${mounted} 条`);
		assert.equal(windowed.hiddenCount, hidden, `batches=${batches} 应折叠 ${hidden} 条`);
		assert.notEqual(windowed.items, source, `batches=${batches} 是裁剪分支，必须是新数组`);
		assert.equal(windowed.items[0], source[500 - mounted]);
		assert.equal(windowed.items.at(-1), source.at(-1));
	}
	const full = boundMountedSteps(source, 120, { anchor: 500, batches: 4 });
	assert.equal(full.items, source, "下界覆盖全量时应返回原引用（既有 memo 契约）");
	assert.equal(full.hiddenCount, 0);
	assert.notEqual(boundMountedSteps(source, 120, { anchor: 500, batches: -3 }).items, source, "负批次按 0 处理，不能变成全量");
	assert.equal(boundMountedSteps(source, 120, { anchor: 500, batches: Number.NaN }).hiddenCount, 380, "NaN 批次按 0 处理");
});

test("expansion：尾部追加新条目时，已展开的旧条目仍全部挂载（下界不右移）", () => {
	const source = items(500);
	const expansion = { anchor: 500, batches: 1 };
	const before = boundMountedSteps(source, 120, expansion);
	const grown = boundMountedSteps([...source, ...items(10).map((index) => `appended-${index}`)], 120, expansion);
	assert.equal(before.items.length, 240);
	// 旧实现按 len-cap 从尾部切，会在这里丢掉最早的 10 条；新语义只增不减。
	assert.deepEqual(grown.items.slice(0, 240), before.items);
	assert.equal(grown.items.length, 250);
	assert.equal(grown.hiddenCount, 260);
	assert.equal(grown.items.at(-1), "appended-step-9");
});

test("expansion：anchor 超出/低于条目数时下界被 clamp", () => {
	assert.equal(boundMountedSteps(items(50), 120, { anchor: 500, batches: 3 }).hiddenCount, 0, "anchor 远大于长度时不能越界");
	const clamped = boundMountedSteps(items(300), 120, { anchor: 500, batches: 1 });
	assert.equal(clamped.items.length, 240, "anchor 被 clamp 到 len 后下界 = len - 2 × limit");
	assert.equal(clamped.hiddenCount, 60);
});

test("limit<=0 视为未启用预算", () => {
	const source = items(500);
	assert.equal(boundMountedSteps(source, 0).items, source);
	assert.equal(boundMountedSteps(source, -1).items, source);
});

test("边界：条目数恰好等于 limit 时不折叠", () => {
	const windowed = boundMountedSteps(items(120), 120);
	assert.equal(windowed.hiddenCount, 0);
	assert.equal(windowed.items.length, 120);
});
