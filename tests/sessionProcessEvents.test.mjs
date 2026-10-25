import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadModule() {
	return loadTsCommonJs("src/main/sessions/sessionProcessEvents.ts");
}

function systemMessage(partial) {
	return JSON.stringify({
		type: "message",
		id: partial.id ?? "sys-1",
		timestamp: partial.timestamp ?? "2026-01-01T00:00:00.000Z",
		...(partial.parentId ? { parentId: partial.parentId } : {}),
		message: { role: "system", timestamp: 1, content: partial.content ?? "", ...partial.message },
	});
}

test("parseSessionProcessEvents keeps session/model/thinking/custom and skips ordinary messages", () => {
	const { parseSessionProcessEvents } = loadModule();
	const raw = [
		JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }),
		JSON.stringify({ type: "model_change", id: "m1", timestamp: "2026-01-01T00:00:01.000Z", provider: "openai", modelId: "gpt-4.1" }),
		JSON.stringify({ type: "thinking_level_change", id: "t1", timestamp: "2026-01-01T00:00:02.000Z", thinkingLevel: "low" }),
		JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "hi" } }),
		JSON.stringify({ type: "custom", id: "c1", timestamp: "2026-01-01T00:00:03.000Z", customType: "pi-deck-todo", content: "- [ ] a" }),
		JSON.stringify({ type: "compaction", id: "k1", timestamp: "2026-01-01T00:00:04.000Z", summary: "compacted", tokensBefore: 80000 }),
	].join("\n");
	const events = parseSessionProcessEvents(raw);
	assert.equal(events.map((event) => event.kind).join(","), "session,modelChange,thinkingChange,custom,compaction");
	assert.equal(events[0].cwd, "/repo");
	assert.equal(events[1].modelId, "gpt-4.1");
	assert.equal(events[2].thinkingLevel, "low");
	assert.equal(events[3].customType, "pi-deck-todo");
	assert.equal(events[4].tokensBefore, 80000);
});

test("pi system message replays into an initial prompt snapshot with tools", () => {
	const { parseSessionProcessEvents } = loadModule();
	const raw = [
		JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }),
		systemMessage({
			timestamp: "2026-01-01T00:00:01.000Z",
			content: "",
			message: {
				sections: { preamble: "You are pi.", rules: "Be brief." },
				toolsAdded: [{ name: "bash" }, { name: "read" }],
			},
		}),
		JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "hi" } }),
	].join("\n");
	const events = parseSessionProcessEvents(raw);
	const prompt = events.find((event) => event.kind === "systemPrompt");
	assert.ok(prompt, "system prompt must land in the ledger events");
	assert.equal(prompt.prompt.kind, "initial");
	assert.match(prompt.prompt.text, /You are pi\./);
	assert.match(prompt.prompt.text, /Be brief\./);
	assert.equal(prompt.prompt.tools.join(","), "bash,read");
	assert.equal(prompt.prompt.toolsAdded, undefined);
	assert.equal(prompt.timestamp, Date.parse("2026-01-01T00:00:01.000Z"));
});

test("section and tool patches emit one update snapshot with a diff, repeated loads are dropped", () => {
	const { parseSessionProcessEvents } = loadModule();
	const raw = [
		systemMessage({ id: "sys-1", timestamp: "2026-01-01T00:00:01.000Z", message: { sections: { preamble: "base", rules: "old" }, toolsAdded: [{ name: "bash" }, { name: "read" }] } }),
		// 同一份装载重复落盘：不产记录（账本只记真实变化）。
		systemMessage({ id: "sys-2", timestamp: "2026-01-01T00:00:02.000Z", message: { sections: { preamble: "base", rules: "old" }, toolsAdded: [{ name: "bash" }, { name: "read" }] } }),
		systemMessage({ id: "sys-3", timestamp: "2026-01-01T00:00:03.000Z", message: { sections: { rules: "new", extra: "added" }, toolsAdded: [{ name: "write" }], toolsRemoved: [{ name: "read" }] } }),
	].join("\n");
	const prompts = parseSessionProcessEvents(raw).filter((event) => event.kind === "systemPrompt");
	assert.equal(prompts.length, 2, "only the initial load and the real change are recorded");
	const update = prompts[1].prompt;
	assert.equal(update.kind, "update");
	assert.equal(update.sectionsUpdated.join(","), "rules");
	assert.equal(update.sectionsAdded.join(","), "extra");
	assert.equal(update.toolsAdded.join(","), "write");
	assert.equal(update.toolsRemoved.join(","), "read");
	assert.equal(update.tools.join(","), "bash,write");
	assert.match(update.text, /new/);
});

