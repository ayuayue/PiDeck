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

function makeManager({ webStatus = WEB_RUNNING, tunnel = null, reader = null } = {}) {
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

test("getState 反映 web 服务上下文（端口/token/鉴权开关）", () => {
	const { manager } = makeManager({});
	const state = manager.getState();
	assert.equal(state.webRunning, true);
	assert.equal(state.webPort, 38765);
	assert.equal(state.webToken, "tok123");
	assert.equal(state.webRequiresAuth, true);
});
