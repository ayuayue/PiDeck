/**
 * 本地服务能力（`service.local`）的门禁测试。
 *
 * 覆盖四件事：
 *   1. manifest：`service.local` 与 `services` 互为必需，且只能点名 PiDeck 已实现的服务；
 *   2. policy：四个 service 方法只接受白名单 id，其他一律 `invalid-request` / `unsupported-method`；
 *   3. broker：权限 + 点名双重门、适配器缺席时 `service-unavailable`、撤销授权时中断在途启停、
 *      `openUi` 只转发主进程适配器推导出的地址；
 *   4. 适配器自身：只认回环 UI 地址、只按 CLI 报告的 pid 终止、命令与参数过字符白名单。
 *
 * 另外守一份「随包内置示例插件」的契约：它必须是真能装进用户目录的包。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseHostPluginManifest } = loadTsCommonJs("src/main/plugins/hostPluginManifest.ts");
const { parsePluginRequest } = loadTsCommonJs("src/main/plugins/hostPluginPolicy.ts");
const { HostPluginBroker } = loadTsCommonJs("src/main/plugins/HostPluginBroker.ts");
const { HostPluginManager } = loadTsCommonJs("src/main/plugins/HostPluginManager.ts");
const { LocalServiceRegistry } = loadTsCommonJs("src/main/localServices/LocalServiceRegistry.ts");
const { BillionContextService, parseBillionContextReport } = loadTsCommonJs("src/main/localServices/billionContextService.ts");
const { localServiceInvocation, localServiceDetachedInvocation, killLocalServiceInvocation, LOCAL_SERVICE_LAUNCHER_PROGRAM, LOCAL_SERVICE_LAUNCH_COMMAND_ENV, LOCAL_SERVICE_LAUNCH_ARGS_ENV } = loadTsCommonJs("src/main/localServices/localServiceCli.ts");
const { LOCAL_SERVICE_IDS, isLocalServiceId } = loadTsCommonJs("src/shared/localServices.ts");

const SERVICE_ID = LOCAL_SERVICE_IDS[0];

/**
 * `loadTsCommonJs` 在 vm 沙箱里求值，生产模块造出来的对象属于另一个 realm，
 * `assert.deepStrictEqual` 会因为原型不同报 “same structure but not reference-equal”。
 * 比较前一律过一遍 JSON 往返（同 `tests/hostPlugins.test.mjs` 的做法）。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function manifest(over = {}) {
	return {
		schemaVersion: 1,
		apiVersion: 1,
		id: "example.viewer",
		name: "Viewer",
		version: "1.0.0",
		permissions: ["service.local"],
		services: [SERVICE_ID],
		contributes: { panels: [{ id: "main", title: "Main", entry: "app.html" }], commands: [] },
		...over,
	};
}

/** broker 只读 manifest.permissions / manifest.services，不重新校验，所以这里给原始对象。 */
const brokerManifest = (permissions, services) => ({ schemaVersion: 1, apiVersion: 1, id: "example.viewer", name: "Viewer", version: "1.0.0", permissions, services, contributes: { panels: [], commands: [] } });
const emptySessions = { list: () => ({ sessions: [], nextOffset: null }), entries: async () => ({ entries: [], nextCursor: null, truncated: false }), describe: (context) => context, navigable: () => false };
const emptyStorage = { get: () => null, set: async () => undefined, keys: async () => [], remove: async () => undefined };
const context = { locale: "zh-CN", theme: "light" };

function brokerFor(permissions, services, registry) {
	// 参数尾部是 (projectNameOf, network, services)；这里只要服务适配器表，其余走缺省。
	return new HostPluginBroker({ getEnabled: (id) => (id === "example.viewer" ? { manifest: brokerManifest(permissions, services), fingerprint: "f" } : undefined), onChanged: () => () => {} }, emptySessions, emptyStorage, undefined, undefined, registry);
}

/** 替身适配器：记录调用顺序，可注入每个方法的行为。 */
function fakeAdapter(over = {}) {
	const calls = [];
	const status = over.status ?? (async () => ({ id: SERVICE_ID, available: true, running: true, pid: 42, uiUrl: "http://127.0.0.1:8788/__bili/" }));
	return {
		calls,
		adapter: {
			id: SERVICE_ID,
			status: async (signal) => {
				calls.push("status");
				return status(signal);
			},
			start: async (signal) => {
				calls.push("start");
				return over.start ? over.start(signal) : { id: SERVICE_ID, available: true, running: true, pid: 42 };
			},
			stop: async () => {
				calls.push("stop");
				return over.stop ? over.stop() : { id: SERVICE_ID, available: true, running: false };
			},
		},
	};
}

