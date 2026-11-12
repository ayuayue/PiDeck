import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端会话的**恢复链路**（Phase 4 P4.2 收口第 1、3 项）。
 *
 * 这组用例走的是真正的 join 流程，而不是替身之间的对接：
 * 真 `SessionCatalog`（真身份写入 + 真去重）、真 `AgentManager`（真远端路由）、真
 * `createRemoteRuntimePort`（真身份折算）与真 `SessionRuntimeCoordinator`（真激活/绑定），
 * 只有「SSH 那台机器」是替身（假端口：事实/启动器/会话根探测）。锁三件事：
 *
 * 1. **能恢复**：ssh locator 的 catalog 记录 activate 之后走到远端 runtime（plan 的 cwd /
 *    `--session` 来自记录，launcher 来自端口），且本机专属准备（trust / 会话文件修复 / 本机路径
 *    归一化）一次都不碰；
 * 2. **不静默回退**：端口不可用 ⇒ 稳定码 + 零 launch（绝不当本机会话跑）；
 * 3. **单一记录**：新远端会话（渲染层先建的 draft）走完一次激活后，catalog 里同一远端会话**恰好一条**
 *    记录 —— 且 Surviving 的是 draft 那条 id（渲染层手上的 sessionId），远端路径**没有**落进本机
 *    `filePath`。
 */

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const { createRemoteRuntimePort, REMOTE_RUNTIME_CODES } = loadTsCommonJs("src/main/pi/remoteRuntimePort.ts");
const { CompositeAgentGateway } = loadTsCommonJs("src/main/agents/CompositeAgentGateway.ts");
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
	stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
});
const { SessionRuntimeCoordinator } = createTsSandbox({ stubs: { "../../shared/types": {} } })("src/main/sessions/SessionRuntimeCoordinator.ts");

const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PROJECT_ID = "project-remote";
const REMOTE_CWD = "/srv/remote-app";
const HOME = "/home/dev";
const DEFAULT_ROOT = HOME + "/.pi/agent/sessions";
const REMOTE_SESSION_ID = "-srv-remote-app/2026-01-02T03-04-05_deadbeef.jsonl";
const REMOTE_SESSION_FILE = DEFAULT_ROOT + "/" + REMOTE_SESSION_ID;
const NODE_PATH = "/usr/local/bin/node";
const PI_PATH = "/usr/local/bin/pi";
const RUNNER_PATH = "/home/dev/.pideck/remote-host/bundles/deadbeef/runner.mjs";

/** 跨 VM realm 的比较前先归一化（deepStrictEqual 会比较原型）。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

async function makeCatalog(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-runtime-join-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalog = new SessionCatalog(join(directory, "session-catalog.json"));
	await catalog.load();
	return catalog;
}

const remoteProject = { id: PROJECT_ID, name: "remote-app", locator: { kind: "ssh", hostId: HOST_ID, remotePath: REMOTE_CWD } };

/**
 * 假远端 pi：`get_state` / `get_session_stats` 按真实 RPC 帧形状应答（必须回显 request id，否则握手
 * 会等到超时）。`get_session_stats` 也被答：激活收尾的 `publishRuntimeState` 会要求它（远端不读本机
 * 会话文件，但这两个 RPC 仍要走同一通道）。
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
			if (request.type === "get_session_stats") {
				stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: "get_session_stats", success: true, data: { tokens: {} } })}\n`);
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

/**
 * 假连接服务：事实/启动器/会话根探测三件事。
 *
 * `withProjectSession` 一律失败 = 远端 pi 的 user-level `settings.json` 读不到 —— scanner 会按
 * 「未配置」处理并退回默认会话根（`<home>/.pi/agent/sessions`），这正是本套夹具会话文件所在的布局。
 */
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
		async remoteHome() {
			return HOME;
		},
		async withProjectSession() {
			return { ok: false, code: "PATH_NOT_FOUND" };
		},
	};
}

/**
 * 真 AgentManager 装配：本机专属依赖（trust / 会话文件修复 / 本机路径归一化）一律 stub 成「一调用就抛」，
 * 所以「远端分支没碰它们」是硬事实，不是靠断言调用次数的软证据。
 */
