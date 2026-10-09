/**
 * 会话上下文投影（sessionContextProjection）单测。
 *
 * 这是 PiDeck 对 pi `context_edit` 语义的独立实现（离线 Viewer / Web / 历史页
 * 不能启动 pi 进程）。两个关键点：
 *
 * 1. **差异校验**：pi 的 `buildContextEntries` 可从已安装的 pi 包直接 import，
 *    作为 oracle 对比「压缩裁剪后到底剩哪些条目」。本文件在 pi 可用时逐例比对，
 *    不可用（CI 未装 pi）时跳过，不算失败。
 * 2. **编辑应用**：pi 的 `buildSessionProjection` 内部函数不导出，因此按
 *    docs/session-format.md 的契约断言（replacement null = 移出上下文；
 *    对象 content = 替换；同 targetId 后者覆盖）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildSessionProjection, buildContextEntries, buildSessionPath, collectEffectiveEdits, parseReplacement, parseSessionEntries } = loadTsCommonJs("src/main/pi/sessionContextProjection.ts");

/**
 * 跨 realm 归一化：loadTsCommonJs 在 vm 沙箱里求值，返回的数组/对象原型与宿主
 * 不同源，assert/strict 的 deepEqual 会报「结构相同但非引用相等」。
 * 这里先 JSON 往返成宿主对象，保留 deepStrictEqual 的严格语义（不能直接改成非严格断言）。
 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** 已安装 pi 的 session-manager（含 buildContextEntries oracle）；缺失时返回 null。 */
async function loadPiOracle() {
	const path = "/home/zhadainian/.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
	if (!existsSync(path)) return null;
	try {
		return await import(path);
	} catch {
		return null;
	}
}

const PI_ORACLE = await loadPiOracle();

/** 构造 message 条目。 */
function msg(id, parentId, role, content, extra = {}) {
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role, content, timestamp: 1, ...extra } };
}

function compact(id, parentId, firstKeptEntryId, extra = {}) {
	return { type: "compaction", id, parentId, summary: `summary-${id}`, firstKeptEntryId, timestamp: "2026-01-01T00:00:01.000Z", ...extra };
}

/** 线性会话：u1 → a1 → u2 → a2，返回条目数组。 */
function linearSession() {
	return [msg("u1", null, "user", "hello"), msg("a1", "u1", "assistant", "hi"), msg("u2", "a1", "user", "more"), msg("a2", "u2", "assistant", "sure")];
}

test("buildSessionPath：从 leaf 沿 parentId 回溯，返回 root → leaf", () => {
	const entries = linearSession();
	assert.deepEqual(plain(buildSessionPath(entries, "a2").map((entry) => entry.id)), ["u1", "a1", "u2", "a2"]);
	// 中间节点切片（分叉后旧叶仍能取到自己的路径）
	assert.deepEqual(plain(buildSessionPath(entries, "a1").map((entry) => entry.id)), ["u1", "a1"]);
});

test("buildSessionPath：父链断裂 / 环 / 未知 leaf 都安全返回，不抛错", () => {
	assert.deepEqual(plain(buildSessionPath([], "missing")), []);
	assert.deepEqual(plain(buildSessionPath([{ type: "message", id: "x", parentId: "ghost" }], "x").map((e) => e.id)), ["x"]);
	// 环：a → b → a
	const cyclic = [
		{ type: "message", id: "a", parentId: "b" },
		{ type: "message", id: "b", parentId: "a" },
	];
	assert.deepEqual(plain(buildSessionPath(cyclic, "a").map((e) => e.id)), ["b", "a"]);
});

test("buildContextEntries：无压缩时原样返回路径", () => {
	const entries = linearSession();
	assert.deepEqual(plain(buildContextEntries(entries).map((entry) => entry.id)), ["u1", "a1", "u2", "a2"]);
});

/**
 * 压缩裁剪：最新 compaction 之前的条目只保留从 firstKeptEntryId 起的那一段，
 * 更早的已被摘要替代。这条契约直接决定「模型还看得到哪些历史」。
 */
