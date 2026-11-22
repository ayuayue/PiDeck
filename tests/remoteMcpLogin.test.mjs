import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端 MCP OAuth 登录：授权 URL 必须在通话还没结束时出去。
 *
 * 三条链分开钉：
 * 1. `mcp-login.mjs` 运行器——真跑一个子进程，URL 只报一次、退出码映射成 ok、取消会 kill；
 * 2. helper 的 `mcp.login` 契约——能力、参数闭集、事件帧形状（`event: auth-url` 带 requestId）；
 * 3. 主进程客户端与服务——URL 只回到发起它的那次请求，emits 到渲染层时不做广播。
 */
const { REMOTE_MCP_LOGIN_SOURCE } = loadTsCommonJs("src/main/remote/RemoteMcpLoginSource.ts");
const entry = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const { createRemotePiMcpService } = loadTsCommonJs("src/main/config/RemotePiMcpService.ts");
const { createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");
const { REMOTE_HELPER_CAPABILITIES } = loadTsCommonJs("src/main/remote/RemoteHelperCapabilities.ts");
const { REMOTE_MCP_CODES } = loadTsCommonJs("src/shared/types/remotePiManagement.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));
const factory = (source, name) => new Function(source.replace("export function " + name, "function " + name) + "\nreturn " + name + ";")();
const HOST = "11111111-1111-4111-8111-111111111111";

/** 一个假的 `pi`：打印授权 URL 后等待，模拟「等用户在浏览器里完成授权」。 */
function fakePi(t, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-fake-pi-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const script = join(dir, "fake-pi.js");
	writeFileSync(script, [`process.stdout.write(${JSON.stringify(options.line ?? "Open this URL to authorize: https://example.com/oauth?code=abc123\n")});`, options.hang === false ? "process.exit(0);" : "setTimeout(function () { process.exit(0); }, 4000);"].join("\n"));
	return script;
}

test("the login runner reports the authorization URL while the child is still running", async (t) => {
	const runner = factory(REMOTE_MCP_LOGIN_SOURCE, "createMcpLoginRunner")(spawn);
	const urls = [];
	const job = runner({ server: "search", timeoutSec: 5, home: tmpdir(), piPath: fakePi(t), nodePath: process.execPath }, (url) => urls.push(url));
	const result = await job.promise;
	assert.deepEqual(urls, ["https://example.com/oauth?code=abc123"], "URL 只报一次，且已剥掉尾随标点");
	assert.equal(result.ok, true, "退出码 0 映射成 ok:true");
	assert.equal(result.reason, "ok");
});

test("the login runner maps a non-zero exit and a cancel to a bounded failure", async (t) => {
	const runner = factory(REMOTE_MCP_LOGIN_SOURCE, "createMcpLoginRunner")(spawn);
	const failing = runner({ server: "s", timeoutSec: 5, home: tmpdir(), piPath: fakePi(t, { hang: false, line: "boom\n" }), nodePath: process.execPath }, () => {});
	assert.equal((await failing.promise).ok, true, "先跑通一次确认夹具可用");

	// spawn 失败（可执行文件不存在）必须是 ok:false，而不是把异常抛给协议层。
	const broken = runner({ server: "s", timeoutSec: 5, home: tmpdir(), piPath: join(tmpdir(), "does-not-exist.js"), nodePath: process.execPath }, () => {});
	const outcome = await broken.promise;
	assert.equal(outcome.ok, false);
});

test("the frozen helper advertises mcp.login with the documented parameter set", () => {
	assert.ok(REMOTE_HELPER_CAPABILITIES.includes("mcp.login"), "能力表必须包含 mcp.login（hello 按同一顺序声明）");
	assert.equal(entry.REMOTE_HELPER_ENTRY_VERSION, "1.36.2", "helper 版本要跟着协议变化前进");
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes('"mcp.login"'), "hello 的能力表与实际分发必须同源");
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes("home,nodePath,piPath,server,timeoutSec"), "参数按闭集校验，多一个少一个都拒绝");
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes('event: "auth-url"'), "URL 走无 id 的事件帧，并带上发起它的 requestId");
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes("requestId: identity.id"), "事件帧必须绑定请求 id，否则 URL 会串到别的调用");
	const artifact = entry.REMOTE_HELPER_ARTIFACTS.find((item) => item.name === "mcp-login.mjs");
	assert.ok(artifact, "mcp-login.mjs 必须作为独立 artifact 部署并单独设钉");
	assert.equal(artifact.sha256, entry.REMOTE_HELPER_MCP_LOGIN_SHA256);
});

