/**
 * 跨会话正文搜索：sidecar 命中按「会话文件路径」映射回 catalog 记录。
 *
 * 回归背景：`SessionRecord.id` 是跨重启稳定的 UUID，`filePath` 是独立字段；
 * 渲染层曾用 `records[hit.filePath]` 取值，而 `sessionRecordsAtom` 以 id 为键，
 * 于是映射恒为 undefined、所有命中被过滤掉，侧栏正文结果区块永远不渲染。
 *
 * 这里把映射策略抽成纯函数钉住（组件只做呈现），同时覆盖 Windows 分隔符/盘符大小写
 * 与 POSIX 大小写敏感两条路径。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildSessionContentSearchHits, sessionFilePathKey, sessionSearchItemFields } = loadTsCommonJs("src/renderer/src/utils/sessionContentSearchHits.ts");
// 命令面板的会话项构造：图标来自 lucide（纯展示），测试里桩掉避免拉整包。
const { buildSidebarSearchItems } = loadTsCommonJs("src/renderer/src/components/sidebar/sidebarSearchItems.ts", {
	stubs: { "lucide-react": { Folder: () => null, MessageSquare: () => null } },
});
const { filterSearchItems } = loadTsCommonJs("src/renderer/src/components/motion/morphingSearchFilter.ts");

/** 完整 SessionRecord 工厂：测试数据不依赖运行时缺省字段。 */
function record(id, filePath, extra = {}) {
	return {
		id,
		projectId: "p1",
		title: `会话 ${id}`,
		source: "pi",
		environment: "windows",
		filePath,
		preview: "",
		messageCount: 1,
		status: "active",
		createdAt: 1,
		updatedAt: 1,
		...extra,
	};
}

function hit(filePath, matches = [{ messageId: "m1", role: "user", timestampMs: 1, snippet: "alpha 命中" }], extra = {}) {
	return { filePath, updatedAtMs: 1, matches, ...extra };
}

test("按 filePath 映射回以 UUID id 为键的记录（不再依赖 records[filePath]）", () => {
	const records = { "uuid-1": record("uuid-1", "C:\\sessions\\a.jsonl") };
	const result = { sessions: [hit("C:\\sessions\\a.jsonl", undefined, { hitCount: 3 })], totalHitSessions: 1, truncated: false };

	const hits = buildSessionContentSearchHits(result, records);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].record.id, "uuid-1");
	assert.equal(hits[0].matchCount, 3);
	assert.equal(hits[0].firstMessageId, "m1");
	assert.equal(hits[0].snippet, "alpha 命中");
});

test("没有 hitCount 时回退到 matches.length（与组件展示口径一致）", () => {
	const records = { "uuid-1": record("uuid-1", "/home/u/.pi/a.jsonl") };
	const result = {
		sessions: [
			hit("/home/u/.pi/a.jsonl", [
				{ messageId: "m1", role: "user", timestampMs: 1, snippet: "x" },
				{ messageId: "m2", role: "assistant", timestampMs: 2, snippet: "y" },
			]),
		],
		totalHitSessions: 1,
		truncated: false,
	};

	const hits = buildSessionContentSearchHits(result, records);
	assert.equal(hits[0].matchCount, 2);
});

test("Windows 分隔符与盘符大小写不同也能命中（sidecar 与 catalog 的写法可能不一致）", () => {
	const records = { "uuid-1": record("uuid-1", "C:\\Users\\u\\a.jsonl") };
	const result = { sessions: [hit("c:/users/u/a.jsonl")], totalHitSessions: 1, truncated: false };

	assert.equal(buildSessionContentSearchHits(result, records).length, 1);
});

test("POSIX 路径大小写敏感：不因大小写折叠误配另一个文件", () => {
	const records = { "uuid-1": record("uuid-1", "/home/u/A.jsonl") };
	const result = { sessions: [hit("/home/u/a.jsonl")], totalHitSessions: 1, truncated: false };

	assert.equal(buildSessionContentSearchHits(result, records).length, 0);
});

test("映射缺失与空命中的条目被丢弃，其余命中保留", () => {
	const records = {
		"uuid-1": record("uuid-1", "C:\\sessions\\a.jsonl"),
		// 匿名/DSH 会话没有 filePath，不参与映射
		"uuid-2": record("uuid-2", undefined, { noSession: true }),
	};
	const result = {
		sessions: [hit("C:\\sessions\\a.jsonl"), hit("C:\\sessions\\missing.jsonl"), hit("C:\\sessions\\empty.jsonl", [])],
		totalHitSessions: 3,
		truncated: false,
	};

	const hits = buildSessionContentSearchHits(result, records);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].record.id, "uuid-1");
});