test("buildContextEntries：只保留最新 compaction + firstKeptEntryId 之后的区间", () => {
	const entries = [msg("u1", null, "user", "old"), msg("u2", "u1", "user", "kept"), msg("a2", "u2", "assistant", "kept answer"), compact("c1", "a2", "u2"), msg("u3", "c1", "user", "after compaction")];
	const context = buildContextEntries(entries);
	// u1 被摘要替代；c1 是检查点；u2 起（firstKeptEntryId）到 leaf 全部保留。
	assert.deepEqual(plain(context.map((entry) => entry.id)), ["c1", "u2", "a2", "u3"]);
});

test("buildContextEntries：多次压缩只有最新一次生效（嵌套摘要）", () => {
	const entries = [msg("u1", null, "user", "one"), compact("c1", "u1", "u1"), msg("u2", "c1", "user", "two"), compact("c2", "u2", "u2"), msg("u3", "c2", "user", "three")];
	// 最新 compaction = c2：c1/u1 被它取代，保留 u2 起。
	assert.deepEqual(plain(buildContextEntries(entries).map((entry) => entry.id)), ["c2", "u2", "u3"]);
});

test("buildContextEntries：保留区间内的 system 消息被跳过（pi 用它承载提示词/工具清单）", () => {
	const entries = [msg("s0", null, "system", "prompt"), msg("u1", "s0", "user", "hi"), compact("c1", "u1", "s0"), msg("u2", "c1", "user", "after")];
	// firstKeptEntryId = s0，但 system 历史条目不进上下文（与 pi 一致）。
	assert.deepEqual(plain(buildContextEntries(entries).map((entry) => entry.id)), ["c1", "u1", "u2"]);
});

test("buildContextEntries：找不到 firstKeptEntryId 锚点时保留 compaction 之后的条目（不丢内容）", () => {
	const entries = [msg("u1", null, "user", "old"), compact("c1", "u1", "not-in-path"), msg("u2", "c1", "user", "after")];
	assert.deepEqual(plain(buildContextEntries(entries).map((entry) => entry.id)), ["c1", "u2"]);
});

/** 与 pi 官方实现逐例比对：压缩裁剪是本模块最容易与上游漂移的地方。 */
test("差异校验：buildContextEntries 与 pi 官方实现结果一致", async (t) => {
	if (!PI_ORACLE) {
		t.skip("未安装 pi，跳过与官方实现的差异校验");
		return;
	}
	const cases = {
		线性无压缩: linearSession(),
		单次压缩: [msg("u1", null, "user", "old"), msg("u2", "u1", "user", "kept"), compact("c1", "u2", "u2"), msg("u3", "c1", "user", "after")],
		多次压缩: [msg("u1", null, "user", "one"), compact("c1", "u1", "u1"), msg("u2", "c1", "user", "two"), compact("c2", "u2", "u2"), msg("u3", "c2", "user", "three")],
		含system: [msg("s0", null, "system", "prompt"), msg("u1", "s0", "user", "hi"), compact("c1", "u1", "s0"), msg("u2", "c1", "user", "after")],
		锚点缺失: [msg("u1", null, "user", "old"), compact("c1", "u1", "ghost"), msg("u2", "c1", "user", "after")],
		压缩后更新: [msg("u1", null, "user", "old"), compact("c1", "u1", "u1"), msg("u2", "c1", "user", "two")],
	};
	for (const [name, entries] of Object.entries(cases)) {
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const leafId = entries[entries.length - 1].id;
		const ours = plain(buildContextEntries(entries).map((entry) => entry.id));
		const theirs = plain(PI_ORACLE.buildContextEntries(entries, leafId, byId).map((entry) => entry.id));
		assert.deepEqual(ours, theirs, `用例「${name}」与 pi 官方实现不一致`);
	}
});

