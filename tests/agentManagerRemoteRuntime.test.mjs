import { agentManagerSource } from "./helpers/agentManagerSources.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * `AgentManager` 的远端项目路由（Phase 4 P4.2）。
 *
 * 这组用例锁的是**产品路由的分叉边界**（pipeline 的远端实现各自另有套件）：
 * 1. 远端项目 + 注入的远端运行时端口 ⇒ 走远端分支：plan 的 cwd 是 `locator.remotePath`、
 *    启动器来自端口、远端 pi 报回来的会话文件**不被本机规则改写**；
 * 2. 本地专属准备（项目 trust、会话文件修复、会话路径归一化）**一次都不碰**——它们被 stub 成
 *    「一调用就抛」，所以「没调用」这件事是硬的，不是靠断言调用次数的软证据；
 * 3. 缺端口 / 端口没有登记能力 ⇒ 稳定码 fail-closed，绝不把远端 cwd 当本机路径跑，
 *    也不写一条伪 catalog 记录；
 * 4. deckSessionId 的远端会话：拿到 pi 上报的会话文件后由端口登记 catalog 身份（ssh locator），
 *    登记失败落会话错误卡 + 稳定码；
 * 5. 远端 runtime 的本机专属操作（终端 cwd、checkpoint 的 git）在守卫处拒绝，本地行为不变；
 * 6. 远端会话如实带 `remoteTrustUnhandled` 标记（P4.2 收口第 1 项：这条会话的 trust 由 PiDeck 决策表管理），
 *    本机/WSL tab 契约上没有这个状态，且**未决策时**远端启动参数不含任何 trust flag（零行为变更；
 *    决策真的能经端口落到 args 也在本套件里验证，见「注入 trust 解析器后…」）。
 */

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const { createRemoteRuntimePort, REMOTE_RUNTIME_CODES } = loadTsCommonJs("src/main/pi/remoteRuntimePort.ts");

const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_HOST_ID = "9c1d5f7a-2b3e-4c5d-8e9f-0a1b2c3d4e5f";
const REMOTE_CWD = "/srv/remote-app";
const REMOTE_SESSION_FILE = "/home/dev/.pi/agent/sessions/-srv-remote-app/2026-01-02T03-04-05_deadbeef.jsonl";
const NODE_PATH = "/usr/local/bin/node";
const PI_PATH = "/usr/local/bin/pi";
const RUNNER_PATH = "/home/dev/.pideck/remote-host/bundles/deadbeef/runner.mjs";

const remoteProject = (id, hostId) => ({ id, name: `app-${id}`, locator: { kind: "ssh", hostId, remotePath: REMOTE_CWD } });
const localProject = { id: "project-local", name: "Local App", path: "C:/projects/local-app" };

/**
 * 一条假的远端 pi：三根流由用例摆布，`get_state` 按真实 RPC 帧形状应答。
 *
 * 应答必须带匹配的 request id（`PiRpcClient` 按 id 认领响应），否则握手会等到超时。
 */
function createFakeRemoteHandle() {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const state = { stops: [], requests: [] };
	let buffer = "";
	stdin.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line.trim()) continue;
			const request = JSON.parse(line);
			state.requests.push(request);
			if (request.type === "get_state") {
				stdout.write(
					`${JSON.stringify({
						id: request.id,
						type: "response",
						command: "get_state",
						success: true,
						data: { sessionId: "pi-session-remote", sessionFile: REMOTE_SESSION_FILE, sessionName: "远端会话" },
					})}\n`,
				);
			}
		}
	});
	return {
		state,
		handle: {
			stdin,
			stdout,
			stderr,
			pid: 4242,
			stop(reason) {
				state.stops.push(reason);
				return Promise.resolve();
			},
			onExit() {
				return () => undefined;
			},
			onSpawnError() {
				return () => undefined;
			},
		},
	};
}

