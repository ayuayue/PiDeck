import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端 MCP：配置快照/保存 + 主机上的 `pi mcp list --json` / `pi mcp logout`。
 *
 * 这一组钉住的是「哪些事在远端能做、失败怎么报」，而不是把 MCP 校验再实现一遍
 * （校验用的是主进程既有纯函数，重复断言等于两套口径）。
 */
const { createRemotePiMcpService } = loadTsCommonJs("src/main/config/RemotePiMcpService.ts");
const { createRemoteConfigEditorApi } = loadTsCommonJs("src/renderer/src/config/remoteConfigEditorApi.ts");
const { REMOTE_MCP_CODES } = loadTsCommonJs("src/shared/types/remotePiManagement.ts");
const { REMOTE_CONFIG_CODES } = loadTsCommonJs("src/shared/piConfig.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const HOME = "/home/tester";
const VERSION = "a".repeat(64);
const GOOGLE = { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "configured" } };

/** 被测对象来自 loadTsCommonJs 的另一个 realm：归一成纯 JSON 再严格比较。 */
const plain = (value) => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) => assert.deepEqual(plain(actual), expected, message);

function service(overrides = {}) {
	const calls = { read: [], replace: [], run: [] };
	const config = {
		read: async (input) => {
			calls.read.push(input);
			return { kind: "remote", hostId: input.hostId, file: input.file, version: VERSION, sha256: VERSION, data: { mcpServers: { search: GOOGLE } }, secrets: [] };
		},
		replace: async (input) => {
			calls.replace.push(input);
			return { kind: "remote", hostId: input.hostId, file: input.file, version: "b".repeat(64), sha256: "b".repeat(64) };
		},
	};
	const facts = { piPath: "/usr/local/bin/pi", nodePath: "/usr/local/bin/node", version: "1.5.2", home: HOME };
	const instance = createRemotePiMcpService({
		config: () => (overrides.noConfig ? undefined : config),
		resolveFacts: async () => facts,
		run: async (input) => {
			calls.run.push(input);
			return overrides.run ? overrides.run(input) : { exitCode: 0, stdout: '{"servers":[]}', stderr: "" };
		},
		...(overrides.ports ?? {}),
	});
	return { instance, calls };
}

test("snapshot merges the host's single mcp.json layer and reports the real remote path", async () => {
	const { instance, calls } = service();
	const result = await instance.execute(HOST, { action: "snapshot" });
	assert.equal(result.action, "snapshot");
	const snapshot = result.snapshot;
	assert.equal(snapshot.writablePath, HOME + "/.pi/agent/mcp.json");
	same(snapshot.layers, [{ kind: "pi-agent", path: HOME + "/.pi/agent/mcp.json", exists: true, writable: true }]);
	assert.equal(snapshot.revision, VERSION, "乐观锁用主机文件的 sha256");
	same(
		snapshot.servers.map((server) => server.name),
		["search"],
	);
	same(snapshot.invalidServers, []);
	// 单层 + mcp-auth.json 不在远端可读清单：这两个字段必须是空数组而不是编造。
	same(snapshot.lowerLayerNames, []);
	same(snapshot.oauthCredentialNames, []);
	assert.equal(calls.read[0].file, "mcp");
});

test("save writes the whole document with the caller's revision and never smuggles secret sources", async () => {
	const { instance, calls } = service();
	const result = await instance.execute(HOST, { action: "save", file: { mcpServers: { search: GOOGLE } }, expectedVersion: VERSION });
	same(result, { action: "save", valid: true, revision: "b".repeat(64) });
	assert.equal(calls.replace.length, 1);
	assert.equal(calls.replace[0].file, "mcp");
	assert.equal(calls.replace[0].expectedVersion, VERSION);
	same(calls.replace[0].secretSources, [], "远端没有 to→from 的密钥搬运表，必须显式为空");
	// 密钥值以 configured 哨兵回传时，helper 侧的 restoreDocument 会保留原值（这里只保证不被改写）。
	assert.equal(calls.replace[0].data.mcpServers.search.headers.Authorization, "configured");
});

