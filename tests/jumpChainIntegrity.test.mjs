import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// 跳转链 2026-11-25 按「新逻辑放新模块」搬进 useTimelineJumpChain，控制器只剩装配。
// 读控制器的判据一律拼上那份新文件：只读控制器会在搬迁后变成永远绿的空断言。
const JUMP_CHAIN = "src/renderer/src/hooks/session/timeline/useTimelineJumpChain.ts";
const CONTROLLER = "src/renderer/src/hooks/useSessionTimelineController.ts";
const read = (p) => readFileSync(p, "utf8") + (p === CONTROLLER ? readFileSync(JUMP_CHAIN, "utf8") : "");
const stripComments = (text) =>
	text
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join("\n");

const PAGING = "src/renderer/src/hooks/session/timeline/useTimelineHistoryPaging.ts";
const TIMELINE = "src/renderer/src/components/session/SessionMessageTimeline.tsx";
const JUMP = "src/renderer/src/hooks/session/timeline/useTimelineJumpNavigation.ts";

test("① 补页 loading 由在飞计数推出，复位不走 sequence 守卫", () => {
	const code = stripComments(read(PAGING));
	assert.equal(code.includes("setIsLoadingMessagePage(pendingPageLoadsRef.current > 0)"), true);
	assert.equal(code.includes("getLatestLoad(sessionId) === sequence) setIsLoadingMessagePage(false)"), false);
});

test("② 时间线窗口走 makeWindow 唯一构造器", () => {
	const code = read(TIMELINE);
	assert.equal(code.includes("resolveAnchoredTurnWindow("), true, "窗口走锚点入口");
	assert.equal(code.includes("windowAnchorId"), true);
	assert.equal(code.includes("selectTimelineTurnWindow("), false, "不得再走旧入口");
});

test("③ 跳转一开始就把目标写进浏览钉", () => {
	const code = stripComments(read(JUMP));
	assert.equal(code.includes("browsePinRef.current = { messageId: targetNodeId, expectedViewportTop: 0 }"), true);
});

test("④ jumpPending 只报活跃跳转", () => {
	assert.equal(read(CONTROLLER).includes("jumpPending: pendingJump !== undefined && loadMoreError === null"), true);
});

test("⑤ 跳转不再触发整表实心渲染", () => {
	const code = stripComments(read(CONTROLLER));
	const m = code.match(/navBlockingVirtualization:\s*([^,]+),/);
	assert.ok(m, "必须有 navBlockingVirtualization");
	assert.equal(m[1].includes("pendingJump"), false, "跳转在途不得整表渲染");
});

test("⑥ 目标缺失时不得静默 return", () => {
	const code = stripComments(read(JUMP));
	assert.equal(code.includes("if (index < 0 && !hasMorePages && !shouldDeferJumpUntilLoaded"), false);
	assert.equal(code.includes("setPendingJump({"), true);
});

test("⑦ 补页完成后必须把锚点写到目标轮上", () => {
	assert.equal(stripComments(read(CONTROLLER)).includes("if (stillInData) setJumpAnchorMessageId(targetNodeId);"), true);
});

test("⑧ 跳转入口返回具名结果（六个调用方不必靠界面猜）", () => {
	const code = stripComments(read(JUMP));
	assert.equal(code.includes("=> JumpStartResult"), true, "jumpToMessage 必须返回具名结果");
	assert.equal(code.includes('"skipped-no-timeline"'), true);
	assert.equal(code.includes('"skipped-owner"'), true);
	assert.equal(code.includes('"pending-unresolved"'), true, "挂起也要如实说，不能假装 started");
	assert.equal(code.includes('"started"'), true);
});

test("⑨ 点回底按钮必须无条件清锚点（不能有条件挡着）", () => {
	const code = stripComments(read(CONTROLLER));
	// 2026-11 真机：「回底按钮不是回到最底部」。回底只滚不清锚点时，窗口仍钉在
	// 目标轮，滚到底看到的还是旧切片 —— 而且 shouldResetExpandBudget 在 pendingJump
	// 残留时会拒绝重置，所以清理必须放在回底入口里，不能指望那个条件判断。
	assert.equal(code.includes("const scrollToBottomReset = useCallback"), true, "必须有回底重置入口");
	assert.equal(code.includes("setJumpAnchorMessageId(null)"), true, "必须清锚点");
	assert.equal(code.includes("scrollToBottom: scrollToBottomReset"), true, "按钮必须指向重置入口");
});

test("⑩ 取页成功后必须立刻设锚点（否则要点 2~3 次）", () => {
	const code = stripComments(read(CONTROLLER));
	const then = code.slice(code.indexOf("loadPageAroundEntry(wanted, isCurrent)"));
	const block = then.slice(0, 1200);
	assert.equal(block.includes("setJumpAnchorMessageId(anchorEntryId)"), true, "取页成功后必须立刻设锚点");
	assert.equal(block.includes("isCurrent()"), true, "迟到的取页结果必须先确认仍属于本次点击");
	assert.equal(block.includes("setJumpAnchorMessageId(pendingJump.value.messageId)"), false, "不得直接用原始 id 当锚点");
});

