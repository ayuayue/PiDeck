import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * 入口保 entryId：跳转链第一步不许把 entryId 换成 messageId 再去已加载列表里找。
 *
 * 为什么要有这条：这是 2026-11「点一条消息要连点好几次」的直接断点。
 * 入口（SessionMessageTimeline / SessionSurfaceStage）给的是 entryId，
 * 而 useTimelineJumpNavigation 第一步用 resolveJumpMessageIndex(combinedMessages, messageId)
 * 去已加载的消息里查：目标没加载时必然 -1，于是掉进「补页 + 扩窗」的逐页逼近循环，
 * 而 main 侧「按 entryId 一次取页」的能力根本没被调用。
 *
 * 口径（这条决定它能不能红）：
 * - 只扫 jumpToMessage 函数体（从它的声明到下一个顶层 useCallback 声明前），不扫全文。
 *   全文扫会把 findFallbackJumpRow 之类合法使用误伤。
 * - 判据是「函数体里不得出现 resolveJumpMessageIndex」，不是「必须出现某个新名字」。
 *   后者会把重构钉死成指定实现，前者只拦那一种退步。
 * - 现在这条应当是红的：B 步落地前，dev 上就是旧写法。红是预期，绿是修好。
 */
const SOURCE = "src/renderer/src/hooks/session/timeline/useTimelineJumpNavigation.ts";

function jumpToMessageBody(source) {
	const start = source.indexOf("const jumpToMessage");
	if (start < 0) return null;
	const rest = source.slice(start + 10);
	const candidates = ["const scrollJumpTargetIntoView", "const settleJumpTarget", "const findFallbackJumpRow"].map((marker) => rest.indexOf(marker)).filter((index) => index >= 0);
	const end = candidates.length > 0 ? Math.min(...candidates) : rest.length;
	return rest.slice(0, end);
}

test("跳转入口保 entryId：第一步不许退成按 messageId 查已加载列表", () => {
	const source = readFileSync(SOURCE, "utf8");
	const body = jumpToMessageBody(source);
	assert.ok(body !== null, "jumpToMessage 函数没找到，判据前提不成立（文件被改名或重构）");
	assert.equal(body.includes("resolveJumpMessageIndex"), false, "jumpToMessage 里又出现了 resolveJumpMessageIndex：等于把入口给的 entryId 换成 messageId 再去已加载列表里找，目标没加载时必然 -1，会退回逐页逼近");
});