test("context_edit：replacement null 把目标移出模型上下文，原文条目仍在路径里", () => {
	const entries = [...linearSession(), { type: "context_edit", id: "e1", parentId: "a2", timestamp: "2026-01-01T00:00:02.000Z", targetId: "u1", replacement: null }];
	const projection = buildSessionProjection(entries);
	assert.deepEqual(plain(projection.messages.map((message) => message.content)), ["hi", "more", "sure"], "u1 不应再进入模型上下文");
	// 原始条目仍保留在活动分支上（追加记录，不改写原文）
	assert.ok(
		projection.path.some((entry) => entry.id === "u1"),
		"原始条目必须保留在文件/分支上",
	);
	const projected = projection.projectedEntries.find((entry) => entry.entryId === "u1");
	assert.equal(projected?.excluded, true);
	assert.equal(projected?.edit?.editEntryId, "e1");
});

test("context_edit：replacement 含 content 时替换内容，其余消息不受影响", () => {
	const entries = [...linearSession(), { type: "context_edit", id: "e1", parentId: "a2", timestamp: "2026-01-01T00:00:02.000Z", targetId: "u1", replacement: { content: "rewritten question" } }];
	const projection = buildSessionProjection(entries);
	assert.deepEqual(plain(projection.messages.map((message) => message.content)), ["rewritten question", "hi", "more", "sure"]);
	const projected = projection.projectedEntries.find((entry) => entry.entryId === "u1");
	assert.equal(projected?.excluded, false);
	// 原文未被改写：只是投影时替换
	assert.equal(projected?.entry.message.content, "hello");
});

test("context_edit：assistant/toolResult 的字符串 content 被包成 text block（与 pi 一致）", () => {
	const entries = [...linearSession(), { type: "context_edit", id: "e1", parentId: "a2", timestamp: "2026-01-01T00:00:02.000Z", targetId: "a1", replacement: { content: "revised answer" } }];
	const projection = buildSessionProjection(entries);
	const assistant = projection.messages.find((message) => message.role === "assistant");
	assert.deepEqual(plain(assistant.content), [{ type: "text", text: "revised answer" }]);
});

test("context_edit：user 消息的字符串 content 保持字符串（不包装）", () => {
	const entries = [...linearSession(), { type: "context_edit", id: "e1", parentId: "a2", timestamp: "2026-01-01T00:00:02.000Z", targetId: "u1", replacement: { content: "plain" } }];
	const projection = buildSessionProjection(entries);
	assert.equal(projection.messages[0].content, "plain");
});

