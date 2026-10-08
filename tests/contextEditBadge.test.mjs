/**
 * 上下文编辑标记（ContextEditBadge）单测。
 *
 * 背景：pi 用追加的 `context_edit` 记录表达「把某条消息移出/改写模型上下文」，
 * 原始行不动、费用不回退、已被摘要转述的内容也删不掉。界面必须把「原始历史」
 * 与「模型下次能看到的内容」分开说清楚，因此对已标记的消息出一个可 hover 的徽章：
 *   - excluded：正文照常显示（原文可查），徽章说明「已移出上下文」；
 *   - replaced：显示的是原文，徽章说明模型看到的是改后的内容。
 *
 * 这条边界容易走反：早期想法是「把移出的消息隐藏/折叠成占位」，那会让用户以为
 * 「删除＝彻底忘掉/省钱」，与 pi 的真实语义相反。本测试锁定「不隐藏、只标记」。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ContextEditBadge, readContextEditState } = loadTsCommonJs("src/renderer/src/components/session/ContextEditBadge.tsx", {
	stubs: {
		"../../i18n": {
			t: (key) => {
				// 与 rendererCopy.zh-CN 的真实文案保持一致：断言「原文/费用」等关键说明时
				// 不能用一个更短的替身，否则测的是替身而不是线上文案。
				const copy = {
					"timeline.contextExcluded": "已移出上下文",
					"timeline.contextReplaced": "上下文已改写",
					"timeline.contextExcludedHint": "这条消息只在原始历史里了，下次请求不会再送给模型（原文保留、已产生的费用不会回退）。",
					"timeline.contextReplacedHint": "模型下次看到的是改写后的内容，原始正文仍保留在历史里（本页显示的是原文）。",
				};
				return copy[key] ?? key;
			},
		},
	},
});

function messageWith(contextEdit) {
	return { id: "m1", agentId: "a", role: "user", text: "hello", timestamp: 1, meta: contextEdit ? { entryId: "u1", contextEdit } : { entryId: "u1" } };
}

function render(message) {
	return renderToStaticMarkup(createElement(ContextEditBadge, { message }));
}

test("readContextEditState：只认 excluded / replaced，其余（含缺失与脏值）返回 undefined", () => {
	assert.equal(readContextEditState(messageWith("excluded")), "excluded");
	assert.equal(readContextEditState(messageWith("replaced")), "replaced");
	assert.equal(readContextEditState(messageWith(undefined)), undefined);
	assert.equal(readContextEditState(messageWith("removed")), undefined, "未知值不得被当成已移出（否则会误报）");
	assert.equal(readContextEditState({ id: "m", agentId: "a", role: "user", text: "t", timestamp: 1 }), undefined, "无 meta 的老消息零影响");
});

test("已移出上下文：出徽章且带解释（不隐藏消息，故不产生占位文案）", () => {
	const html = render(messageWith("excluded"));
	assert.match(html, /已移出上下文/);
	assert.match(html, /data-context-edit="excluded"/);
	// hover 说明必须解释「原文保留 + 费用不回退」，避免用户以为消息被彻底删除。
	// 解释在 title 属性里（静态标记不以文本形式输出），所以从属性断言。
	assert.match(html, /title="[^"]*原文[^"]*"/, "解释里必须说原文仍保留");
	assert.match(html, /title="[^"]*费用[^"]*"/, "解释里必须说明已产生的费用不回退");
	assert.doesNotMatch(html, /已从历史删除|彻底删除/, "不得暗示消息已从历史消失");
});

test("上下文已改写：出不同徽章，并说明原文仍可查", () => {
	const html = render(messageWith("replaced"));
	assert.match(html, /上下文已改写/);
	assert.match(html, /data-context-edit="replaced"/);
	assert.match(html, /title="[^"]*原文[^"]*"/, "解释里必须说原文仍在历史里");
});

test("无标记时不渲染任何内容（普通消息零噪声）", () => {
	assert.equal(render(messageWith(undefined)), "");
});
