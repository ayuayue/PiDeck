import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 判据：导轨合并结果里，同一 entryId（或无 entryId 时的同 id）只能出现一次。
 *
 * 事故（真机 2026-11-27，用户原话「末尾有两个的 bug，还是没修好」）：
 * 面板末尾两条一模一样的条目。盘上只有一条 user 消息、目录 112 条无重复、
 * buildOutline 单跑也正常 —— 重复发生在**追加分支**：旧代码的 usedEntryIds
 * 只在「已加载项匹配到目录项」时写入，未匹配的 live 项一律追加，于是同键两条都进去了。
 *
 * 反例（能红）：把追加分支改回 `if (!usedEntryIds.has(...)) merged.push(item)` 且不 add，
 * 同一 live 条目给两份 → 输出 2 条。
 */

const rail = () => loadTsCommonJs("src/renderer/src/components/session/timeline/outlineRailTicks.ts");

test("同一条 live 消息给两份：合并结果只留一条", () => {
	const { mergeOutlineRailItems } = rail();
	const live = { id: "m1", entryId: "e1", role: "user", title: "跳转还是很慢", time: "" };
	const merged = mergeOutlineRailItems([live, { ...live }], []);
	assert.equal(merged.length, 1, "同一 entryId 两条 -> " + merged.length + " 条（应为 1）");
});

test("有目录时，重复的 live 项也只追加一条（这才是真机那条路径）", () => {
	const { mergeOutlineRailItems } = rail();
	const dir = [{ entryId: "e1", title: "目录里的旧提问", time: "" }];
	const live = { id: "m2", entryId: "e2", role: "user", title: "跳转还是很慢", time: "" };
	const merged = mergeOutlineRailItems([live, { ...live }], dir);
	assert.equal(merged.length, 2, "1 条目录 + 1 条唯一 live，得到 " + merged.length + " 条");
	assert.equal(merged[1].entryId, "e2");
});
test("无 entryId 的 live 项按 messageId 去重", () => {
	const { mergeOutlineRailItems } = rail();
	const live = { id: "m2", role: "user", title: "末尾有两个", time: "" };
	const merged = mergeOutlineRailItems([live, { ...live }], []);
	assert.equal(merged.length, 1, "同 id 两条 -> " + merged.length + " 条（应为 1）");
});

test("目录里同一 entryId 出现两次：只画一条", () => {
	const { mergeOutlineRailItems } = rail();
	const dir = [
		{ entryId: "e1", title: "跳转还是很慢", time: "" },
		{ entryId: "e1", title: "跳转还是很慢", time: "" },
	];
	assert.equal(mergeOutlineRailItems([], dir).length, 1, "重复目录项应合并成一条");
});

test("已加载项与目录项重叠时，不额外追加（原行为不变）", () => {
	const { mergeOutlineRailItems } = rail();
	const loaded = [{ id: "m1", entryId: "e1", role: "user", title: "已加载的标题", time: "" }];
	const dir = [{ entryId: "e1", title: "目录的标题", time: "" }];
	const merged = mergeOutlineRailItems(loaded, dir);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].title, "已加载的标题", "重叠时用已加载项的标题");
});

test("目录里没有的 live 项仍要追加（否则刚发的提问从刻度上消失）", () => {
	const { mergeOutlineRailItems } = rail();
	const loaded = [{ id: "m2", entryId: "e2", role: "user", title: "刚发的", time: "" }];
	const dir = [{ entryId: "e1", title: "旧的", time: "" }];
	const merged = mergeOutlineRailItems(loaded, dir);
	assert.equal(merged.length, 2);
	assert.equal(merged[1].title, "刚发的");
});
