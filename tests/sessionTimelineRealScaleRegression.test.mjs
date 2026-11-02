/**
 * 真实规模会话的时间线回归（#473 根因复现）。
 *
 * 用户症状：约 171 轮 / 59 MB 的会话，从最底部一键定位到顶部时无限加载、永远转圈；
 * 连续上翻时偶尔原地打转、点了没反应。小会话（几十条消息）永远测不出来。
 *
 * 语料不是真实会话原文（内容含个人数据，不能进公开仓库），而是按实测结构参数
 * 合成的等价会话。参数来源：本机最大会话 2026-10-31T07-39-40-691Z_01a190e6，
 * 实测 59,280,241 字节 / 6005 行 / 5600 条消息 / 171 轮 / 最大单轮 397 条 /
 * user 171 + assistant 2827 + toolResult 2590 / 每条文本长度 p50=531、p90=2609。
 * 合成语料复现「轮数、每轮条数、字节规模、角色混合」四项，不含任何原文。
 *
 * 页大小取默认值 3 轮（SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE），
 * 所以 171 轮从底到顶需要约 57 页——这正是真机上「一直转圈」的规模条件。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { trimHistoryMessages } = loadTsCommonJs("src/main/pi/agentUtils.ts");
const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

// 实测参数（见文件头）：171 轮、每轮 33 条、约 10 KB/条、一轮 397 条的大轮。
const REAL_SCALE = {
	turns: 171,
	messagesPerTurn: 32,
	textBytesPerMessage: 10_400,
	fatTurnIndex: 40,
	fatTurnMessages: 397,
};

function buildRealScaleSession(profile = REAL_SCALE) {
	const rows = [JSON.stringify({ type: "session", version: 3, id: "real-scale", timestamp: 1_700_000_000_000, cwd: "/tmp/real-scale" })];
	let parentId = "real-scale";
	let messageCount = 0;
	const entryId = () => `m${String(messageCount++).padStart(5, "0")}`;

	for (let turn = 0; turn < profile.turns; turn += 1) {
		const userId = `u${turn}`;
		rows.push(
			JSON.stringify({
				type: "message",
				id: userId,
				parentId,
				timestamp: turn * 1000,
				message: { role: "user", content: [{ type: "text", text: `第 ${turn} 问`.padEnd(600, "问") }] },
			}),
		);
		parentId = userId;
		messageCount += 1;
		const count = turn === profile.fatTurnIndex ? profile.fatTurnMessages : profile.messagesPerTurn;
		for (let i = 0; i < count; i += 1) {
			const id = entryId();
			const role = i % 2 === 0 ? "assistant" : "toolResult";
			rows.push(
				JSON.stringify({
					type: "message",
					id,
					parentId,
					timestamp: turn * 1000 + i,
					message: {
						role,
						content: [{ type: "text", text: `${turn}:${i}:`.padEnd(profile.textBytesPerMessage, String(i % 10)) }],
					},
				}),
			);
			parentId = id;
		}
	}
	return { jsonl: `${rows.join("\n")}\n`, firstEntryId: "u0", totalMessages: messageCount };
}

function createReader() {
	return new SessionHistoryReader({
		toHostPath: (sessionPath) => sessionPath,
		convertMessages: (_agentId, rawMessages, entryIds = []) =>
			rawMessages.map((message, index) => ({
				id: entryIds[index] ?? `message-${index}`,
				role: message.role,
				text: typeof message.content === "string" ? message.content : (message.content?.[0]?.text ?? ""),
			})),
		trimMessages: (messages, maxTurns) => trimHistoryMessages(messages, maxTurns),
		translate: () => "Summary unavailable.",
	});
}

async function withRealScaleSession(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-real-scale-"));
	const sessionPath = join(dir, "real-scale.jsonl");
	try {
		const built = buildRealScaleSession();
		await writeFile(sessionPath, built.jsonl, "utf8");
		return await run({ sessionPath, built });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("合成语料与实测会话同量级（约 59 MB / 171 轮）", async () => {
	await withRealScaleSession(async ({ sessionPath, built }) => {
		const bytes = statSync(sessionPath).size;
		assert.ok(bytes > 40_000_000, `语料应达到真实规模量级，实际 ${bytes} 字节`);
		assert.ok(built.totalMessages > 5_000, `消息条数应接近实测 5600 条，实际 ${built.totalMessages}`);
	});
});

test("真实规模会话：连续上翻 60 页，游标严格递减且能翻到顶", async () => {
	await withRealScaleSession(async ({ sessionPath, built }) => {
		const reader = createReader();
		let before;
		let pages = 0;
		const seenCursors = [];
		let reachedTop = false;

		for (let i = 0; i < 60; i += 1) {
			const page = await reader.readSessionDisplayTurnPage(sessionPath, "_viewer", before);
			assert.equal(page.total, built.totalMessages, "总条数应当稳定，不能随翻页变化");
			assert.ok(page.messages.length > 0, `第 ${i + 1} 页拿到空页（真机上表现为一直转圈）`);
			pages += 1;
			const next = page.nextBefore;
			if (next === null || next === undefined) {
				reachedTop = true;
				break;
			}
			if (before !== undefined) {
				assert.ok(next < before, `第 ${i + 1} 页游标未前进：before=${before} nextBefore=${next}（原地打转 = #474 死循环）`);
			}
			assert.ok(!seenCursors.includes(next), `游标重复出现：${next}，页与页之间回绕了`);
			seenCursors.push(next);
			before = next;
		}

		assert.ok(reachedTop, `翻了 ${pages} 页仍未到顶（171 轮 / 每页 3 轮应为 57 页左右）`);
		assert.ok(pages <= 60, `翻页数 ${pages} 超出预期上界`);
	});
});

test("真实规模会话：从底部一次跳顶，一次调用就拿到整段历史", async () => {
	await withRealScaleSession(async ({ sessionPath, built }) => {
		const reader = createReader();
		// 「从最底部一键定位到顶部」在主进程侧就是一次超大页请求：游标给会话末、
		// 页大小给到上限（MAX_TURN_PAGE_SIZE = 200，够覆盖 171 轮）。
		const page = await reader.readSessionDisplayTurnPage(sessionPath, "_viewer", built.totalMessages, 200);
		assert.ok(page.messages.length > 5_000, `一次跳顶应拿到整段历史，实际只有 ${page.messages.length} 条（真机上就是一直转圈）`);
		assert.equal(page.nextBefore, null, "拿到全部历史后游标必须收口，否则渲染层会继续往上要");
		assert.equal(page.messages[0]?.role, "user", "页首应当是第一问");
	});
});

test("真实规模会话：点名中段 entryId，返回覆盖它的页且游标前进", async () => {
	await withRealScaleSession(async ({ sessionPath }) => {
		const reader = createReader();
		const page = await reader.readSessionDisplayTurnPage(sessionPath, "_viewer", undefined, undefined, "m00500");
		assert.ok(page.messages.length > 0, "点名中段 entryId 必须返回内容");
		assert.equal(page.messages[0]?.role, "user", "页首应当对齐轮起点，不能从回答中间切半轮");
		assert.ok(typeof page.nextBefore === "number" && page.nextBefore < 500, `游标必须落在锚点之前：nextBefore=${page.nextBefore}`);
	});
});

test("真实规模会话：点名第一条消息，明确回「没有更早」而不是跳回最新", async () => {
	await withRealScaleSession(async ({ sessionPath, built }) => {
		const reader = createReader();
		// 锚点就是第 0 条时，正确行为是「上面没有了」，绝不能悄悄退回尾部
		// 重新读一遍最新消息——那正是用户看到的「点了没反应 / 又跳回底部」。
		const page = await reader.readSessionDisplayTurnPage(sessionPath, "_viewer", undefined, undefined, built.firstEntryId);
		assert.equal(page.nextBefore, null, "第一问之上没有更早历史，游标必须收口");
		assert.equal(page.messages.length, 0, "第一问之上不应再返回任何消息");
	});
});

test("真实规模会话：单页读取耗时不超过 5 秒（慢到失控就红）", async () => {
	await withRealScaleSession(async ({ sessionPath }) => {
		const reader = createReader();
		const startedAt = Date.now();
		await reader.readSessionDisplayTurnPage(sessionPath, "_viewer");
		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed < 5_000, `冷启动读一页耗时 ${elapsed}ms，超过 5 秒（真机上就是无限转圈）`);
	});
});
test("真实规模会话：点名一个不存在的 entryId，必须停住而不是跳回最新", async () => {
	await withRealScaleSession(async ({ sessionPath }) => {
		const reader = createReader();
		// #474 记录的「点了没反应」路径：渲染层拿的锚点在主进程索引里找不到
		//（运行时窗口与 JSONL 是两个下标空间），此时正确行为是明确回「没有更早」；
		// 一旦静默退回尾部，界面就把整段最新历史又 prepend 一遍，用户看到的是原地闪一下。
		const page = await reader.readSessionDisplayTurnPage(sessionPath, "_viewer", undefined, undefined, "this-entry-does-not-exist");
		assert.equal(page.nextBefore, null, "锚点解析失败必须收口，不能给一个可继续翻的游标");
		assert.equal(page.messages.length, 0, "锚点解析失败不应返回最新一页");
	});
});
