import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 外网访问域（cloudflare quick tunnel / tailscale serve）：
// 只测纯函数与注入 stub 后的状态机行为，不 spawn 真实二进制、不碰网络。
function loadModule(rel) {
	return loadTsCommonJs(rel);
}

function makeLogger() {
	const lines = [];
	return {
		logger: {
			info: (msg) => lines.push(`info ${msg}`),
			warn: (msg) => lines.push(`warn ${msg}`),
			error: (msg) => lines.push(`error ${msg}`),
			debug: () => {},
		},
		lines,
	};
}

// ── shared 类型守卫（IPC 入参白名单） ──

test("isRemoteAccessChannelId 只放行两个白名单渠道", () => {
	const { isRemoteAccessChannelId } = loadModule("src/shared/types/remoteAccess.ts");
	assert.equal(isRemoteAccessChannelId("cloudflare"), true);
	assert.equal(isRemoteAccessChannelId("tailscale"), true);
	assert.equal(isRemoteAccessChannelId(""), false);
	assert.equal(isRemoteAccessChannelId("ngrok"), false);
	assert.equal(isRemoteAccessChannelId(1), false);
	assert.equal(isRemoteAccessChannelId(null), false);
	assert.equal(isRemoteAccessChannelId(undefined), false);
});

// ── 自定义公网地址（固定链接） ──

test("normalizeRemotePublicUrl 补全 scheme、只保留 origin、拒绝非法输入", () => {
	const { normalizeRemotePublicUrl } = loadModule("src/shared/types/remoteAccess.ts");
	assert.equal(normalizeRemotePublicUrl(""), "");
	assert.equal(normalizeRemotePublicUrl(null), "");
	assert.equal(normalizeRemotePublicUrl(42), "");
	// 只贴域名：补 https
	assert.equal(normalizeRemotePublicUrl("pideck.example.com"), "https://pideck.example.com");
	// 带路径/查询/锚点：只留 origin（转发层把 API 挂在根上）
	assert.equal(normalizeRemotePublicUrl("https://pideck.example.com/app?x=1#y"), "https://pideck.example.com");
	assert.equal(normalizeRemotePublicUrl("  https://pideck.example.com/  "), "https://pideck.example.com");
	// 非默认端口保留
	assert.equal(normalizeRemotePublicUrl("http://1.2.3.4:8765"), "http://1.2.3.4:8765");
	// 非 http/https 协议拒绝
	assert.equal(normalizeRemotePublicUrl("ftp://files.example.com"), "");
	assert.equal(normalizeRemotePublicUrl("javascript:alert(1)"), "");
	// 带凭据的地址丢弃 userinfo，避免把账号密码带进二维码
	assert.equal(normalizeRemotePublicUrl("https://user:pass@host.example.com"), "https://host.example.com");
});

// ── cloudflared 纯函数 ──

