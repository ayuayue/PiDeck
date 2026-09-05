import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * DSH 会话统计挂载护栏：host 必须挂官方 dsh-session-stats（dsh-web StatsLine 同源），
 * 否则没有 sessionStats 投影，输入框底下不会出现「N 轮 · M 步」。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "package.json"));

test("package.json keeps dsh-session-stats in devDependencies for the runtime archive", () => {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	assert.ok(
		pkg.devDependencies["@deepseek-ai/dsh-session-stats"],
		"@deepseek-ai/dsh-session-stats must be a devDependency (deps partitioned into the dsh-runtime archive)",
	);
});

test("dsh-session-stats is resolvable from the app root", () => {
	const resolved = require.resolve("@deepseek-ai/dsh-session-stats");
	assert.ok(existsSync(resolved), `missing ${resolved}`);
	const pkg = JSON.parse(
		readFileSync(require.resolve("@deepseek-ai/dsh-session-stats/package.json"), "utf8"),
	);
	assert.equal(pkg.name, "@deepseek-ai/dsh-session-stats");
});

test("hostEntry composition inserts the session-stats plugin row", () => {
	const src = readFileSync(join(repoRoot, "src/main/dsh/hostEntry.ts"), "utf8");
	assert.match(src, /id:\s*"session-stats"/);
	assert.match(src, /name:\s*"@deepseek-ai\/dsh-session-stats"/);
});

test("runtime state falls back to message-derived turns when sessionStats is missing", () => {
	const src = readFileSync(join(repoRoot, "src/main/dsh/DshAgentManager.ts"), "utf8");
	assert.match(src, /deriveSessionStatsFallback/);
	assert.match(src, /sessionStatsRaw = runtime\.sessionStats \?\? deriveSessionStatsFallback\(runtime\.messages\)/);
	assert.match(src, /this\.emitRuntimeState\(agentId\)/);
});