test("manifest: service.local and services are mutually required and must name an implemented service", () => {
	assert.deepEqual(plain(parseHostPluginManifest(manifest()).services), [SERVICE_ID]);
	// 只声明权限不点名服务 → 拒
	assert.throws(() => parseHostPluginManifest(manifest({ services: undefined })), /invalid-services/);
	// 点名了 PiDeck 没实现的服务 → 拒（第三方插件无法自行扩展能力面）
	assert.throws(() => parseHostPluginManifest(manifest({ services: ["some-other-service"] })), /invalid-services/);
	assert.throws(() => parseHostPluginManifest(manifest({ services: [SERVICE_ID, SERVICE_ID] })), /invalid-services/);
	assert.throws(() => parseHostPluginManifest(manifest({ services: [] })), /invalid-services/);
	assert.throws(() => parseHostPluginManifest(manifest({ services: Array.from({ length: 9 }, () => SERVICE_ID) })), /invalid-services/);
	// 反过来：没有 service.local 权限却写 services → 同样拒
	assert.throws(() => parseHostPluginManifest(manifest({ permissions: ["sessions.read"] })), /invalid-services/);
	// 不涉及服务时不受影响
	const parsed = parseHostPluginManifest(manifest({ permissions: ["sessions.read"], services: undefined }));
	assert.equal(parsed.services, undefined);
	assert.equal(isLocalServiceId(SERVICE_ID), true);
	assert.equal(isLocalServiceId("billion-contexts"), false);
});

test("policy: service methods accept only allowlisted ids and reject unknown methods", () => {
	for (const method of ["service.status", "service.start", "service.stop", "service.openUi"]) {
		assert.deepEqual(plain(parsePluginRequest({ method, id: SERVICE_ID })), { method, id: SERVICE_ID });
	}
	assert.throws(() => parsePluginRequest({ method: "service.start", id: "billion-context; rm -rf /" }), /invalid-request/);
	assert.throws(() => parsePluginRequest({ method: "service.start", id: "" }), /invalid-request/);
	assert.throws(() => parsePluginRequest({ method: "service.start" }), /invalid-request/);
	// 只有登记过的方法存在：新增方法忘登记会报错，而不是白拿权限。
	assert.throws(() => parsePluginRequest({ method: "service.install", id: SERVICE_ID }), /unsupported-method/);
});

test("broker: service control requires both the permission and the named service", async () => {
	const { adapter, calls } = fakeAdapter();
	const registry = new LocalServiceRegistry([adapter]);

	const allowed = brokerFor(["service.local"], [SERVICE_ID], registry);
	allowed.bind(1, "example.viewer", "f", context);
	assert.equal((await allowed.request(1, true, { method: "service.status", id: SERVICE_ID })).ok, true);
	assert.deepEqual(calls, ["status"]);

	// 有权限但没点名这个服务 → permission-denied，适配器一次都不该被碰
	const undeclared = brokerFor(["service.local"], [], registry);
	undeclared.bind(1, "example.viewer", "f", context);
	assert.deepEqual(plain(await undeclared.request(1, true, { method: "service.status", id: SERVICE_ID })), { ok: false, code: "permission-denied" });
	assert.deepEqual(calls, ["status"]);

	// 点名了但没有权限 → permission-denied
	const unpermitted = brokerFor(["sessions.read"], [SERVICE_ID], registry);
	unpermitted.bind(1, "example.viewer", "f", context);
	assert.deepEqual(plain(await unpermitted.request(1, true, { method: "service.start", id: SERVICE_ID })), { ok: false, code: "permission-denied" });

	// 白名单里有、但本机没装适配器 → service-unavailable（白名单与适配器装配是两件事）
	const missing = brokerFor(["service.local"], [SERVICE_ID], new LocalServiceRegistry([]));
	missing.bind(1, "example.viewer", "f", context);
	assert.deepEqual(plain(await missing.request(1, true, { method: "service.status", id: SERVICE_ID })), { ok: false, code: "service-unavailable" });

	for (const broker of [allowed, undeclared, unpermitted, missing]) broker.dispose();
});

test("broker: openUi forwards the adapter-derived url and refuses a stopped service", async () => {
	const running = fakeAdapter();
	const opened = [];
	const broker = brokerFor(["service.local"], [SERVICE_ID], new LocalServiceRegistry([running.adapter]));
	broker.onOpenBrowser((url) => opened.push(url));
	broker.bind(1, "example.viewer", "f", context);
	assert.deepEqual(plain(await broker.request(1, true, { method: "service.openUi", id: SERVICE_ID })), { ok: true, value: null });
	// 插件只能要求「打开」，地址一律来自主进程适配器。
	assert.deepEqual(opened, ["http://127.0.0.1:8788/__bili/"]);

	const stopped = fakeAdapter({ status: async () => ({ id: SERVICE_ID, available: true, running: false }) });
	const broker2 = brokerFor(["service.local"], [SERVICE_ID], new LocalServiceRegistry([stopped.adapter]));
	const opened2 = [];
	broker2.onOpenBrowser((url) => opened2.push(url));
	broker2.bind(1, "example.viewer", "f", context);
	assert.deepEqual(plain(await broker2.request(1, true, { method: "service.openUi", id: SERVICE_ID })), { ok: false, code: "service-not-running" });
	assert.deepEqual(opened2, []);

	broker.dispose();
	broker2.dispose();
});

