import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseAddFavoriteInput } = loadTsCommonJs("src/main/favorites/favoriteInput.ts");
const { FAVORITE_META_MAX_CHARS, FAVORITE_TEXT_INPUT_MAX_CHARS } = loadTsCommonJs("src/shared/types/favorites.ts");

test("parseAddFavoriteInput 只收白名单字段并保留 Markdown 原文", () => {
	const parsed = parseAddFavoriteInput({
		kind: "selection",
		text: "  # 标题\n\n正文  ",
		role: "assistant",
		sessionId: "s1",
		sessionTitle: "会话",
		projectId: "p1",
		messageId: "m1",
		model: "global/x",
		partial: true,
		extra: "drop me",
	});
	assert.deepEqual(
		{ ...parsed },
		{
			kind: "selection",
			text: "# 标题\n\n正文",
			role: "assistant",
			sessionId: "s1",
			sessionTitle: "会话",
			projectId: "p1",
			messageId: "m1",
			model: "global/x",
			partial: true,
		},
	);
	assert.equal("extra" in parsed, false, "多余字段不得进入 store");
});

test("parseAddFavoriteInput 对形状/枚举/正文做硬校验", () => {
	assert.throws(() => parseAddFavoriteInput(null), /not an object/);
	assert.throws(() => parseAddFavoriteInput([]), /not an object/);
	assert.throws(() => parseAddFavoriteInput({ kind: "other", text: "x" }), /kind/);
	assert.throws(() => parseAddFavoriteInput({ kind: "message", text: "   " }), /text is empty/);
	assert.throws(() => parseAddFavoriteInput({ kind: "message", text: "x".repeat(FAVORITE_TEXT_INPUT_MAX_CHARS + 1) }), /too long/);
});

test("parseAddFavoriteInput 对可选元信息降级而不整体拒绝", () => {
	const parsed = parseAddFavoriteInput({ kind: "message", text: "正文", role: "error", sessionId: 42, sessionTitle: "   ", partial: "yes" });
	assert.equal(parsed.role, null, "非白名单角色降级为 null");
	assert.equal(parsed.sessionId, null, "非字符串 id 降级为 null");
	assert.equal(parsed.sessionTitle, null, "空白标题降级为 null");
	assert.equal(parsed.partial, false, "只有字面 true 才算 partial");
	const capped = parseAddFavoriteInput({ kind: "message", text: "正文", sessionId: "s".repeat(FAVORITE_META_MAX_CHARS + 10) });
	assert.equal(capped.sessionId.length, FAVORITE_META_MAX_CHARS, "超长元信息按上限截断");
});