test("compaction systemMessage resets the loadout and records a snapshot", () => {
	const { parseSessionProcessEvents } = loadModule();
	const raw = [
		systemMessage({ id: "sys-1", timestamp: "2026-01-01T00:00:01.000Z", message: { sections: { preamble: "base", rules: "old" }, toolsAdded: [{ name: "bash" }] } }),
		JSON.stringify({
			type: "compaction",
			id: "k1",
			timestamp: "2026-01-01T00:00:05.000Z",
			summary: "compacted",
			tokensBefore: 80000,
			systemMessage: { role: "system", timestamp: 1, content: "", sections: { preamble: "after compaction" }, toolsAdded: [{ name: "bash" }, { name: "edit" }] },
		}),
	].join("\n");
	const prompts = parseSessionProcessEvents(raw).filter((event) => event.kind === "systemPrompt");
	assert.equal(prompts.length, 2);
	assert.equal(prompts[1].prompt.kind, "snapshot");
	assert.match(prompts[1].prompt.text, /after compaction/);
	assert.equal(prompts[1].prompt.tools.join(","), "bash,edit");
	assert.equal(prompts[1].prompt.sectionsRemoved.join(","), "rules");
});

test("pi usage entries land as usage process records", () => {
	const { parseSessionProcessEvents } = loadModule();
	const raw = JSON.stringify({
		type: "usage",
		id: "use-1",
		timestamp: "2026-01-01T00:00:02.000Z",
		kind: "cache_warm",
		provider: "openai",
		model: "gpt-4.1",
		usage: { input: 1200, output: 0 },
	});
	const [event] = parseSessionProcessEvents(raw);
	assert.equal(event.kind, "usage");
	assert.equal(event.usageKind, "cache_warm");
	assert.match(event.summary, /cache_warm/);
});

test("process-event IPC is wired on channel, handler, and preload", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const handler = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.match(ipc, /sessionsCatalogReadProcessEvents: "sessions:catalog-read-process-events"/);
	assert.match(handler, /sessionsCatalogReadProcessEvents/);
	assert.match(handler, /parseSessionProcessEvents/);
	assert.match(preload, /readProcessEvents:/);
	assert.match(preload, /sessionsCatalogReadProcessEvents/);
});

// ── S1 红测基线（计划 docs/trajectory-session-consumer-plan.md §8.3）────────────
// 这组用例按「修正后的语义」写，当前实现应为红；S1 实现落地后转绿并永久保留。
// 夹具数值取自计划 §3.2 的预算口径：提示词 ≤96,000 码元且 ≤256KiB（262,144 字节）。

const PROMPT_BYTE_LIMIT = 262_144;

function finalPromptText(events) {
	const prompts = events.filter((event) => event.kind === "systemPrompt");
	assert.ok(prompts.length > 0, "必须有提示词快照");
	return prompts[prompts.length - 1].prompt;
}

test("B1: 旁支的 system 补丁不得进入当前装载", () => {
	const { parseSessionProcessEvents } = loadModule();
	// root(a1) ─┬─ 旁支 b1
	//           └─ 活动 a2 → leaf a3（文件末条决定活动分支）
	const raw = [
		systemMessage({ id: "a1", timestamp: "2026-01-01T00:00:01.000Z", message: { sections: { preamble: "ROOT-PREAMBLE" } } }),
		systemMessage({ id: "b1", parentId: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { sections: { siblingOnly: "SIBLING-ONLY" } } }),
		systemMessage({ id: "a2", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { sections: { activeOnly: "ACTIVE-ONLY" } } }),
		JSON.stringify({ type: "message", id: "a3", parentId: "a2", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: "ok" } }),
	].join("\n");

	const prompt = finalPromptText(parseSessionProcessEvents(raw));
	assert.doesNotMatch(prompt.text, /SIBLING-ONLY/, "旁支补丁污染了当前装载");
	assert.match(prompt.text, /ACTIVE-ONLY/, "活动分支补丁必须生效");
	assert.match(prompt.text, /ROOT-PREAMBLE/);
});

