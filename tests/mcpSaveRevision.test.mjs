/**
 * mcp.json 保存的乐观锁契约（P1-1 回归）。
 *
 * 历史缺陷（2026-10-04 实测）：MCP 页草稿保存会静默覆盖外部手改——界面加载后文件被
 * pi/手改/其它窗口改过，保存时整份写回，外部修改无提示丢失。修复后快照携带可写层
 * 内容哈希（revision），保存时回传比对：不匹配 = 拒绝覆盖并要求重新加载。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { loadMcpConfigSnapshot, saveMcpConfigFile } = loadTsCommonJs("src/main/config/mcpConfig.ts");
const { revisionOf } = loadTsCommonJs("src/main/config/piConfigFileStore.ts");

test("快照携带可写层 revision：内容变更则 revision 变化，文件缺失为 missing 哨兵", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-mcp-rev-"));
	try {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const mcpJson = join(agentDir, "mcp.json");
		const missing = await loadMcpConfigSnapshot(agentDir);
		assert.equal(missing.revision, "missing");

		writeFileSync(mcpJson, JSON.stringify({ mcpServers: { a: { url: "https://a/mcp" } } }), "utf8");
		const first = await loadMcpConfigSnapshot(agentDir);
		assert.equal(first.revision, revisionOf(readFileSync(mcpJson, "utf8"), true));

		writeFileSync(mcpJson, JSON.stringify({ mcpServers: { a: { url: "https://b/mcp" } } }), "utf8");
		const second = await loadMcpConfigSnapshot(agentDir);
		assert.notEqual(second.revision, first.revision);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("saveMcpConfigFile：revision 匹配才写入；不匹配拒绝并返回磁盘当前 revision", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-mcp-save-"));
	try {
		const mcpJson = join(root, "mcp.json");
		writeFileSync(mcpJson, JSON.stringify({ mcpServers: { keep: { url: "https://keep/mcp" } }, unknownTopLevel: 1 }), "utf8");
		const snapshot = await loadMcpConfigSnapshot(root);

		// 过期 revision：拒绝覆盖，且返回磁盘当前 revision 供刷新
		const stale = await saveMcpConfigFile(mcpJson, { mcpServers: { evil: { url: "https://evil/mcp" } } }, { expectedRevision: snapshot.revision + "-stale" });
		assert.equal(stale.ok, false);
		assert.equal(stale.conflict, true);
		assert.ok(stale.revision && stale.revision !== snapshot.revision + "-stale");
		// 外部内容未被覆盖
		assert.ok(readFileSync(mcpJson, "utf8").includes("keep"));

		// 匹配 revision：写入成功，只替换 mcpServers 键、顶层未知字段保留
		const ok = await saveMcpConfigFile(mcpJson, { mcpServers: { next: { url: "https://next/mcp" } } }, { expectedRevision: snapshot.revision });
		assert.equal(ok.ok, true);
		const saved = JSON.parse(readFileSync(mcpJson, "utf8"));
		assert.deepEqual(Object.keys(saved.mcpServers), ["next"]);
		assert.equal(saved.unknownTopLevel, 1);

		// 不带 expectedRevision = 不校验（兼容旧调用方）
		const unguarded = await saveMcpConfigFile(mcpJson, { mcpServers: {} });
		assert.equal(unguarded.ok, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("saveMcpConfigFile：missing 哨兵只在文件确实不存在时放行「从无到有」写入", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-mcp-missing-"));
	try {
		const mcpJson = join(root, "mcp.json");
		const create = await saveMcpConfigFile(mcpJson, { mcpServers: { fresh: { url: "https://fresh/mcp" } } }, { expectedRevision: "missing" });
		assert.equal(create.ok, true);
		assert.ok(readFileSync(mcpJson, "utf8").includes("fresh"));

		// 文件已存在后再拿 "missing" 当期望值：必须冲突，不能把外部内容覆盖掉
		const staleMissing = await saveMcpConfigFile(mcpJson, { mcpServers: {} }, { expectedRevision: "missing" });
		assert.equal(staleMissing.ok, false);
		assert.equal(staleMissing.conflict, true);
		assert.ok(readFileSync(mcpJson, "utf8").includes("fresh"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
