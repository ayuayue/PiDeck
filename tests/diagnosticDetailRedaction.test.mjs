/**
 * 诊断包 detail 脱敏：redactDetail 是 #374 的修复主体。
 *
 * 背景：诊断 zip 之前只保留 time/level/scope/message，detail 整列被白名单丢弃，
 * 错误定位信息（require stack、超时毫秒数、原始 stderr）无法随包带出。
 * 补上 detail 的同时必须保证它不比 message 更松——这里逐条锁定脱敏与边界。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { REDACTED, createPathMasker, redactDetail } = loadTsCommonJs("src/main/health/redact.ts");

const maskHome = createPathMasker("C:/Users/john");

test("redactDetail masks home paths inside strings", () => {
	const detail = { path: "C:/Users/john/AppData/Roaming/PiDeck/app.log" };
	const out = redactDetail(detail, maskHome);
	assert.equal(out.path, "~/AppData/Roaming/PiDeck/app.log");
});

test("redactDetail masks credentials inside strings", () => {
	const out = redactDetail({ stderr: "curl -H 'Authorization: Bearer abcdefghijklmnop'" }, maskHome);
	assert.ok(!out.stderr.includes("abcdefghijklmnop"));
	assert.ok(out.stderr.includes(REDACTED));
});

test("redactDetail replaces values under sensitive keys even without known prefixes", () => {
	// 裸值没有 sk-/Bearer 前缀，文本正则洗不到，必须按键名判定
	const out = redactDetail({ apiKey: "aBc123xYz", token: "plain-credential", password: "hunter2" }, maskHome);
	assert.equal(out.apiKey, REDACTED);
	assert.equal(out.token, REDACTED);
	assert.equal(out.password, REDACTED);
});

test("redactDetail keeps non-sensitive scalars untouched", () => {
	// 逐字段断言：loadTsCommonJs 跨 vm realm，deepEqual 会因原型不同而失败
	const out = redactDetail({ status: 500, ok: false, missing: null, elapsedMs: 10000 }, maskHome);
	assert.equal(out.status, 500);
	assert.equal(out.ok, false);
	assert.equal(out.missing, null);
	assert.equal(out.elapsedMs, 10000);
});

test("redactDetail recurses into nested objects and arrays", () => {
	const out = redactDetail(
		{
			error: { code: "MODULE_NOT_FOUND", requireStack: ["C:/Users/john/proj/index.js"] },
			attempts: [1000, 2000],
		},
		maskHome,
	);
	assert.equal(out.error.requireStack[0], "~/proj/index.js");
	assert.equal(out.attempts.length, 2);
	assert.equal(out.attempts[0], 1000);
	assert.equal(out.attempts[1], 2000);
});

test("redactDetail truncates oversized strings", () => {
	const long = "x".repeat(1200);
	const out = redactDetail({ stack: long }, maskHome);
	assert.ok(out.stack.length <= 500);
	assert.ok(out.stack.endsWith("…"));
});

test("redactDetail caps array length with a marker", () => {
	const out = redactDetail({ items: Array.from({ length: 30 }, (_, i) => i) }, maskHome);
	assert.equal(out.items.length, 21); // 20 项 + 1 条省略标记
	assert.equal(out.items[20], "[...10 more]");
});

test("redactDetail caps recursion depth", () => {
	let deep = { value: "leaf" };
	for (let i = 0; i < 8; i++) deep = { nested: deep };
	let cursor = redactDetail(deep, maskHome);
	let hops = 0;
	while (cursor && typeof cursor === "object" && "nested" in cursor) {
		cursor = cursor.nested;
		hops++;
	}
	assert.equal(cursor, "[truncated]");
	assert.ok(hops <= 4);
});

test("redactDetail survives circular references", () => {
	const cyclic = { name: "root" };
	cyclic.self = cyclic;
	const out = redactDetail(cyclic, maskHome);
	assert.equal(out.name, "root");
	assert.equal(out.self, "[circular]");
});

test("redactDetail drops unserializable values", () => {
	const out = redactDetail({ fn: () => 1, keep: "ok" }, maskHome);
	assert.equal(out.keep, "ok");
	assert.ok(!("fn" in out));
});

test("redactDetail returns primitives as-is", () => {
	assert.equal(redactDetail("plain", maskHome), "plain");
	assert.equal(redactDetail(42, maskHome), 42);
	assert.equal(redactDetail(null, maskHome), null);
	assert.equal(redactDetail(undefined, maskHome), undefined);
});

// 集成层：确认修复真正接进了诊断导出的逐行处理，而不只是纯函数可用
const { LogBundleExporter } = loadTsCommonJs("src/main/health/LogBundleExporter.ts", {
	stubs: { electron: { app: { getPath: () => "C:/Users/john" }, dialog: {} } },
});

function exportLine(entry) {
	const exporter = new LogBundleExporter({ appLogger: {} });
	const out = exporter.redactLogText(`${JSON.stringify(entry)}\n`);
	return JSON.parse(out.trim());
}

test("diagnostic export keeps redacted detail instead of dropping it", () => {
	const line = exportLine({
		id: "1",
		time: 1,
		level: "error",
		scope: "upstream",
		message: "request failed",
		detail: {
			command: "git status",
			path: "C:/Users/john/proj/app.ts",
			stderr: "fatal: not a git repository",
			token: "plain-credential",
		},
	});
	assert.equal(line.message, "request failed");
	assert.equal(line.detail.command, "git status");
	assert.equal(line.detail.path, "~/proj/app.ts");
	assert.equal(line.detail.stderr, "fatal: not a git repository");
	assert.equal(line.detail.token, REDACTED);
});

test("diagnostic export omits detail key when the log line has none", () => {
	const line = exportLine({ id: "1", time: 1, level: "info", scope: "app", message: "started" });
	assert.ok(!("detail" in line));
});

test("diagnostic export still drops unparsable lines", () => {
	const exporter = new LogBundleExporter({ appLogger: {} });
	assert.equal(exporter.redactLogText("not-json\n{broken\n"), "");
});