test("broker: openUi(pid) routes to the allowlisted instance and rejects unknown pids", async () => {
	// 多实例服务（如 billion-context 的 lane daemon）：instances 全部来自主进程适配器报告。
	const multi = fakeAdapter({
		status: async () => ({
			id: SERVICE_ID,
			available: true,
			running: true,
			pid: 13436,
			uiUrl: "http://127.0.0.1:8787/__bili/",
			instances: [
				{ pid: 13436, uiUrl: "http://127.0.0.1:8787/__bili/" },
				{ pid: 20664, uiUrl: "http://127.0.0.1:18790/__bili/" },
			],
		}),
	});
	const opened = [];
	const broker = brokerFor(["service.local"], [SERVICE_ID], new LocalServiceRegistry([multi.adapter]));
	broker.onOpenBrowser((url) => opened.push(url));
	broker.bind(1, "example.viewer", "f", context);
	// 点名 lane 实例 → 打开 lane 的面板
	assert.deepEqual(plain(await broker.request(1, true, { method: "service.openUi", id: SERVICE_ID, pid: 20664 })), { ok: true, value: null });
	// 不带 pid → 仍然是主实例（向后兼容）
	await broker.request(1, true, { method: "service.openUi", id: SERVICE_ID });
	assert.deepEqual(opened, ["http://127.0.0.1:18790/__bili/", "http://127.0.0.1:8787/__bili/"]);

	// 白名单外/已退出的 pid → service-not-running，什么都不开
	const opened2 = [];
	broker.onOpenBrowser((url) => opened2.push(url));
	assert.deepEqual(plain(await broker.request(1, true, { method: "service.openUi", id: SERVICE_ID, pid: 1 })), { ok: false, code: "service-not-running" });
	assert.deepEqual(opened2, []);

	// 单实例服务没有 instances 字段 → 点名任何 pid 都拒
	const single = fakeAdapter();
	const broker3 = brokerFor(["service.local"], [SERVICE_ID], new LocalServiceRegistry([single.adapter]));
	broker3.bind(1, "example.viewer", "f", context);
	assert.deepEqual(plain(await broker3.request(1, true, { method: "service.openUi", id: SERVICE_ID, pid: 42 })), { ok: false, code: "service-not-running" });

	broker.dispose();
	broker3.dispose();
});

test("policy: openUi pid must be a positive integer when present", () => {
	assert.deepEqual(plain(parsePluginRequest({ method: "service.openUi", id: SERVICE_ID, pid: 20664 })), { method: "service.openUi", id: SERVICE_ID, pid: 20664 });
	// 省略 pid 的请求归一化为不带 pid（向后兼容）
	assert.deepEqual(plain(parsePluginRequest({ method: "service.openUi", id: SERVICE_ID })), { method: "service.openUi", id: SERVICE_ID });
	assert.deepEqual(plain(parsePluginRequest({ method: "service.openUi", id: SERVICE_ID, pid: undefined })), { method: "service.openUi", id: SERVICE_ID });
	for (const bad of [0, -1, 1.5, "20664", NaN]) {
		assert.throws(() => parsePluginRequest({ method: "service.openUi", id: SERVICE_ID, pid: bad }), /invalid-request/);
	}
	// pid 字段只对 openUi 有意义：其他服务方法带上也不收（能力面最小化）
	assert.throws(() => parsePluginRequest({ method: "service.status", id: SERVICE_ID, pid: 20664 }), /invalid-request/);
});

test("broker: revoking the plugin aborts an in-flight start and voids its result", async () => {
	let released;
	const started = new Promise((resolve) => {
		released = resolve;
	});
	const { adapter } = fakeAdapter({
		start: async (signal) => {
			// 启停要等进程真的起来：这里模拟「还在等」的服务，撤销授权必须立刻中断。
			await new Promise((done) => {
				signal.addEventListener("abort", () => done(), { once: true });
				void started.then(() => done());
			});
			return { id: SERVICE_ID, available: true, running: true, pid: 42 };
		},
	});
	const broker = brokerFor(["service.local"], [SERVICE_ID], new LocalServiceRegistry([adapter]));
	broker.bind(1, "example.viewer", "f", context);
	const pending = broker.request(1, true, { method: "service.start", id: SERVICE_ID });
	broker.unbind(1);
	released();
	assert.deepEqual(plain(await pending), { ok: false, code: "plugin-revoked" });
	broker.dispose();
});

test("billion-context report: only loopback origins with a live pid count as running", () => {
	const report = (processes, global) => JSON.stringify({ processes, global });
	const live = { instanceId: "i", pid: 23704, port: 28800, origin: "http://127.0.0.1:28800", alive: true };
	assert.deepEqual(plain(parseBillionContextReport(report([live], { runningVersion: "0.1.195" }))), { running: true, pid: 23704, origin: "http://127.0.0.1:28800", version: "0.1.195", instances: [{ pid: 23704, origin: "http://127.0.0.1:28800" }] });
	// 没有 origin 但有 pid + port：origin 由 port 推导
	assert.equal(parseBillionContextReport(report([{ pid: 7, port: 8788, alive: true }], {})).origin, "http://127.0.0.1:8788");
	// 报告被改写成公网地址 → 不当成可用（否则会把内置浏览器带走）
	assert.deepEqual(plain(parseBillionContextReport(report([{ pid: 7, port: 8788, origin: "http://evil.example.com:8788", alive: true }], {}))), { running: false, instances: [] });
	assert.deepEqual(plain(parseBillionContextReport(report([{ pid: 7, port: 8788, origin: "https://127.0.0.1:8788", alive: true }], {}))), { running: false, instances: [] });
	// alive:false / 缺 pid 的条目不算运行
	assert.deepEqual(plain(parseBillionContextReport(report([{ ...live, alive: false }], {}))), { running: false, instances: [] });
	assert.deepEqual(plain(parseBillionContextReport(report([{ port: 8788, alive: true }], {}))), { running: false, instances: [] });
	// 报告本身不可解析（区别于「装了但没跑」）
	assert.equal(parseBillionContextReport("not json"), null);
	assert.equal(parseBillionContextReport("[]"), null);
});

