import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const M = loadTsCommonJs("src/renderer/src/components/session/timeline/outlineRailTicks.ts");
const merge = M.mergeOutlineRailItems;

const directory = [{ entryId: "7a92d169", title: "继续，我重启了，看看有无东西遗漏。", time: "22:01" }];

/**
 * live 消息没有 meta.entryId 时，id 是 requestId，与目录 entryId 不相等。
 *
 * 反例（2026-11-25 真机）：面板里 61 / 62 两条一模一样的「继续，我重启了…」；
 * 点第二条时 foundIndex=-1（requestId 不在数据里）→ 走取页 → 全文结构乱。
 * 旧实现按 `item.entryId ?? item.id` 比对，requestId 永不命中 usedEntryIds，于是重复追加。
 */
test("live 项没有 entryId 且目录已有同一轮：不再追加第二条", () => {
	const loaded = [{ id: "07e649d7-4b75-42fd-841e-0af4a6abe61f", role: "user", title: "继续，我重启了，看看有无东西遗漏。", time: "22:01" }];
	const merged = merge(loaded, directory);
	assert.equal(merged.length, 1, "同一轮只能有一条刻度，实际 " + merged.length);
	assert.equal(merged[0].entryId, "7a92d169", "保留的必须是目录那条（它的 id 才跳得动）");
});

test("目录里没有这一轮：live 项照旧保留（索引还没更新的新提问）", () => {
	const loaded = [{ id: "07e649d7-0000-0000-0000-000000000000", role: "user", title: "刚发出的新提问", time: "22:30" }];
	const merged = merge(loaded, directory);
	assert.equal(merged.length, 2, "目录 1 条 + 新提问 1 条");
	assert.equal(merged[1].id, "07e649d7-0000-0000-0000-000000000000");
});

test("live 项带 entryId 且目录已包含：仍按 entryId 去重（原行为不变）", () => {
	const loaded = [{ id: "agent-history-7a92d169", entryId: "7a92d169", role: "user", title: "继续，我重启了，看看有无东西遗漏。", time: "22:01" }];
	const merged = merge(loaded, directory);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].id, "agent-history-7a92d169", "已加载项带投影 id 时沿用它（能命中 DOM）");
});

test("标题相同但时间不同：不是同一轮，不能合并（用户可能真的问两次）", () => {
	const loaded = [{ id: "req-2", role: "user", title: "继续，我重启了，看看有无东西遗漏。", time: "22:30" }];
	const merged = merge(loaded, directory);
	assert.equal(merged.length, 2, "同标题不同时间必须各留一条，否则用户第二次提问会消失");
});
