import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const normalize = await loadTsCommonJs("src/main/sessions/importNormalize.ts");

test("safeIsoTimestamp：合法值直通、畸形值回退 epoch 而非 RangeError", () => {
	assert.equal(normalize.safeIsoTimestamp(1700000000000), new Date(1700000000000).toISOString());
	assert.equal(normalize.safeIsoTimestamp("2026-03-01T00:00:00Z"), "2026-03-01T00:00:00.000Z");
	// 1e300 超出 ±8.64e15 → Invalid Date → 旧实现 toISOString 抛 RangeError
	assert.equal(normalize.safeIsoTimestamp(1e300), "1970-01-01T00:00:00.000Z");
	assert.equal(normalize.safeIsoTimestamp(Number.NaN), "1970-01-01T00:00:00.000Z");
	assert.equal(normalize.safeIsoTimestamp(Number.POSITIVE_INFINITY), "1970-01-01T00:00:00.000Z");
});

function writeClaudeSession(home, projectPath, sessionId, entries) {
	const slug = projectPath
		.replace(/\\/g, "/")
		.replace(/^([A-Za-z]):\//, "$1--")
		.replace(/\//g, "-");
	const dir = join(home, ".claude", "projects", slug);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
	return file;
}

// Claude scan 兜底：单条畸形会话（content 数组含 null / 数字 sessionId）
// 只降级自己，不再让整个 scan 列表 reject（2026-03 导入器审计实测旧实现整列表裸错误）。
test("Claude scan：单条畸形会话只跳过自己，列表其余会话正常返回", async () => {
	const home = mkdtempSync(join(tmpdir(), "claude-home-"));
	const projectPath = "F:\\PiDeck";
	writeClaudeSession(home, projectPath, "s-good", [
		{ type: "user", sessionId: "s-good", cwd: projectPath, timestamp: "2026-03-01T00:00:00Z", message: { role: "user", content: "hello" } },
		{ type: "assistant", timestamp: "2026-03-01T00:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
	]);
	// content 数组含 null（合法 JSON，畸形导出）——旧实现在 item.type 处 TypeError 炸整列表
	writeClaudeSession(home, projectPath, "s-null", [{ type: "user", sessionId: "s-null", cwd: projectPath, timestamp: "2026-03-01T00:00:00Z", message: { role: "user", content: [null] } }]);
	// 数字 sessionId——旧实现 truthy 检查放行后下游 .replace TypeError
	writeClaudeSession(home, projectPath, "s-num", [{ type: "user", sessionId: 123, cwd: projectPath, timestamp: "2026-03-01T00:00:00Z", message: { role: "user", content: "x" } }]);

	const { ClaudeSessionImporter } = await loadTsCommonJs("src/main/sessions/ClaudeSessionImporter.ts", {
		stubs: { electron: { app: { getPath: () => home } } },
	});
	const importer = new ClaudeSessionImporter();
	const summaries = await importer.scan(projectPath);
	// 核心回归点：旧实现在数字 sessionId 场景下 scan 整体 reject（裸错误过 IPC）；
	// 修复后畸形自己被跳过，good 会话必在列表里（s-null 的 null content 只影响 import 层，scan 层合法）
	assert.ok(summaries.some((s) => String(s.sessionId ?? s.id ?? "").includes("good")));
	assert.ok(!summaries.some((s) => String(s.sessionId ?? s.id ?? "").includes("num")));
});