/** 假连接服务：只实现端口用到的那两个方法（事实探测 + 配对启动器）。 */
function createFakeService(record) {
	return {
		async remotePiRuntimeFacts(hostId) {
			record.facts.push(hostId);
			return { nodePath: NODE_PATH, piPath: PI_PATH, version: "1.0.4", runnerPath: RUNNER_PATH };
		},
		createPiRuntimeLauncher() {
			return {
				async launch(plan) {
					const fake = createFakeRemoteHandle();
					record.launches.push(plan);
					record.handles.push(fake);
					return fake.handle;
				},
			};
		},
	};
}

/**
 * 构造被测 AgentManager。位置参数按构造器顺序给：远端端口在**末尾**（本批新增的那个可选参数），
 * 本地专属依赖（configManager 的 trust 面、repairSessionFile）一律 stub 成「一调用就抛」——
 * 远端分支一旦碰它们，用例当场红而不是静默走错。
 */
function createHarness({ projects, record, remoteRuntime }) {
	const manager = new AgentManager(
		(id) => projects.get(id),
		() => null,
		{ get: () => ({}) },
		{
			ensureTrustedDirectory: async (cwd) => {
				record.forbidden.push(`ensureTrustedDirectory:${cwd}`);
				throw new Error("LOCAL_TRUST_MUST_NOT_RUN_FOR_REMOTE");
			},
			getProjectTrustDecision: async (cwd) => {
				record.forbidden.push(`getProjectTrustDecision:${cwd}`);
				throw new Error("LOCAL_TRUST_MUST_NOT_RUN_FOR_REMOTE");
			},
		},
		undefined,
		undefined,
		undefined,
		undefined,
		() => record.beforeSpawn++,
		undefined,
		async (sessionPath) => {
			record.forbidden.push(`repairSessionFile:${sessionPath}`);
			throw new Error("LOCAL_SESSION_REPAIR_MUST_NOT_RUN_FOR_REMOTE");
		},
		undefined,
		undefined,
		undefined,
		undefined,
		remoteRuntime,
	);
	// 本机路径归一化必须对远端**不可见**：直接让这个方法炸，远端分支一旦调用它就会炸在用例里。
	const prototype = Object.getPrototypeOf(manager);
	const original = prototype.normalizeSessionPathFromPi;
	prototype.normalizeSessionPathFromPi = function patched(...args) {
		record.forbidden.push("normalizeSessionPathFromPi");
		return original.apply(this, args);
	};
	return {
		manager,
		restore: () => {
			prototype.normalizeSessionPathFromPi = original;
		},
	};
}

function createRecord() {
	return { facts: [], launches: [], handles: [], prepares: [], forbidden: [], registrations: [], beforeSpawn: 0, launcherRequests: 0 };
}

function createPort(record, service, options = {}) {
	return createRemoteRuntimePort({
		resolveService: () => service,
		settings: () => ({}),
		// P4.4b：trust 决策由装配注入。本套件**默认不注入**（= 未决策），专门锁「未决策 ⇒ 一个 flag 都不加」；
		// 传了解析器的用例用来证明这条断言不是空的（决策真的能经端口落到 plan.args 上）。
		...(options.resolveTrust === undefined ? {} : { resolveTrust: options.resolveTrust }),
	});
}

/**
 * 端口替身：启动能力用真端口，登记方法换成「记下调用 + 返回一条 ssh locator record」。
 * 产品路由关心的就是这两件事（登记被调用、拿到的路径是 pi 上报的那条），而 ssh locator 的
 * 推导与幂等由 `remoteSessionCatalogIdentity.test.mjs` 用真 catalog + 真 scanner 锁住。
 */
function createPortWithRegistration(record, service, options = {}) {
	const port = createPort(record, service);
	return {
		prepare: (input) => port.prepare(input),
		createLauncher: () => port.createLauncher(),
		async registerRemoteSession(input) {
			record.registrations.push(input);
			if (options.registrationFailure) throw new Error(options.registrationFailure);
			return {
				record: { id: "catalog-remote-session", projectId: input.projectId, title: "远端会话", locator: { kind: "ssh", hostId: input.hostId, remoteSessionId: "-srv-remote-app/session.jsonl", remotePath: input.remotePath } },
				created: true,
			};
		},
	};
}