test("save without a revision reads the host version first, and a stale revision surfaces as a conflict", async () => {
	const { instance, calls } = service();
	await instance.execute(HOST, { action: "save", file: { mcpServers: {} } });
	assert.equal(calls.read.length, 1, "缺 expectedVersion 时先读当前版本");
	assert.equal(calls.replace[0].expectedVersion, VERSION);

	const stale = service({
		ports: {
			config: () => ({
				read: async () => ({ kind: "remote", hostId: HOST, file: "mcp", version: VERSION, sha256: VERSION, data: {}, secrets: [] }),
				replace: async () => {
					throw Object.assign(new Error(REMOTE_CONFIG_CODES.versionConflict), { code: REMOTE_CONFIG_CODES.versionConflict });
				},
			}),
		},
	});
	const conflict = await stale.instance.execute(HOST, { action: "save", file: { mcpServers: {} }, expectedVersion: VERSION });
	same(conflict, { action: "save", valid: false, error: REMOTE_CONFIG_CODES.versionConflict, conflict: true });
});

test("save refuses a malformed server definition before it reaches the host", async () => {
	const { instance, calls } = service();
	const result = await instance.execute(HOST, { action: "save", file: { mcpServers: { bad: { args: ["no transport"] } } }, expectedVersion: VERSION });
	assert.equal(result.valid, false);
	assert.match(result.error, /command|url/i);
	assert.equal(calls.replace.length, 0, "校验失败时一个字节都不该写到主机");
});

test("list parses the host report and treats exit 1 with legal JSON as a report, not a failure", async () => {
	const report = JSON.stringify({ servers: [{ name: "search", state: "needs-auth", transport: "http", enabled: true }], errors: [] });
	const { instance, calls } = service({ run: async () => ({ exitCode: 1, stdout: report, stderr: "" }) });
	const result = await instance.execute(HOST, { action: "list" });
	assert.equal(result.action, "list");
	same(
		result.report.servers.map((server) => [server.name, server.state]),
		[["search", "needs-auth"]],
	);
	// 固定动词：命令里只有 mcp list --json，且 pi 用主机上已验证的 node 运行。
	const command = calls.run[0].remoteCommand;
	assert.match(command, /mcp/);
	assert.match(command, /list/);
	assert.match(command, /--json/);
	assert.match(command, /\/usr\/local\/bin\/node/);
	assert.match(command, /\/usr\/local\/bin\/pi/);

	const broken = service({ run: async () => ({ exitCode: 0, stdout: "not json", stderr: "" }) });
	await assert.rejects(() => broken.instance.execute(HOST, { action: "list" }), new RegExp(REMOTE_MCP_CODES.commandFailed));
});

test("logout only accepts a server name, and reports the host's exit code", async () => {
	const { instance, calls } = service({ run: async () => ({ exitCode: 0, stdout: "", stderr: "已登出" }) });
	same(await instance.execute(HOST, { action: "logout", server: "search" }), { action: "logout", ok: true, output: "已登出" });
	assert.match(calls.run[0].remoteCommand, /logout/);
	assert.match(calls.run[0].remoteCommand, /search/);

	for (const server of ["../etc/passwd", "a b", "", "x".repeat(200)]) {
		await assert.rejects(() => instance.execute(HOST, { action: "logout", server }), new RegExp(REMOTE_MCP_CODES.invalid), server);
	}

	const failed = service({ run: async () => ({ exitCode: 2, stdout: "", stderr: "boom" }) });
	assert.equal((await failed.instance.execute(HOST, { action: "logout", server: "search" })).ok, false);
});

test("execute closes the shape: host id, known action, no extra keys", async () => {
	const { instance } = service();
	await assert.rejects(() => instance.execute("not-a-host", { action: "facts" }), new RegExp(REMOTE_MCP_CODES.invalid));
	await assert.rejects(() => instance.execute(HOST, { action: "login" }), new RegExp(REMOTE_MCP_CODES.invalid));
	await assert.rejects(() => instance.execute(HOST, { action: "facts", extra: 1 }), new RegExp(REMOTE_MCP_CODES.invalid));
	await assert.rejects(() => instance.execute(HOST, null), new RegExp(REMOTE_MCP_CODES.invalid));
	same(await instance.execute(HOST, { action: "facts" }), { action: "facts", home: HOME, piVersion: "1.5.2" });
	// 功能开关关掉（没有 remote config backend）时失败要明确，不能退化成读本机。
	const disabled = service({ noConfig: true });
	await assert.rejects(() => disabled.instance.execute(HOST, { action: "snapshot" }), new RegExp(REMOTE_MCP_CODES.unavailable));
});