test("billion-context report: collects every live instance (lane daemons included) in table order", () => {
	const report = (processes) => JSON.stringify({ processes, global: {} });
	const shared = { instanceId: "i", origin: "http://127.0.0.1:8787", alive: true };
	// 进程表顺序即优先级：第一个活实例是主实例，lane daemon（如 pi 自己拉起的）跟在后面。
	const snapshot = parseBillionContextReport(
		report([
			{ ...shared, pid: 13436, port: 8787 },
			{ instanceId: "b", pid: 20664, port: 18790, alive: true },
			{ ...shared, pid: 99999, port: 28800, alive: false },
		]),
	);
	assert.deepEqual(plain(snapshot), {
		running: true,
		pid: 13436,
		origin: "http://127.0.0.1:8787",
		instances: [
			{ pid: 13436, origin: "http://127.0.0.1:8787" },
			{ pid: 20664, origin: "http://127.0.0.1:18790" },
		],
	});
	// 非回环实例被剔除后仍不影响其余实例入列。
	const filtered = parseBillionContextReport(
		report([
			{ pid: 1, port: 8788, origin: "http://10.0.0.1:8788", alive: true },
			{ pid: 2, port: 8789, alive: true },
		]),
	);
	assert.deepEqual(plain(filtered.instances), [{ pid: 2, origin: "http://127.0.0.1:8789" }]);
});

test("billion-context status: maps every live instance to a loopback uiUrl", async () => {
	const report = JSON.stringify({
		processes: [
			{ instanceId: "a", pid: 13436, port: 8787, origin: "http://127.0.0.1:8787", alive: true },
			{ instanceId: "b", pid: 20664, port: 18790, alive: true },
		],
		global: { runningVersion: "0.1.208" },
	});
	const service = new BillionContextService({ cli: { run: async () => ({ ok: true, stdout: report }), spawnDetached: async () => ({ ok: true }) }, kill: async () => true });
	assert.deepEqual(plain(await service.status()), {
		id: "billion-context",
		available: true,
		running: true,
		pid: 13436,
		uiUrl: "http://127.0.0.1:8787/__bili/",
		version: "0.1.208",
		instances: [
			{ pid: 13436, uiUrl: "http://127.0.0.1:8787/__bili/" },
			{ pid: 20664, uiUrl: "http://127.0.0.1:18790/__bili/" },
		],
	});
});

test("billion-context service: status, start and stop all go through the fixed CLI commands", async () => {
	const record = [];
	const cli = (report) => ({ run: async (args) => (record.push(["run", ...args]), { ok: true, stdout: typeof report === "function" ? report(args) : report }), spawnDetached: (args) => (record.push(["spawn", ...args]), { ok: true }) });
	const kill = async (pid) => (record.push(["kill", pid]), true);
	const running = JSON.stringify({ processes: [{ pid: 23704, port: 28800, alive: true }], global: { runningVersion: "0.1.195" } });
	const stopped = JSON.stringify({ processes: [], global: { runningVersion: "0.1.195" } });

	const service = new BillionContextService({ cli: cli(running), kill });
	assert.deepEqual(plain(await service.status()), { id: SERVICE_ID, available: true, running: true, pid: 23704, uiUrl: "http://127.0.0.1:28800/__bili/", version: "0.1.195", instances: [{ pid: 23704, uiUrl: "http://127.0.0.1:28800/__bili/" }] });
	assert.deepEqual(record, [["run", "doctor", "--json"]]);

	// 未运行 → 先起进程，再轮询到 doctor 报告存活；命令固定为 `bili start`
	record.length = 0;
	let calls = 0;
	const starting = new BillionContextService({ cli: cli(() => (++calls === 1 ? stopped : running)), kill });
	assert.deepEqual(plain(await starting.start()), { id: SERVICE_ID, available: true, running: true, pid: 23704, uiUrl: "http://127.0.0.1:28800/__bili/", version: "0.1.195", instances: [{ pid: 23704, uiUrl: "http://127.0.0.1:28800/__bili/" }] });
	assert.deepEqual(record, [
		["run", "doctor", "--json"],
		["spawn", "start"],
		["run", "doctor", "--json"],
	]);

	// 停止：pid 只来自报告，不猜
	record.length = 0;
	assert.deepEqual(plain(await new BillionContextService({ cli: cli(() => (++calls > 3 ? stopped : running)), kill }).stop()), { id: SERVICE_ID, available: true, running: false, version: "0.1.195" });
	assert.deepEqual(record, [
		["run", "doctor", "--json"],
		["kill", 23704],
		["run", "doctor", "--json"],
	]);

	// CLI 不可用 → available:false 且带原因码；未运行时不发 kill
	const missing = new BillionContextService({ cli: { run: async () => ({ ok: false, reason: "cli-missing" }), spawnDetached: () => ({ ok: true }) }, kill });
	assert.deepEqual(plain(await missing.status()), { id: SERVICE_ID, available: false, running: false, reason: "cli-missing" });
	assert.deepEqual(plain(await missing.stop()), { id: SERVICE_ID, available: false, running: false });
});