/** 旧装配/替身的形状：启动能力在、登记能力不在（新增这个方法之前的端口就是这样）。 */
function createPortWithoutRegistration(record, service) {
	const port = createPort(record, service);
	return { prepare: (input) => port.prepare(input), createLauncher: () => port.createLauncher() };
}

test("远端项目 + 注入端口：走远端分支（plan 用 locator.remotePath、launcher 来自端口），本机 trust/repair/normalize 一次都不碰", async () => {
	const record = createRecord();
	const service = createFakeService(record);
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, service) });
	const { manager, restore } = harness;
	try {
		// WSL 打开：远端会话身份仍必须是 native（远端路径不是 WSL 路径）。
		manager.configureWsl({ distro: "Ubuntu", user: "dev", linuxHome: "/home/dev", windowsHome: "\\\\wsl.localhost\\Ubuntu\\home\\dev" });
		const tab = await manager.create({ projectId: "remote", title: "远端会话", environment: "wsl" });

		assert.equal(record.facts.length, 1, "远端事实必须来自端口（一次 prepare = 一次事实探测）");
		assert.equal(record.facts[0], HOST_ID);
		assert.equal(record.launches.length, 1, "启动必须经端口给出的 launcher");
		const plan = record.launches[0];
		assert.equal(plan.kind, "remote-ssh");
		assert.equal(plan.hostId, HOST_ID);
		assert.equal(plan.cwd, REMOTE_CWD, "plan 的 cwd 必须是远端项目根（locator.remotePath）");
		assert.equal(plan.nodePath, NODE_PATH);
		assert.equal(plan.runnerPath, RUNNER_PATH);

		assert.equal(tab.cwd, REMOTE_CWD, "tab.cwd 是远端路径");
		assert.equal(tab.status, "idle");
		assert.equal(tab.sessionEnvironment, "native", "远端会话身份不套 WSL");
		// pi 报回来的会话文件在远端：原样采用，不得被本机规则改写（本机转换会把 /home/... 拼成盘符路径）。
		assert.equal(tab.sessionPath, REMOTE_SESSION_FILE);
		assert.equal(tab.sessionId, "pi-session-remote");

		assert.deepEqual(record.forbidden, [], "远端分支不得调用 trust / repairSessionFile / 本机路径归一化");
		// 远端历史不在本机：不自动加载（本机 reader 不参与），消息列表保持为空。
		// 注意：这些数组来自被加载模块自己的 realm，不能与测试 realm 的 [] 做 deepStrictEqual。
		assert.equal(manager.messages.get(tab.id).length, 0);
		// 本机 pi 的模型目录刷新与本次 cwd 无关，仍按本地语义执行（远端模型目录属 P4.3）。
		assert.equal(record.beforeSpawn, 1);
		return { manager, tab, record, service, restore };
	} catch (error) {
		restore();
		throw error;
	}
});

