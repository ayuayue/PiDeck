import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 跳转「提示文案 vs 判据」与「hook 位置」的源码判据。
 *
 * 每一条都对着一次真实事故写，反例是当时那一行代码。
 */
const CONTROLLER = "src/renderer/src/hooks/useSessionTimelineController.ts";
// 跳转链（取页 / 揭示 / give-up 分支）2026-11-25 按「新逻辑放新模块」搬进 useTimelineJumpChain，
// 控制器只剩装配。判据读**两份拼接**：只读控制器会在搬迁后变成永远绿的空断言。
const JUMP_CHAIN = "src/renderer/src/hooks/session/timeline/useTimelineJumpChain.ts";
const read = () => readFileSync(JUMP_CHAIN, "utf8") + readFileSync(CONTROLLER, "utf8");

/** 取「以给定开头的那一行」到匹配的收尾大括号之间的整块（按 tab 缩进闭合）。 */
function block(code, opener) {
	const start = code.indexOf(opener);
	assert.notEqual(start, -1, `找不到块：${opener}`);
	const end = code.indexOf("\n\t\t}", start);
	assert.notEqual(end, -1, `块没有闭合：${opener}`);
	return code.slice(start, end);
}

test("① 落到 load-page 分支时不得再报 H1「这条在已加载内容里」", () => {
	// 事故（2026-11-25）：通知历史里 19 条「未能跳转（H1）：这条在已加载内容里」，而其中
	// 大部分来自 load-page 分支 —— 该分支的前置恰是 stillInData=false（目标**不在**已加载
	// 内容里），文案与判据相反，而且这里一条日志都不留。
	const loadPage = block(read(), 'if (action.kind === "load-page") {');
	assert.equal(loadPage.includes('"sessionFind.jumpFailed.target-not-mountable"'), false, "load-page 分支不得再报 target-not-mountable");
	// 原因由 hasMorePages 决定（2026-11-26 修正）：还有更早的页时说「已到文件头」与日志相反。
	// 选因逻辑是纯函数（jumpWindowPolicy.resolveStaleTargetReason，行为见 ⑦），这里只判接线。
	assert.equal(loadPage.includes("resolveStaleTargetReason({ hasMorePages })"), true, "原因必须由 hasMorePages 算出来");
	assert.equal(loadPage.includes('logFromRenderer("warn", "jump", "give-up"'), true, "失败必须留痕（否则通知历史里分不出来路）");
	assert.equal(loadPage.includes('route: "load-page-after-fetch"'), true, "日志要标出是哪条路，才分得清它与状态机直接 give-up");
});

test("② 取页在途要有显式标记，且状态机读它", () => {
	// 事故（2026-11-25 06:13:13）：give-up 比 merge 早 14ms —— 页取到了，提示已经弹完。
	const code = read();
	assert.equal(code.includes("jumpPageInFlightRef.current = requestId;"), true, "取页前必须绑定本次点击");
	assert.equal(code.includes("jumpPageInFlightRef.current = null;"), true, "取页结束必须复位");
	assert.equal(code.includes("pageInFlight: jumpPageInFlightRef.current === pendingJump.value.requestId"), true, "旧点击不能阻塞新点击的状态机");
});

test("③ 揭示请求必须由状态机发出（目标是折叠区里的节点时）", () => {
	const code = read();
	const reveal = block(code, 'if (action.kind === "reveal") {');
	assert.equal(reveal.includes("requestTimelineReveal(targetNodeId)"), true, "reveal 动作要请渲染层展开那一轮");
	assert.equal(reveal.includes("revealRequested: true"), true, "标记已揭示，避免每帧重复请求");
});