test("billion-context service: a proxy that comes straight back is reported as stop-restarted, not stop-failed", async () => {
	const killed = [];
	const first = JSON.stringify({ processes: [{ pid: 23704, port: 28800, alive: true }], global: { runningVersion: "0.1.195" } });
	const second = JSON.stringify({ processes: [{ pid: 49760, port: 28800, alive: true }], global: { runningVersion: "0.1.195" } });
	let calls = 0;
	const service = new BillionContextService({
		// 终止动作成功，但 doctor 立刻报了一个新 pid——pi 发现自己的代理死了，又拉起来一个。
		cli: { run: async () => ({ ok: true, stdout: ++calls === 1 ? first : second }), spawnDetached: () => ({ ok: true }) },
		kill: async (pid) => (killed.push(pid), true),
		timing: { pollMs: 1, stopSettleMs: 10 },
	});
	const status = plain(await service.stop());
	assert.equal(status.running, true);
	assert.equal(status.reason, "stop-restarted");
	assert.equal(status.pid, 49760);
	assert.equal(status.uiUrl, "http://127.0.0.1:28800/__bili/");
	assert.deepEqual(killed, [23704]);
});

test("billion-context service: a service that never comes up reports start-timeout instead of hanging", async () => {
	const stopped = JSON.stringify({ processes: [], global: {} });
	let calls = 0;
	const controller = new AbortController();
	// 第 2 次 doctor 时中断（等价于插件被撤销授权）：轮询必须立刻收手，而不是等满 20 秒预算。
	const service = new BillionContextService({
		cli: {
			run: async () => {
				calls += 1;
				if (calls >= 2) controller.abort();
				return { ok: true, stdout: stopped };
			},
			spawnDetached: () => ({ ok: true }),
		},
		kill: async () => true,
	});
	assert.deepEqual(plain(await service.start(controller.signal)), { id: SERVICE_ID, available: true, running: false, reason: "start-timeout" });
});

test("local service cli: commands and arguments are character-allowlisted, never interpolated", () => {
	const invocation = localServiceInvocation("bili", ["doctor", "--json"]);
	assert.equal(invocation.args.at(-1).includes("doctor --json"), true);
	// Windows 上 npm 全局命令是 .cmd 垫片，必须经 cmd.exe；其他平台原样透传。
	assert.equal(process.platform === "win32" ? invocation.command === (process.env.ComSpec || "cmd.exe") && invocation.windowsVerbatimArguments === true : invocation.command === "bili" && invocation.args.length === 2, true);
	assert.doesNotThrow(() => localServiceInvocation("bili", ["start", "--port=8788", "-F"]));
	assert.throws(() => localServiceInvocation("bili; rm -rf /", []), /invalid-service-command/);
	assert.throws(() => localServiceInvocation("bili && curl evil.example.com", []), /invalid-service-command/);
	assert.throws(() => localServiceInvocation("bili", ["$(whoami)"]), /invalid-service-argument/);
	assert.throws(() => localServiceInvocation("bili", ["start | tee /tmp/x"]), /invalid-service-argument/);
	assert.throws(() => localServiceInvocation("bili", ["a".repeat(200)]), /invalid-service-argument/);
	// 长驻命令：win32 必须换成 GUI 子系统启动器。
	// 直接 detached 的控制台子系统子进程会被 Windows 新建控制台，`windowsHide` 对「新建的」控制台不生效 → 闪黑框；
	// 换成 GUI 子系统二进制（app 自己的 runtime，`ELECTRON_RUN_AS_NODE` + `-e` 启动器程序）后全程无窗口，
	// 同时靠 detached 活过 PiDeck 退出（消窗与存活两个都不能丢）。
	const detachBase = { command: "cmd.exe", args: ["/d", "/s", "/c", "bili start"], windowsVerbatimArguments: true };
	const win = plain(localServiceDetachedInvocation(detachBase, { platform: "win32", runtimePath: "C:\\app\\PiDeck.exe", env: { PATH: "x" } }));
	assert.equal(win.command, "C:\\app\\PiDeck.exe");
	assert.deepEqual(win.args, ["-e", LOCAL_SERVICE_LAUNCHER_PROGRAM]);
	// 启动器程序本身走 argv 引号（不是 verbatim 整行），CLI 那一层才是 verbatim。
	assert.equal(win.windowsVerbatimArguments, false);
	assert.equal(win.env.ELECTRON_RUN_AS_NODE, "1");
	assert.equal(win.env[LOCAL_SERVICE_LAUNCH_COMMAND_ENV], "cmd.exe");
	assert.deepEqual(JSON.parse(win.env[LOCAL_SERVICE_LAUNCH_ARGS_ENV]), detachBase.args);
	// 适配器清洗过的 env 原样继承，不多带别的。
	assert.equal(win.env.PATH, "x");
	// 启动器必须与 CLI 同生共死：非 detached 的子进程落在启动器自己的 libuv job 上，启动器一退就被连坐杀掉。
	assert.equal(LOCAL_SERVICE_LAUNCHER_PROGRAM.includes("unref"), false);
	// 启动器专用的环境变量不能漏给被拉起的服务（尤其 ELECTRON_RUN_AS_NODE）。
	for (const key of ["ELECTRON_RUN_AS_NODE", LOCAL_SERVICE_LAUNCH_COMMAND_ENV, LOCAL_SERVICE_LAUNCH_ARGS_ENV]) assert.equal(LOCAL_SERVICE_LAUNCHER_PROGRAM.includes(`delete env.${key}`), true, key);
	// 非 Windows 维持原样：electron 在那两个平台当 Node 跑没有 GUI 子系统问题，直接 detached。
	assert.deepEqual(plain(localServiceDetachedInvocation(detachBase, { platform: "darwin", env: { PATH: "y" } })), { command: "cmd.exe", args: detachBase.args, env: { PATH: "y" }, windowsVerbatimArguments: true });
	// 终止：参数永远是数组，Windows 走 taskkill 真 exe（不经 cmd.exe、不拼 shell 字符串）。
	assert.deepEqual(plain(killLocalServiceInvocation(23704, "win32")), { command: "taskkill", args: ["/pid", "23704", "/t", "/f"] });
	assert.deepEqual(plain(killLocalServiceInvocation(23704, "linux")), { command: "kill", args: ["-TERM", "23704"] });
	// 非法 pid 直接拒绝，不发命令
	for (const pid of [0, -1, 1.5, 2 ** 31, Number.NaN]) assert.equal(killLocalServiceInvocation(pid, "win32"), null, String(pid));
});