test("B2: 240 条普通事件之后的提示词变化仍要返回", () => {
	const { parseSessionProcessEvents, MAX_EVENTS } = loadModule();
	const lines = [systemMessage({ id: "sys-1", timestamp: "2026-01-01T00:00:01.000Z", message: { sections: { preamble: "INITIAL" } } })];
	for (let index = 0; index < 250; index += 1) {
		lines.push(JSON.stringify({ type: "custom", id: `c${index}`, timestamp: "2026-01-01T00:00:02.000Z", customType: "note", content: `n${index}` }));
	}
	lines.push(systemMessage({ id: "sys-late", timestamp: "2026-01-01T00:00:09.000Z", message: { sections: { late: "LATE-PATCH" } } }));

	const events = parseSessionProcessEvents(lines.join("\n"));
	assert.ok(events.length <= MAX_EVENTS, `返回事件数必须仍受上限约束，实际 ${events.length}`);
	const late = events.find((event) => event.kind === "systemPrompt" && /LATE-PATCH/.test(event.prompt?.text ?? ""));
	assert.ok(late, "事件上限截断了后续提示词：账本会停在 240 条时的旧装载");
});

test("B3: 90,000 个汉字超出字节预算时按字节截断并标记 truncated", () => {
	const { parseSessionProcessEvents } = loadModule();
	// 90,000 × 3 字节 = 270,000 字节 > 262,144，但码元数 90,000 < 96,000。
	const raw = systemMessage({ id: "sys-1", message: { sections: { body: "中".repeat(90_000) } } });
	const prompt = finalPromptText(parseSessionProcessEvents(raw));
	assert.equal(prompt.truncated, true, "字符数未超限但字节超限，必须标记 truncated");
	assert.ok(Buffer.byteLength(prompt.text, "utf8") <= PROMPT_BYTE_LIMIT, `字节超限：${Buffer.byteLength(prompt.text, "utf8")} > ${PROMPT_BYTE_LIMIT}`);
	assert.equal(prompt.text.length, 87_381, "262,144 / 3 = 87,381 个汉字是可容纳的最大完整前缀");
});

test("B3: 截断不得拆开 emoji（字节边界与码元边界都要整体省略）", () => {
	const { parseSessionProcessEvents } = loadModule();
	const cases = [
		// 87,381 汉字 = 262,143 字节，剩 1 字节装不下 4 字节的 emoji。
		{ label: "字节边界", text: "中".repeat(87_381) + "😀" },
		// 码元数 96,001 > 96,000，代理对恰好跨越截断点。
		{ label: "码元边界", text: "a".repeat(95_999) + "😀" },
	];
	for (const { label, text } of cases) {
		const prompt = finalPromptText(parseSessionProcessEvents(systemMessage({ id: `sys-${label}`, message: { sections: { body: text } } })));
		assert.equal(prompt.truncated, true, `${label}: 必须标记 truncated`);
		assert.ok(Buffer.byteLength(prompt.text, "utf8") <= PROMPT_BYTE_LIMIT, `${label}: 字节超限`);
		assert.ok(!prompt.text.includes("😀"), `${label}: 半个 emoji 也不能留下`);
		const last = prompt.text.charCodeAt(prompt.text.length - 1);
		assert.ok(!(last >= 0xd800 && last <= 0xdbff), `${label}: 结尾是孤立高代理（0x${last.toString(16)}）`);
		assert.ok(!prompt.text.includes("\uFFFD"), `${label}: 不能引入替换字符`);
	}
});

test("B3: 预算内的中英与 emoji 保持原值，不误报 truncated（正常对照）", () => {
	const { parseSessionProcessEvents } = loadModule();
	const text = `${"规则：简短回答。\n".repeat(100)}ok 😀`;
	const prompt = finalPromptText(parseSessionProcessEvents(systemMessage({ id: "sys-ok", message: { sections: { body: text } } })));
	assert.equal(prompt.truncated, undefined);
	assert.equal(prompt.text, text);
});
