import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const W = compile("src/renderer/src/components/session/timeline/jumpTargetWait.ts");
const plan = W.planJumpTargetWait;
const sel = W.jumpTargetSelector;
const pick = W.jumpWaitSelector;
const shouldExpand = W.shouldExpandWhileWaiting;
const MAX = W.JUMP_TARGET_WAIT_FRAMES;
const EXPAND_MAX = W.JUMP_WAIT_EXPAND_MAX_ATTEMPTS;
const EXPAND_EVERY = W.JUMP_WAIT_EXPAND_EVERY_FRAMES;

/**
 * 取页之后的「等目标挂上 DOM」判据。
 *
 * 反例（2026-11-25 日志，点 b6a20c25）：
 *   06.1228 entry foundIndex=-1     → 目标不在已加载数据里
 *   06.1308 merge pageHasTarget=true cacheWrite=true   → 取页成功、写进缓存
 *   06.1309 page  outcome=exact
 *   ── 此后 1.17 秒没有任何 tick / settle ──
 *   07.3032 entry foundIndex=56     ← 用户又点了一次才发现数据到了
 * 表现就是「要点好几次」。旧实现把继续落位全押在 pendingJump effect 重跑上，
 * 而它依赖 combinedMessages 的快照，错位时根本不重跑。
 */

test("认不出目标（不在数据里）时 8 帧就交回，不干等满 120 帧", () => {
	// 反例（2026-11-26 真机日志，entryId cd9540b6）：
	//   give-up route=load-page-after-fetch hasMorePages=true pageOutcome=exact
	//   row-exhausted frames=120                        ← 干等 2 秒
	// 补页与扩窗都帮不上「认不出」这一种：目标根本不在数据里，等满 120 帧只是把
	// 「认不出」拖成 2 秒空白。8 帧（约 130ms）足够虚拟列表挂行，之后就交回状态机。
	assert.equal(W.JUMP_TARGET_WAIT_UNINDEXED_FRAMES, 8);
	assert.equal(plan({ found: false, frames: 0, inData: false }).kind, "wait", "第 0 帧仍给挂行机会");
	assert.equal(plan({ found: false, frames: 7, inData: false }).kind, "wait", "宽限内继续等");
	assert.equal(plan({ found: false, frames: 8, inData: false }).kind, "exhausted", "8 帧后交回状态机");
	// 认得出（在数据里、只是不在渲染窗口）仍按原上限等：扩窗需要时间，早交回会误报。
	assert.equal(plan({ found: false, frames: 8, inData: true }).kind, "wait");
	assert.equal(plan({ found: false, frames: MAX, inData: true }).kind, "exhausted");
	// 老调用不传 inData：行为不变（按 120 帧）。
	assert.equal(plan({ found: false, frames: 8 }).kind, "wait");
	assert.equal(plan({ found: false, frames: MAX }).kind, "exhausted");
	// 命中优先于一切：最后一帧挂上仍算成功。
	assert.equal(plan({ found: true, frames: MAX, inData: false }).kind, "found");
});
test("选择器按 entryId 后缀匹配投影 id（agentId 在前端不可知）", () => {
	assert.equal(sel("b6a20c25"), '[data-message-id$="-history-b6a20c25"]');
	assert.ok(sel("abc").includes("abc"));
});

test("目标一出现立刻算命中，不等满帧", () => {
	assert.equal(plan({ found: true, frames: 0 }).kind, "found");
	assert.equal(plan({ found: true, frames: 7 }).kind, "found");
});

test("还没出现就等，不是失败", () => {
	assert.equal(plan({ found: false, frames: 0 }).kind, "wait");
	assert.equal(plan({ found: false, frames: MAX - 1 }).kind, "wait");
});

test("最后一帧恰好挂上必须算成功（差一帧不能变成又一次「没反应」）", () => {
	assert.equal(plan({ found: true, frames: MAX }).kind, "found", "命中判断必须排在帧数上限之前");
});

test("帧数用尽才交回失败，不做无限 rAF", () => {
	assert.equal(plan({ found: false, frames: MAX }).kind, "exhausted");
	assert.ok(MAX >= 60 && MAX <= 240, "上限应是 1-4 秒量级，实际 " + MAX);
});

/**
 * 归一之后必须用精确 id 查。
 * 反例：只留后缀选择器 —— 同一 entryId 出现在两个 agent 前缀下（主代理 + 子代理）时
 * querySelector 命中的可能是另一条，落位落到别人的行上（用户原话「表现为定位错误」）。
 */
test("能归一就用精确 id，不再后缀撞库", () => {
	assert.equal(pick({ entryId: "abc", resolvedId: "agent1-history-abc" }), '[data-message-id="agent1-history-abc"]');
	assert.equal(pick({ entryId: "abc", resolvedId: null }), sel("abc"), "归一不了才退回后缀");
	assert.equal(pick({ entryId: "abc" }), sel("abc"), "缺字段同样退化到后缀，不能抛");
});