test("降级（result 为 null）返回空数组，不抛错", () => {
	const hits = buildSessionContentSearchHits(null, { "uuid-1": record("uuid-1", "C:\\a.jsonl") });
	assert.equal(Array.isArray(hits), true);
	assert.equal(hits.length, 0);
});

test("路径键：Windows 路径折叠分隔符与盘符大小写，POSIX 原样", () => {
	assert.equal(sessionFilePathKey("C:\\Sessions\\A.jsonl"), "c:/sessions/a.jsonl");
	assert.equal(sessionFilePathKey("/home/u/A.jsonl"), "/home/u/A.jsonl");
});

// ── #610：命令面板（Ctrl+F）的会话项 ──────────────────────────────────────
// 面板原先只能按标题/预览命中，点开只「打开会话」——用户搜的是正文里的词，落点却在顶部。
// 规则收口在 sessionSearchItemFields（纯函数），条目构造在 sidebarSearchItems。

test("正文命中：片段顶替预览、片段参与匹配、带首条命中的跳转目标", () => {
	const fields = sessionSearchItemFields("旧的预览文字", { record: record("uuid-1", "/a.jsonl"), matchCount: 2, firstMessageId: "m9", snippet: "这里才是用户搜的词" });
	assert.equal(fields.description, "这里才是用户搜的词");
	assert.deepEqual([...fields.keywords], ["这里才是用户搜的词"]);
	assert.equal(fields.jumpMessageId, "m9");
});

test("没有正文命中：保持预览、不加关键词、不带跳转目标", () => {
	const fields = sessionSearchItemFields("预览", undefined);
	assert.equal(fields.description, "预览");
	assert.deepEqual([...fields.keywords], []);
	assert.equal(fields.jumpMessageId, undefined);
});

test("片段为空时回退预览，且不把空串塞进 keywords（否则任意查询都命中）", () => {
	const fields = sessionSearchItemFields("预览", { record: record("uuid-1", "/a.jsonl"), matchCount: 1, firstMessageId: "m1", snippet: "   " });
	assert.equal(fields.description, "预览");
	assert.deepEqual([...fields.keywords], []);
	// 跳转目标仍然有效：命中确实存在，只是片段没取到
	assert.equal(fields.jumpMessageId, "m1");
});

test("面板条目：正文命中会话带着跳转目标打开，未命中会话只打开", () => {
	const hits = buildSessionContentSearchHits({ sessions: [hit("/home/u/.pi/a.jsonl", [{ messageId: "m7", role: "user", timestampMs: 1, snippet: "正文里的词" }])], totalHitSessions: 1, truncated: false }, { "uuid-1": record("uuid-1", "/home/u/.pi/a.jsonl") });
	const contentHits = new Map(hits.map((entry) => [entry.record.id, entry]));
	const opened = [];
	const items = buildSidebarSearchItems({
		projects: [{ id: "p1", path: "/home/u/proj", name: "proj", environment: "windows" }],
		sessionsByProject: { p1: [record("uuid-1", "/home/u/.pi/a.jsonl"), record("uuid-2", "/home/u/.pi/b.jsonl")] },
		contentHits,
		onSelectProject: () => {},
		onOpenSession: (projectId, sessionId, jumpMessageId) => opened.push({ projectId, sessionId, jumpMessageId }),
	});

	const sessionItems = items.filter((item) => item.id.startsWith("session:"));
	assert.equal(sessionItems.length, 2);
	const hitItem = sessionItems.find((item) => item.id === "session:uuid-1");
	assert.equal(hitItem.description, "正文里的词");
	assert.deepEqual([...hitItem.keywords], ["正文里的词"]);
	hitItem.onSelect();
	assert.deepEqual(opened.at(-1), { projectId: "p1", sessionId: "uuid-1", jumpMessageId: "m7" });

	const plainItem = sessionItems.find((item) => item.id === "session:uuid-2");
	plainItem.onSelect();
	assert.deepEqual(opened.at(-1), { projectId: "p1", sessionId: "uuid-2", jumpMessageId: undefined });

	// 端到端：标题不含查询词的命中会话，必须仍能被面板筛选留下（靠片段进 keywords）
	const kept = filterSearchItems(items, "正文里的词").map((item) => item.id);
	assert.deepEqual([...kept], ["session:uuid-1"]);
	// 反向守卫：预览里的旧文字不再让未命中会话被这条查询留下
	assert.equal(filterSearchItems(items, "旧的预览").length, 0);
});