// ── 渲染层 facade：远端 MCP 六个入口的行为 ─────────────────────────────

function facade(overrides = {}) {
	const calls = [];
	const api = {
		remotePiMcp: async (hostId, input) => {
			calls.push({ hostId, input });
			return overrides.answer ? overrides.answer(input) : { action: "facts", home: HOME, piVersion: "1.5.2" };
		},
	};
	const editor = createRemoteConfigEditorApi(api, HOST, async () => ({ ok: true }));
	return { editor, calls, api };
}

test("remote MCP facade: snapshot/save/list/logout go through the host channel", async () => {
	const snapshot = { writablePath: HOME + "/.pi/agent/mcp.json", writableFile: { mcpServers: {} }, writableRaw: "{}\n", revision: VERSION, layers: [], servers: [], invalidServers: [], lowerLayerNames: [], oauthCredentialNames: [] };
	const port = facade({
		answer: (input) => {
			if (input.action === "facts") return { action: "facts", home: HOME, piVersion: "1.5.2" };
			if (input.action === "snapshot") return { action: "snapshot", snapshot };
			if (input.action === "save") return { action: "save", valid: true, revision: "c".repeat(64) };
			if (input.action === "list") return { action: "list", report: { servers: [{ name: "search", state: "connected" }], errors: [] } };
			return { action: "logout", ok: true, output: "ok" };
		},
	});
	same(await port.editor.config.getMcp(), snapshot);
	same(await port.editor.config.saveMcp({ mcpServers: {} }, undefined, VERSION), { valid: true });
	same(
		(await port.editor.config.mcpListStatus()).servers.map((server) => server.state),
		["connected"],
	);
	same(await port.editor.config.mcpLogout("search"), { ok: true, output: "ok" });
});

test("remote MCP facade: 项目作用域只服务本页项目，probe 给可读原因，login 直通主机结果", async () => {
	// 没有入口项目的 facade（全局配置页）收到项目作用域请求：拒绝，而不是读主机全局 mcp.json。
	const port = facade();
	await assert.rejects(() => port.editor.config.getMcp({ scope: "project", projectId: "p" }), new RegExp(REMOTE_MCP_CODES.projectScopeUnsupported));
	await assert.rejects(() => port.editor.config.mcpListStatus({ scope: "project", projectId: "p" }), new RegExp(REMOTE_MCP_CODES.projectScopeUnsupported));
	await assert.rejects(() => port.editor.config.mcpLogin("search", 240, { scope: "project", projectId: "p" }), new RegExp(REMOTE_MCP_CODES.projectScopeUnsupported));

	// 项目页的 facade 只服务本页项目：拿别的 projectId 来问必须拒绝（不跨项目读配置）。
	const projectPort = facade({ projectId: "p" });
	await assert.rejects(() => projectPort.editor.config.getMcp({ scope: "project", projectId: "other" }), new RegExp(REMOTE_MCP_CODES.projectScopeUnsupported));

	const probe = await port.editor.config.probeMcp({ url: "https://mcp.example.com/mcp" });
	assert.equal(probe.ok, false);
	assert.match(probe.error, /./, "探测失败要给可读文案，不能是空串");
	assert.equal(probe.transport, "http");

	// 登录在主机上跑（helper ≥1.36）：facade 只透传结果，超时与 operationId 一并下发。
	// 授权 URL 走 onMcpLoginUrl 事件通道，绝不出现在返回值里（返回值会进日志与通用错误位）。
	const loginPort = facade({ answer: () => ({ action: "login", ok: true, output: "authorized" }) });
	same(await loginPort.editor.config.mcpLogin("search", 240, undefined, "op-1"), { ok: true, output: "authorized" });
	same(loginPort.calls.at(-1), { hostId: HOST, input: { action: "login", server: "search", timeoutSec: 240, operationId: "op-1" } });

	// 主机回了非登录形状（两边协议不一致）：不能当成功吞掉，要报明确错误码。
	const wrongPort = facade({ answer: () => ({ action: "logout", ok: true, output: "x" }) });
	await assert.rejects(() => wrongPort.editor.config.mcpLogin("search"), new RegExp(REMOTE_MCP_CODES.invalid));
});

// ── 项目层（scope: "project"）：同一台主机、限定在该项目根的会话 ────────────