test("④ 盯 DOM 的那两个 hook 必须在 effect 外（不能在 effect 回调里调用 hook）", () => {
	// 反例（本轮改动自身）：把 useRef/useCallback/useEffect 写进 pendingJump 的 effect 回调里，
	// biome lint/correctness/useHookAtTopLevel 报 3 条红，React 运行时调用顺序也会错乱。
	const lines = read().split("\n");
	// 循环本体已按项目规则搬进 useJumpRowWait（新逻辑放新模块）：这里断言的是**接线形状** ——
	// 控制器顶层拿到 waitForRow，且 ref/回调都在 hook 顶层，不在任何 effect 回调里。
	const wired = lines.findIndex((line) => line.startsWith("\tconst { waitForRow: waitForJumpRow } = useJumpRowWait("));
	assert.notEqual(wired, -1, "waitForRow 必须在控制器顶层取到（1 个 tab 缩进）");
	const inEffect = lines.findIndex((line) => /^\t\t.*useRef<\(number \| null\)>\(null\);/.test(line) && line.includes("jumpRowWait"));
	assert.equal(inEffect, -1, "等待循环的 ref 不得写进 effect 回调（嵌套调用 hook）");
	const hookSrc = readFileSync("src/renderer/src/hooks/session/timeline/useJumpRowWait.ts", "utf8").split("\n");
	const ref = hookSrc.findIndex((line) => line.startsWith("\tconst frameRef = useRef<number | null>(null);"));
	const cb = hookSrc.findIndex((line) => line.startsWith("\tconst waitForRow = useCallback("));
	assert.notEqual(ref, -1, "frameRef 必须在 hook 顶层");
	assert.notEqual(cb, -1, "waitForRow 必须在 hook 顶层");
	assert.ok(cb > ref, "waitForRow 要在 frameRef 之后定义");
});

test("⑤ 盯不到目标行时不得静默收手", () => {
	// 事故：row-exhausted 只打一条 warn 就 return，用户界面没有任何结论。
	const code = read();
	const exhausted = code.slice(code.indexOf('"jump", "row-exhausted"'));
	const tail = exhausted.slice(0, 400);
	assert.equal(tail.includes("setPendingJump((previous) =>"), true, "盯不到行要把结论交回状态机（bump nonce），不能静默收手");
});

test("⑦ 页取到了仍跳不过去：原因由 hasMorePages 决定，不许硬编码", () => {
	// 反例（2026-11-26 真机日志，entryId cd9540b6，同一形状 4 次）：
	//   give-up {"reason":"no-earlier-pages","route":"load-page-after-fetch",
	//            "hasMorePages":true,"pageOutcome":"exact"}
	// 文案说「没有更早的历史页可补（已到文件头）」，而同一行日志里 hasMorePages=true。
	const { resolveStaleTargetReason } = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpWindowPolicy.ts");
	assert.equal(resolveStaleTargetReason({ hasMorePages: true }), "target-not-indexed");
	assert.equal(resolveStaleTargetReason({ hasMorePages: false }), "no-earlier-pages");
	// 文案必须跟着原因走（钉死一条 = 又回到「提示与判据相反」）。
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	assert.equal(zh.includes('"sessionFind.jumpFailed.target-not-indexed"'), true, "新原因必须有中文文案");
});

test("⑥ 取页抛错也要给结论：catch 必须留痕并把判定交回状态机", () => {
	// 事故形状：.then(...).finally(...) 没有 catch。IPC 或缓存写入抛错时既没有落位、
	// 也没有提示，pendingJump 永远挂着 —— 与「点了没反应」不可区分。
	const code = read();
	const at = code.indexOf('"jump", "page-failed"');
	assert.notEqual(at, -1, "取页失败必须留一条可读的日志");
	const tail = code.slice(at, at + 700);
	assert.equal(tail.includes("setPendingJump((previous) =>"), true, "失败要把判定交回状态机");
	// 顺序：先 bump 再复位在途标记。反过来的话，bump 触发的那次 effect 会读到 true 而再等一轮。
	assert.ok(tail.indexOf("setPendingJump((previous) =>") < tail.indexOf("jumpPageInFlightRef.current = null;"), "先 bump 再复位在途标记");
});
