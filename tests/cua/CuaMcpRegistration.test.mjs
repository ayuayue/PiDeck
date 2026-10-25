import assert from "node:assert";
import test from "node:test";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// CuaMcpRegistration resolves homedir() at call time, so we point HOME /
// USERPROFILE at a temp dir and re-import with a cache-busting query.

const fakeHome = join(tmpdir(), `cua-mcp-test-${Date.now()}`);
mkdirSync(fakeHome, { recursive: true });

const URL1 = "http://127.0.0.1:31415/mcp";
const TOKEN1 = "tok-abc";

test("ensureCuaMcpRegistered writes a url entry to ~/.pi/agent/mcp.json", async () => {
	process.env.HOME = fakeHome;
	process.env.USERPROFILE = fakeHome;

	const mod = await import(`../../src/main/cua/CuaMcpRegistration.ts?t=${Date.now()}`);

	const result = mod.ensureCuaMcpRegistered({ url: URL1, bearerToken: TOKEN1 });
	assert.strictEqual(result.written, true);

	const mcpPath = join(fakeHome, ".pi", "agent", "mcp.json");
	assert.ok(existsSync(mcpPath));

	const config = JSON.parse(readFileSync(mcpPath, "utf8"));
	const entry = config.mcpServers["pideck-cua"];
	assert.ok(entry);
	assert.strictEqual(entry.url, URL1);
	// pi 0.99 内置 MCP schema：auth / bearerToken / lifecycle 不再被识别（见文件头注释）。
	assert.strictEqual(entry.auth, undefined);
	assert.strictEqual(entry.bearerToken, undefined);
	assert.strictEqual(entry.lifecycle, undefined);
	assert.deepStrictEqual(entry.headers, { Authorization: `Bearer ${TOKEN1}` });
	assert.strictEqual(entry.exposure, "direct");
	assert.strictEqual(entry.command, undefined);
});

test("ensureCuaMcpRegistered is idempotent for the same definition", async () => {
	const mod = await import(`../../src/main/cua/CuaMcpRegistration.ts?t=${Date.now() + 1}`);
	const result = mod.ensureCuaMcpRegistered({ url: URL1, bearerToken: TOKEN1 });
	assert.strictEqual(result.written, false);
});

test("ensureCuaMcpRegistered updates a changed definition", async () => {
	const mod = await import(`../../src/main/cua/CuaMcpRegistration.ts?t=${Date.now() + 2}`);
	const result = mod.ensureCuaMcpRegistered({ url: "http://127.0.0.1:40999/mcp", bearerToken: "tok-2" });
	assert.strictEqual(result.written, true);

	const mcpPath = join(fakeHome, ".pi", "agent", "mcp.json");
	const config = JSON.parse(readFileSync(mcpPath, "utf8"));
	assert.strictEqual(config.mcpServers["pideck-cua"].url, "http://127.0.0.1:40999/mcp");
	assert.deepStrictEqual(config.mcpServers["pideck-cua"].headers, { Authorization: "Bearer tok-2" });
});

test("ensureCuaMcpRegistered preserves other servers", async () => {
	const mcpPath = join(fakeHome, ".pi", "agent", "mcp.json");
	const config = JSON.parse(readFileSync(mcpPath, "utf8"));
	config.mcpServers["other-server"] = { command: "other", args: [] };
	const { writeFileSync } = await import("node:fs");
	writeFileSync(mcpPath, JSON.stringify(config, null, 2), "utf8");

	const mod = await import(`../../src/main/cua/CuaMcpRegistration.ts?t=${Date.now() + 3}`);
	mod.ensureCuaMcpRegistered({ url: "http://127.0.0.1:31415/mcp", bearerToken: "tok-3" });

	const after = JSON.parse(readFileSync(mcpPath, "utf8"));
	assert.ok(after.mcpServers["other-server"], "other server must be preserved");
	assert.ok(after.mcpServers["pideck-cua"]);
});

test("unregisterCuaMcp removes the entry", async () => {
	const mod = await import(`../../src/main/cua/CuaMcpRegistration.ts?t=${Date.now() + 4}`);
	const result = mod.unregisterCuaMcp();
	assert.strictEqual(result.removed, true);

	const mcpPath = join(fakeHome, ".pi", "agent", "mcp.json");
	const config = JSON.parse(readFileSync(mcpPath, "utf8"));
	assert.ok(!config.mcpServers["pideck-cua"]);
});

test("unregisterCuaMcp is idempotent", async () => {
	const mod = await import(`../../src/main/cua/CuaMcpRegistration.ts?t=${Date.now() + 5}`);
	const result = mod.unregisterCuaMcp();
	assert.strictEqual(result.removed, false);
});

test("cleanup temp home", () => {
	rmSync(fakeHome, { recursive: true, force: true });
	assert.ok(!existsSync(fakeHome));
});