function createManager(record, remoteRuntime) {
	const manager = new AgentManager(
		(id) => (id === remoteProject.id ? remoteProject : undefined),
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
	return { facts: [], launches: [], handles: [], forbidden: [], errorCards: [], beforeSpawn: 0 };
}

/** 装配被测组合：真 catalog + 真端口 + 真 AgentManager + 真协调器（项目位置按远端项目解析）。 */
async function createHarness(t, { resolveService, registerSession = true } = {}) {
	const catalog = await makeCatalog(t);
	const record = createRecord();
	const service = createFakeService(record);
	const port = createRemoteRuntimePort({
		resolveService: resolveService ?? (() => service),
		settings: () => ({}),
		...(registerSession ? { resolveCatalog: () => catalog } : {}),
	});
	const { manager, restore } = createManager(record, port);
	// 终态 runtime 会被协调器先 stop 再报错（错误卡同时从 manager.messages 里消失），所以在 stop 的那一刻
	// 把错误卡抄下来：要断言的是**协调器这条链路**里产生的稳定码，而不是另起一条创建路径。
	const originalStop = manager.stop.bind(manager);
	manager.stop = async (agentId) => {
		record.errorCards.push(...manager.getMessages(agentId).filter((message) => message.role === "error"));
		return originalStop(agentId);
	};
	const coordinator = new SessionRuntimeCoordinator(
		catalog,
		new CompositeAgentGateway([manager]),
		async (input) => ({ accepted: true, requestId: input.requestId }),
		undefined,
		(projectId) => (projectId === PROJECT_ID ? remoteProject.locator : undefined),
	);
	return { catalog, coordinator, manager, record, restore };
}

test("恢复：ssh locator 的 catalog 记录 activate ⇒ 远端 runtime（plan 来自记录与端口，本机 trust/repair/normalize 一次不碰）", async (t) => {
	const harness = await createHarness(t);
	const { catalog, coordinator, record, restore } = harness;
	try {
		const registration = await catalog.ensureRemoteSession({
			projectId: PROJECT_ID,
			hostId: HOST_ID,
			remoteSessionId: REMOTE_SESSION_ID,
			remotePath: REMOTE_SESSION_FILE,
			title: "远端会话",
			updatedAt: 1,
		});

		const result = await coordinator.activateRuntime(registration.record.id);

		assert.equal(result.ok, true, `激活必须成功：${result.ok ? "" : result.error.debugDetails}`);
		assert.equal(result.value.sessionId, registration.record.id);
		// 远端事实来自端口（一次 prepare = 一次事实探测），启动经端口给出的 launcher。
		assert.deepEqual(record.facts, [HOST_ID]);
		assert.equal(record.launches.length, 1);
		const plan = record.launches[0];
		assert.equal(plan.kind, "remote-ssh");
		assert.equal(plan.cwd, REMOTE_CWD, "plan 的 cwd 来自项目 locator（远端项目根）");
		assert.equal(plan.nodePath, NODE_PATH);
		assert.equal(plan.runnerPath, RUNNER_PATH);
		// 「重开同一会话」的会话文件来自 catalog 记录里的 remotePath（不是本机路径、也不是猜的）。
		const sessionIndex = plan.args.indexOf("--session");
		assert.notEqual(sessionIndex, -1, "恢复必须带 --session");
		assert.equal(plan.args[sessionIndex + 1], REMOTE_SESSION_FILE);
		assert.equal(plan.args.includes("--no-session"), false);
		// 本机专属准备一次都不许参与。
		assert.deepEqual(record.forbidden, []);
		// 绑定成立：会话身份 ↔ 那个远端 runtime。
		const target = coordinator.getTarget(registration.record.id);
		assert.equal(target?.agentId, result.value.agentId);

		// 一条 ssh 记录，远端路径没进本机字段。
		const entries = catalog.listEntries().filter((entry) => entry.projectId === PROJECT_ID);
		assert.equal(entries.length, 1, "恢复不得产生第二条记录");
		const entry = entries[0];
		assert.equal(entry.id, registration.record.id);
		assert.equal(entry.filePath, undefined);
		assert.equal(entry.originKey, undefined);
		assert.equal(entry.piSessionId, undefined);
		assert.equal(entry.status, "active");
		assert.deepEqual(plain(entry.locator), { kind: "ssh", hostId: HOST_ID, remoteSessionId: REMOTE_SESSION_ID, remotePath: REMOTE_SESSION_FILE });

		// 第二次激活复用同一个 runtime（不重开远端进程，也不新建记录）。
		const again = await coordinator.activateRuntime(registration.record.id);
		assert.equal(again.ok, true);
		assert.equal(again.value.agentId, result.value.agentId);
		assert.equal(record.launches.length, 1, "已绑定的 runtime 不得被重复拉起");
		assert.equal(catalog.listEntries().filter((candidate) => candidate.projectId === PROJECT_ID).length, 1);
		assert.deepEqual(record.forbidden, []);
	} finally {
		restore();
	}
});

test("端口不可用：稳定码 + 零 launch（不静默当本机会话，也不改写记录）", async (t) => {
	const harness = await createHarness(t, { resolveService: () => undefined });
	const { catalog, coordinator, record, restore } = harness;
	try {
		const registration = await catalog.ensureRemoteSession({
			projectId: PROJECT_ID,
			hostId: HOST_ID,
			remoteSessionId: REMOTE_SESSION_ID,
			remotePath: REMOTE_SESSION_FILE,
			title: "远端会话",
			updatedAt: 1,
		});

		const result = await coordinator.activateRuntime(registration.record.id);

		assert.equal(result.ok, false);
		// 启动错误卡现在会在 stop() 之前被读走（否则 messages.delete 抹掉它），所以真实稳定码
		// 能传到这一层：它是「远端运行时不可用」，比以前的泛化 COMMAND_FAILED 更精确。
		assert.equal(result.error.code, "SESSION_RUNTIME_UNAVAILABLE");
		assert.match(result.error.debugDetails, new RegExp(REMOTE_RUNTIME_CODES.unavailable));
		assert.equal(record.launches.length, 0, "拿不到端口时零启动动作");
		assert.deepEqual(record.forbidden, [], "拒绝必须发生在任何本机准备之前");
		// 稳定码来自链路深处（会话内错误卡，经 renderer 通道展示给用户）：是「远端运行时不可用」，
		// 不是「本机 pi 起来了」或任何本机准备的结果。
		assert.equal(record.errorCards.length, 1);
		assert.match(String(record.errorCards[0].meta?.debugDetails ?? ""), new RegExp(REMOTE_RUNTIME_CODES.unavailable));
		const entry = catalog.listEntries().find((candidate) => candidate.id === registration.record.id);
		assert.equal(entry.filePath, undefined, "失败路径不得把远端路径写成本机 filePath");
		assert.equal(catalog.listEntries().filter((candidate) => candidate.projectId === PROJECT_ID).length, 1);
	} finally {
		restore();
	}
});

test("单一记录：新远端会话（draft）激活后同一远端会话恰好一条，且存活的是 draft 那条 id", async (t) => {
	const harness = await createHarness(t);
	const { catalog, coordinator, record, restore } = harness;
	try {
		// 渲染层先建的 draft：只有 projectId，没有任何位置身份（远端 pi 的会话文件此时还不存在）。
		const draft = await catalog.createDraft({ projectId: PROJECT_ID, title: "新会话", environment: "native" });

		const result = await coordinator.activateRuntime(draft.id);

		assert.equal(result.ok, true, `激活必须成功：${result.ok ? "" : result.error.debugDetails}`);
		assert.equal(result.value.sessionId, draft.id, "渲染层手上的 sessionId 必须是存活记录");
		assert.equal(record.launches.length, 1);
		assert.equal(record.launches[0].args.includes("--session"), false, "新会话不带 --session（让远端 pi 自己挑文件）");
		assert.deepEqual(record.forbidden, []);

		const entries = catalog.listEntries().filter((entry) => entry.projectId === PROJECT_ID);
		assert.equal(entries.length, 1, "握手登记另立的那条记录必须被 draft 吸收，而不是与它并存");
		const entry = entries[0];
		assert.equal(entry.id, draft.id);
		assert.equal(entry.status, "active");
		// 远端身份落在 locator 上：hostId + pi 上报的路径 + 由登记推出的相对身份。
		assert.deepEqual(plain(entry.locator), { kind: "ssh", hostId: HOST_ID, remoteSessionId: REMOTE_SESSION_ID, remotePath: REMOTE_SESSION_FILE });
		// **绝不**落进本机字段。
		assert.equal(entry.filePath, undefined);
		assert.equal(entry.originKey, undefined);
		assert.equal(entry.piSessionId, undefined);
		assert.equal(entry.projectId, PROJECT_ID);

		// 这条会话现在可恢复：再激活一次复用同一 runtime（同一条记录，同一个 agent）。
		const again = await coordinator.activateRuntime(draft.id);
		assert.equal(again.ok, true);
		assert.equal(again.value.agentId, result.value.agentId);
		assert.equal(record.launches.length, 1);
		assert.equal(catalog.listEntries().filter((candidate) => candidate.projectId === PROJECT_ID).length, 1);
	} finally {
		restore();
	}
});

test("装配守卫：main/index.ts 把项目位置解析器注入会话协调器（远端 draft 收敛的判据来源）", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	// 空白容忍的定位（不改格式就把断言语义弄丢）：构造点 → 项目存储读值 → locator → 本地分支判定。
	assert.match(main, /new SessionRuntimeCoordinator\([\s\S]{0,400}?projectStore\.get\(projectId\)[\s\S]{0,400}?\.locator/);
	assert.match(main, /new SessionRuntimeCoordinator\([\s\S]{0,400}?isLocalProject\(project\)/);
});