test("remote user/assistant events retain pi timestamps for live-ID mutation across clock skew", async () => {
	const record = createRecord();
	const { manager, restore } = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, createFakeService(record)) });
	try {
		const tab = await manager.create({ projectId: "remote", title: "remote timestamps" });
		const localTimestamp = Date.now();
		const remoteTimestamp = localTimestamp - 60_000;
		manager.messages.set(tab.id, [{ id: "live-user", role: "user", text: "prompt", timestamp: localTimestamp, meta: { requestId: "live-user" } }]);
		const emit = (event) => record.handles[0].handle.stdout.write(JSON.stringify(event) + "\n");
		emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "prompt" }] } });
		assert.equal(manager.getMessages(tab.id)[0].meta.persistedTimestamp, undefined, "projector fallback time is not remote evidence");
		emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "prompt" }], timestamp: remoteTimestamp } });
		let messages = manager.getMessages(tab.id);
		assert.equal(messages[0].meta.persistedTimestamp, remoteTimestamp);
		assert.equal(messages[0].timestamp, localTimestamp, "display timestamps do not change");
		emit({ type: "message_start", message: { role: "assistant", content: [], timestamp: remoteTimestamp + 10 } });
		emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: remoteTimestamp + 10, stopReason: "stop" } });
		messages = manager.getMessages(tab.id);
		const answer = messages.find((message) => message.role === "assistant");
		assert.equal(answer.meta.persistedTimestamp, remoteTimestamp + 10);
		assert.equal(answer.text, "answer");
		await manager.stop(tab.id);
		emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "prompt" }], timestamp: remoteTimestamp } });
		assert.equal(manager.messages.has(tab.id), false, "late events must not rebuild stopped caches");
	} finally {
		restore();
	}
});

test("远端会话：能停（stop 打到远端句柄）、能重启（第二次 plan 带 --session 重开同一远端会话）", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, createFakeService(record)) });
	const { manager, restore } = harness;
	try {
		const tab = await manager.create({ projectId: "remote", title: "远端会话" });
		const handle = record.handles[0];

		const restarted = await manager.restart(tab.id);
		assert.equal(record.launches.length, 2, "重启必须重新准备并拉起一次远端运行");
		const secondPlan = record.launches[1];
		assert.equal(secondPlan.cwd, REMOTE_CWD);
		assert.equal(secondPlan.nonce !== record.launches[0].nonce, true, "每次运行有自己的 nonce");
		const sessionIndex = secondPlan.args.indexOf("--session");
		assert.notEqual(sessionIndex, -1, "重启同一会话必须带 --session");
		assert.equal(secondPlan.args[sessionIndex + 1], REMOTE_SESSION_FILE, "--session 用的是 pi 报回来的远端会话文件");
		assert.equal(restarted.cwd, REMOTE_CWD);
		assert.equal(restarted.sessionPath, REMOTE_SESSION_FILE);

		await manager.stop(restarted.id);
		assert.deepEqual(handle.state.stops, ["shutdown"], "停止必须真的打到远端句柄上");
		assert.deepEqual(record.forbidden, []);
	} finally {
		restore();
	}
});

test("远端会话的自动重连（reattachProcess）：不再按本机专属拒绝，远端会话文件原样采用", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, createFakeService(record)) });
	const { manager, restore } = harness;
	try {
		const tab = await manager.create({ projectId: "remote", title: "远端会话" });
		// 进程退出型压缩 / abort 期间进程退出都会走这条路：此前第一行就是 isLocalProject 守卫直接拒绝（UNSUPPORTED_PROJECT_LOCATION）。
		await manager.reattachProcess(tab.id, tab.sessionPath);
		assert.equal(record.launches.length, 2, "重连必须重新拉起一次远端运行");
		const plan = record.launches[1];
		assert.equal(plan.cwd, REMOTE_CWD);
		const sessionIndex = plan.args.indexOf("--session");
		assert.notEqual(sessionIndex, -1, "重连同一会话必须带 --session");
		assert.equal(plan.args[sessionIndex + 1], REMOTE_SESSION_FILE, "--session 用的是 pi 报回来的远端会话文件");
		// 关键分叉：远端路径**不得**被 normalizeSessionPathFromPi 改成本机风格（改了下次 spawn 就找不到文件）。
		assert.equal(tab.sessionPath, REMOTE_SESSION_FILE);
		assert.equal(tab.status, "idle");
		assert.deepEqual(record.forbidden, [], "重连不得触发任何本机准备（不得静默当本地跑）");
	} finally {
		restore();
	}
});