test("seedBuiltin places the packaged demo plugin once and never overwrites it", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-host-plugins-"));
	try {
		const source = join(root, "resources");
		const plugin = join(source, SERVICE_ID);
		await mkdir(plugin, { recursive: true });
		await writeFile(join(plugin, "pideck-plugin.json"), JSON.stringify(manifest({ id: SERVICE_ID, name: "billion-context", permissions: ["service.local"], services: [SERVICE_ID] })));
		await writeFile(join(plugin, "app.html"), "<!doctype html>");
		await writeFile(join(plugin, "app.js"), "console.log('shipped');");

		const manager = new HostPluginManager(join(root, "userData"));
		await manager.seedBuiltin(source);
		const target = join(root, "userData", "host-plugins", SERVICE_ID);
		assert.equal(await readFile(join(target, "app.js"), "utf8"), "console.log('shipped');");
		// seedBuiltin 只负责落位，扫描仍由 load()/rescan() 触发
		await manager.load();
		assert.equal(manager.catalog().plugins.length, 1);
		// 落位不等于授权：内置插件同样是 requiresConsent。
		assert.equal(manager.catalog().plugins[0].requiresConsent, true);

		// 内置内容升级：目录里还是上次落位的那份（指纹等于落位记录）→ 允许替换，已授权的沿用。
		// 这是第一方内容换版，不该让用户在每次应用更新后重新批准自己的内置示例。
		const granted = manager.catalog().plugins[0];
		await manager.setEnabled(SERVICE_ID, true, granted.fingerprint);
		await writeFile(join(plugin, "app.js"), "console.log('shipped-v2');");
		await manager.seedBuiltin(source);
		assert.equal(await readFile(join(target, "app.js"), "utf8"), "console.log('shipped-v2');");
		// seedBuiltin 只动磁盘，目录内容要重新扫描才反映到 catalog（真实链路由 initialize 接着调 load）
		await manager.load();
		const upgraded = manager.catalog().plugins[0];
		assert.notEqual(upgraded.fingerprint, granted.fingerprint);
		assert.equal(upgraded.enabled, true, "第一方内容换版不该让用户重新授权");

		// 用户改过的副本永不被覆盖
		await writeFile(join(target, "app.js"), "console.log('mine');");
		await manager.seedBuiltin(source);
		assert.equal(await readFile(join(target, "app.js"), "utf8"), "console.log('mine');");

		// 源目录不存在（打包漏配 extraResources）只是少一个示例，不该抛
		await assert.doesNotReject(() => manager.seedBuiltin(join(root, "absent")));
		manager.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("seedBuiltin migrates copies placed before the seed record existed", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-host-plugins-"));
	try {
		const source = join(root, "resources");
		const plugin = join(source, SERVICE_ID);
		const userData = join(root, "userData");
		const target = join(userData, "host-plugins", SERVICE_ID);
		await mkdir(plugin, { recursive: true });
		await writeFile(join(plugin, "pideck-plugin.json"), JSON.stringify(manifest({ id: SERVICE_ID, name: "billion-context", version: "0.2.0" })));
		await writeFile(join(plugin, "app.html"), "<!doctype html>");
		await writeFile(join(plugin, "app.js"), "console.log('new');");
		// 旧版本 PiDeck 落的副本 + 只有 grants 的状态文件（没有 seeded 字段），用户已授权过
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "pideck-plugin.json"), JSON.stringify(manifest({ id: SERVICE_ID, name: "billion-context", version: "0.1.0" })));
		await writeFile(join(target, "app.html"), "<!doctype html>");
		await writeFile(join(target, "app.js"), "console.log('old');");
		const manager = new HostPluginManager(userData);
		await manager.load();
		const legacy = manager.catalog().plugins[0];
		await writeFile(join(userData, "host-plugin-state.json"), JSON.stringify({ version: 1, grants: { [SERVICE_ID]: { fingerprint: legacy.fingerprint, enabled: true } } }));

		await manager.seedBuiltin(source);
		await manager.load();
		// 版本不同 ⇒ 这份副本来自另一个 PiDeck 版本的内置载荷，用新版替换；已授权的顺延
		assert.equal(await readFile(join(target, "app.js"), "utf8"), "console.log('new');");
		assert.equal(manager.catalog().plugins[0].enabled, true);

		// 迁移只发生一次：之后 seeded 有记录，手改过的副本又回到「永不覆盖」
		await writeFile(join(target, "app.js"), "console.log('mine');");
		await manager.seedBuiltin(source);
		assert.equal(await readFile(join(target, "app.js"), "utf8"), "console.log('mine');");
		manager.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("remove 卸载第三方插件：先撤权、再删目录、清授权；内置示例拒绝卸载", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-host-plugins-"));
	try {
		const manager = new HostPluginManager(join(root, "userData"));
		const directory = join(root, "userData", "host-plugins", "third-party");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "pideck-plugin.json"), JSON.stringify(manifest({ id: "third-party", name: "Third Party" })));
		await writeFile(join(directory, "app.html"), "<!doctype html>");
		await manager.load();
		const plugin = manager.catalog().plugins.find((item) => item.manifest.id === "third-party");
		await manager.setEnabled("third-party", true, plugin.fingerprint);
		assert.equal(manager.getEnabled("third-party")?.manifest.id, "third-party");

		assert.deepEqual(plain((await manager.remove("third-party")).plugins), []);
		assert.equal(manager.getEnabled("third-party"), undefined, "卸载必须先撤权");
		assert.equal(
			await stat(directory).then(
				() => true,
				() => false,
			),
			false,
		);
		await assert.rejects(() => manager.remove("third-party"), /plugin-not-found/);

		// 内置示例删了下次启动会被重新落位，删了只会让人以为卸载没生效 → 直接拒绝。
		const source = join(root, "resources");
		await mkdir(join(source, SERVICE_ID), { recursive: true });
		await writeFile(join(source, SERVICE_ID, "pideck-plugin.json"), JSON.stringify(manifest({ id: SERVICE_ID })));
		await writeFile(join(source, SERVICE_ID, "app.html"), "<!doctype html>");
		await manager.seedBuiltin(source);
		await manager.load();
		await assert.rejects(() => manager.remove(SERVICE_ID), /plugin-builtin/);
		manager.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("服务面板入口：侧栏一行 + 浮层，rail 永远显示活动面板", async () => {
	// 回归：openDrawerForce("browser") 只切内容、不钉住面板；rail 若只显示 pinned/canRemove，
	// 就没有归属 tab（用户反馈「直接出来一个页面，但是没有归属 tab」）。
	const rail = await readFile("src/renderer/src/components/workspace/WorkspaceDrawerRail.tsx", "utf8");
	assert.match(rail, /\(action\.pinned \?\? false\) \|\| !action\.canRemove \|\| action\.active/);

	// presentation:"popover" 的面板在侧栏那一行就地展开，不写 hostPluginPanelAtom（否则会再弹一个对话框）。
	const dock = await readFile("src/renderer/src/components/plugins/HostPluginDockButtons.tsx", "utf8");
	assert.match(dock, /presentation === "popover"[\s\S]{0,900}<PopoverTrigger asChild>/);
	assert.match(dock, /onClick=\{row\.presentation === "popover" \? undefined/);
	// HostPluginSurface 内部是 flex-1，浮层里必须给一个定高 flex 列，否则 webview 高度塌成 0。
	assert.match(dock, /flex h-\[280px\] flex-col/);
});

test("the packaged billion-context demo is a loadable package that only talks to window.pideck", async () => {
	const directory = join("resources", "host-plugins", SERVICE_ID);
	const packaged = parseHostPluginManifest(JSON.parse(await readFile(join(directory, "pideck-plugin.json"), "utf8")));
	assert.equal(packaged.id, SERVICE_ID);
	assert.deepEqual(plain(packaged.permissions), ["service.local"]);
	assert.deepEqual(plain(packaged.services), [SERVICE_ID]);
	for (const file of ["app.html", "app.js", "styles.css", "README.md"]) assert.ok((await stat(join(directory, file))).size > 0, `${file} 不该是空文件`);
	const app = await readFile(join(directory, "app.js"), "utf8");
	assert.match(app, /pideck\.services\.(status|start|stop|openUi)/);
	// 面板 CSP 是 connect-src 'none'：不能 fetch、不能内嵌、不能引 CDN，能力只走 window.pideck。
	assert.doesNotMatch(app, /\bfetch\(|XMLHttpRequest|innerHTML|importScripts|https?:\/\/(?!127\.0\.0\.1)/);
	assert.doesNotMatch(await readFile(join(directory, "app.html"), "utf8"), /<script[^>]*src="https?:/);
});

test("服务 Web UI 交给内置浏览器时，插件面板先让位", async () => {
	// 面板 modal 是整窗遮罩：不让位的话，刚打开的浏览器抽屉会被盖住（用户反馈「弹框不关、看不到归属 tab」）。
	const source = await readFile("src/renderer/src/hooks/plugins/useHostPluginNavigation.ts", "utf8");
	assert.match(source, /onOpenBrowser\([\s\S]{0,200}closePanel\(null\)[\s\S]{0,200}openBrowser\.current\(url\)/, "先收起插件面板，再打开内置浏览器");
});

test("面板只在动作返回状态时重绘（openUi 没有返回值）", async () => {
	// 回归：openUi 契约是 Promise<void>，主进程回 null；直接 paint(await action()) 会抛
	// “Cannot read properties of null (reading 'available')”。
	const app = await readFile(join("resources", "host-plugins", SERVICE_ID, "app.js"), "utf8");
	assert.doesNotMatch(app, /paint\(\s*await\s+action\(\)\s*\)/);
	assert.match(app, /const\s+next\s*=\s*await\s+action\(\)[\s\S]{0,200}if\s*\(\s*next\s*\)\s*\{[\s\S]{0,80}paint\(next\)/);
	// 动作留下的提示必须在收尾的 refresh() 之后补回：refresh() 自己会清空提示区。
	assert.match(app, /await\s+refresh\(\)[\s\S]{0,80}say\(reasonText\(notice\)\)/);
});

test("服务已在运行时三个按钮不能停在忙碌时的置灰状态", async () => {
	// 回归（用户反馈「直接检查到运行中，但是按钮是灰的」）：服务是别人（用户手敲 bili start、
	// 或 pi 自己的扩展）拉起来的，PiDeck 只管读状态——但面板曾把按钮永久置灰。
	// 根因：paint() 是在忙碌期间被调用的，setBusy(false) 之后没人重算 disabled。
	// 这里跑真脚本 + 假 DOM 断言最终可点状态（app.js 是浏览器脚本、无 import，vm 直接求值）。
	const elements = new Map();
	const fakeNode = () => ({
		className: "",
		textContent: "",
		title: "",
		hidden: false,
		disabled: false,
		dataset: {},
		listeners: {},
		addEventListener(type, handler) {
			this.listeners[type] = handler;
		},
		setAttribute(name, value) {
			this[name] = value;
		},
		replaceChildren() {},
		append() {},
	});
	const element = (id) => {
		if (!elements.has(id)) {
			elements.set(id, {
				id,
				...fakeNode(),
			});
		}
		return elements.get(id);
	};
	const running = { id: SERVICE_ID, available: true, running: true, pid: 23704, uiUrl: "http://127.0.0.1:28800/__bili/" };
	const sandbox = {
		document: { body: { dataset: {} }, documentElement: { lang: "" }, getElementById: element, createElement: () => fakeNode(), querySelectorAll: () => [] },
		window: { setTimeout, clearTimeout },
		pideck: {
			context: { get: async () => ({ locale: "zh-CN" }) },
			services: { status: async () => running, start: async () => running, stop: async () => ({ ...running, running: false }), openUi: async () => undefined },
		},
	};
	vm.runInNewContext(await readFile(join("resources", "host-plugins", SERVICE_ID, "app.js"), "utf8"), sandbox);
	// main() 是 fire-and-forget 的 async：冲刷微任务直到首次状态渲染完成。
	for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));

	assert.equal(element("status").textContent, "运行中");
	assert.equal(element("start").disabled, true, "已在运行：启动按钮应禁用");
	assert.equal(element("stop").disabled, false, "已在运行：停止按钮必须可点");
	assert.equal(element("open").disabled, false, "已在运行且有端口：打开面板必须可点");
	assert.equal(element("refresh").disabled, false, "查询结束后刷新按钮必须解锁");
	assert.equal(sandbox.document.body.dataset.busy, "", "查询结束后忙碌标记必须清掉");
});

test("面板在等状态查询期间给出忙碌反馈（刷新转圈）", async () => {
	// 回归（用户反馈「点击刷新服务状态也没动画」）：一次状态查询要跑 bili doctor，不给反馈就像没点动。
	const app = await readFile(join("resources", "host-plugins", SERVICE_ID, "app.js"), "utf8");
	const css = await readFile(join("resources", "host-plugins", SERVICE_ID, "styles.css"), "utf8");
	const html = await readFile(join("resources", "host-plugins", SERVICE_ID, "app.html"), "utf8");
	assert.match(app, /document\.body\.dataset\.busy = next \? "1" : ""/);
	assert.match(app, /el\("refresh"\)\.disabled = next/);
	// 旋转的是图标本身：直接转按钮会把边框一起转。
	assert.match(html, /<button id="refresh"[^>]*>\s*<span class="glyph">/);
	assert.match(css, /body\[data-busy="1"\] #refresh \.glyph\s*\{[\s\S]{0,120}animation: pideck-spin/);
	// 原因码不只在「不可用」时显示：stop-restarted 是带状态的成功响应。
	assert.match(app, /say\(status\.reason \? reasonText\(status\.reason\) : ""\)/);
});
