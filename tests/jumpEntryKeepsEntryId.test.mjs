import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 首次跳转与 pending/fallback 共用一个 id-space resolver。
 * 反例：入口处用 findIndex(entryId || messageId)，在 E9 撞键时选第 0 条；
 * fallback 先扫完整个 entryId 空间，会选第 1 条。同一目标的两条路径因此落到不同消息。
 * 坏样本：恢复 findIndex(entryId || messageId)；源码判据与运行时对拍会红。
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

test("首次跳转使用与 pending/fallback 相同的 entryId 优先解析", () => {
	const source = readFileSync(SOURCE, "utf8");
	const body = jumpToMessageBody(source);
	assert.ok(body !== null, "jumpToMessage 函数没找到，判据前提不成立");
	assert.match(body, /resolveJumpMessageIndex\(combinedMessages, \{ kind: "unknown", id: messageId \}\)/);
	assert.doesNotMatch(body, /findIndex\(\(message\) => message\.meta\?\.entryId === messageId \|\| message\.id === messageId\)/);

	const { resolveJumpMessageIndex } = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpTarget.ts");
	const collided = [
		{ id: "E9", meta: {} },
		{ id: "m2", meta: { entryId: "E9" } },
	];
	assert.equal(resolveJumpMessageIndex(collided, { kind: "unknown", id: "E9" }), 1, "entryId 命中优先于另一条消息的同名 messageId");
});
