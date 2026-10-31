import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归护栏：「加载更多对话」按钮出现但点了没反应（2026-10 现场）。
 *
 * 现场证据（app-2026-10-31.log，同一 agent 连续 6 次命中，间隔 300ms，字段逐字相同）：
 *   {"start":0,"pos":1,"pageCount":1,"nextBeforeEntryId":"734fb2ee","nextBefore":990}
 * 缓存页永远只有 1 条、锚点永远是同一个 entryId —— 续页原地踏步。
 *
 * 根因：窗口首条是压缩摘要卡片（无 entryId），锚点回退写成「跳到整个 list 里找第一条
 * 带 entryId 的消息」，而 list[pos] 正是请求锚点自身，于是 nextBefore 恒等于上一页的值。
 * 正确边界：回退只能在 page **之前**（[0, start) 区间）倒序取最近的条目；一个都没有就
 * 返回 null，把续页交回文件路径（关掉 runtime 时能翻到底，说明文件路径本身是好的）。
 */
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");

/** 截取 tryReadRuntimeTurnPage 里的锚点选择段，避免整文件匹配误伤别的分支。 */
function anchorBlock() {
	const begin = agentManager.indexOf("const pickAnchorEntryId = (items: typeof list)");
	assert.ok(begin > 0, "锚点选择的 pickAnchorEntryId 必须存在（窗口首条无 entryId 时前进）");
	const end = agentManager.indexOf("const nextBefore = oldestEntryId", begin);
	assert.ok(end > begin, "锚点选择段后面必须紧跟 nextBefore 换算");
	return agentManager.slice(begin, end);
}

test("page 内扫描拿到前进锚点（窗口首条是摘要卡片时按钮仍能推进）", () => {
	const block = anchorBlock();
	assert.match(block, /const oldestEntryId = pickAnchorEntryId\(page\)/);
});

test("回退锚点只允许在 page 之前的区间里倒序取，不得回退到整个 list", () => {
	const block = anchorBlock();
	assert.doesNotMatch(block, /pickAnchorEntryId\(list\)/, "回退到整个 list 会让 nextBefore 原地踏步");
	assert.match(block, /pickAnchorEntryIdBefore\(start\)/, "回退必须限定在 [0, start) 区间");
	const picker = block.match(/const pickAnchorEntryIdBefore = \(end: number\)[\s\S]*?\n\t\t\};/)?.[0] ?? "";
	assert.ok(picker, "pickAnchorEntryIdBefore 必须存在");
	assert.match(picker, /for \(let i = end - 1; i >= 0; i -= 1\)/, "必须从 end-1 倒序扫描");
});

test("缓存里没有更早锚点时返回 null，交给文件路径继续翻", () => {
	const block = anchorBlock();
	assert.match(block, /if \(!oldestEntryId\) return null;/, "缺锚点必须交回文件路径，不能用空锚点静默收尾");
});