test("⑪ 锚点匹配要认 meta.entryId（查找面板给的是文件条目 id，不是投影 id）", () => {
	const code = read("src/renderer/src/components/session/timeline/turnRenderWindow.ts");
	assert.equal(code.includes("matchesJumpMessage("), true, "必须走共享身份判定（含 meta.entryId 与投影前缀）");
});

test("⑫ 非活动分支的目标按 offset 定位，不能把文件序号当活动下标", () => {
	const reader = read("src/main/pi/SessionHistoryReader.ts");
	const resolve = reader.slice(reader.indexOf("async resolveEntryPosition"));
	const body = resolve.slice(0, 1400);
	// 文件序号（上万）与活动分支下标（几百）是两个空间。旧实现 Math.min(ordinal, len)
	// 会把中间的目标全夹到末尾 —— 表现是「第一页和最后一页能跳，中间全跳不了」。
	assert.equal(body.includes("index.entries.get(entryId)"), true, "必须从全量条目拿目标");
	assert.equal(body.includes("pickAnchorOrdinal("), true, "必须用字节偏移锚");
	assert.equal(body.includes("Math.min(ordinal"), false, "不得再用文件序号夹取");
});

test("⑬ 页内不含目标时，必须把目标条目单独读出来插进页里", () => {
	const ipc = read("src/main/ipc/sessionMessageReadIpc.ts");
	const from = ipc.indexOf("readSessionDisplayJumpPage(filePath, sessionId, rawEntryId,");
	const block = ipc.slice(from, ipc.indexOf("\n\t});", from) + 4);
	assert.equal(block.includes("pageHasTargetEntry("), true, "必须判断页里是否含目标");
	assert.equal(block.includes("readEntryDisplayMessage"), true, "必须能单条读");
	// 2026-11-26 改判：按**文件序号**插回原位，不按 timestamp（同一轮里会倒退 25 秒）。
	assert.equal(block.includes("insertByOrdinal("), true, "必须按文件序号插回原位");
	assert.equal(block.includes("insertByTimestamp("), false, "不得再按时间插（时间会倒退）");
	const reader = read("src/main/pi/SessionHistoryReader.ts");
	assert.equal(reader.includes("async readEntryDisplayMessage("), true, "reader 必须提供单条投影");
	assert.equal(reader.includes("index.entries.get(entryId)"), true, "单条读取要能命中非活动分支条目");
});

test("⑯ 锚点未命中时窗口必须有界：不得返回全量（722 轮全挂进 DOM 会卡死）", () => {
	const src = read("src/renderer/src/components/session/timeline/turnRenderWindow.ts");
	const sharedSrc = read("src/shared/sessionJumpAnchor.ts");
	const start = src.indexOf("export function resolveAnchoredTurnWindow");
	const fn = src.slice(start, src.indexOf("\n}\n", start));
	// 反例（真发生过，2026-11 真机）:锚点匹配不上就 `return items as T[]`，
	// 722 轮整份会话一次挂进 DOM —— 切换会话、滚动全部卡死。
	const anchorBlock = fn.slice(fn.indexOf("if (pinnedMessageId) {"), fn.indexOf("if (!shouldWindowTimelineTurns"));
	assert.equal(anchorBlock.includes("return items as T[]"), false, "锚点分支不得返回全量");
	assert.equal(/return sliceLastAgentRuns\(items, windowTurns\);/.test(fn), true, "最终出口必须是有界尾部窗口");
});
test("⑭ 锚点匹配必须认平铺 ChatMessage 的 meta.entryId（三种形状都要）", () => {
	const src = read("src/renderer/src/components/session/timeline/turnRenderWindow.ts");
	const sharedSrc = read("src/shared/sessionJumpAnchor.ts");
	const fn = src.slice(src.indexOf("function childMatchesId"), src.indexOf("export function findAgentRunIndexByItemId"));
	// 平铺形状 { id, meta.entryId }：以前只查 record.id 与 record.message.meta.entryId，
	// 平铺的 meta 在顶层，直接读不到 —— 表现就是「中间条目锚点找不到、窗口不切」。
	assert.equal(fn.includes("matchesJumpMessage({ id: record.id, meta: record.meta }"), true, "平铺形状必须走共享身份判定（含 meta.entryId）");
	assert.equal(fn.includes("matchesJumpMessage({ id: message.id, meta: message.meta }"), true, "包一层形状必须走同一判定");
	assert.equal(sharedSrc.includes("message.id === targetId"), true, "精确 id 命中必须优先于键归一");
});

test("⑮ 跳转失败提示必须报本次取页结果，不得报 loadMore 的残留值", () => {
	const src = read("src/renderer/src/hooks/useSessionTimelineController.ts");
	// 反例（真发生过）：提示里显示 [committed]，那是 loadMoreMessages 的上次结果，
	// 跳转根本不走那条路 —— 屏幕上写着「补页成功」，人却停在原处。
	assert.equal(src.includes("const jumpOutcome = readLastJumpOutcome();"), true, "必须取本次跳转结果");
	assert.equal(src.includes("page=${jumpOutcome}"), true, "诊断里必须带取页结果");
	assert.equal(src.includes("readLastPrependResult() ?"), false, "失败提示不得再显示残留的 prepend 结果");
	const paging = read("src/renderer/src/hooks/session/timeline/useTimelineHistoryPaging.ts");
	assert.equal(paging.includes("lastJumpOutcomeRef.current = outcome"), true, "取页结果必须当场记录");
});