test("buildCloudflaredArgs 固定 quick tunnel 参数并注入目标端口", () => {
	const { buildCloudflaredArgs } = loadModule("src/main/web/remoteAccess/cloudflaredTunnel.ts");
	// vm 沙箱返回值的原型在另一 realm，经 JSON 往返迁回宿主再比较
	// http2 + ipv4：强制 TCP 443，规避国内运营商对境外 UDP(QUIC) 的 QoS 限速（详见源码注释）
	const args = JSON.parse(JSON.stringify(buildCloudflaredArgs(38765)));
	assert.deepEqual(args, ["tunnel", "--url", "http://127.0.0.1:38765", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4"]);
});

test("buildCloudflaredArgs 支持用户可调协议与额外参数，同名 flag 以用户为准", () => {
	const { buildCloudflaredArgs, splitCloudflaredExtraArgs } = loadModule("src/main/web/remoteAccess/cloudflaredTunnel.ts");
	const plain = (value) => JSON.parse(JSON.stringify(value));

	// protocol auto：不注入 --protocol（交给 cloudflared 自行回退），edge-ip-version 仍默认
	assert.deepEqual(plain(buildCloudflaredArgs(1, { protocol: "auto" })), ["tunnel", "--url", "http://127.0.0.1:1", "--no-autoupdate", "--edge-ip-version", "4"]);
	// protocol quic：显式注入
	assert.deepEqual(plain(buildCloudflaredArgs(1, { protocol: "quic" })), ["tunnel", "--url", "http://127.0.0.1:1", "--no-autoupdate", "--protocol", "quic", "--edge-ip-version", "4"]);
	// extra 覆盖同名 flag（--protocol= 等号形式）：默认注入全部跳过，用户参数在尾部
	assert.deepEqual(plain(buildCloudflaredArgs(1, { extraArgs: "--protocol=quic --edge-ip-version 6" })), ["tunnel", "--url", "http://127.0.0.1:1", "--no-autoupdate", "--protocol=quic", "--edge-ip-version", "6"]);
	// extra 仅覆盖 --edge-ip-version（空格形式）：--protocol 仍按设置注入
	assert.deepEqual(plain(buildCloudflaredArgs(1, { extraArgs: "--edge-ip-version 6" })), ["tunnel", "--url", "http://127.0.0.1:1", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "6"]);
	// 多空白切分
	assert.deepEqual(plain(splitCloudflaredExtraArgs("  --region   us  --ha-connections 2 ")), ["--region", "us", "--ha-connections", "2"]);
	assert.deepEqual(plain(splitCloudflaredExtraArgs(undefined)), []);
});

test("sanitizeEasyTierVirtualIp 只接受合法 IPv4，拒绝 CIDR/端口/0.0.0.0/广播地址", () => {
	const { sanitizeEasyTierVirtualIp } = loadModule("src/shared/types/settings.ts");
	assert.equal(sanitizeEasyTierVirtualIp(" 10.144.144.1 "), "10.144.144.1");
	assert.equal(sanitizeEasyTierVirtualIp("192.168.001.010"), "192.168.1.10");
	assert.equal(sanitizeEasyTierVirtualIp("10.144.144.1/24"), "");
	assert.equal(sanitizeEasyTierVirtualIp("10.144.144.1:8765"), "");
	assert.equal(sanitizeEasyTierVirtualIp("999.1.1.1"), "");
	assert.equal(sanitizeEasyTierVirtualIp("0.0.0.0"), "");
	assert.equal(sanitizeEasyTierVirtualIp("255.255.255.255"), "");
	assert.equal(sanitizeEasyTierVirtualIp(""), "");
	assert.equal(sanitizeEasyTierVirtualIp(null), "");
});

test("sanitizeCloudflaredExtraArgs 允许空格分隔、拒绝控制字符与非 ASCII", () => {
	const { sanitizeCloudflaredExtraArgs } = loadModule("src/shared/types/settings.ts");
	assert.equal(sanitizeCloudflaredExtraArgs("--edge-ip-version 6"), "--edge-ip-version 6");
	assert.equal(sanitizeCloudflaredExtraArgs("  --a 1  "), "--a 1");
	assert.equal(sanitizeCloudflaredExtraArgs(""), "");
	assert.equal(sanitizeCloudflaredExtraArgs(null), "");
	assert.equal(sanitizeCloudflaredExtraArgs(42), "");
	assert.equal(sanitizeCloudflaredExtraArgs("a\tb"), "", "制表符是控制字符，整体置空");
	assert.equal(sanitizeCloudflaredExtraArgs("a中b"), "", "非 ASCII 整体置空");
	assert.equal(sanitizeCloudflaredExtraArgs("a".repeat(501)), "", "超长置空");
});

test("cliErrorMessage 提取 stderr 首行，去掉 execFile 的命令行回显噪音", () => {
	const { cliErrorMessage } = loadModule("src/main/web/remoteAccess/tailscaleAccess.ts");
	const noisy = new Error("Command failed: C:\\Program Files\\Tailscale\\tailscale.exe serve --bg http://127.0.0.1:8765\nserve: must enable HTTPS in the admin console\n");
	assert.equal(cliErrorMessage(noisy, "tailscale serve 启用失败（端口 8765）"), "tailscale serve 启用失败（端口 8765）: serve: must enable HTTPS in the admin console");
	// 无 stderr 行：回退到原 message 整体（截断展示交给 UI）；沙箱内 String(error) 带 "Error: " 前缀，只断言包含
	assert.ok(cliErrorMessage(new Error("boom"), "前缀").includes("boom"));
	assert.equal(cliErrorMessage("not an error", "前缀"), "前缀: not an error");
});

test("TailscaleAccessReader.startServe 注入 --accept-risk=serve 且失败消息经 cliErrorMessage 清洗", async () => {
	const { TailscaleAccessReader } = loadModule("src/main/web/remoteAccess/tailscaleAccess.ts");
	const calls = [];
	const reader = new TailscaleAccessReader({
		logger: makeLogger().logger,
		commandFn: async (args) => {
			calls.push(args);
			if (args[0] === "serve" && args[1] !== "status") {
				throw new Error("Command failed: tailscale serve --bg\nserve: https not enabled on tailnet");
			}
			return { stdout: "{}", stderr: "" };
		},
	});
	await assert.rejects(reader.startServe(8765), /https not enabled on tailnet/);
	// vm 沙箱数组原型在另一 realm，经 JSON 往返迁回宿主再比较
	assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["serve", "--bg", "--accept-risk=serve", "http://127.0.0.1:8765"], "非交互 serve 必须带风险确认 flag");
});

test("TailscaleAccessReader.startServe 旧版 CLI 不认识 --accept-risk 时去 flag 重试一次", async () => {
	const { TailscaleAccessReader } = loadModule("src/main/web/remoteAccess/tailscaleAccess.ts");
	const calls = [];
	const reader = new TailscaleAccessReader({
		logger: makeLogger().logger,
		commandFn: async (args) => {
			calls.push(args);
			if (args.includes("--accept-risk=serve")) {
				throw new Error("Command failed: tailscale serve --bg\nflag provided but not defined: -accept-risk");
			}
			return { stdout: "{}", stderr: "" };
		},
	});
	await reader.startServe(8765);
	assert.equal(calls.length, 2, "首次带 flag 失败后必须重试一次");
	assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["serve", "--bg", "http://127.0.0.1:8765"], "旧版重试不得再带 --accept-risk");
	// 其他错误不重试：首次失败后直接抛
	const calls2 = [];
	const reader2 = new TailscaleAccessReader({
		logger: makeLogger().logger,
		commandFn: async (args) => {
			calls2.push(args);
			throw new Error("Command failed: tailscale serve --bg\nserve: https not enabled on tailnet");
		},
	});
	await assert.rejects(reader2.startServe(8765), /https not enabled on tailnet/);
	assert.equal(calls2.length, 1, "非 flag 版本错误不重试");
});

