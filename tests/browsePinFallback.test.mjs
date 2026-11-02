import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const browsePin = load("src/renderer/src/hooks/timeline/browsePin.ts");
const controllerSource = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");

test("不在扩窗在途时不做高度差兜底", () => {
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: false, previousHeight: 100, nextHeight: 300, viewportHeight: 800 }), null);
});

test("没有高度基准时不补（首帧 previousHeight=0）", () => {
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 0, nextHeight: 300, viewportHeight: 800 }), null);
});

test("高度变矮不补（负增量补了反而跳）", () => {
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 300, nextHeight: 100, viewportHeight: 800 }), null);
});

test("增量超过半屏不补：那是内容自己长高，不是顶部插入", () => {
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 100, nextHeight: 900, viewportHeight: 800 }), null);
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 100, nextHeight: 501, viewportHeight: 800 }), null);
});

test("扩窗在途且增量在合理范围内才补，补的量就是增量", () => {
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 100, nextHeight: 350, viewportHeight: 800 }), 250);
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 100, nextHeight: 500, viewportHeight: 800 }), 400);
});

test("兜底分支必须在 shouldCompensateBrowsePin 之前，否则是不可达的死代码", () => {
	// shouldCompensateBrowsePin 在 currentViewportTop === null 时返回 false
	//（browsePin.ts 里明写），所以任何放在它后面的 null 分支都执行不到。
	// 这条判据用源码位置比对，抓的正是「分支写了但从没执行」。
	const body = controllerSource.slice(controllerSource.indexOf("const pinBrowseRow = useCallback("));
	const nullBranch = body.indexOf("if (currentTop === null) {");
	const gate = body.indexOf("shouldCompensateBrowsePin({");
	assert.ok(nullBranch > 0, "找不到 null 兜底分支");
	assert.ok(gate > 0, "找不到 shouldCompensateBrowsePin 调用");
	assert.ok(nullBranch < gate, "null 兜底分支排在 shouldCompensate 之后，永远执行不到");
});

test("高度基准的更新点必须覆盖所有出口", () => {
	const body = controllerSource.slice(controllerSource.indexOf("const pinBrowseRow = useCallback("));
	const updates = body.match(/pinFallbackHeightRef\.current = nextHeight;/g) ?? [];
	assert.ok(updates.length >= 2, "至少要在 null 分支和正常路径各更新一次，否则基准会停在很早的值");
});

test("扩窗插入标记必须在函数最前面消费：任何出口都算结算了这一帧", () => {
	// 标记由 consumeExpandBatch 每帧置 true（只要有 pending），所以「读时清」不会永久丢信号。
	// 清在某几条分支里是不够的：正常路径（扩窗帧最常见）和 skip/autoScroll 提前 return
	// 都会把 true 留到下一帧；那一帧若因 Markdown 异步长高把钉行挤出虚拟区，
	// 就会把「内容自己长高」误判成「正在扩窗插入」并补一次 —— 视口被推走。
	const body = controllerSource.slice(controllerSource.indexOf("const pinBrowseRow = useCallback("));
	const readAt = body.indexOf("const expanding = expandInsertedRef.current;");
	const clearAt = body.indexOf("expandInsertedRef.current = false;");
	const skipGuardAt = body.indexOf("skipBrowsePinRef.current || autoScrollRef.current");
	const pinGuardAt = body.indexOf("if (!pin || !timeline) return;");
	const measureAt = body.indexOf("measurePinnedRowTop(timeline, pin.messageId)");
	assert.ok(readAt > 0, "找不到消费式读取");
	assert.ok(clearAt > 0, "找不到清除");
	assert.ok(skipGuardAt > 0, "找不到 skip/autoScroll 守卫");
	assert.ok(readAt < skipGuardAt, "读取必须排在 skip/autoScroll 之前，否则那条出口会把 true 留到下一帧");
	assert.ok(readAt < clearAt, "必须先读后清");
	assert.ok(clearAt < pinGuardAt, "清除必须排在 pin/timeline 守卫之前");
	assert.ok(clearAt < measureAt, "清除必须在所有下游出口之前");
	const assignments = body.match(/expandInsertedRef\.current = false;/g) ?? [];
	assert.equal(assignments.length, 1, "清除点只能有一处，散在多处必然有出口漏掉");
});

test("置位与清除之间不会让 true 存活超过一帧", () => {
	// consumeExpandBatch 每帧置 true（有 pending 时），pinBrowseRow 入口无条件清。
	// 两条串起来读：置位在 consumeExpandBatch 内、清除在 pinBrowseRow 入口，
	// 中间没有「只在某分支清」的旧形状 —— 这就是「true 不跨帧」的判据。
	const consumeAt = controllerSource.indexOf("const consumeExpandBatch = useCallback(");
	const consumeBody = controllerSource.slice(consumeAt, controllerSource.indexOf("}, []);", consumeAt));
	assert.match(consumeBody, /expandInsertedRef\.current = true;/, "consumeExpandBatch 每帧必须重新置位");
	assert.match(consumeBody, /setScrolledWindowTurns/, "置位必须与那次 setScrolledWindowTurns 同帧");
});