test("⑱ 整页全是卡片时不硬跳：anchorEntryId 必须为空，交由 tick 报可诊断的失败", () => {
	const paging = read("src/renderer/src/hooks/session/timeline/useTimelineHistoryPaging.ts");
	const ctrl = read("src/renderer/src/hooks/useSessionTimelineController.ts");
	// 反例（设计选择，不是缺陷）：一页里一条 history 消息都没有时（整页 custom 卡片），
	// 没有能命中的锚点可用。这时必须让 anchorEntryId 为空、不设锚点、
	// 由状态机给出 target-not-mountable —— 而不是硬跳到页尾把用户放错地方。
	//
	// 行为级样本在 tests/jumpAnchorPick.test.mjs（直接喂四种页给纯函数）。
	// 这里只钉「接线还在」：抽成纯函数之前，这条用源码正则断言，
	// 重构一次就假红（2026-11-24 实际发生过：把内联改成调 pure function，行为未变、正则红）。
	assert.equal(paging.includes("pickJumpAnchorEntryId(page.messages, entryId)"), true, "锚点必须由纯函数挑");
	// 空列表时 at(-1) 是 undefined，调用方必须挡住，不能把 undefined 传下去。
	assert.equal(ctrl.includes("if (anchorEntryId) setJumpAnchorMessageId(anchorEntryId)"), true, "空锚点不得写入");
	// 落空要给可诊断的失败：原因由状态机给（action.reason），controller 只负责翻译成文案。
	// 硬编码某一个原因就等于把「哪条路走到这里」抹掉 —— 2026-11-25 的 load-page 分支正是这样
	// 把 target-not-mountable 报给了 stillInData=false 的情形（判据见 tests/jumpRouteHonesty.test.mjs）。
	assert.equal(ctrl.includes("sessionFind.jumpFailed.${action.reason}"), true, "落空要给可诊断的失败");
});

// 2026-11-25：同一条「页比窗口晚」的逆序病有两个入口，必须收口到一个拼接函数。
//
// 反例（真机）：点刻度 → loadPageAroundEntry 取回目标附近的一页（它可能整体晚于当前窗口）
// → 旧实现 `[...page.messages.filter(未见过), ...visibleMessages]` 只滤重叠、不校顺序
// → 时间线顶部出现最新一条，下面才是更早的消息。用户原话：「我的条目，怎么直接错乱了」。
const PagingModule = "src/renderer/src/hooks/session/timeline/useTimelineHistoryPaging.ts";

test("⑰ 一次取页的拼接必须走 mergeHistoryAndWindow（不得再手写 filter + 前置）", () => {
	const src = read(PagingModule);
	const from = src.indexOf("async (entryId: string, isCurrent");
	assert.equal(from >= 0, true, "loadPageAroundEntry 的签名变了，先同步这条用例");
	const block = src.slice(from, src.indexOf("\n\t\t\t},\n", from));
	// 拼接与去重收口到 atom 事务（session-jump-page-atoms），分页钩子只负责取页与提交。
	assert.equal(block.includes("commitJumpPage("), true, "跳转页必须经统一事务提交");
	assert.equal(block.includes("cacheMessages("), false, "不得再用 force 覆盖整份实时缓存");
	const atoms = read("src/renderer/src/atoms/session-jump-page-atoms.ts");
	assert.equal(atoms.includes("mergeInterleavedHistory("), true, "必须复用交错拼接（去重 + 顺序校正一处定义）");
});

test("⑰b 两条拼接入口都必须真的调用它（配好了 != 生效了）", () => {
	const controller = read("src/renderer/src/hooks/useSessionTimelineController.ts");
	assert.equal(controller.includes("mergeHistoryAndWindow(runtimeHistory.messages, messages)"), true, "首屏历史 + 运行时窗口这条入口没接线");
});
/**
 * 真机（2026-11-26 14:40 与 16:05）：跳过去目标卡片在、下面空白；点最后三条则整片会话消失。
 *
 * 两次都不是「差几条」而是右边界取错：目标下标 + 1 是排他右边界，页的右端就是目标，
 * 于是长工具回合的最终回复被截在页外；补固定 24 条工具又会在长回合里补不够。
 * 判据：右边界按完整回合算（resolveJumpPageBefore），过页大小按回合数给。
 */
test("⑲ 取页右边界必须到目标回合结束，过页大小按回合给", () => {
	const domain = read("src/main/pi/sessionReader/sessionDisplayPaging.ts");
	assert.equal(domain.includes("resolveJumpPageBefore("), true, "完整回合边界属于分页领域");
	assert.equal(domain.includes("index.activeMessageEntries"), true, "只在活动分支坐标内取页");
	assert.equal(domain.includes("this.host.maxPageWindowEntries"), true, "跳转仍遵守条目预算");
});
