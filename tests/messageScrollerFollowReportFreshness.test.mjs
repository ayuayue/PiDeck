import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scrollerSource = readFileSync("src/renderer/src/components/agents/message-scroller.tsx", "utf8");
const engineSource = readFileSync("src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts", "utf8");
const followSource = readFileSync("src/renderer/src/lib/stick-to-bottom/followState.ts", "utf8");

// ACP 会话「切走再切回消息全丢」的崩溃根因（2026-10-14）：MessageScroller 的
// onFollowChange 上报 effect 上报的是**已提交的 React 快照** isFollowing，而
// layout-effect 级联（followOutput 效应 → scrollToBottom/stopScroll → 引擎 setState）
// 中引擎的可变单例 state.isAtBottom 已经再次翻转。把过期快照写进 controller 的
// autoScroll → followOutput 反相 → followOutput 效应再翻转引擎 → 下一份反相的过期
// 上报……周期-2 振荡永不收敛，Maximum update depth exceeded 触发 AppErrorBoundary
// 整窗重载，渲染层内存消息缓存全丢。
// 修复：上报前与引擎实况对账，快照落后于实况时丢弃（引擎每次翻转都会提交新快照，
// 收敛后自然有一份新鲜上报补上；级联里被合并抵消的翻转本就无需上报）。
// 判定与翻转方向无关：relock（false→true）与 unlock（true→false）两侧共用同一守卫，
// 周期-2 的行为断言见 tests/followState.test.mjs 的「上报新鲜度守卫」用例。
test("onFollowChange report must be dropped when the committed snapshot is stale", () => {
	// 引擎实况来自稳定单例 stick.state（useMemo([])，可变字段 isAtBottom 不随提交快照走）
	assert.match(scrollerSource, /const engineLiveState = stick\.state;/);
	// 引擎必须把这个单例暴露在返回值上（消息里解构才成立）
	assert.match(engineSource, /state,\s*\n\s*\};/);
	// 纯策略判定收敛在 followState（快照 === 实况才算新鲜），组件只做接线
	assert.match(followSource, /export function isFollowSnapshotFresh\(committed: boolean, live: boolean\): boolean \{\s*\n\s*return committed === live;\s*\n\}/);
	// 上报 effect：新鲜度守卫必须先于 onFollowChange 调用
	assert.match(scrollerSource, /useEffect\(\(\) => \{\s*\n[\s\S]*?if \(!isFollowSnapshotFresh\(isFollowing, engineLiveState\.isAtBottom\)\) return;\s*\n[\s\S]*?onFollowChange\?\.\(isFollowing\);\s*\n\s*\}, \[isFollowing, onFollowChange, engineLiveState\]\);/);
	// 禁止无守卫的裸上报（旧实现回归哨兵）
	assert.doesNotMatch(scrollerSource, /onFollowChange\?\.\(isFollowing\);\s*\n\s*\}, \[isFollowing, onFollowChange\]\);/);
});
