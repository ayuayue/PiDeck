// 回归：RPC 日志面板「自动滚动」开关关掉后仍然不停追底。
//
// 根因有两处，缺一不可：
// 1) MessageScroller 的 followOutput 布局 effect 原来只处理 true（追底），false 直接 return，
//    从不解除 stick-to-bottom 引擎的锁底。是否追底由引擎内部 state.isAtBottom 决定，它不读这个
//    prop —— 于是「脱离锁底」只会发生在用户上滚那一刻，停在底部时关掉开关毫无效果。
// 2) 引擎在用户（或程序）滚到底时会 relock，日志持续追加又把视口按回底部，等于开关被悄悄打开。
//    面板按开关状态补一次 stopScroll，让跟随只由用户点开关 / 点回底按钮决定。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scroller = readFileSync("src/renderer/src/components/agents/message-scroller.tsx", "utf8");
const panel = readFileSync("src/renderer/src/components/workspace/RpcLogPanel.tsx", "utf8");

test("followOutput=false 主动解锁锁底，而不是什么都不做", () => {
	// false 分支必须调用引擎 stopScroll（幂等：时间线 controller 自己也调）。
	// React #185 修复后改为沿触发（previousFollowOutputRef 快照），仅 true→false 沿执行一次；
	// 引擎侧 stopScroll/restoreAt 也已加 needsBottomUnlock 幂等守卫。
	assert.match(scroller, /const previousFollowOutput = previousFollowOutputRef\.current;/);
	assert.match(scroller, /if \(!followOutput\) \{\s*if \(isFollowEscapeEdge\(previousFollowOutput, followOutput\)\) engineStopScroll\(\);\s*return;/);
	// stopScroll 必须进 effect 依赖，否则闭包里拿到的是旧引用
	assert.match(scroller, /\}, \[followOutput, followThreshold, reduce, engineScrollToBottom, engineStopScroll\]\);/);
});

test("面板在自动滚动关闭时对抗引擎 relock", () => {
	assert.match(panel, /if \(!autoScroll && following\) scrollApiRef\.current\?\.stopScroll\(\);/);
	// 依赖必须同时含开关与跟随状态：只跟 autoScroll 的话，relock 发生在后就不补解锁了
	assert.match(panel, /\}, \[autoScroll, following\]\);/);
});
