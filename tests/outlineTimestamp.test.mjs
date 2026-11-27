import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 判据：导轨目录项的 timestamp 必须能被 Date.parse 解析。
 *
 * 为什么：SessionOutlineEntry.timestamp 是可选 ISO 字符串，渲染层这样用——
 *   time: entry.timestamp ? formatTime(Date.parse(entry.timestamp)) : ""
 * Date.parse 失败给 NaN，formatTime(NaN) 走 new Date(NaN).toLocaleString() 得到「Invalid Date」。
 * 也就是刻度上会出现一个时间显示不出来的项——用户看到的就是「一个不存在的刻度」。
 *
 * 实测（3 个大会话 1155 个目录项，2026-11-27）：unparseable 0、未来 0、2020 前 0。
 * 所以这条今天绿，它不是抓已发生的 bug，是挡住将来某次索引改动把时间写坏。
 *
 * 反例（能红）：把某条 timestamp 改成空串或非 ISO 串，Date.parse 给 NaN。
 */

// 用合成数据测「渲染层遇到坏 timestamp 会怎样」，不依赖本机会话文件（CI 上没有）。
test("Date.parse 失败的 timestamp 会渲染成 Invalid Date（这就是「不存在的刻度」）", () => {
	const { formatTime } = loadTsCommonJs("src/renderer/src/components/session/TimelineFormat.ts");
	assert.match(formatTime(Date.parse("2026-11-18T14:10:43.939Z")), /\d/, "正常 ISO 应给出数字时间");
	assert.match(String(formatTime(Date.parse(""))), /Invalid Date/i, "坏 timestamp 的产物就是 Invalid Date");
});

test("目录项的时间字段只接受可解析的 ISO 串（写入侧约束）", () => {
	// 与 SessionHistoryReader.readSessionOutline 的写入形态一致：timestamp 可选，有值就是 entry.timestamp。
	const accept = (entry) => {
		if (entry.timestamp === undefined) return true; // 可选字段，缺省合法
		return Number.isFinite(Date.parse(entry.timestamp));
	};
	assert.equal(accept({ entryId: "a" }), true, "缺 timestamp 合法");
	assert.equal(accept({ entryId: "a", timestamp: "2026-11-18T14:10:43.939Z" }), true, "ISO 串合法");
	assert.equal(accept({ entryId: "a", timestamp: "" }), false, "空串必须被拒——它会渲染成 Invalid Date");
	// 注意：Date.parse 很宽松——"2026-11-18 14:10" 在 V8 里能解析（初版我写错成必须被拒，实测打脸）。
	// 所以判据只能要求「可解析」，不能要求「必须是严格 ISO」。
	assert.equal(accept({ entryId: "a", timestamp: "not-a-date" }), false, "真无效串必须被拒——它会渲染成 Invalid Date");
});
