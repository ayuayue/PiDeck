import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 扩展列表滚动位置契约（用户反馈「停用任意一项后列表重新加载，滚动位置回到初始位置，
// 每次都要从头滚回上次那个区间」）：
//
// 滚动容器是 .config-content（overflow-y:auto，见 styles/surfaces.css）。停用/启用扩展会走
// props.onRefresh() → ConfigModal.refreshExtensions(true)，把 extensionsLoading 置为 true。
// 若此时用 loading 占位整体替换 <Table>，内容高度骤缩，浏览器立刻把 scrollTop 夹到 0；
// 被聚焦的启停按钮也随所在行卸载而失焦。这与 ModelsTab 的已知问题同源——见 ConfigModal
// loadConfig 的 silent 注释：「避免 ModelsTab 在 `!loading && ...` 条件下被卸载重建、
// 滚动容器内容塔缩后 scrollTop 归零」。
//
// 修法：只有「正在加载且当前没有任何可见行」时才显示加载占位；已有数据时刷新期间沿用旧表格，
// 行高与 key 都不变，视口和焦点自然保留。本测试把该判据锁死，防止有人改回 `props.loading ?`。

const tab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");

test("extension list keeps the table mounted while refreshing so scrollTop and focus survive", () => {
	// 加载占位必须同时要求「正在加载」与「当前没有任何可见行」（正则空白容忍）
	assert.match(tab, /props\.loading\s*&&\s*visibleExtensions\.length\s*===\s*0\s*\?/, "loading placeholder must be gated on an empty list, otherwise refresh unmounts the table and resets scrollTop");
	// 反例守卫：单独的 `{props.loading ? (` 分支会重新引入「刷新卸载表格」的回归
	assert.doesNotMatch(tab, /\{\s*props\.loading\s*\?\s*\(/, "found a bare `props.loading ?` branch — refresh would unmount the table and reset the viewport again");
});

test("the refresh-vs-unmount rationale stays documented beside the list body", () => {
	assert.match(tab, /scrollTop/, "the scrollTop clamp rationale must stay documented next to the list body");
});
