/**
 * DSH 会话内查找的匹配层（findDshSessionMatches）回归。
 *
 * 语义必须与 pi 的 Go sidecar 一致：多词 AND、只折叠 ASCII 大小写、命中按时间线顺序、
 * snippet 单行有界。这里用纯函数把边界钉死——它同时被「回车/↑↓ 逐条跳转」和
 * 「N 条命中」计数消费，匹配口径一歪，用户看到的就是「明明有却搜不到」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { findDshSessionMatches, DSH_SESSION_FIND_MAX_MATCHES } = loadTsCommonJs("src/main/dsh/dshSessionFind.ts");

let nextId = 0;
/** 消息工厂：只填匹配层关心的字段（其余投影字段与查找无关）。 */
function message(overrides = {}) {
	nextId += 1;
	return {
		id: `dsh:${nextId}`,
		role: "user",
		text: "",
		timestamp: 1_700_000_000_000 + nextId,
		...overrides,
	};
}

test("空查询 / 纯空白查询不产生命中", () => {
	for (const query of ["", "   "]) {
		const hit = findDshSessionMatches([message({ text: "alpha" })], query);
		assert.equal(hit.matches.length, 0);
		assert.equal(hit.hitCount, 0);
	}
});

test("多词按 AND：每个词都要出现，顺序无关、可跨行", () => {
	const target = message({ text: "beta 先出现，alpha\n后出现" });
	const hit = findDshSessionMatches([target], "alpha beta");
	assert.equal(hit.hitCount, 1);
	assert.equal(hit.matches[0].messageId, target.id);
	// 缺任一词就是不命中
	assert.equal(findDshSessionMatches([message({ text: "只有 alpha" })], "alpha beta").hitCount, 0);
	// 词元顺序无关
	assert.equal(findDshSessionMatches([message({ text: "alpha 和 beta" })], "beta alpha").hitCount, 1);
});

test("大小写只折叠 ASCII：英文查询不区分大小写，中文原样匹配", () => {
	assert.equal(findDshSessionMatches([message({ text: "Hello ALPHA" })], "hello alpha").hitCount, 1);
	assert.equal(findDshSessionMatches([message({ text: "会话内容里有针" })], "内容").hitCount, 1);
	assert.equal(findDshSessionMatches([message({ text: "会话内容" })], "没有").hitCount, 0);
	// 非 ASCII 不折叠（与 Go asciiLower 同口径）：İ 不会被折成 i，但后面的 ASCII 仍参与折叠
	assert.equal(findDshSessionMatches([message({ text: "İSTANBUL" })], "STANBUL").hitCount, 1);
	assert.equal(findDshSessionMatches([message({ text: "İSTANBUL" })], "istanbul").hitCount, 0);
});

test("只检索 user/assistant 正文：工具卡片、系统提示不参与", () => {
	const messages = [message({ role: "tool", text: "needle in tool" }), message({ role: "system", text: "needle in system" }), message({ role: "assistant", text: "needle in answer" })];
	const hit = findDshSessionMatches(messages, "needle");
	assert.equal(hit.hitCount, 1);
	assert.equal(hit.matches[0].role, "assistant");
});

test("命中按消息顺序返回（上一条/下一条导航），超过上限截断但 hitCount 保留真实总数", () => {
	const messages = [message({ text: "needle 1" }), message({ text: "无" }), message({ text: "needle 2" }), message({ text: "needle 3" })];
	const hit = findDshSessionMatches(messages, "needle", 2);
	assert.equal(hit.hitCount, 3);
	assert.deepEqual(
		Array.from(hit.matches, (match) => match.snippet),
		["needle 1", "needle 2"],
	);
	assert.equal(DSH_SESSION_FIND_MAX_MATCHES, 100);
});

test("snippet 是有界单行窗口：换行/制表折叠成空格，且只截命中附近", () => {
	const longText = `${"前".repeat(100)}needle\n第二行\t尾${"后".repeat(100)}`;
	const hit = findDshSessionMatches([message({ text: longText })], "needle");
	const snippet = hit.matches[0].snippet;
	assert.ok(snippet.includes("needle"));
	assert.ok(!snippet.includes("\n") && !snippet.includes("\t"), "snippet 必须是单行");
	assert.equal(Array.from(snippet).length, 144, "前 48 + 后 96 个字符");
	assert.ok(!snippet.startsWith("前".repeat(100)), "不能把整条长消息塞进 snippet");
});

test("snippet 按码点切窗口，不会把 emoji 的代理对切成半个字符", () => {
	const text = `${"🙂".repeat(80)}needle${"🙂".repeat(80)}`;
	const snippet = findDshSessionMatches([message({ text })], "needle").matches[0].snippet;
	assert.ok(snippet.includes("needle"));
	assert.ok(snippet.includes("🙂"));
	assert.ok(!snippet.includes("\uFFFD"), "不能出现替换字符（截断产生的半个代理对）");
});

test("整句出现处优先作为锚点：多词散落时落在整句位置而不是最早词元", () => {
	const text = `${"x".repeat(80)} beta ${"y".repeat(80)} alpha beta`;
	const snippet = findDshSessionMatches([message({ text })], "alpha beta").matches[0].snippet;
	// 整句 "alpha beta" 在 160 之后：锚点应落在整句（snippet 里能看到 alpha 在前）
	assert.ok(snippet.includes("alpha beta"));
	assert.ok(!snippet.trimStart().startsWith("beta"));
});

test("接线：DSH 后端在 manager/IPC/装配层各有一处，避免只修一半", () => {
	const manager = readFileSync("src/main/dsh/DshAgentManager.ts", "utf8");
	assert.match(manager, /async\s+searchSessionMessages\(\s*dshSessionId: string,\s*query: string/);
	assert.match(manager, /findDshSessionMatches\(messages,\s*trimmed,\s*limit\)/);
	assert.match(manager, /collectAllDshSessionMessages\(dshSessionId\)/);
	assert.match(manager, /readSessionCursor\(dshSessionId\)/);
	const wiring = readFileSync("src/main/index.ts", "utf8");
	assert.match(wiring, /searchDshSessionMessages:\s*\(\s*dshSessionId,\s*query\s*\)\s*=>\s*dshAgentManager\.searchSessionMessages/);
	const handler = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
	assert.match(handler, /dshBackend\?\.searchDshSessionMessages/);
});
