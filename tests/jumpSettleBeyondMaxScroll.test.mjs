import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 调用点的契约：余量必须把**目标位置**算进去，只传 maxScroll 是不够的。
 * 反例：只传 maxScroll 时，目标超出可滚上限（16303 > 15826）仍被判为「能滚」，
 * 于是继续写 scrollTop、被浏览器钳位、drift 恒 400 —— 也就是这一轮修的那个缺陷。
 */
test("调用点把目标文档坐标算进余量（源码契约）", () => {
	const src = readFileSync("src/renderer/src/hooks/session/timeline/useTimelineJumpNavigation.ts", "utf8");
	assert.match(src, /maxScroll - Math\.max\(0, timeline\.scrollTop \+ driftPx\)/, "余量必须是 maxScroll - max(0, scrollTop + drift)");
	assert.match(src, /const maxScroll = timeline\.scrollHeight - timeline\.clientHeight;/, "maxScroll 必须由容器高度算出");
});
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
	return module.exports;
}

const J = compile("src/renderer/src/components/session/timeline/jumpSettle.ts");
const plan = J.planJumpSettleStep;
const base = { frames: 2, elapsedMs: 50, interrupted: false, expandAttempts: 0 };
const expect = (d, kind, extra) => {
	assert.equal(d.kind, kind, "kind: got " + d.kind);
	if (extra !== undefined) assert.equal(d.kind === "scroll" ? d.delta : d.reason, extra);
};

/** 复刻调用点的算法：余量 = maxScroll - max(0, scrollTop + drift)。 */
const room = (scrollTop, drift, scrollHeight, clientHeight) => {
	const maxScroll = scrollHeight - clientHeight;
	return maxScroll - Math.max(0, scrollTop + drift);
};

test("目标超出可滚上限：必须 expand（滚到底也够不到）", () => {
	// 反例（2026-11-25 日志实证，点第 100 条）：
	//   settle scrollTop=1056 rectTop=15247 scrollHeight=16686 clientHeight=860
	//   → maxScroll=15826，目标文档坐标 16303，超出 477px
	//   → drift 恒 400，24 帧后 give-up，用户看到「定位错到别处」
	const r = room(1056, 15247, 16686, 860);
	assert.ok(r < 0, "余量应为负，实际 " + r);
	expect(plan({ ...base, driftPx: 15247, canScrollPx: r }), "expand");
});

test("同一会话第二次点击：目标超出 476px，同样 expand", () => {
	const r = room(123, 16404, 16911, 860);
	assert.ok(r < 0, "余量应为负，实际 " + r);
	expect(plan({ ...base, driftPx: 16404, canScrollPx: r }), "expand");
});

test("目标在上方（向上跳）：余量按 maxScroll 计，不该被 expand 抢走", () => {
	// drift 为负 → max(0, scrollTop+drift) 可能为 0 → 余量 = maxScroll，够滚
	const r = room(5000, -1674, 16686, 860);
	expect(plan({ ...base, driftPx: -1674, canScrollPx: r }), "scroll", -1674);
});

test("目标在可滚范围内（常规下跳）：照常 scroll", () => {
	const r = room(1000, 400, 16686, 860);
	assert.ok(r > 4, "余量应足够，实际 " + r);
	expect(plan({ ...base, driftPx: 400, canScrollPx: r }), "scroll", 400);
});

test("内容比视口矮：余量为 0，仍走 expand（上一轮的判据不回退）", () => {
	const r = room(0, 345, 858, 858);
	expect(plan({ ...base, driftPx: 345, canScrollPx: r }), "expand");
});
