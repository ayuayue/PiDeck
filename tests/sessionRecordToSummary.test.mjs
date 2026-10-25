import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sessionRecordToSummary } = loadTsCommonJs("src/renderer/src/atoms/session-selectors.ts");

const baseRecord = {
	id: "session-1",
	projectId: "project-1",
	title: "pi-desktop DSH",
	source: "pi",
	environment: "native",
	status: "active",
	createdAt: 1000,
	updatedAt: 2000,
	preview: "",
	messageCount: 0,
};

test("pi 会话无 filePath 仍不投影（文件会话必须有路径）", () => {
	const summary = sessionRecordToSummary({ ...baseRecord, filePath: undefined });
	assert.equal(summary, undefined);
});

test("DSH 会话无 filePath 投影进侧栏列表（filePath 空串 + backend + dshSessionId）", () => {
	const summary = sessionRecordToSummary({
		...baseRecord,
		filePath: undefined,
		backend: "dsh",
		dshSessionId: "session-abc-123",
	});
	assert.ok(summary, "DSH 会话必须进列表");
	assert.equal(summary.id, "session-1");
	assert.equal(summary.filePath, "");
	assert.equal(summary.backend, "dsh");
	assert.equal(summary.dshSessionId, "session-abc-123");
	assert.equal(summary.name, "pi-desktop DSH");
});

test("ACP 会话无 filePath 投影进侧栏列表（backend + acpToolId 品牌徽标用）", () => {
	// ACP 会话由 CLI 自持久化（无 pi 文件），重启/运行时释放后必须仍在侧栏可见；
	// acpToolId 供侧栏/tab 解析工具品牌徽标（与消息区 TurnAuthorHeader 同源）。
	const summary = sessionRecordToSummary({
		...baseRecord,
		title: "Claude 会话",
		filePath: undefined,
		backend: "acp",
		acpSessionId: "acp-sess-9",
		acpToolId: "acp-tool-mv7pwvnq",
	});
	assert.ok(summary, "ACP 会话必须进列表");
	assert.equal(summary.backend, "acp");
	assert.equal(summary.acpToolId, "acp-tool-mv7pwvnq");
	assert.equal(summary.filePath, "");
});

test("有 filePath 的会话投影保持不变", () => {
	const summary = sessionRecordToSummary({
		...baseRecord,
		filePath: "C:\\work\\session.jsonl",
	});
	assert.ok(summary);
	assert.equal(summary.filePath, "C:\\work\\session.jsonl");
});

test("侧边任务标记透传给侧栏列表（列表照常收录，只多一枚徽标）", () => {
	const summary = sessionRecordToSummary({ ...baseRecord, filePath: "C:\\work\\task.jsonl", sideTask: true });
	assert.equal(summary.sideTask, true);
});

test("普通会话投影不带 sideTask 字段值", () => {
	const summary = sessionRecordToSummary({ ...baseRecord, filePath: "C:\\work\\task.jsonl" });
	assert.equal(summary.sideTask, undefined);
});
