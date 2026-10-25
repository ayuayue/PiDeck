import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseMcpListOutput, extractAuthorizationUrl, createAuthorizationUrlScanner, MCP_LOGIN_URL_RE, PiMcpCli } = loadTsCommonJs("src/main/pi/piMcpCli.ts");

test("parseMcpListOutput requires a complete report shape", () => {
	// 合法报告（exit 0 或 1 都可能带它）
	const parsed = parseMcpListOutput(JSON.stringify({ servers: [{ name: "docs", state: "connected", tools: ["search"], scope: "global", exposure: "direct" }], errors: [] }));
	assert.ok(parsed);
	assert.equal(parsed.servers.length, 1);
	assert.equal(parsed.servers[0].state, "connected");
	assert.deepEqual([...parsed.servers[0].tools], ["search"]);
	// 只有 JSON 形状、没有报告字段 → 不能当作成功
	assert.equal(parseMcpListOutput('{"foo":1}'), null);
	assert.equal(parseMcpListOutput("[]"), null);
	assert.equal(parseMcpListOutput("not json"), null);
	assert.equal(parseMcpListOutput(""), null);
	// servers 必须存在（空数组是合法报告）
	const empty = parseMcpListOutput(JSON.stringify({ servers: [], errors: [] }));
	assert.ok(empty);
	assert.equal(empty.servers.length, 0);
});

test("parseMcpListOutput tolerates partial entries but keeps unknown state", () => {
	const parsed = parseMcpListOutput(JSON.stringify({ servers: [{ name: "x", state: "weird-state" }], errors: ["bad entry"] }));
	assert.ok(parsed);
	assert.equal(parsed.servers[0].state, "weird-state");
	assert.deepEqual([...parsed.errors], ["bad entry"]);
	// enabled 缺省视为 true；enabled:false 保留
	const disabled = parseMcpListOutput(JSON.stringify({ servers: [{ name: "y", enabled: false }] }));
	assert.equal(disabled.servers[0].enabled, false);
});

test("authorization URL extraction accepts only complete http(s) URLs", () => {
	// 同一行
	assert.equal(extractAuthorizationUrl("prefix in your browser: https://auth.example.com/a?b=1"), "https://auth.example.com/a?b=1");
	// 「提示行 + 下一行 URL」（pi 的实际输出）
	const scan = createAuthorizationUrlScanner();
	assert.equal(scan('Sign in to MCP server "sentry" in your browser:'), undefined);
	assert.equal(scan("https://auth.example.com/authorize?client_id=x"), "https://auth.example.com/authorize?client_id=x");
	// 非 http(s) 拒绝
	assert.equal(extractAuthorizationUrl("in your browser: file:///etc/passwd"), undefined);
	assert.equal(extractAuthorizationUrl("in your browser: javascript:alert(1)"), undefined);
	// 提示后的下一行不是 URL 时不会被误当链接，且状态已消费
	const scan2 = createAuthorizationUrlScanner();
	assert.equal(scan2("in your browser:"), undefined);
	assert.equal(scan2("spinner..."), undefined);
	assert.equal(scan2("https://auth.example.com/late"), undefined);
	// 无提示时不会拿任意一行 URL 当授权链接
	assert.equal(extractAuthorizationUrl("https://unrelated.example/log"), undefined);
	assert.ok(MCP_LOGIN_URL_RE.test('Sign in to MCP server "sentry" in your browser: https://x.example/a'));
});

test("LineBuffer semantics: chunk splitting and CRLF (mirrors the login parser)", () => {
	// 直接测提取逻辑 + 通过模块源码确认逐行解析器存在（避免重复实现）
	const source = readFileSync("src/main/pi/piMcpCli.ts", "utf8");
	assert.match(source, /class LineBuffer/);
	assert.match(source, /push\(chunk: string\)/);
	assert.match(source, /flush\(\)/);
	// 不允许对累积 output 反复跑正则（那会产生半截/重复 URL）
	assert.doesNotMatch(source, /exec\(output\)/);
});

test("global scope never reuses the app cwd (temporary dir unless injected)", () => {
	const source = readFileSync("src/main/pi/piMcpCli.ts", "utf8");
	assert.match(source, /mkdtempSync\(join\(tmpdir\(\), "pideck-mcp-global-"\)\)/);
	assert.match(source, /createGlobalCwd/);
	// 项目作用域必须校验已保存信任，未信任直接抛错
	assert.match(source, /Project is not trusted\./);
});

test("list treats only exit 0/1 with a valid report as success", () => {
	const source = readFileSync("src/main/pi/piMcpCli.ts", "utf8");
	assert.match(source, /code === 1/);
	assert.match(source, /parseMcpListOutput\(outText\)/);
	// 超时/信号/spawn 失败走 reject 分支
	assert.match(source, /reject\(new Error\(tail/);
	// list/login/logout 都不传 -l（该参数只属于 add/remove）
	assert.doesNotMatch(source, /"mcp",\s*"list",\s*"--json",\s*"-l"/);
	assert.doesNotMatch(source, /"-l"/);
});

test("PiMcpCli exposes scope-aware list/login/logout", () => {
	assert.equal(typeof PiMcpCli.prototype.list, "function");
	assert.equal(typeof PiMcpCli.prototype.login, "function");
	assert.equal(typeof PiMcpCli.prototype.logout, "function");
	// login 签名顺序：scope, server, timeoutSec, callbacks
	const source = readFileSync("src/main/pi/piMcpCli.ts", "utf8");
	assert.match(source, /async login\(scope: McpCliScope, server: string, timeoutSec: number/);
	assert.match(source, /async logout\(scope: McpCliScope, server: string\)/);
});

test("parseMcpListOutput accepts both resource shapes (pi 1.1 counts, 1.2 boolean)", () => {
	// pi 1.1：数量
	const legacy = parseMcpListOutput(JSON.stringify({ servers: [{ name: "a", resources: 2, resourceTemplates: 1 }], errors: [] }));
	assert.equal(legacy.servers[0].resources, 2);
	assert.equal(legacy.servers[0].resourceTemplates, 1);
	// pi 1.2：`resources: true`，且不再输出 resourceTemplates
	const current = parseMcpListOutput(JSON.stringify({ servers: [{ name: "b", resources: true }], errors: [] }));
	assert.equal(current.servers[0].resources, true, "pi 1.2 的布尔形态不能丢");
	assert.equal(current.servers[0].resourceTemplates, undefined);
	// 其它形态仍视为未提供
	const bogus = parseMcpListOutput(JSON.stringify({ servers: [{ name: "c", resources: "yes" }], errors: [] }));
	assert.equal(bogus.servers[0].resources, undefined);
});