test("context_edit：同一 targetId 多次编辑，后者覆盖前者", () => {
	const entries = [
		...linearSession(),
		{ type: "context_edit", id: "e1", parentId: "a2", timestamp: "2026-01-01T00:00:02.000Z", targetId: "u1", replacement: { content: "first" } },
		{ type: "context_edit", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:03.000Z", targetId: "u1", replacement: { content: "second" } },
	];
	const projection = buildSessionProjection(entries);
	assert.equal(projection.messages[0].content, "second");
	assert.equal(projection.edits.get("u1")?.editEntryId, "e2");
});

test("context_edit：先替换再删除 = 最终被移出上下文", () => {
	const entries = [...linearSession(), { type: "context_edit", id: "e1", parentId: "a2", timestamp: "2026-01-01T00:00:02.000Z", targetId: "u1", replacement: { content: "first" } }, { type: "context_edit", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:03.000Z", targetId: "u1", replacement: null }];
	const projection = buildSessionProjection(entries);
	assert.deepEqual(plain(projection.messages.map((message) => message.content)), ["hi", "more", "sure"]);
});

/**
 * 分支隔离：编辑只作用于「当前 leaf 的父链」。这里分两种情形（语义不同，不能混）：
 * A. 编辑条目本身不在当前分支上 → 根本不被收集（否则切分支会看到别人的改写）；
 * B. 编辑在当前分支上、但目标不在（目标属另一分支或已被压缩归档）→ 被收集但无效果，
 *    尤其不得把目标条目重新拉回上下文。
 */
test("context_edit：不在当前分支上的编辑不被收集", () => {
	// 文件顺序决定 leaf（最后一条带 id 的条目），所以主分支叶子放最后。
	const entries = [
		msg("u1", null, "user", "shared"),
		msg("a1", "u1", "assistant", "main answer"),
		// 另一分支：b1 + 其上的编辑，均不在 leaf=a2 的父链上。
		msg("b1", "u1", "assistant", "side answer"),
		{ type: "context_edit", id: "e-side", parentId: "b1", timestamp: "2026-01-01T00:00:02.000Z", targetId: "a1", replacement: null },
		msg("a2", "a1", "assistant", "main leaf"),
	];
	const projection = buildSessionProjection(entries);
	assert.deepEqual(plain(projection.path.map((entry) => entry.id)), ["u1", "a1", "a2"]);
	assert.equal(projection.edits.size, 0, "不在分支上的编辑不得被收集");
	assert.deepEqual(plain(projection.messages.map((message) => message.content)), ["shared", "main answer", "main leaf"]);
});

test("context_edit：目标不在当前分支上时被收集但不生效，也不把目标拉回上下文", () => {
	const entries = [
		msg("u1", null, "user", "shared"),
		msg("a1", "u1", "assistant", "other branch answer"),
		msg("b1", "u1", "assistant", "side answer"),
		// 编辑在当前分支（u1 → b1 → e-side）上，但目标 a1 属另一分支。
		{ type: "context_edit", id: "e-side", parentId: "b1", timestamp: "2026-01-01T00:00:02.000Z", targetId: "a1", replacement: { content: "should not apply" } },
	];
	const projection = buildSessionProjection(entries);
	assert.deepEqual(plain(projection.path.map((entry) => entry.id)), ["u1", "b1", "e-side"]);
	// 编辑被收集（它在分支上），但 a1 不在 contextEntries 里，因此无任何消息被改写：
	// 特别是不得把 a1 的内容重新注入上下文。
	assert.equal(projection.edits.has("a1"), true);
	assert.deepEqual(plain(projection.messages.map((message) => message.content)), ["shared", "side answer"]);
});

/** 目标在压缩归档区间内：编辑仍在分支上，但该条目已不进上下文，不应凭空复活它。 */
test("context_edit：目标已被压缩归档时，编辑不使该条目重新进入上下文", () => {
	const entries = [msg("u1", null, "user", "archived"), compact("c1", "u1", "u2"), msg("u2", "c1", "user", "kept"), { type: "context_edit", id: "e1", parentId: "u2", timestamp: "2026-01-01T00:00:02.000Z", targetId: "u1", replacement: { content: "resurrect?" } }];
	const projection = buildSessionProjection(entries);
	assert.deepEqual(plain(projection.contextEntries.map((entry) => entry.id)), ["c1", "u2", "e1"]);
	// u1 不在 contextEntries 里 → 不产生消息；编辑记录本身不贡献上下文。
	assert.deepEqual(plain(projection.messages.map((message) => message.content)), ["kept"]);
});

test("context_edit：compaction 之后的编辑照常生效", () => {
	const entries = [msg("u1", null, "user", "archived"), compact("c1", "u1", "u2"), msg("u2", "c1", "user", "kept"), { type: "context_edit", id: "e1", parentId: "u2", timestamp: "2026-01-01T00:00:02.000Z", targetId: "u2", replacement: { content: "edited kept" } }];
	const projection = buildSessionProjection(entries);
	assert.ok(projection.messages.some((message) => message.content === "edited kept"));
});

test("parseReplacement：null=排除，含 content 的对象=替换，其余=无效（不当作排除）", () => {
	assert.deepEqual(plain(parseReplacement(null)), { kind: "excluded" });
	assert.deepEqual(plain(parseReplacement({ content: "x" })), { kind: "replaced", content: "x" });
	assert.deepEqual(plain(parseReplacement({ content: [{ type: "text", text: "x" }] })), { kind: "replaced", content: [{ type: "text", text: "x" }] });
	// 畸形形态绝不能当「排除」——那会静默丢失上下文，且用户看不到原因。
	assert.deepEqual(plain(parseReplacement(undefined)), { kind: "invalid" });
	assert.deepEqual(plain(parseReplacement({})), { kind: "invalid" });
	assert.deepEqual(plain(parseReplacement({ content: 42 })), { kind: "invalid" });
	assert.deepEqual(plain(parseReplacement("null")), { kind: "invalid" });
});

test("畸形 replacement 不生效：条目内容按原文进入上下文", () => {
	const entries = [...linearSession(), { type: "context_edit", id: "e1", parentId: "a2", timestamp: "2026-01-01T00:00:02.000Z", targetId: "u1", replacement: { content: 42 } }];
	const projection = buildSessionProjection(entries);
	assert.equal(projection.messages[0].content, "hello", "畸形编辑应被忽略，而不是把消息移出上下文");
	const projected = projection.projectedEntries.find((entry) => entry.entryId === "u1");
	assert.equal(projected?.excluded, false);
	assert.equal(projected?.edit, undefined, "无效编辑不暴露为生效编辑");
});

test("context_edit 指向不存在的条目 / 缺 targetId：安全忽略，不影响其他消息", () => {
	const entries = [...linearSession(), { type: "context_edit", id: "e1", parentId: "a2", timestamp: "2026-01-01T00:00:02.000Z", targetId: "ghost", replacement: null }, { type: "context_edit", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:03.000Z", replacement: null }];
	const projection = buildSessionProjection(entries);
	assert.deepEqual(plain(projection.messages.map((message) => message.content)), ["hello", "hi", "more", "sure"]);
});

/**
 * 旧 PiDeck 墓碑（type:"deleted"）是原地替换格式，与 pi 原生 context_edit 并存。
 * 读取端必须继续跳过它们（这些条目没有 message，本来就不贡献上下文），
 * 且不能让父链断裂。
 */
test("旧版 deleted 墓碑：不贡献上下文且不打断父链", () => {
	const entries = [msg("u1", null, "user", "hello"), { type: "deleted", id: "a1", originalEntryId: "a1", parentId: "u1", ts: 1 }, msg("u2", "a1", "user", "next")];
	const projection = buildSessionProjection(entries);
	assert.deepEqual(plain(projection.path.map((entry) => entry.id)), ["u1", "a1", "u2"], "父链必须穿过墓碑");
	assert.deepEqual(plain(projection.messages.map((message) => message.content)), ["hello", "next"]);
});

test("自定义消息与分支摘要：custom_message 进入上下文，label 类条目不进入", () => {
	const entries = [
		msg("u1", null, "user", "hi"),
		{ type: "custom_message", id: "cm1", parentId: "u1", customType: "notice", content: "note", display: true, timestamp: "2026-01-01T00:00:00.000Z" },
		{ type: "label", id: "l1", parentId: "cm1", targetId: "u1", label: "checkpoint", timestamp: "2026-01-01T00:00:01.000Z" },
		{ type: "branch_summary", id: "bs1", parentId: "l1", fromId: "u1", summary: "explored A", timestamp: "2026-01-01T00:00:02.000Z" },
	];
	const projection = buildSessionProjection(entries);
	assert.ok(
		projection.contextEntries.some((entry) => entry.id === "cm1"),
		"custom_message 应进入上下文",
	);
	assert.ok(
		projection.contextEntries.some((entry) => entry.id === "bs1"),
		"带 summary 的 branch_summary 进入上下文",
	);
	// label 只是元数据（不贡献消息），但必须保留在路径上供 UI 标注。
	assert.ok(projection.contextEntries.some((entry) => entry.id === "l1"));
	assert.equal(projection.projectedEntries.find((entry) => entry.entryId === "l1")?.messages.length, 0);
});

test("parseSessionEntries：坏行跳过，好行保留（单行损坏不应吞掉整段历史）", () => {
	const entries = parseSessionEntries(['{"type":"message","id":"u1","parentId":null}', "{not json", "", '{"type":"message","id":"u2","parentId":"u1"}']);
	assert.deepEqual(plain(entries.map((entry) => entry.id)), ["u1", "u2"]);
});

test("collectEffectiveEdits / buildSessionProjection：leaf 缺省取最后一条带 id 的条目", () => {
	const entries = linearSession();
	const projection = buildSessionProjection(entries);
	assert.deepEqual(plain(projection.path.map((entry) => entry.id)), ["u1", "a1", "u2", "a2"]);
	const edits = collectEffectiveEdits([...entries, { type: "context_edit", id: "e1", targetId: "u1", replacement: null }]);
	assert.equal(edits.size, 1);
	assert.equal(edits.get("u1")?.replacement.kind, "excluded");
});
