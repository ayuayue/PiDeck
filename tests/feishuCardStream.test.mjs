import assert from "node:assert/strict";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 飞书流式卡片的交付边界：卡片是 pi 会话回复**唯一**的正文载体（agent_end 后不再补发文本），
 * 所以「更新被拒」必须被识别成失败，上层才会走纯文本兜底。
 * 以前的实现只依赖 HTTP 异常：飞书返回 200 + code≠0、或卡片超过 30KB 更新上限时，
 * 卡片静默停在上一版（多数情况是还没正文的骨架），用户端看不到答案。
 */

const loadCardStream = createTsSandbox({
	stubs: {
		"../logging/sharedLogger": { getAppLogger: () => null },
	},
});

const { CardStream, MAX_CARD_PATCH_BYTES } = loadCardStream("src/main/feishu/CardStream.ts");

function createClient(patch) {
	return {
		im: {
			message: {
				create: async () => ({ data: { message_id: "om_created" } }),
			},
			v1: {
				message: {
					patch,
				},
			},
		},
	};
}

async function openWith(patch) {
	const client = createClient(patch);
	const stream = await CardStream.open(client, "oc_chat", { elements: [] });
	return { stream, client };
}

test("patch 成功：lastPatchFailed 复位", async () => {
	const calls = [];
	const { stream } = await openWith(async (payload) => {
		calls.push(payload);
		return { code: 0, msg: "success", data: {} };
	});
	await stream.flush({ elements: [{ tag: "markdown", content: "回答" }] });
	assert.equal(calls.length, 1);
	assert.equal(stream.lastPatchFailed, false);
	assert.equal(stream.lastPatchError, "");
});

test("业务失败（HTTP 200 + code≠0）必须判失败，不能当成功静默吞掉", async () => {
	let calls = 0;
	const { stream } = await openWith(async () => {
		calls += 1;
		// 典型：卡片更新无权限 / 消息已撤回 / 被限流
		return { code: 230020, msg: "update card rejected" };
	});
	await assert.rejects(() => stream.flush({ elements: [] }), /230020/);
	// 重试 MAX_UPDATE_RETRIES(2) 次后放弃
	assert.equal(calls, 3);
	assert.equal(stream.lastPatchFailed, true);
	assert.match(stream.lastPatchError, /code=230020/);
});

test("超过飞书 30KB 更新上限的卡片不发请求，直接判失败交给纯文本兜底", async () => {
	let calls = 0;
	const { stream } = await openWith(async () => {
		calls += 1;
		return { code: 0 };
	});
	const big = { elements: [{ tag: "markdown", content: "中".repeat(MAX_CARD_PATCH_BYTES) }] };
	await assert.rejects(() => stream.flush(big), /超过/);
	assert.equal(calls, 0, "超限时不得把注定被拒的请求发出去");
	assert.equal(stream.lastPatchFailed, true);
	assert.match(stream.lastPatchError, /字节上限/);
});

test("节流窗口内的多次更新合并成一次 patch（终态 flush 必达）", async () => {
	const cards = [];
	const { stream } = await openWith(async (payload) => {
		cards.push(JSON.parse(payload.data.content));
		return { code: 0 };
	});
	stream.update({ elements: [{ content: "第一版" }] });
	stream.update({ elements: [{ content: "第二版" }] });
	await stream.flush();
	assert.equal(cards.length, 1);
	assert.equal(cards[0].elements[0].content, "第二版");
});