test("匿名远端会话（noSession）：plan 追加 --no-session，且不带 --session", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, createFakeService(record)) });
	const { manager, restore } = harness;
	try {
		await manager.create({ projectId: "remote", title: "匿名", noSession: true });
		const plan = record.launches[0];
		assert.equal(plan.args.includes("--no-session"), true, "匿名会话不能让远端 pi 落一个 PiDeck 不认的会话文件");
		assert.equal(plan.args.includes("--session"), false);
	} finally {
		restore();
	}
});

test("远端项目 + 未注入端口：仍旧 UNSUPPORTED_PROJECT_LOCATION（fail-closed，不静默当本地跑）", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record });
	const { manager, restore } = harness;
	try {
		await assert.rejects(() => manager.create({ projectId: "remote", title: "远端会话" }), /UNSUPPORTED_PROJECT_LOCATION/);
		// catalog 绑定的会话同样先撞「没有端口」这一关（而不是先去过 catalog 身份）。
		await assert.rejects(() => manager.create({ projectId: "remote", title: "远端会话", deckSessionId: "11111111-2222-4333-8444-555555555555" }), /UNSUPPORTED_PROJECT_LOCATION/);
		assert.deepEqual(record.forbidden, [], "拒绝必须发生在任何本机准备之前");
	} finally {
		restore();
	}
});

test("服务拿不到（门禁关闭/尚未装配/建服务失败）：REMOTE_RUNTIME_UNAVAILABLE 落到会话错误卡，不静默回退本机", async () => {
	for (const resolveService of [() => undefined, () => Promise.reject(new Error("SSH_CLIENT_UNAVAILABLE")), () => Promise.reject(new Error("something went sideways"))]) {
		const record = createRecord();
		const port = createRemoteRuntimePort({ resolveService, settings: () => ({}) });
		const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: port });
		const { manager, restore } = harness;
		try {
			const tab = await manager.create({ projectId: "remote", title: "远端会话" });
			// 与本地「pi 起不来」同一条路径：tab 是终态 error + 会话内错误卡（带稳定码），不是静默成功。
			assert.equal(tab.status, "error");
			// 占位 runtime（错误卡宿主）也是「远端会话」：trust 现状标记同样要在。
			assert.equal(tab.remoteTrustUnhandled, true);
			assert.equal(
				manager.list().some((candidate) => candidate.id === tab.id),
				true,
				"错误卡必须落在一条能显示出来的 tab 上",
			);
			const card = manager.messages.get(tab.id).at(-1);
			assert.equal(card.role, "error");
			const code = String(card.meta?.debugDetails ?? "");
			// 服务自己带的稳定码（如 ssh 客户端缺失）原样转述，不带稳定码的折叠成 REMOTE_RUNTIME_UNAVAILABLE。
			assert.match(code, /SSH_CLIENT_UNAVAILABLE|REMOTE_RUNTIME_UNAVAILABLE/);
			assert.equal(record.launches.length, 0, "拿不到服务时绝不能有任何远端或本地启动动作");
			assert.deepEqual(record.forbidden, []);
		} finally {
			restore();
		}
	}
});

test("准备失败的占位 runtime：不会被当成可启动 runtime 去起本机 pi", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, undefined) });
	const { manager, restore } = harness;
	try {
		const tab = await manager.create({ projectId: "remote", title: "远端会话" });
		assert.equal(tab.status, "error");
		// 直接推它进入 spawn 路径（模拟任何未来“重连/重试”误用）：必须稳定码拒绝，而不是本地起 pi。
		await assert.rejects(() => manager.handshakePiProcess(tab.id, { projectPath: REMOTE_CWD, onExit: () => undefined }), new RegExp(REMOTE_RUNTIME_CODES.unavailable));
		assert.equal(record.launches.length, 0);
	} finally {
		restore();
	}
});