test("远端 MCP 项目层：快照/保存在项目根上，缺少或跨主机的项目被拒绝", async () => {
	const calls = { read: [], replace: [] };
	const ROOT = "/srv/app";
	const config = {
		read: async (input) => {
			calls.read.push(input);
			return { kind: "remote", hostId: input.hostId, file: input.file, version: VERSION, sha256: VERSION, data: { mcpServers: { search: GOOGLE } }, secrets: [] };
		},
		replace: async (input) => {
			calls.replace.push(input);
			return { kind: "remote", hostId: input.hostId, file: input.file, version: "b".repeat(64), sha256: "b".repeat(64) };
		},
	};
	const { instance } = service({
		ports: {
			config: () => config,
			resolveFacts: async () => ({ piPath: "/usr/local/bin/pi", nodePath: "/usr/local/bin/node", version: "1.5.2", home: HOME }),
			resolveProject: async (projectId) => (projectId === "p-a" ? { hostId: HOST, root: ROOT } : { code: "REMOTE_MCP_TARGET_INVALID" }),
		},
	});

	const snapshot = await instance.execute(HOST, { action: "snapshot", scope: "project", projectId: "p-a" });
	assert.equal(snapshot.snapshot.writablePath, ROOT + "/.pi/mcp.json", "项目层的真实路径是该项目的 .pi/mcp.json");
	same(calls.read.at(-1), { hostId: HOST, file: "mcp", projectRoot: ROOT });

	await instance.execute(HOST, { action: "save", scope: "project", projectId: "p-a", expectedVersion: VERSION, file: { mcpServers: {} } });
	assert.equal(calls.replace.at(-1).projectRoot, ROOT, "写入同样落在项目根上");

	// 没有 projectId / 未知项目 / 另一台主机的项目：一律拒绝，绝不退回主机全局层。
	await assert.rejects(() => instance.execute(HOST, { action: "snapshot", scope: "project" }), new RegExp(REMOTE_MCP_CODES.invalid));
	await assert.rejects(() => instance.execute(HOST, { action: "snapshot", scope: "project", projectId: "missing" }), new RegExp(REMOTE_MCP_CODES.invalid));
	await assert.rejects(() => instance.execute("22222222-2222-4222-8222-222222222222", { action: "snapshot", scope: "project", projectId: "p-a" }), new RegExp(REMOTE_MCP_CODES.invalid));
	// facts 是主机级事实（HOME / pi 版本），不因项目层而变：页面的远端路径仍取主机 HOME。
	same(await instance.execute(HOST, { action: "facts", scope: "project", projectId: "p-a" }), { action: "facts", home: HOME, piVersion: "1.5.2" });
});

test("远端 MCP 项目层：检测与登录在项目目录里跑，授权帧标出所属层", async () => {
	const runs = [];
	const logins = [];
	const { instance } = service({
		ports: {
			resolveFacts: async () => ({ piPath: "/usr/local/bin/pi", nodePath: "/usr/local/bin/node", version: "1.5.2", home: HOME }),
			resolveProject: async () => ({ hostId: HOST, root: "/srv/app" }),
			request: async (hostId, method, params) => {
				logins.push({ method, params });
				return method === "mcp.login" ? { ok: true, output: "authorized" } : undefined;
			},
			run: async (input) => {
				runs.push(input.remoteCommand);
				return { exitCode: 0, stdout: '{"servers":[]}', stderr: "" };
			},
		},
	});
	await instance.execute(HOST, { action: "list", scope: "project", projectId: "p-a" });
	assert.match(runs.at(-1), /cd '\/srv\/app' &&/, "检测命令在项目目录里执行");
	await instance.execute(HOST, { action: "logout", scope: "project", projectId: "p-a", server: "search" });
	assert.match(runs.at(-1), /cd '\/srv\/app' &&/, "登出同样按项目目录执行");

	const frames = [];
	await instance.execute(HOST, { action: "login", scope: "project", projectId: "p-a", server: "search", timeoutSec: 60, operationId: "op-1" }, (payload) => frames.push(payload));
	assert.equal(logins.at(-1).method, "mcp.login");
	assert.equal(logins.at(-1).params.scope, "project", "helper 只在项目根里执行登录，路径不由渲染层提供");
	assert.equal("projectId" in logins.at(-1).params, false);
});
