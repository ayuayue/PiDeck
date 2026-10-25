import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { inferMcpTransport, isMcpServerName, mergeMcpServers, mergeMcpServersWithErrors, mcpNamespacesClash, mcpLayerPaths, parseMcpConfigFile, probeHttpUrl, probeStdioCommand, resolveExposureAlias, resolveExposureAliases, validateMcpServer, validateMcpServerValue, validateMcpConfigFile, loadMcpConfigSnapshot } =
	loadTsCommonJs("src/main/config/mcpConfig.ts");

/** 跨 VM 数组/对象先复制再比较（见 tests/helpers/loadTsCommonJs.mjs）。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

test("mcp server names follow the native rule (letters, digits, underscore, dash)", () => {
	assert.equal(isMcpServerName("chrome-devtools"), true);
	assert.equal(isMcpServerName("docs_v2"), true);
	// pi 原生 ^[A-Za-z0-9_-]+$：下划线/短横线开头合法，也没有 64 字符上限
	assert.equal(isMcpServerName("_private"), true);
	assert.equal(isMcpServerName("-leading"), true);
	assert.equal(isMcpServerName("a".repeat(200)), true);
	assert.equal(isMcpServerName(""), false);
	assert.equal(isMcpServerName("   "), false);
	assert.equal(isMcpServerName("../evil"), false);
	assert.equal(isMcpServerName("has space"), false);
	assert.equal(isMcpServerName("中文名"), false);
});

test("namespaces that differ only in - and _ clash (pi rejects the second)", () => {
	assert.equal(mcpNamespacesClash("dev-radius", "dev_radius"), true);
	assert.equal(mcpNamespacesClash("dev-radius", "dev-radius"), false);
	assert.equal(mcpNamespacesClash("dev-radius", "other"), false);
});

test("transport inference is per native branch: url wins unless type says stdio", () => {
	assert.equal(inferMcpTransport({ command: "npx" }), "stdio");
	assert.equal(inferMcpTransport({ url: "https://mcp.example/mcp" }), "http");
	// 同时含 command/url 时无法只凭字段判断（原生按 type/有效分支决定）
	assert.equal(inferMcpTransport({ command: "npx", url: "https://x" }), null);
	assert.equal(inferMcpTransport({}), null);
});

test("enabled:false still requires a transport (native semantics)", () => {
	// pi 的 validateMcpServerConfig 对 {enabled:false} 且无传输的条目报错：
	// 项目层要停用继承的服务器必须写有效的最小定义。
	assert.match(validateMcpServer("docs", { enabled: false }), /needs either "command".*"url"/);
	// 有传输的停用定义合法
	assert.equal(validateMcpServer("docs", { url: "https://x/mcp", enabled: false }), null);
	assert.equal(validateMcpServer("docs", { command: "npx", enabled: false }), null);
	assert.match(validateMcpServer("bad name", { command: "npx" }), /invalid server name/);
});

test("native merge: a project entry replaces the whole global entry (no shallow merge)", () => {
	const merged = mergeMcpServers(
		[
			{
				path: "/home/user/.pi/agent/mcp.json",
				file: { mcpServers: { docs: { command: "npx", args: ["-y", "docs"] } } },
			},
			{
				path: "/repo/.pi/mcp.json",
				file: { mcpServers: { docs: { url: "https://project.example/mcp", enabled: false } } },
			},
		],
		"/home/user/.pi/agent/mcp.json",
	);
	assert.equal(merged.length, 1);
	// 项目层没有 command/args；替换后它们必须消失，而不是残留在合并结果里
	assert.equal(merged[0].definition.command, undefined);
	assert.equal(merged[0].definition.args, undefined);
	assert.equal(merged[0].definition.url, "https://project.example/mcp");
	assert.equal(merged[0].definition.enabled, false);
	assert.equal(merged[0].originPath, "/repo/.pi/mcp.json");
	assert.equal(merged[0].originScope, "project-pi");
	assert.equal(merged[0].ownedByWritable, false);
});

test("native merge: project entry with no global base is reported, global stays effective", () => {
	// pi 1.0.1 起无传输条目是合法的项目覆盖形态；只有项目层且没有全局基座时才报错
	const result = mergeMcpServersWithErrors(
		[
			{ path: "/global/mcp.json", kind: "pi-agent", file: { mcpServers: { docs: { command: "npx" } } } },
			{ path: "/project/mcp.json", kind: "project-pi", file: { mcpServers: { ghost: { enabled: false } } } },
		],
		"/global/mcp.json",
	);
	assert.equal(result.servers.length, 1);
	assert.equal(result.servers[0].name, "docs");
	assert.equal(result.servers[0].definition.command, "npx");
	assert.equal(result.servers[0].originPath, "/global/mcp.json");
	assert.equal(result.invalidServers.length, 1);
	assert.match(result.invalidServers[0].error, /or a global server to override/);
});

test("native merge: namespace clash is skipped and reported", () => {
	const result = mergeMcpServersWithErrors(
		[
			{ path: "/global/mcp.json", kind: "pi-agent", file: { mcpServers: { "dev-radius": { command: "a" } } } },
			{ path: "/project/mcp.json", kind: "project-pi", file: { mcpServers: { dev_radius: { command: "b" } } } },
		],
		"/global/mcp.json",
	);
	assert.equal(result.servers.length, 1);
	assert.equal(result.servers[0].name, "dev-radius");
	assert.equal(result.invalidServers.length, 1);
	assert.match(result.invalidServers[0].error, /conflicts with/);
});

test("exposure alias resolves codemode-deferred to codemode but the raw value round-trips", () => {
	assert.equal(resolveExposureAlias("codemode-deferred"), "codemode");
	assert.equal(resolveExposureAlias("deferred"), "deferred");
	assert.equal(resolveExposureAlias(undefined), undefined);
	// 整个定义归一（渲染层表单的展示/预选值依赖它），toolExposure 的别名一并归位。
	// 注意：模块经 vm 加载，跨 context 对象直接 deepEqual 会因原型不同失败，先展开放回本 context。
	const resolvedAliases = resolveExposureAliases({ url: "https://x/mcp", exposure: "codemode-deferred", toolExposure: { a: "codemode-deferred", b: "direct" } });
	assert.deepEqual({ ...resolvedAliases, toolExposure: { ...resolvedAliases.toolExposure } }, { url: "https://x/mcp", exposure: "codemode", toolExposure: { a: "codemode", b: "direct" } });
	// 旧文件仍可读，校验通过
	assert.equal(validateMcpServer("docs", { url: "https://x/mcp", exposure: "codemode-deferred" }), null);
	assert.equal(validateMcpServer("docs", { url: "https://x/mcp", toolExposure: { a: "codemode-deferred" } }), null);
});

test("ownedByWritable tracks the writable layer path", () => {
	const merged = mergeMcpServers([{ path: "/home/user/.pi/agent/mcp.json", file: { mcpServers: { local: { command: "npx" } } } }], "/home/user/.pi/agent/mcp.json");
	assert.equal(merged[0].ownedByWritable, true);
});

test("mcp layer paths: global writable; project layer added on demand", () => {
	const globalOnly = mcpLayerPaths("/home/me", "/home/me/.pi/agent");
	assert.equal(globalOnly.length, 1);
	assert.equal(globalOnly[0].kind, "pi-agent");
	assert.equal(globalOnly[0].writable, true);
	const withProject = mcpLayerPaths("/home/me", "/home/me/.pi/agent", "/repo");
	assert.equal(withProject.length, 2);
	assert.ok(withProject[1].path.replace(/\\/g, "/").endsWith(".pi/mcp.json"));
	// 默认可写层跟随触发入口：全局页写 agentDir，项目页在 snapshot 里把可写层重定向
	assert.equal(withProject[1].writable, false);
});

test("stdio probe resolves an existing absolute command and rejects missing ones", () => {
	const ok = probeStdioCommand(process.execPath);
	assert.equal(ok.ok, true);
	const missing = probeStdioCommand("definitely-not-a-pideck-mcp-bin-xyz");
	assert.equal(missing.ok, false);
	assert.match(missing.error, /not found/i);
});

test("HTTP probe treats 4xx as reachable config and 5xx as failure", async () => {
	const reachable = await probeHttpUrl("https://mcp.example/mcp", async () => ({ status: 405 }), 1000);
	assert.equal(reachable.ok, true);
	const down = await probeHttpUrl("https://mcp.example/mcp", async () => ({ status: 502 }), 1000);
	assert.equal(down.ok, false);
	const invalid = await probeHttpUrl("not-a-url");
	assert.equal(invalid.ok, false);
});

test("pi 1.0.1 项目覆盖条目：无传输形态只允许 enabled/exposure/toolExposure 且仅项目层", () => {
	assert.equal(validateMcpServerValue("docs", { enabled: false }, { scope: "project-pi" }), null);
	assert.equal(validateMcpServerValue("docs", { exposure: "direct" }, { scope: "project-pi" }), null);
	assert.equal(validateMcpServerValue("docs", { enabled: false, toolExposure: { a: "direct" } }, { scope: "project-pi" }), null);
	assert.match(validateMcpServerValue("docs", { enabled: false, headers: { A: "1" } }, { scope: "project-pi" }), /can only set/);
	assert.match(validateMcpServerValue("docs", { enabled: false }, { scope: "pi-agent" }), /needs either/);
});

test("pi 1.0.1 项目覆盖条目参与合并：部分覆盖全局，传输/凭据继承；无基座报错", () => {
	const merged = mergeMcpServersWithErrors(
		[
			{ path: "/g/mcp.json", kind: "pi-agent", file: { mcpServers: { docs: { url: "https://x/mcp", headers: { A: "1" }, enabled: false } } } },
			{ path: "/p/mcp.json", kind: "project-pi", file: { mcpServers: { docs: { enabled: true } } } },
		],
		"/g/mcp.json",
	);
	const docs = merged.servers.find((s) => s.name === "docs");
	assert.equal(docs.definition.enabled, true, "覆盖条目改写 enabled");
	assert.equal(docs.definition.headers.A, "1", "全局传输/头继承");
	assert.equal(docs.originScope, "project-pi");
	assert.deepEqual(plain(merged.invalidServers), []);
	const noBase = mergeMcpServersWithErrors([{ path: "/p/mcp.json", kind: "project-pi", file: { mcpServers: { ghost: { enabled: false } } } }], "/p/mcp.json");
	assert.match(noBase.invalidServers[0].error, /or a global server to override/);
});

test("pi 1.0.1 oauth.clientRegistration：dcr/cimd 值与 cimd 约束", () => {
	assert.equal(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { clientRegistration: "dcr" } }), null);
	assert.equal(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { clientRegistration: "cimd" } }), null);
	assert.match(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { clientRegistration: "bogus" } }), /clientRegistration must be/);
	assert.match(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { clientRegistration: "cimd", clientId: "a" } }), /cannot be combined/);
	assert.match(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { clientRegistration: "cimd", clientName: "pi" } }), /cannot be combined/);
	assert.match(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { clientRegistration: "cimd", callbackUrl: "http://[::1]:1/callback" } }), /requires oauth.callbackUrl/);
	assert.match(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { clientRegistration: "cimd", callbackUrl: "http://127.0.0.1:1/api" } }), /path \/callback/);
	assert.equal(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { clientRegistration: "cimd", callbackUrl: "http://localhost:1/callback" } }), null);
});

test("pi 1.0 schema validation accepts oauth.authServerMetadataUrl (https or loopback http)", () => {
	assert.equal(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { authServerMetadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server" } }), null);
	assert.equal(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { authServerMetadataUrl: "http://127.0.0.1:9000/.well-known/oauth-authorization-server" } }), null);
	assert.match(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { authServerMetadataUrl: "http://auth.example.com/metadata" } }), /authServerMetadataUrl/);
	assert.match(validateMcpServerValue("docs", { url: "https://x/mcp", oauth: { authServerMetadataUrl: "not a url" } }), /authServerMetadataUrl/);
});

test("pi 0.99.2 schema validation rejects socket, sse, bad exposure, bad oauth, bad auth", () => {
	assert.match(validateMcpServerValue("docs", { socket: "/tmp/x.sock" }), /needs either/);
	assert.match(validateMcpServerValue("docs", { url: "https://x/sse", type: "sse" }), /SSE/);
	assert.match(validateMcpServerValue("docs", { url: "https://x", exposure: "always" }), /exposure/);
	assert.match(validateMcpServerValue("docs", { url: "https://x", toolExposure: { a: "bogus" } }), /toolExposure/);
	assert.match(validateMcpServerValue("docs", { url: "https://x", timeout: -1 }), /timeout/);
	assert.match(validateMcpServerValue("docs", { url: "https://x", oauth: { callbackPort: 0 } }), /callbackPort/);
	assert.match(validateMcpServerValue("docs", { url: "https://x", oauth: { callbackUrl: "https://evil.example/cb" } }), /callbackUrl/);
	assert.match(validateMcpServerValue("docs", { url: "https://x", oauth: { callbackUrl: "http://127.0.0.1:1/cb", callbackPort: 2 } }), /different ports/);
	assert.equal(validateMcpServerValue("docs", { url: "https://x", oauth: { clientId: "a", callbackPort: 8765 } }), null);
	assert.equal(validateMcpServerValue("docs", { command: "npx", exposure: "direct" }), null);
	// 0.99.2 新增字段
	assert.equal(validateMcpServerValue("docs", { url: "https://x", description: "docs server" }), null);
	assert.match(validateMcpServerValue("docs", { url: "https://x", description: 42 }), /description must be a string/);
	assert.equal(validateMcpServerValue("docs", { url: "https://x", oauth: { clientName: "Claude Code" } }), null);
	assert.match(validateMcpServerValue("docs", { url: "https://x", oauth: { clientName: "   " } }), /clientName/);
	assert.equal(validateMcpServerValue("docs", { url: "https://api.example/mcp", auth: { provider: "anthropic" } }), null);
	// auth 要求 https 或环回
	assert.match(validateMcpServerValue("docs", { url: "http://api.example/mcp", auth: { provider: "anthropic" } }), /requires an https URL/);
	assert.equal(validateMcpServerValue("docs", { url: "http://127.0.0.1:3000/mcp", auth: { provider: "anthropic" } }), null);
	assert.match(validateMcpServerValue("docs", { url: "https://x", auth: {} }), /auth\.provider/);
	// auth 只能写在全局层（项目层被 pi 跳过）
	assert.match(validateMcpServerValue("docs", { url: "https://x", auth: { provider: "anthropic" } }, { scope: "project-pi" }), /only allowed in the global/);
});

test("malformed known values are reported before normalization (not silently dropped)", () => {
	// 归一化不能把 timeout:"abc" 变成 undefined 后宣称合法
	assert.match(validateMcpServerValue("docs", { url: "https://x", timeout: "abc" }), /timeout/);
	assert.match(validateMcpServerValue("docs", { command: "npx", args: [1, 2] }), /args must be an array of strings/);
	assert.match(validateMcpServerValue("docs", { command: "npx", env: { A: 1 } }), /env must map names to strings/);
	assert.match(validateMcpServerValue("docs", { url: "https://x", headers: { A: 1 } }), /headers must map names to strings/);
	assert.match(validateMcpServerValue("docs", { url: "https://x", enabled: "yes" }), /enabled must be a boolean/);
	assert.match(validateMcpServerValue("docs", { url: "https://x", oauth: "token" }), /oauth must be an object/);
	assert.match(validateMcpServerValue("docs", 42), /must be an object/);
});

test("loadMcpConfigSnapshot merges native layers and exposes the requested writable scope", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-mcp-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const project = join(root, "project");
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(join(project, ".pi"), { recursive: true });
		await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { local: { url: "https://mcp.local/mcp" } } }, null, 2), "utf8");
		// 项目同名条目整体替换全局：这里只给 enabled:false 是无效的（pi 会报错跳过）
		await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { local: { url: "https://mcp.local/mcp", enabled: false }, proj: { command: "npx" } } }), "utf8");
		const snapshot = await loadMcpConfigSnapshot(agentDir, project, home);
		assert.equal(snapshot.servers.length, 2);
		const local = snapshot.servers.find((item) => item.name === "local");
		// 项目同名条目整体替换全局：来源变成项目层，且不在可写层（全局页不能删它）
		assert.equal(local.ownedByWritable, false);
		assert.equal(local.originScope, "project-pi");
		assert.equal(local.definition.enabled, false);
		assert.equal(local.originPath, join(project, ".pi", "mcp.json"));
		assert.ok(snapshot.servers.some((item) => item.name === "proj"));
		assert.match(snapshot.writableRaw, /local/);
		assert.deepEqual(plain(snapshot.invalidServers), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("project-scope snapshot writes/reads the project layer and hides it when untrusted", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-mcp-scope-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const project = join(root, "project");
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(join(project, ".pi"), { recursive: true });
		await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "npx", args: ["global"] } } }), "utf8");
		await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "npx", args: ["project"] } } }), "utf8");
		// 项目作用域：可写层是项目 .pi/mcp.json
		const projectSnapshot = await loadMcpConfigSnapshot(agentDir, project, home, { writableScope: "project-pi" });
		assert.equal(projectSnapshot.writablePath, join(project, ".pi", "mcp.json"));
		assert.equal(projectSnapshot.layers.find((layer) => layer.kind === "project-pi").writable, true);
		assert.equal(projectSnapshot.servers.find((item) => item.name === "shared").definition.args[0], "project");
		// 未信任：项目层不参与合并
		const untrusted = await loadMcpConfigSnapshot(agentDir, project, home, { writableScope: "pi-agent", projectTrusted: false });
		assert.equal(untrusted.servers.length, 1);
		assert.equal(untrusted.servers[0].definition.args[0], "global");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("broken writable mcp.json keeps raw, reports error, and does not wipe other layers", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-mcp-broken-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const project = join(root, "project");
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(join(project, ".pi"), { recursive: true });
		await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "npx" } } }), "utf8");
		await writeFile(join(agentDir, "mcp.json"), "{ not json", "utf8");
		const snapshot = await loadMcpConfigSnapshot(agentDir, project, home);
		assert.ok(snapshot.writableError);
		assert.match(snapshot.writableRaw, /not json/);
		assert.equal(snapshot.servers.length, 1);
		assert.equal(snapshot.servers[0].name, "shared");
		assert.deepEqual(plain({ ...snapshot.writableFile, mcpServers: { ...snapshot.writableFile.mcpServers } }), { mcpServers: {} });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("malformed writable server entries preserve raw JSON and block visual saving", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-mcp-malformed-server-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { valid: { command: "npx" }, damaged: 42 } }, null, 2), "utf8");
		const snapshot = await loadMcpConfigSnapshot(agentDir, undefined, home);
		assert.match(snapshot.writableError ?? "", /damaged.*object/i);
		// 原文完整保留（可视化保存被 writableError 拦住，不会用空对象覆盖）
		assert.match(snapshot.writableRaw, /"damaged"\s*:\s*42/);
		// 解析层单独看：非法条目按原文 round-trip，不会被静默删掉
		const parsed = parseMcpConfigFile(snapshot.writableRaw);
		assert.equal(parsed.file.mcpServers.damaged, 42);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("project MCP layer junction cannot escape the registered project root", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-mcp-junction-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	const project = join(root, "project");
	const outsidePi = join(root, "outside-pi");
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(project, { recursive: true });
		await mkdir(outsidePi, { recursive: true });
		await writeFile(join(outsidePi, "mcp.json"), JSON.stringify({ mcpServers: { secret: { command: "outside" } } }), "utf8");
		try {
			await symlink(outsidePi, join(project, ".pi"), process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit junction creation");
				return;
			}
			throw error;
		}
		const snapshot = await loadMcpConfigSnapshot(agentDir, project, home);
		assert.equal(
			snapshot.servers.some((server) => server.name === "secret"),
			false,
		);
		assert.equal(snapshot.layers.find((layer) => layer.kind === "project-pi")?.exists, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("parseMcpConfigFile rejects non-object mcpServers and keeps unknown top-level keys", () => {
	const bad = parseMcpConfigFile(JSON.stringify({ mcpServers: [] }));
	assert.ok(bad.error);
	const malformedServer = parseMcpConfigFile(JSON.stringify({ mcpServers: { damaged: 42 } }));
	assert.match(malformedServer.error ?? "", /damaged.*object/i);
	// 非法条目仍保留原文，方便用户修复
	assert.equal(malformedServer.file.mcpServers.damaged, 42);
	const ok = parseMcpConfigFile(JSON.stringify({ mcpServers: { a: { command: "npx" } }, autoEnableCodemode: false, futureKey: 1 }));
	assert.equal(ok.error, undefined);
	assert.equal(ok.file.mcpServers.a.command, "npx");
	assert.equal(ok.file.autoEnableCodemode, false);
	assert.equal(ok.file.futureKey, 1);
});

test("parseMcpConfigFile 容忍 UTF-8 BOM（Windows PowerShell 5.1 写出的 mcp.json）", () => {
	// pi 1.4.0 起自己的 mcp.json 读取走 stripBom（#11191）。两边口径必须一致：
	// 同一份带 BOM 的文件，pi 能加载而 PiDeck 报「配置损坏」会把用户卡死在保存/导入之前。
	const raw = `\uFEFF${JSON.stringify({ mcpServers: { a: { command: "npx" } }, futureKey: 1 }, null, 2)}`;
	const parsed = parseMcpConfigFile(raw);
	assert.equal(parsed.error, undefined, `带 BOM 的 mcp.json 不应报解析错误：${parsed.error}`);
	assert.equal(parsed.file.mcpServers.a.command, "npx");
	assert.equal(parsed.file.futureKey, 1);
});

test("validateMcpConfigFile checks autoEnableCodemode, transport rules and namespace clashes", () => {
	assert.match(validateMcpConfigFile({ autoEnableCodemode: "yes" }), /autoEnableCodemode/);
	// pi 原生按有效分支判定：type 省略且同时有 command/url 时 url 分支优先（已验证）
	assert.equal(validateMcpConfigFile({ mcpServers: { a: { command: "npx", url: "https://x" } } }), null);
	assert.equal(validateMcpConfigFile({ mcpServers: { a: { type: "stdio", command: "npx", url: "https://x" } } }), null);
	assert.match(validateMcpConfigFile({ mcpServers: { a: { command: 42 } } }), /needs either/);
	assert.equal(validateMcpConfigFile({ mcpServers: { a: { url: "https://x/mcp" } } }), null);
	assert.match(validateMcpConfigFile({ mcpServers: { "dev-radius": { command: "a" }, dev_radius: { command: "b" } } }), /conflicts with/);
	// 项目作用域下的 auth 被拒
	assert.match(validateMcpConfigFile({ mcpServers: { a: { url: "https://x", auth: { provider: "anthropic" } } } }, { scope: "project-pi" }), /only allowed in the global/);
});

test("快照解析 mcp-auth.json 键名为已存凭据 server 名（只读键名）", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-mcp-auth-"));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" }, beui: { url: "https://mcp.beui.dev/mcp" } } }), "utf8");
		// 三种键形态：新（mcp__名|url）、历史（裸 URL）、未知（丢弃）
		await writeFile(join(agentDir, "mcp-auth.json"), JSON.stringify({ "mcp__linear|https://mcp.linear.app/mcp": { access_token: "x" }, "https://mcp.beui.dev/mcp": { access_token: "y" }, "mcp__ghost|https://gone/mcp": {} }), "utf8");
		const snapshot = await loadMcpConfigSnapshot(agentDir);
		assert.deepEqual([...snapshot.oauthCredentialNames], ["beui", "linear"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("没有 mcp-auth.json 时 oauthCredentialNames 为空", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-mcp-noauth-"));
	const agentDir = join(root, "agent");
	try {
		await mkdir(agentDir, { recursive: true });
		const snapshot = await loadMcpConfigSnapshot(agentDir);
		assert.deepEqual([...snapshot.oauthCredentialNames], []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