test("端口没有登记能力（旧装配/替身）：catalog 绑定的远端会话仍旧稳定码 fail-closed，且不半启动运行", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPortWithoutRegistration(record, createFakeService(record)) });
	const { manager, restore } = harness;
	try {
		// deckSessionId = 这条会话已经属于一条 catalog 记录（协调器随后会把 tab 身份写进 catalog）。
		await assert.rejects(() => manager.create({ projectId: "remote", title: "远端会话", deckSessionId: "11111111-2222-4333-8444-555555555555" }), new RegExp(REMOTE_RUNTIME_CODES.catalogIdentityUnsupported));
		assert.deepEqual(record.facts, [], "拒绝必须发生在探测/拉起之前（不留半启动的远端进程）");
		assert.equal(record.launches.length, 0);
		assert.deepEqual(record.registrations, [], "没有登记能力时一条记录都不能写");
	} finally {
		restore();
	}
});

test("远端 + deckSessionId + 端口可登记：不再抛 catalogIdentityUnsupported，登记的就是 pi 上报的会话文件", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPortWithRegistration(record, createFakeService(record)) });
	const { manager, restore } = harness;
	try {
		const tab = await manager.create({ projectId: "remote", title: "远端会话", deckSessionId: "11111111-2222-4333-8444-555555555555" });

		assert.equal(tab.status, "idle", "有登记能力时这条会话必须能起来（不再是 fail-closed 错误卡）");
		assert.equal(record.registrations.length, 1, "必须在拿到 pi 上报的会话文件之后登记一次");
		assert.equal(record.registrations[0].hostId, HOST_ID);
		assert.equal(record.registrations[0].projectId, "remote");
		assert.equal(record.registrations[0].remotePath, REMOTE_SESSION_FILE);
		// 标题不由 AgentManager 编：新会话的 input.title 是本地化占位名（"新会话"），写进远端记录会造出假标题；
		// 缺省让端口取文件名 stem（与 scanner 的登记路径同一取值）。
		assert.equal(record.registrations[0].title, undefined);
		// tab 的会话文件仍是远端路径（ssh locator 的 remotePath 语义），不被本机规则改写。
		assert.equal(tab.sessionPath, REMOTE_SESSION_FILE);
		assert.deepEqual(record.forbidden, []);

		// 没有 deckSessionId 的远端会话（不入 catalog）不登记：身份登记只属于「已有一条 catalog 记录」的会话。
		await manager.create({ projectId: "remote", title: "另一个远端会话" });
		assert.equal(record.registrations.length, 1);
	} finally {
		restore();
	}
});

test("登记失败（身份折不出来）：落到会话错误卡 + 稳定码，不静默当作成功", async () => {
	const record = createRecord();
	const harness = createHarness({
		projects: new Map([["remote", remoteProject("remote", HOST_ID)]]),
		record,
		remoteRuntime: createPortWithRegistration(record, createFakeService(record), { registrationFailure: REMOTE_RUNTIME_CODES.locatorUnresolved }),
	});
	const { manager, restore } = harness;
	try {
		const tab = await manager.create({ projectId: "remote", title: "远端会话", deckSessionId: "11111111-2222-4333-8444-555555555555" });

		assert.equal(record.registrations.length, 1, "登记必须真的被尝试过");
		// 与本地「pi 起不来」同一条归口：终态 error + 会话内错误卡（带稳定码），不是静默成功。
		assert.equal(tab.status, "error");
		const card = manager.messages.get(tab.id).at(-1);
		assert.equal(card.role, "error");
		assert.match(String(card.meta?.debugDetails ?? ""), new RegExp(REMOTE_RUNTIME_CODES.locatorUnresolved));
		assert.deepEqual(record.forbidden, []);
	} finally {
		restore();
	}
});

