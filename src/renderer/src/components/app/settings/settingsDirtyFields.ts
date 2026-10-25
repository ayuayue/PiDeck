import { deepEqual } from "../../../utils/deepEqual";

/**
 * 计算草稿相对基准快照的脏字段集合（纯函数，可单测）。
 *
 * 用真实差异（deepEqual）而不是「touched 集合」记录改动：改回原值即自动摘掉脏标记，
 * 关闭确认 / 左侧黄点 / 保存按钮只反映真实未保存改动，避免「改过又改回」仍被判为已修改。
 * 遍历「草稿 + 基准」的键并集，避免只遍历草稿键时漏掉「字段被删除（草稿里消失、基准里还在）」的情况。
 */
export function computeDirtyFields(draft: Record<string, unknown>, base: Record<string, unknown>): Set<string> {
	const keys = new Set<string>();
	const allKeys = new Set([...Object.keys(draft), ...Object.keys(base)]);
	for (const key of allKeys) {
		if (!deepEqual(draft[key], base[key])) keys.add(key);
	}
	return keys;
}