test("the client routes an auth-url frame to the request that started it, and nowhere else", async () => {
	const sent = [];
	const urls = [];
	const diagnostics = [];
	const client = createRemoteControlClient({
		hostId: HOST,
		send: (line) => sent.push(line),
		onDiagnostic: (entry) => diagnostics.push(plain(entry)),
	});
	client.openConnection();
	const pendingRequest = client.request("mcp.login", { server: "search" }, { onAuthUrl: (url) => urls.push(url) });
	const frame = JSON.parse(sent[0]);
	// 只认自己的 id：别人的 id 与非法 URL 都必须被丢掉，而不是转手给任何一个观察者。
	client.handleLine(JSON.stringify({ v: 1, hostId: HOST, generation: frame.generation, requestId: "someone-else", event: "auth-url", url: "https://evil.example/x" }));
	assert.deepEqual(urls, []);
	client.handleLine(JSON.stringify({ v: 1, hostId: HOST, generation: frame.generation, requestId: frame.id, event: "auth-url", url: "javascript:alert(1)" }));
	assert.deepEqual(urls, [], "只接受 http(s)");
	client.handleLine(JSON.stringify({ v: 1, hostId: HOST, generation: frame.generation, requestId: frame.id, event: "auth-url", url: "https://example.com/oauth?code=abc123" }));
	assert.deepEqual(urls, ["https://example.com/oauth?code=abc123"]);
	// 收尾：终态应答照常 settle，URL 事件不影响 pending 表。
	client.handleLine(JSON.stringify({ v: 1, hostId: HOST, generation: frame.generation, id: frame.id, ok: true, result: { ok: true, output: "", reason: "ok" } }));
	same(await pendingRequest, { ok: true, output: "", reason: "ok" });
});

function service(overrides = {}) {
	const calls = [];
	const facts = { piPath: "/usr/local/bin/pi", nodePath: "/usr/local/bin/node", version: "1.6.0", home: "/home/tester" };
	const instance = createRemotePiMcpService({
		config: () => undefined,
		resolveFacts: async () => facts,
		run: async () => ({ exitCode: 0, stdout: "" }),
		request: async (hostId, method, params, options) => {
			calls.push({ hostId, method, params, options: { timeoutMs: options?.timeoutMs, hasAuthUrl: typeof options?.onAuthUrl === "function" } });
			options?.onAuthUrl?.("https://example.com/oauth?code=abc123");
			return overrides.result ?? { ok: true, output: "authorized", reason: "ok" };
		},
		...overrides.ports,
	});
	return { instance, calls };
}

test("mcp.login runs on the host and pushes the URL to the caller, never through the return value", async () => {
	const { instance, calls } = service();
	const emitted = [];
	const result = await instance.execute(HOST, { action: "login", server: "search", timeoutSec: 90, operationId: "op-1" }, (payload) => emitted.push(plain(payload)));
	same(result, { action: "login", ok: true, output: "authorized" });
	assert.equal(calls[0].method, "mcp.login");
	same(Object.keys(calls[0].params).sort(), ["home", "nodePath", "piPath", "server", "timeoutSec"]);
	assert.equal(calls[0].params.server, "search");
	assert.equal(calls[0].params.timeoutSec, 90);
	assert.equal(calls[0].options.hasAuthUrl, true, "登录请求必须带 onAuthUrl 回调，否则 URL 无处可去");
	assert.ok(calls[0].options.timeoutMs > 90 * 1000, "请求超时必须比 pi 自己的等待更长，否则 URL 到手前请求先死");
	same(emitted, [{ server: "search", operationId: "op-1", url: "https://example.com/oauth?code=abc123" }]);
	assert.equal(JSON.stringify(result).includes("oauth"), false, "URL 不进返回值：它是一次性凭据");
});

test("mcp.login refuses a bad server name or a missing helper result", async () => {
	const { instance } = service();
	for (const server of ["", "../x", "a b", "x".repeat(200)]) await assert.rejects(() => instance.execute(HOST, { action: "login", server, timeoutSec: 60 }), new RegExp(REMOTE_MCP_CODES.invalid));
	const broken = service({ result: { nope: true } });
	await assert.rejects(() => broken.instance.execute(HOST, { action: "login", server: "search", timeoutSec: 60 }), new RegExp(REMOTE_MCP_CODES.unconfirmed));
});

function same(actual, expected, message) {
	assert.deepEqual(plain(actual), expected, message);
}