test("会话身份 key 带 hostId：同路径不同主机不互相顶掉，同主机同会话复用既有 runtime", async () => {
	const record = createRecord();
	const projects = new Map([
		["remote-a", remoteProject("remote-a", HOST_ID)],
		["remote-b", remoteProject("remote-b", OTHER_HOST_ID)],
	]);
	const harness = createHarness({ projects, record, remoteRuntime: createPort(record, createFakeService(record)) });
	const { manager, restore } = harness;
	try {
		const first = await manager.create({ projectId: "remote-a", title: "A", sessionPath: REMOTE_SESSION_FILE });
		const reused = await manager.create({ projectId: "remote-a", title: "A", sessionPath: REMOTE_SESSION_FILE });
		assert.equal(reused.id, first.id, "同一主机 + 同一远端会话文件必须复用既有 runtime");
		assert.equal(record.launches.length, 1);

		const other = await manager.create({ projectId: "remote-b", title: "B", sessionPath: REMOTE_SESSION_FILE });
		assert.notEqual(other.id, first.id, "同一路径在另一台主机上是另一个会话，不得复用 A 的 runtime");
		assert.equal(record.launches.length, 2);
		assert.deepEqual(record.forbidden, []);
	} finally {
		restore();
	}
});

test("远端会话 tab 带 remoteTrustUnhandled 标记；未决策时远端启动参数里没有任何 trust flag", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, createFakeService(record)) });
	const { manager, restore } = harness;
	try {
		const tab = await manager.create({ projectId: "remote", title: "远端会话" });
		// 语义：这条会话是远端会话（远端项目 .pi 资源的 trust 由 PiDeck 的决策表管理；提示条据此渲染）。
		assert.equal(tab.remoteTrustUnhandled, true);
		// 标记必须落在 agents:state 下发的 tab 上（渲染层只从那里读，见 sessionRemoteTrustNotice.test.mjs）。
		assert.equal(manager.list().find((candidate) => candidate.id === tab.id).remoteTrustUnhandled, true);
		// 未注入 trust 解析器 = 未决策：一个 flag 都不加（与历史行为逐字一致，安全边界不变）。
		const args = record.launches[0].args;
		assert.equal(args.includes("--approve"), false);
		assert.equal(args.includes("--no-approve"), false);
	} finally {
		restore();
	}
});

test("注入 trust 解析器后：决策能落到 plan.args（这条断言不是空的），未决策仍不加", async () => {
	/** 每次用一套全新 harness：一条会话的 tab 会记住 pi 报回来的会话文件，多次 create 会命中同一 runtime 而不再次 spawn。 */
	const launchArgsFor = async (override) => {
		const record = createRecord();
		const trustPort = { trustOverride: async () => override };
		const harness = createHarness({
			projects: new Map([["remote", remoteProject("remote", HOST_ID)]]),
			record,
			remoteRuntime: createPort(record, createFakeService(record), { resolveTrust: () => trustPort }),
		});
		try {
			await harness.manager.create({ projectId: "remote", title: "远端会话" });
			assert.equal(record.launches.length, 1, "每个用例恰好启动一次远端会话");
			return record.launches[0].args;
		} finally {
			harness.restore();
		}
	};

	const undecided = await launchArgsFor(undefined);
	assert.equal(undecided.includes("--approve"), false);
	assert.equal(undecided.includes("--no-approve"), false);

	const approved = await launchArgsFor("approve");
	assert.ok(approved.includes("--approve"), "决策经端口落到 plan.args（trust 语义的真实入口）");
	assert.equal(approved.includes("--no-approve"), false);

	const denied = await launchArgsFor("no-approve");
	assert.ok(denied.includes("--no-approve"));
	assert.equal(denied.includes("--approve"), false);
});

/**
 * 源码级守卫（本机会话的行为级断言需要 electron 桩，不引入那套装置）：
 * - 标记**只**写在 `createRemoteUnlocked` 的 tab 字面量里；
 * - 本机 `createUnlocked` 的 tab 字面量不带这个字段（本地/WSL 契约向后兼容）；
 * - 远端分支不自己拼 trust（决策由运行时端口在 prepare 时解析，构造点只认已经解析好的决策），
 *   参数构造器只在**显式传了决策**时追加 flag（缺省 = 不加，见 tests/remoteTrustFlagContract.test.mjs）。
 */