test("精确 id 里的引号要转义（否则选择器语法错误，异常吞掉就变成「查不到」）", () => {
	const out = pick({ entryId: "x", resolvedId: 'a"b' });
	assert.equal(out, '[data-message-id="a\\"b"]');
	assert.doesNotThrow(() => new Function("return document") && out.length);
});

/**
 * 等待期间要不要扩窗。
 * 反例：目标还在没取到的历史页里（inData=false）却扩窗 —— 白挂几百轮，界面卡顿，
 * 而且目标根本不可能因此出现。
 */
test("数据里没有目标：不扩窗，等取页", () => {
	for (const frames of [0, 8, 16, 80]) {
		assert.equal(shouldExpand({ frames, attempts: 0, inData: false }), false, "frames=" + frames);
	}
});

test("数据里有目标但没挂出来：按节拍扩窗，且首发不扩", () => {
	assert.equal(shouldExpand({ frames: 0, attempts: 0, inData: true }), false, "第 0 帧不扩（虚拟列表还没提交）");
	assert.equal(shouldExpand({ frames: 1, attempts: 0, inData: true }), false);
	assert.equal(shouldExpand({ frames: EXPAND_EVERY, attempts: 0, inData: true }), true);
	assert.equal(shouldExpand({ frames: EXPAND_EVERY * 2, attempts: 1, inData: true }), true);
});

test("扩窗次数有界：不能靠扩窗把一个挂不出来的行等出来", () => {
	assert.equal(shouldExpand({ frames: EXPAND_EVERY * 10, attempts: EXPAND_MAX, inData: true }), false);
	assert.equal(shouldExpand({ frames: EXPAND_EVERY * 10, attempts: EXPAND_MAX + 5, inData: true }), false);
	assert.ok(EXPAND_MAX >= 1 && EXPAND_MAX <= 8, "上界应是几次量级，实际 " + EXPAND_MAX);
});

test("调用点确实在取页成功后启动了这个循环（源码契约）", () => {
	// 循环本体已按项目规则（新逻辑放新模块）搬到 useJumpRowWait：这里两处都要看，
	// 否则搬迁后断言仍然绿、而接线断掉（假绿）。
	const ctl = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
	const chain = readFileSync("src/renderer/src/hooks/session/timeline/useTimelineJumpChain.ts", "utf8");
	assert.match(chain, /waitForJumpRow\(timeline,/, "取页 then 分支必须启动等待");
	assert.match(ctl, /useJumpRowWait\(\{/, "循环必须由 hook 提供（在控制器装配）");
	const hookSrc = readFileSync("src/renderer/src/hooks/session/timeline/useJumpRowWait.ts", "utf8");
	assert.match(hookSrc, /planJumpTargetWait\(\{ found: Boolean\(row\), frames, inData \}\)/, "循环必须用纯函数判定，并把 inData 传进去（认不出与挂不出来要分开）");
	assert.match(hookSrc, /cancelAnimationFrame\(frameRef\.current\)/, "新跳转必须先取消上一段循环");
	assert.match(hookSrc, /messagesRef\.current/, "必须读最新消息表，不能用发起时的快照");
	assert.match(hookSrc, /if \(!row && resolvedId !== null\) \{\s*resolvedCache = null;/, "缓存失效时必须重扫（否则补页后永远查不到）");
	assert.match(hookSrc, /shouldExpandWhileWaiting\(\{ frames, attempts: expandAttempts, inData \}\)/, "等待期间必须能推进渲染窗口（且以认得出为前提）");
});

/**
 * 上游：目标还没进数据时必须清掉上一次跳转的锚点。
 * 反例：连着点两个相隔很远的刻度 —— 第二次的窗口仍锚在第一次的目标上，
 * 取页把新目标带进来后窗口按旧锚选轮，目标轮挂不出来，只能再点一次。
 */
test("跳转开始就清掉上一次的窗口锚点（目标不在数据里时）", () => {
	const nav = readFileSync("src/renderer/src/hooks/session/timeline/useTimelineJumpNavigation.ts", "utf8");
	assert.match(nav, /\} else \{\s*\/\/[^\n]*\n[^}]*setJumpAnchorMessageId\(null\)/, "index<0 分支必须清锚");
});

test("批次卡住要留痕：等扩窗超过 1.2 秒打一条可读告警", () => {
	const src = readFileSync("src/renderer/src/hooks/session/timeline/useTimelineJumpChain.ts", "utf8");
	assert.match(src, /"jump", "expand-stall"/, "被挂起时必须可观测");
});
