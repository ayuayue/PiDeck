import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * 判据：渲染层不许读目录项里的 messageIndex 来定位。
 *
 * 为什么要有这一条：readSessionOutline 给每个目录项带了两个坐标系——
 *   entryId       文件条目 id（跳转与取页认这个）
 *   messageIndex  活动消息条目的下标（文件下标空间）
 * 而活动条目 12581 条里只有 5737 条能投影成消息（系统条目、context_edit 移出的都投影不出来）。
 * 两个坐标不等价，拿 messageIndex 当渲染位置就会落到「有位置没内容」的地方。
 *
 * 今天零使用（grep 全仓，渲染层只有 renderEquality 里的同名局部数组下标参数，不是这个字段）。
 * 零使用不等于明天零使用，所以立这条。
 *
 * 反例（能红）：任何一处写 item.messageIndex / outline.messageIndex 去取消息或定位。
 */
const RENDERER = "src/renderer/src";

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.tsx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

test("渲染层不许读目录项的 messageIndex（活动下标与渲染位置不等价）", () => {
	const offenders = [];
	for (const file of walk(RENDERER)) {
		const source = readFileSync(file, "utf8");
		for (const [index, line] of source.split("\n").entries()) {
			if (/\.messageIndex\b/.test(line)) offenders.push(file + ":" + (index + 1) + "  " + line.trim().slice(0, 80));
		}
	}
	assert.deepEqual(offenders, [], "有人拿活动下标当渲染位置用了：活动条目与可投影消息不等价（实测 12581 vs 5737）");
});