test("TailscaleAccessReader 默认命令执行器给子进程补 TERM（macOS GUI 版 CLI 模式判定依赖它）", async () => {
	const calls = [];
	const fakeExecFile = (command, args, options, callback) => {
		calls.push({ command, args, options });
		callback(null, { stdout: JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.1.2.3"], DNSName: "box.tail.ts.net." } }), stderr: "" });
	};
	const { TailscaleAccessReader } = loadTsCommonJs("src/main/web/remoteAccess/tailscaleAccess.ts", { stubs: { "node:child_process": { execFile: fakeExecFile } } });
	const reader = new TailscaleAccessReader({ logger: makeLogger().logger, binary: "/Applications/Tailscale.app/Contents/MacOS/Tailscale" });
	const savedTerm = process.env.TERM;
	try {
		// 模拟 Dock/Finder 启动：launchd 给的环境里没有 TERM，父进程环境因此也没有
		delete process.env.TERM;
		assert.equal((await reader.probeStatus()).error, "");
		// 终端启动路径已有 TERM：原样带到子进程，不被兜底值覆盖
		process.env.TERM = "screen-256color";
		assert.equal((await reader.probeStatus()).loggedIn, true);
	} finally {
		if (savedTerm === undefined) delete process.env.TERM;
		else process.env.TERM = savedTerm;
	}
	assert.equal(calls.length, 2);
	assert.equal(calls[0].command, "/Applications/Tailscale.app/Contents/MacOS/Tailscale");
	assert.equal(calls[0].options.env.TERM, "xterm-256color", "父进程无 TERM 时必须补兜底值");
	assert.equal(calls[1].options.env.TERM, "screen-256color", "已有 TERM 不覆盖");
	// Windows 上 {...process.env} 展开的键名是 Path（GH runner 只有 Path、没有 PATH），普通对象读取大小写敏感：
	// 两侧都做大小写兼容，写法与 tests/gitWslInvocation.test.mjs 的同类断言一致
	const inheritedPath = calls[0].options.env.PATH ?? calls[0].options.env.Path;
	assert.equal(inheritedPath, process.env.PATH ?? process.env.Path, "父进程环境其余部分完整继承");
});

test("probeStatus 把非 JSON 输出（macOS GUI 模式文本）转成带 CLI 原文的错误", async () => {
	const { TailscaleAccessReader } = loadModule("src/main/web/remoteAccess/tailscaleAccess.ts");
	const warns = [];
	const logger = { info: () => {}, warn: (...args) => warns.push(args), error: () => {}, debug: () => {} };
	const guiText = "The Tailscale GUI failed to start: The operation couldn't be completed. (Tailscale.CLIError error 3.)";
	const reader = new TailscaleAccessReader({ logger, commandFn: async () => ({ stdout: `${guiText}\n`, stderr: "" }) });
	const status = await reader.probeStatus();
	assert.equal(status.loggedIn, false);
	assert.equal(status.error, `tailscale status 未返回 JSON：${guiText}`);
	assert.ok(
		warns.some(([scope, message]) => scope === "web-remote" && message === "tailscale status probe failed"),
		"仍走既有 warn 日志",
	);
});

test("extractTryCloudflareUrl 从 cloudflared 日志文本提取 trycloudflare 地址", () => {
	const { extractTryCloudflareUrl } = loadModule("src/main/web/remoteAccess/cloudflaredTunnel.ts");
	const logLines = [
		"2026-03-01T10:00:00Z INF +--------------------------------------------------------------------------------------------+",
		"2026-03-01T10:00:00Z INF |  https://random-words-here.trycloudflare.com                                                   |",
		"2026-03-01T10:00:00Z INF +--------------------------------------------------------------------------------------------+",
	].join("\n");
	assert.equal(extractTryCloudflareUrl(logLines), "https://random-words-here.trycloudflare.com");
	assert.equal(extractTryCloudflareUrl("no url here"), "");
});

// ── tailscale 纯函数 ──

test("parseTailscaleStatus 解析登录态、backendState、虚拟 IP 与 MagicDNS 名", () => {
	const { parseTailscaleStatus } = loadModule("src/main/web/remoteAccess/tailscaleAccess.ts");
	const parsed = JSON.parse(
		JSON.stringify(
			parseTailscaleStatus({
				BackendState: "Running",
				Self: { TailscaleIPs: ["100.101.102.103"], DNSName: "box.tail1234.ts.net." },
			}),
		),
	);
	assert.deepEqual(parsed, { loggedIn: true, backendState: "Running", ip: "100.101.102.103", dnsName: "box.tail1234.ts.net" });
});

test("parseTailscaleStatus 对 NeedsLogin/缺 IP 判未登录且无地址", () => {
	const { parseTailscaleStatus } = loadModule("src/main/web/remoteAccess/tailscaleAccess.ts");
	const parsed = parseTailscaleStatus({ BackendState: "NeedsLogin", Self: {} });
	assert.equal(parsed.loggedIn, false);
	assert.equal(parsed.ip, "");
	assert.equal(parsed.dnsName, "");
});

test("serveStatusTargetsPort 识别 serve 状态 JSON 中的回源端口", () => {
	const { serveStatusTargetsPort } = loadModule("src/main/web/remoteAccess/tailscaleAccess.ts");
	// serve status 输出是 JSON；判定策略是序列化后包含目标回源地址（版本无关的宽松匹配）
	const pointing = JSON.stringify({ https: { 443: { handler: "proxy", proxy: "http://127.0.0.1:38765" } } });
	const pointingOther = JSON.stringify({ https: { 443: { handler: "proxy", proxy: "http://127.0.0.1:9999" } } });
	assert.equal(serveStatusTargetsPort(pointing, 38765), true);
	assert.equal(serveStatusTargetsPort(pointingOther, 38765), false);
	assert.equal(serveStatusTargetsPort("", 38765), false);
	assert.equal(serveStatusTargetsPort("not-json", 38765), false);
});

test("buildTailscaleServeUrl 由 dnsName 拼固定 https 地址", () => {
	const { buildTailscaleServeUrl } = loadModule("src/main/web/remoteAccess/tailscaleAccess.ts");
	assert.equal(buildTailscaleServeUrl("box.tail1234.ts.net"), "https://box.tail1234.ts.net");
	assert.equal(buildTailscaleServeUrl(""), "");
});

test("parseTailscaleStatusStdout 解析 JSON；非 JSON 时只带 CLI 首行原文（截断到 200 字符）", () => {
	const { parseTailscaleStatusStdout } = loadModule("src/main/web/remoteAccess/tailscaleAccess.ts");
	// vm 沙箱返回值的原型在另一 realm，经 JSON 往返迁回宿主再比较
	const parsed = JSON.parse(JSON.stringify(parseTailscaleStatusStdout('{"BackendState":"Running"}')));
	assert.deepEqual(parsed, { BackendState: "Running" });
	const gui = "The Tailscale GUI failed to start: The operation couldn't be completed. (Tailscale.CLIError error 3.)";
	// 多行：只取首行，界面与日志不被后续噪声撑爆
	assert.throws(
		() => parseTailscaleStatusStdout(`${gui}\nsecond line\n`),
		(error) => error.message === `tailscale status 未返回 JSON：${gui}`,
	);
	// 超长单行：截断到 200 字符
	assert.throws(
		() => parseTailscaleStatusStdout("y".repeat(500)),
		(error) => error.message === `tailscale status 未返回 JSON：${"y".repeat(200)}`,
	);
	assert.throws(() => parseTailscaleStatusStdout("   \n"), /没有输出/, "纯空白视为没有输出");
});

test("buildTailscaleChildEnv 补缺失 TERM、保留已有值与环境其余部分", () => {
	const { buildTailscaleChildEnv } = loadModule("src/main/web/remoteAccess/tailscaleAccess.ts");
	const injected = JSON.parse(JSON.stringify(buildTailscaleChildEnv({ PATH: "/usr/bin", HOME: "/Users/me" })));
	assert.deepEqual(injected, { PATH: "/usr/bin", HOME: "/Users/me", TERM: "xterm-256color" });
	assert.equal(buildTailscaleChildEnv({ TERM: "screen-256color" }).TERM, "screen-256color", "已有 TERM 不覆盖");
	assert.equal(buildTailscaleChildEnv({ TERM: "" }).TERM, "xterm-256color", "空 TERM 视为未设置");
});

// ── easytier 纯函数与读取器 ──

test("normalizeEasyTierIpv4 去 CIDR、补全前导零并拒绝非法地址", () => {
	const { normalizeEasyTierIpv4 } = loadModule("src/main/web/remoteAccess/easytierAccess.ts");
	assert.equal(normalizeEasyTierIpv4("10.144.144.1/24"), "10.144.144.1");
	assert.equal(normalizeEasyTierIpv4(" 10.144.144.001 "), "10.144.144.1");
	assert.equal(normalizeEasyTierIpv4("0.0.0.0"), "");
	assert.equal(normalizeEasyTierIpv4("255.255.255.255"), "");
	assert.equal(normalizeEasyTierIpv4("10.144.144"), "");
	assert.equal(normalizeEasyTierIpv4(""), "");
});

test("parseEasyTierNodeJson 解析单实例与多实例 NodeInfo", () => {
	const { parseEasyTierNodeJson } = loadModule("src/main/web/remoteAccess/easytierAccess.ts");
	const single = JSON.parse(JSON.stringify(parseEasyTierNodeJson(JSON.stringify({ ipv4_addr: "10.144.144.1/24", hostname: "et-node", version: "2.7.0" }))));
	assert.deepEqual(single, { ip: "10.144.144.1", hostname: "et-node", version: "2.7.0" });
	const multi = JSON.parse(
		JSON.stringify(
			parseEasyTierNodeJson(
				JSON.stringify([
					{ instance_id: "a", instance_name: "first", result: { ipv4_addr: "10.144.144.2/24", hostname: "node-a", version: "2.6.0" } },
					{ instance_id: "b", instance_name: "second", result: { ipv4_addr: "10.144.144.3/24", hostname: "node-b", version: "2.6.0" } },
				]),
			),
		),
	);
	assert.deepEqual(multi, { ip: "10.144.144.2", hostname: "node-a", version: "2.6.0" }, "多实例取第一条有虚拟 IP 的节点");
	assert.deepEqual(JSON.parse(JSON.stringify(parseEasyTierNodeJson("not-json"))), { ip: "", hostname: "", version: "" });
});

test("parseEasyTierNodeTable 解析旧版 markdown 表格的 Virtual IP", () => {
	const { parseEasyTierNodeTable } = loadModule("src/main/web/remoteAccess/easytierAccess.ts");
	const table = ["| Virtual IP | 10.144.144.1/24 |", "| Hostname | et-node |", "| Peer ID | 439804259 |"].join("\n");
	assert.deepEqual(JSON.parse(JSON.stringify(parseEasyTierNodeTable(table))), { ip: "10.144.144.1", hostname: "et-node", version: "" });
	assert.deepEqual(JSON.parse(JSON.stringify(parseEasyTierNodeTable("no table"))), { ip: "", hostname: "", version: "" });
});

test("sanitizeEasyTierCliPath 去引号与空白、拒绝控制字符", () => {
	const { sanitizeEasyTierCliPath } = loadModule("src/shared/types/settings.ts");
	assert.equal(sanitizeEasyTierCliPath('  "C:\\Program Files\\EasyTier\\easytier-cli.exe" '), "C:\\Program Files\\EasyTier\\easytier-cli.exe");
	assert.equal(sanitizeEasyTierCliPath("  /usr/local/bin/easytier-cli  "), "/usr/local/bin/easytier-cli");
	// 中文目录必须保留（Windows 用户目录常见）
	assert.equal(sanitizeEasyTierCliPath("D:\\工具\\EasyTier\\easytier-cli.exe"), "D:\\工具\\EasyTier\\easytier-cli.exe");
	assert.equal(sanitizeEasyTierCliPath(""), "");
	assert.equal(sanitizeEasyTierCliPath(null), "");
	assert.equal(sanitizeEasyTierCliPath("a\nb"), "");
	assert.equal(sanitizeEasyTierCliPath("x".repeat(1025)), "");
});

test("detectEasyTierBinary 优先返回用户指定路径（文件/目录/带引号都认）", async () => {
	const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "pideck-et-cli-"));
	try {
		const exeName = process.platform === "win32" ? "easytier-cli.exe" : "easytier-cli";
		const exePath = join(dir, exeName);
		await writeFile(exePath, "");
		const { detectEasyTierBinary } = loadModule("src/main/web/remoteAccess/easytierAccess.ts");
		assert.equal(await detectEasyTierBinary(exePath), exePath, "直接给可执行文件");
		assert.equal(await detectEasyTierBinary(dir), exePath, "给目录时补 easytier-cli[.exe]");
		assert.equal(await detectEasyTierBinary(`  "${exePath}"  `), exePath, "容忍引号与空白");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("refresh 把用户指定的 easytier-cli 路径传给检测器", async () => {
	const { logger } = makeLogger();
	const seen = [];
	const { RemoteAccessManager } = loadModule("src/main/web/remoteAccess/RemoteAccessManager.ts");
	const manager = new RemoteAccessManager({
		logger,
		getWebServiceStatus: () => ({ running: false, port: 0, token: "", requiresAuth: false }),
		pushState: () => {},
		detectCloudflared: () => "",
		detectTailscale: () => "",
		detectEasyTier: (preferredPath) => {
			seen.push(preferredPath);
			return "C:/fake/easytier-cli.exe";
		},
		getEasyTierCliPath: () => "  D:/Tools/EasyTier/easytier-cli.exe  ",
		getEasyTierManualIp: () => "",
		easytierReaderFactory: () => ({
			probe: async () => ({ running: true, ip: "10.144.144.1", hostname: "", version: "", ipSource: "cli", error: "" }),
		}),
	});
	await manager.refresh();
	assert.deepEqual(seen, ["D:/Tools/EasyTier/easytier-cli.exe"]);
});

test("指定路径不可用时给出明确错误，而不是静默显示未安装", async () => {
	const { logger } = makeLogger();
	const { RemoteAccessManager } = loadModule("src/main/web/remoteAccess/RemoteAccessManager.ts");
	const manager = new RemoteAccessManager({
		logger,
		getWebServiceStatus: () => ({ running: false, port: 0, token: "", requiresAuth: false }),
		pushState: () => {},
		detectCloudflared: () => "",
		detectTailscale: () => "",
		detectEasyTier: () => "",
		getEasyTierCliPath: () => "D:/nope/easytier-cli.exe",
	});
	const state = await manager.refresh();
	assert.equal(state.easytier.installed, false);
	assert.match(state.easytier.error, /指定的 easytier-cli 路径不可用/);
});

test("EasyTierAccessReader 从 -o json 读取节点信息", async () => {
	const { EasyTierAccessReader } = loadModule("src/main/web/remoteAccess/easytierAccess.ts");
	const calls = [];
	const reader = new EasyTierAccessReader({
		logger: makeLogger().logger,
		commandFn: async (args) => {
			calls.push(args);
			return { stdout: JSON.stringify({ ipv4_addr: "10.144.144.1/24", hostname: "et-node", version: "2.7.0" }), stderr: "" };
		},
	});
	const probe = await reader.probe();
	assert.equal(probe.running, true);
	assert.equal(probe.ip, "10.144.144.1");
	assert.equal(probe.ipSource, "cli");
	assert.equal(probe.error, "");
	assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["-o", "json", "node"]]);
});

test("EasyTierAccessReader 手动 IP 优先于自动检测结果", async () => {
	const { EasyTierAccessReader } = loadModule("src/main/web/remoteAccess/easytierAccess.ts");
	const reader = new EasyTierAccessReader({
		logger: makeLogger().logger,
		manualIp: "10.144.144.9",
		commandFn: async () => ({ stdout: JSON.stringify({ ipv4_addr: "10.144.144.1/24", hostname: "et-node", version: "2.7.0" }), stderr: "" }),
	});
	const probe = await reader.probe();
	assert.equal(probe.ip, "10.144.144.9");
	assert.equal(probe.ipSource, "manual");
	assert.equal(probe.running, true);
	assert.equal(probe.hostname, "et-node");
});

test("EasyTierAccessReader CLI 不可用时回落到手动 IP，不把探测错误甩给用户", async () => {
	const { EasyTierAccessReader } = loadModule("src/main/web/remoteAccess/easytierAccess.ts");
	const reader = new EasyTierAccessReader({
		logger: makeLogger().logger,
		manualIp: "10.144.144.9",
		commandFn: async () => {
			throw new Error("Command failed: easytier-cli -o json node\nconnection refused");
		},
	});
	const probe = await reader.probe();
	assert.equal(probe.running, false);
	assert.equal(probe.ip, "10.144.144.9");
	assert.equal(probe.ipSource, "manual");
	assert.equal(probe.error, "");
});

test("EasyTierAccessReader 无手动 IP 时返回可读错误", async () => {
	const { EasyTierAccessReader } = loadModule("src/main/web/remoteAccess/easytierAccess.ts");
	const reader = new EasyTierAccessReader({
		logger: makeLogger().logger,
		commandFn: async () => {
			throw new Error("Command failed: easytier-cli -o json node\n\u001b[31;1mconnection refused\u001b[0m");
		},
	});
	const probe = await reader.probe();
	assert.equal(probe.ip, "");
	assert.equal(probe.ipSource, "");
	assert.ok(probe.error.includes("connection refused"));
	assert.ok(!probe.error.includes("\u001b"), "错误信息必须去掉 ANSI 颜色码");
});

// ── RemoteAccessManager 状态机（注入 stub，不碰 PATH 与子进程） ──

const WEB_RUNNING = { running: true, port: 38765, token: "tok123", requiresAuth: true };

function stubTunnel(log) {
	return {
		start: async (binary, port) => {
			log.push(`tunnel-start ${binary} ${port}`);
			return "https://stub.trycloudflare.com";
		},
		stop: async () => {
			log.push("tunnel-stop");
		},
		attachLifecycleWatch: () => {
			log.push("tunnel-watch");
		},
	};
}

function stubReader(log, status) {
	return {
		probeStatus: async () => ({ loggedIn: true, backendState: "Running", ip: "100.1.2.3", dnsName: "box.tail.ts.net", error: "" }),
		probeServe: async (port) => {
			log.push(`probe-serve ${port}`);
			return false;
		},
		startServe: async (port) => {
			log.push(`start-serve ${port}`);
		},
		stopServe: async () => {
			log.push("stop-serve");
		},
		status,
	};
}

function makeManager({ webStatus = WEB_RUNNING, tunnel = null, reader = null, easyTier = null, easyTierManualIp = () => (easyTier === "manual" ? "10.144.144.9" : "") } = {}) {
	const { logger } = makeLogger();
	const pushes = [];
	const log = [];
	const { RemoteAccessManager } = loadModule("src/main/web/remoteAccess/RemoteAccessManager.ts");
	const manager = new RemoteAccessManager({
		logger,
		getWebServiceStatus: () => webStatus,
		pushState: (state) => pushes.push(state),
		detectCloudflared: () => (tunnel ? "C:/fake/cloudflared.exe" : ""),
		detectTailscale: () => (reader ? "C:/fake/tailscale.exe" : ""),
		detectEasyTier: () => (easyTier ? "C:/fake/easytier-cli.exe" : ""),
		getEasyTierManualIp: easyTierManualIp,
		easytierReaderFactory: () => ({
			probe: async () => (easyTier === "manual" ? { running: true, ip: "10.144.144.9", hostname: "", version: "", ipSource: "manual", error: "" } : { running: true, ip: "10.144.144.1", hostname: "et-node", version: "2.7.0", ipSource: "cli", error: "" }),
		}),
		tunnelFactory: () => stubTunnel(log),
		readerFactory: () => stubReader(log, reader),
	});
	return { manager, pushes, log };
}

test("cloudflare start 置 running 并把 publicUrl 带进状态与推送", async () => {
	const { manager, pushes, log } = makeManager({ tunnel: true });
	const state = await manager.start("cloudflare");
	assert.equal(state.cloudflare.running, true);
	assert.equal(state.cloudflare.starting, false);
	assert.equal(state.cloudflare.publicUrl, "https://stub.trycloudflare.com");
	assert.ok(pushes.some((s) => s.cloudflare.publicUrl === "https://stub.trycloudflare.com"));
	await manager.stop("cloudflare");
	assert.deepEqual(log, ["tunnel-start C:/fake/cloudflared.exe 38765", "tunnel-watch", "tunnel-stop"]);
});

test("cloudflare start 在 Web 服务未运行时拒绝并保留错误信息", async () => {
	const { manager } = makeManager({ webStatus: { running: false, port: 0, token: "", requiresAuth: false }, tunnel: true });
	const state = await manager.start("cloudflare");
	assert.equal(state.cloudflare.running, false);
	assert.ok(state.cloudflare.error.length > 0);
});

test("cloudflare start 在未安装 cloudflared 时给出可读指引", async () => {
	const { manager } = makeManager({ tunnel: false });
	const state = await manager.start("cloudflare");
	assert.equal(state.cloudflare.running, false);
	assert.equal(state.cloudflare.binaryAvailable, false);
	assert.ok(state.cloudflare.error.includes("cloudflared"));
});

test("tailscale startServe 成功后 serveActive/serveUrl 就位", async () => {
	const { manager, log } = makeManager({ reader: true });
	await manager.refresh();
	const state = await manager.start("tailscale");
	assert.equal(state.tailscale.serveActive, true);
	assert.equal(state.tailscale.serveUrl, "https://box.tail.ts.net");
	assert.ok(log.includes("start-serve 38765"));
	await manager.stop("tailscale");
	assert.ok(log.includes("stop-serve"));
});

test("tailscale 渠道未安装时 start 返回错误而非抛异常", async () => {
	const { manager } = makeManager({ reader: false });
	const state = await manager.start("tailscale");
	assert.equal(state.tailscale.installed, false);
	assert.ok(state.tailscale.error.length > 0);
});

test("refresh 聚合 reader 探测结果到状态", async () => {
	const { manager } = makeManager({ reader: true });
	const state = await manager.refresh();
	assert.equal(state.tailscale.installed, true);
	assert.equal(state.tailscale.loggedIn, true);
	assert.equal(state.tailscale.ip, "100.1.2.3");
	assert.equal(state.tailscale.dnsName, "box.tail.ts.net");
});

test("refresh 聚合 easytier 只读探测结果", async () => {
	const { manager, pushes } = makeManager({ easyTier: true });
	const state = await manager.refresh();
	assert.equal(state.easytier.installed, true);
	assert.equal(state.easytier.running, true);
	assert.equal(state.easytier.ip, "10.144.144.1");
	assert.equal(state.easytier.hostname, "et-node");
	assert.equal(state.easytier.version, "2.7.0");
	assert.equal(state.easytier.ipSource, "cli");
	assert.ok(pushes.some((s) => s.easytier.ip === "10.144.144.1"));
});

test("syncWebService 在保存设置后刷新 easytier 手动 IP", async () => {
	let manualIp = "";
	const { manager } = makeManager({ easyTier: false, easyTierManualIp: () => manualIp });
	manualIp = "10.144.144.9";
	await manager.syncWebService();
	const state = manager.getState();
	assert.equal(state.easytier.installed, false);
	assert.equal(state.easytier.ip, "10.144.144.9");
	assert.equal(state.easytier.ipSource, "manual");
});

test("getState 反映 web 服务上下文（端口/token/鉴权开关）", () => {
	const { manager } = makeManager({});
	const state = manager.getState();
	assert.equal(state.webRunning, true);
	assert.equal(state.webPort, 38765);
	assert.equal(state.webToken, "tok123");
	assert.equal(state.webRequiresAuth, true);
});

// ── 隧道启动失败清理（孤儿进程回归）──
// 场景：waitForUrl 超时/URL 解析失败时 start 抛错。若 manager 不调用 tunnel.stop()，
// cloudflared 子进程成为孤儿——它可能稍后自行建好隧道，公网入口存在但 UI 显示失败。
test("cloudflare start 失败时必须 stop 隧道进程（不留孤儿/幽灵公网入口）", async () => {
	const { logger } = makeLogger();
	const calls = [];
	const { RemoteAccessManager } = loadModule("src/main/web/remoteAccess/RemoteAccessManager.ts");
	const manager = new RemoteAccessManager({
		logger,
		getWebServiceStatus: () => WEB_RUNNING,
		pushState: () => {},
		detectCloudflared: () => "C:/fake/cloudflared.exe",
		detectTailscale: () => "",
		tunnelFactory: () => ({
			start: async () => {
				calls.push("start");
				throw new Error("等待 Cloudflare 分配隧道地址超时（30 秒），请检查网络后重试");
			},
			stop: async () => {
				calls.push("stop");
			},
			attachLifecycleWatch: () => {
				calls.push("watch");
			},
		}),
		readerFactory: () => null,
	});
	const state = await manager.start("cloudflare");
	assert.equal(state.cloudflare.running, false);
	assert.equal(state.cloudflare.error.includes("超时"), true, `error should surface timeout cause: ${state.cloudflare.error}`);
	assert.deepEqual(calls, ["start", "stop"], "failed tunnel must be stopped exactly once");
});
