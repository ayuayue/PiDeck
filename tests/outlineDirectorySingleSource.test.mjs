import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * 判据：导轨目录（useSessionOutlineDirectory）只许有一个取数点。
 *
 * 事故（2026-11-27 真机，用户报「末尾有两个」，这次是反方向）：
 * SessionView 与 SessionSurfaceStage 各调一次 useSessionOutlineDirectory，
 * 两处传的第二个参数不同：
 *   SessionView   sessionTimeline.messages.length   <- 新消息一到就变
 *   Stage         outlineItems.length               <- 要等大纲重建才变
 * 该 hook 的第二个参数是 effect 依赖（触发重拉），不是一个值。于是两条路径会在不同时刻
 * 重新拉目录，各自 useState 存一份快照 —— 过渡期间两份长度不同：
 * 状态栏读 A 份、导轨读 B 份，78 vs 79 就以反方向再出现一次。
 *
 * 修法：目录只由 SessionView 取一次，作为 prop 传给 Stage。
 * 判据：本目录下 useSessionOutlineDirectory 的调用点恰好 1 处，且 Stage 必须从 props 拿。
 */

const DIR = "src/renderer/src/components/session";

test("session 组件目录里 useSessionOutlineDirectory 的调用点恰好 1 处", () => {
	const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".tsx"));
	const calls = [];
	for (const f of files) {
		const src = fs.readFileSync(DIR + "/" + f, "utf8");
		for (const line of src.split("\n")) {
			if (/useSessionOutlineDirectory\(/.test(line) && !/^\s*(import|\/\/|\*)/.test(line)) calls.push(f + ": " + line.trim());
		}
	}
	assert.equal(calls.length, 1, "调用点必须恰好 1 处（>1 = 两份快照会分叉，78/79 会再出现）：\n" + calls.join("\n"));
});

test("Stage 从 props 拿目录，而不是自己再取一次", () => {
	const src = fs.readFileSync(DIR + "/SessionSurfaceStage.tsx", "utf8");
	assert.ok(!/useSessionOutlineDirectory\(/.test(src), "Stage 仍在自己取目录：它和 SessionView 会各存一份快照");
	assert.ok(/outlineDirectory\??:/.test(src), "Stage 的 props 里没有 outlineDirectory 字段");
	assert.ok(/\{[^}]*outlineDirectory[^}]*\}\s*=\s*props/.test(src) || /props\.outlineDirectory/.test(src), "Stage 没有从 props 解构出 outlineDirectory");
});