test("只有远端分支写 remoteTrustUnhandled：本机 tab 不带、远端分支不拼 trust flag", () => {
	const source = agentManagerSource;
	/** 取锚点之后、下一次 `const t1 = Date.now();` 之前的那一个 `const tab: AgentTab = {…};` 字面量。 */
	const tabLiteral = (marker) => {
		const slice = source.slice(source.indexOf(marker));
		return /const tab: AgentTab = \{([\s\S]*?)\n[\t ]*\};\n[\s\S]{0,80}?const t1 = Date\.now\(\);/.exec(slice)?.[1] ?? "";
	};
	const remoteTab = tabLiteral("private async createRemoteUnlocked(");
	const localTab = tabLiteral("private async createUnlocked(input: CreateAgentInput)");
	assert.match(remoteTab, /remoteTrustUnhandled: true/);
	assert.doesNotMatch(localTab, /remoteTrustUnhandled/);

	// 注释里说明「远端 trust 不在 AgentManager 里解析」是允许的；代码里出现本机那套才是违规。
	const remoteBody = source.slice(source.indexOf("private async createRemoteUnlocked("), source.indexOf("private async createUnlocked(input: CreateAgentInput)"));
	assert.doesNotMatch(remoteBody.replace(/\/\/[^\n]*/g, ""), /trustOverride|ensureProjectTrust/);
	// 参数构造器只在显式传了决策时才加 flag：缺省分支不产生任何默认值（默认 approve 是明令禁止的）。
	const remoteArgs = readFileSync("src/main/pi/piRpcArgs.ts", "utf8");
	assert.match(remoteArgs, /if \(input\.trust !== undefined\) args\.push\(input\.trust === "approve" \? "--approve" : "--no-approve"\);/);
	// plan 构造点只能透传决策，不认 flag 字面量（注释里讨论这两个 flag 是允许的，先剥注释再断言）。
	const planCode = readFileSync("src/main/pi/piRemoteRuntimePlan.ts", "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[\t ]*\/\/[^\n]*/gm, "");
	assert.doesNotMatch(planCode, /--no-approve|--approve/);
});

test("远端 runtime 的本机专属操作在守卫处拒绝；本机 runtime 行为不变", async () => {
	const record = createRecord();
	const projects = new Map([
		["remote", remoteProject("remote", HOST_ID)],
		["local", localProject],
	]);
	const harness = createHarness({ projects, record });
	const { manager, restore } = harness;
	try {
		const tab = (id, projectId, cwd) => ({
			id,
			projectId,
			cwd,
			title: id,
			status: "idle",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		});
		manager.agents.set("agent-remote", { tab: tab("agent-remote", "remote", REMOTE_CWD), process: { client: { request: async () => ({ success: true, data: {} }) } } });
		manager.agents.set("agent-local", { tab: tab("agent-local", "local", "C:/projects/local-app"), process: { client: { request: async () => ({ success: true, data: {} }) } } });

		// 终端（node-pty cwd）与 checkpoint（本机 git ref）都是本机实现：远端必须当场拒绝。
		assert.throws(() => manager.getCwd("agent-remote"), new RegExp(REMOTE_RUNTIME_CODES.localOperationUnsupported));
		await assert.rejects(() => manager.listCheckpoints("agent-remote"), new RegExp(REMOTE_RUNTIME_CODES.localOperationUnsupported));
		await assert.rejects(() => manager.reload("agent-remote"), new RegExp(REMOTE_RUNTIME_CODES.localOperationUnsupported));
		// 远端历史读取不参与本机文件：loadMessages 直接返回内存消息。
		assert.equal((await manager.loadMessages("agent-remote")).length, 0);

		// 本机 runtime 一字不变：cwd 照常返回（本地项目仍以 project.path 为工作目录）。
		assert.equal(manager.getCwd("agent-local"), "C:/projects/local-app");
	} finally {
		restore();
	}
});
