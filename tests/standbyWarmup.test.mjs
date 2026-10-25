/**
 * standby 预热状态机（standbyWarmup.ts）+ AgentManager 接入契约。
 *
 * 背景（2026-10 线上实测）：一次 pi RPC 启动 8~25s，几乎全耗在 pi 加载用户 npm 扩展。
 * 旧实现里「后台预热进行中」对认领方不可见：新建会话后马上发送（尤其引导页首条消息）时，
 * 认领方看不到池条目就自己 spawn，26.5s 的真会话 spawn 与 12.1s 的 standby spawn 并行，
 * 又慢又费内存；单槽位池在预热进行中切项目还会直接丢掉最新请求。
 *
 * 本文件覆盖三件事：
 * 1. StandbyWarmupTracker 全部语义（begin/settle/等待/超时清理/取消/接力）；
 * 2. AgentManager 接线后的行为（claim 等待进行中预热、ensure 目标接力、release/stopAll 取消）；
 * 3. 关键时序的源码契约（成功先 put 再 settle、取消先 settle 再 stop）——用空白容忍正则，
 *    避免一次格式化就整组红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { STANDBY_CLAIM_WAIT_MS, StandbyWarmupTracker } = loadTsCommonJs("src/main/pi/standbyWarmup.ts");
const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const agentManagerSource = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const standbyWarmupSource = readFileSync("src/main/pi/standbyWarmup.ts", "utf8");

/** 等到「微任务 + 下一轮事件循环」都跑完（预热 settle → 唤醒等待者 → 接力都在微任务里推进）。 */
const flush = async () => {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ── StandbyWarmupTracker：纯逻辑语义 ──────────────────────────────

test("STANDBY_CLAIM_WAIT_MS 是 30s（覆盖一次 8~25s 的冷启动后仍留余量）", () => {
	assert.equal(STANDBY_CLAIM_WAIT_MS, 30_000);
});

test("begin 幂等：进行中的预热不会被第二次 begin 覆盖目标", () => {
	const tracker = new StandbyWarmupTracker();
	assert.equal(tracker.hasPending(), false);
	assert.equal(tracker.begin("p1", "fp-a"), true);
	assert.equal(tracker.begin("p1", "fp-a"), false);
	assert.equal(tracker.begin("p2", "fp-b"), false, "目标不同也必须先 settle 当前预热（单飞）");
	assert.equal(tracker.hasPending(), true);
	assert.equal(tracker.matches("p1", "fp-a"), true);
	assert.equal(tracker.matches("p2", "fp-b"), false);
	// settle 之后才允许登记下一次预热
	assert.equal(tracker.settle("agent-a"), false);
	assert.equal(tracker.hasPending(), false);
	assert.equal(tracker.begin("p2", "fp-b"), true);
});

test("settle 成功：唤醒等待者 ok=true，返回是否被取消（false）", async () => {
	const tracker = new StandbyWarmupTracker();
	tracker.begin("p1", "fp-a");
	const waiting = tracker.waitForClaim("p1", "fp-a", 1000);
	assert.equal(tracker.settle("agent-a"), false, "未取消的 settle 返回 false");
	const settlement = await waiting;
	assert.equal(settlement?.projectId, "p1");
	assert.equal(settlement?.fingerprint, "fp-a");
	assert.equal(settlement?.ok, true);
	assert.equal(settlement?.cancelled, false);
	assert.equal(tracker.hasPending(), false);
	assert.equal(tracker.settle("agent-b"), false, "重复 settle 幂等：不再唤醒、不报错");
});

test("settle 失败：唤醒等待者 ok=false（认领方据此回退普通 spawn）", async () => {
	const tracker = new StandbyWarmupTracker();
	tracker.begin("p1", "fp-a");
	const waiting = tracker.waitForClaim("p1", "fp-a", 1000);
	assert.equal(tracker.settle(null), false);
	const settlement = await waiting;
	assert.equal(settlement?.ok, false);
	assert.equal(settlement?.cancelled, false);
});

test("waitForClaim 不消费状态：项目/指纹不匹配立即 null，进行中的预热保持原样", async () => {
	const tracker = new StandbyWarmupTracker();
	tracker.begin("p1", "fp-a");
	assert.equal(await tracker.waitForClaim("p2", "fp-a", 10), null);
	assert.equal(await tracker.waitForClaim("p1", "fp-b", 10), null);
	assert.equal(tracker.hasPending(), true);
	assert.equal(tracker.matches("p1", "fp-a"), true);
});

test("waitForClaim 超时返回 null 并移除等待者（预热卡死时不能泄漏 promise/定时器）", async () => {
	const tracker = new StandbyWarmupTracker();
	tracker.begin("p1", "fp-a");
	const settlement = await tracker.waitForClaim("p1", "fp-a", 5);
	assert.equal(settlement, null);
	// private 字段在转译后就是普通属性：直接断言清理结果（这是本用例的目的）。
	assert.equal(tracker.waiters.size, 0, "超时必须把等待者从集合里移除");
	// 超时后 settle 不得再对已移除的等待者二次 resolve
	tracker.settle("agent-a");
	assert.equal(tracker.waiters.size, 0);
});

test("并发等待：同一目标多个等待者都被唤醒；settle 前不提前返回", async () => {
	const tracker = new StandbyWarmupTracker();
	tracker.begin("p1", "fp-a");
	const first = tracker.waitForClaim("p1", "fp-a", 1000);
	const second = tracker.waitForClaim("p1", "fp-a", 1000);
	let settledCount = 0;
	first.then(() => {
		settledCount += 1;
	});
	second.then(() => {
		settledCount += 1;
	});
	await Promise.resolve();
	assert.equal(settledCount, 0, "预热未 settle 前等待者必须挂起");
	assert.equal(tracker.waiters.size, 2);
	tracker.settle("agent-a");
	const settlements = await Promise.all([first, second]);
	for (const settlement of settlements) {
		assert.equal(settlement?.ok, true);
		assert.equal(settlement?.fingerprint, "fp-a");
	}
	assert.equal(tracker.waiters.size, 0, "settle 后等待者集合必须清空");
});

test("cancelPending：按项目作用域标记取消，立即唤醒等待者（null），pending 保留到 settle", async () => {
	const tracker = new StandbyWarmupTracker();
	tracker.begin("p1", "fp-a");
	let woken = "pending";
	const waiting = tracker.waitForClaim("p1", "fp-a", 1000).then((settlement) => {
		woken = settlement;
	});
	assert.equal(tracker.cancelPending("p2"), false, "项目不符不得取消");
	assert.equal(tracker.isCancelled(), false);
	assert.equal(tracker.cancelPending("p1"), true);
	assert.equal(tracker.cancelPending("p1"), true, "重复取消幂等");
	await waiting;
	assert.equal(woken, null, "取消立即唤醒等待者，别让认领方陪跑一个注定被 stop 的进程");
	assert.equal(tracker.hasPending(), true, "取消不提前清 pending：完成时还要拿 agentId 去 stop");
	assert.equal(tracker.isCancelled(), true);
	assert.equal(tracker.settle("agent-a"), true, "settle 返回已取消");
	assert.equal(tracker.hasPending(), false);
	assert.equal(tracker.cancelPending(), false, "无进行中预热时取消返回 false");
});

test("waitForClaim 在已取消的预热上立即返回 null（不注册等待者、不等超时）", async () => {
	const tracker = new StandbyWarmupTracker();
	tracker.begin("p1", "fp-a");
	tracker.cancelPending("p1");
	const settlement = await tracker.waitForClaim("p1", "fp-a", 10_000);
	assert.equal(settlement, null);
	assert.equal(tracker.waiters.size, 0);
});

test("requestProject / takeRequestedProject：只保留最新目标、只取一次、clearRequestedProject 丢弃", () => {
	const tracker = new StandbyWarmupTracker();
	assert.equal(tracker.takeRequestedProject(), null);
	tracker.requestProject("p1", "fp-a");
	tracker.requestProject("p2", "fp-b");
	const requested = tracker.takeRequestedProject();
	assert.equal(requested?.projectId, "p2", "接力只认最新目标（前一个请求已被覆盖）");
	assert.equal(requested?.fingerprint, "fp-b");
	assert.equal(tracker.takeRequestedProject(), null, "接力目标只取一次");
	tracker.requestProject("p3", "fp-c");
	tracker.clearRequestedProject();
	assert.equal(tracker.takeRequestedProject(), null, "退出清理后不得再补热");
});

test("isCancelled 在无进行中预热时为 false（hasPending 初始态干净）", () => {
	const tracker = new StandbyWarmupTracker();
	assert.equal(tracker.isCancelled(), false);
	assert.equal(tracker.hasPending(), false);
	assert.equal(tracker.matches("p1", "fp-a"), false);
});

// ── AgentManager 接线：等待认领 / 目标接力 / 取消安全 ─────────────

const PROJECTS = new Map([
	["project-1", { id: "project-1", name: "Project One", path: "C:/project-one" }],
	["project-2", { id: "project-2", name: "Project Two", path: "C:/project-two" }],
]);

/**
 * 极简 harness：只有 standby 链路需要的方法面被替换（指纹/信任/停止/spawn），
 * 池与 tracker 都用真实实现（AgencyManager 自己构造）。
 */
function createStandbyManager() {
	const logs = { info: [], warn: [] };
	const stopped = [];
	const spawns = [];
	let fingerprint = "fp-shared";
	const manager = new AgentManager(
		(id) => PROJECTS.get(id),
		() => null,
		{ get: () => ({ standbyRuntimeEnabled: true, rpcTimeout: 600_000 }) },
		{},
		undefined,
		{ info: (...args) => logs.info.push(args), warn: (...args) => logs.warn.push(args) },
	);
	manager.computeStandbyFingerprintFor = () => fingerprint;
	manager.projectTrust.resolveTrustWithoutPrompt = async () => undefined;
	manager.stop = async (agentId) => {
		stopped.push(agentId);
		manager.agents.delete(agentId);
	};
	manager.createUnlocked = (input) => {
		const gate = deferred();
		spawns.push({ projectId: input.projectId, gate });
		return gate.promise;
	};
	return {
		manager,
		logs,
		stopped,
		spawns,
		setFingerprint(next) {
			fingerprint = next;
		},
	};
}

function standbyTab(id, projectId) {
	return { id, projectId, cwd: PROJECTS.get(projectId).path, title: "Standby", status: "idle", standby: true, createdAt: 1 };
}

function registerRuntime(manager, tab) {
	manager.agents.set(tab.id, { tab, process: { isRunning: () => true, stop: () => undefined } });
}

test("claimStandbyAgent：匹配的进行中预热存在时等待并认领，绝不再并行 spawn 第二个 pi", async () => {
	const { manager, spawns } = createStandbyManager();
	manager.ensureStandbyAgent("project-1");
	await flush();
	assert.equal(spawns.length, 1);
	manager.ensureStandbyAgent("project-1");
	await flush();
	assert.equal(spawns.length, 1, "进行中预热存在时 ensure 不得重复 spawn");

	let claimed = "pending";
	const claimPromise = manager.claimStandbyAgent({ projectId: "project-1", sessionId: "session-1" }).then((tab) => {
		claimed = tab;
		return tab;
	});
	await flush();
	assert.equal(claimed, "pending", "预热未 settle 前 claim 必须等待（不能直接 null 让调用方再 spawn）");
	assert.equal(spawns.length, 1, "等待期间绝不能再发起第二次 spawn");

	const tab = standbyTab("agent-standby", "project-1");
	registerRuntime(manager, tab);
	spawns[0].gate.resolve(tab);
	const result = await claimPromise;
	assert.equal(result?.id, "agent-standby");
	assert.equal(claimed?.standby, undefined, "认领后必须清 standby 标记（否则 list() 永远看不到）");
	assert.equal(manager.standbyPool.status(), null, "认领后池条目被消费");
	assert.equal(spawns.length, 1, "认领成功路径不得再 spawn");
});

test("claimStandbyAgent：预热失败时唤醒等待者并回退（返回 null 交调用方正常 spawn）", async () => {
	const { manager, spawns } = createStandbyManager();
	manager.ensureStandbyAgent("project-1");
	const claimPromise = manager.claimStandbyAgent({ projectId: "project-1", sessionId: "session-1" });
	await flush();
	spawns[0].gate.reject(new Error("spawn exploded"));
	assert.equal(await claimPromise, null);
	assert.equal(manager.standbyPool.status(), null, "失败预热不得入池");
	assert.equal(spawns.length, 1);
});

test("claimStandbyAgent：项目/指纹不匹配的进行中预热不等（换项目后直接回退 spawn）", async () => {
	const harness = createStandbyManager();
	harness.manager.ensureStandbyAgent("project-1");
	harness.setFingerprint("fp-changed");
	const startedAt = Date.now();
	const claimed = await harness.manager.claimStandbyAgent({ projectId: "project-1", sessionId: "session-1" });
	assert.equal(claimed, null);
	assert.ok(Date.now() - startedAt < 1000, "指纹不一致必须立即回退，不能等满 30s");
	assert.equal(harness.spawns.length, 1, "claim 自身不 spawn");
});

test("claimStandbyAgent：取消中的预热不再等待（用户不用陪跑注定被 stop 的进程）", async () => {
	const harness = createStandbyManager();
	harness.manager.ensureStandbyAgent("project-1");
	assert.equal(harness.manager.releaseStandbyAgent("project-1"), true);
	const startedAt = Date.now();
	const claimed = await harness.manager.claimStandbyAgent({ projectId: "project-1", sessionId: "session-1" });
	assert.equal(claimed, null);
	assert.ok(Date.now() - startedAt < 1000, "取消中的预热必须立即回退");
	assert.equal(harness.spawns.length, 1);
});

test("ensureStandbyAgent：预热进行中切项目时记录最新目标，当前预热 settle 后自动补热", async () => {
	const { manager, spawns } = createStandbyManager();
	manager.ensureStandbyAgent("project-1");
	manager.ensureStandbyAgent("project-2");
	await flush();
	assert.equal(spawns.length, 1, "同一时间只允许一次预热（单槽池）");
	assert.equal(spawns[0].projectId, "project-1");

	const tab1 = standbyTab("agent-1", "project-1");
	registerRuntime(manager, tab1);
	spawns[0].gate.resolve(tab1);
	await flush();
	assert.equal(spawns.length, 2, "当前预热 settle 后必须为最新目标补热，不能丢掉切项目请求");
	assert.equal(spawns[1].projectId, "project-2");
	assert.equal(manager.standbyPool.status()?.projectId, "project-1", "接力预热完成前，池里保留上一个可用进程");

	const tab2 = standbyTab("agent-2", "project-2");
	registerRuntime(manager, tab2);
	spawns[1].gate.resolve(tab2);
	await flush();
	assert.equal(manager.standbyPool.status()?.projectId, "project-2", "接力完成后池换到最新项目");
});

test("ensureStandbyAgent：池里已有同项目同指纹条目时不再 spawn", async () => {
	const { manager, spawns } = createStandbyManager();
	manager.ensureStandbyAgent("project-1");
	await flush();
	const tab = standbyTab("agent-1", "project-1");
	registerRuntime(manager, tab);
	spawns[0].gate.resolve(tab);
	await flush();
	assert.equal(manager.standbyPool.status()?.agentId, "agent-1");
	manager.ensureStandbyAgent("project-1");
	assert.equal(spawns.length, 1, "命中池条目必须直接返回");
});

test("ensureStandbyAgent：池条目指纹过期时为新指纹补热（旧条目被 put 顶替回收）", async () => {
	const harness = createStandbyManager();
	harness.manager.ensureStandbyAgent("project-1");
	await flush();
	const tab1 = standbyTab("agent-1", "project-1");
	registerRuntime(harness.manager, tab1);
	harness.spawns[0].gate.resolve(tab1);
	await flush();
	harness.setFingerprint("fp-changed");
	harness.manager.ensureStandbyAgent("project-1");
	await flush();
	assert.equal(harness.spawns.length, 2, "池里旧参数进程服务不了新 spawn 输入，必须补热");
	const tab2 = standbyTab("agent-2", "project-1");
	registerRuntime(harness.manager, tab2);
	harness.spawns[1].gate.resolve(tab2);
	await flush();
	assert.equal(harness.manager.standbyPool.status()?.agentId, "agent-2");
	assert.deepEqual(harness.stopped, ["agent-1"], "被顶替的旧 standby 必须停掉（不能留到 TTL）");
});

test("claimStandbyAgent：池条目指纹过期时丢弃旧进程并回退（旧进程服务不了本次认领）", async () => {
	const harness = createStandbyManager();
	harness.manager.ensureStandbyAgent("project-1");
	await flush();
	const tab1 = standbyTab("agent-1", "project-1");
	registerRuntime(harness.manager, tab1);
	harness.spawns[0].gate.resolve(tab1);
	await flush();
	harness.setFingerprint("fp-changed");
	assert.equal(await harness.manager.claimStandbyAgent({ projectId: "project-1", sessionId: "session-1" }), null);
	assert.deepEqual(harness.stopped, ["agent-1"], "指纹不符的池条目必须立即回收");
});

test("releaseStandbyAgent：取消进行中预热，完成时直接 stop 且绝不入池", async () => {
	const { manager, spawns, stopped } = createStandbyManager();
	manager.ensureStandbyAgent("project-1");
	await flush();
	const tab = standbyTab("agent-standby", "project-1");
	registerRuntime(manager, tab);
	assert.equal(manager.releaseStandbyAgent("project-2"), false, "项目不符不得取消别的项目的预热");
	assert.equal(manager.standbyWarmup.isCancelled(), false);
	assert.equal(manager.releaseStandbyAgent("project-1"), true);
	spawns[0].gate.resolve(tab);
	await flush();
	assert.deepEqual(stopped, ["agent-standby"], "取消的预热完成时必须 stop 掉进程");
	assert.equal(manager.standbyPool.status(), null, "取消的预热绝不 put 进池（否则 TTL 前泄漏不可见进程）");
});

test("stopAll：取消进行中预热并丢弃接力目标，退出路径不再 spawn", async () => {
	const { manager, spawns, stopped } = createStandbyManager();
	manager.ensureStandbyAgent("project-1");
	await flush();
	manager.ensureStandbyAgent("project-2"); // 排队了接力目标
	const tab = standbyTab("agent-standby", "project-1");
	registerRuntime(manager, tab);
	manager.stopAll();
	spawns[0].gate.resolve(tab);
	await flush();
	assert.ok(stopped.includes("agent-standby"), "stopAll 后完成的预热必须 stop");
	assert.equal(spawns.length, 1, "stopAll 之后不得再为接力目标补热");
	assert.equal(manager.standbyPool.status(), null);
});

// ── 源码契约：关键时序不能靠注释保证 ─────────────────────────────

function methodSource(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	assert.ok(start >= 0, `missing source marker: ${startMarker}`);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.ok(end > start, `missing end marker: ${endMarker}`);
	return source.slice(start, end);
}

test("源码契约：claimStandbyAgent 等待匹配的进行中预热，且自身绝不 spawn", () => {
	const claimSource = methodSource(agentManagerSource, "async claimStandbyAgent(input:", "/** 后台 spawn 一个 standby");
	assert.match(claimSource, /this\.standbyWarmup\.matches\(\s*input\.projectId\s*,\s*fingerprint\s*\)/);
	assert.match(claimSource, /await this\.standbyWarmup\.waitForClaim\(\s*input\.projectId\s*,\s*fingerprint\s*,\s*STANDBY_CLAIM_WAIT_MS\s*\)/);
	assert.match(claimSource, /if\s*\(\s*settlement\?\.ok\s*\)\s*entry\s*=\s*this\.standbyPool\.take\(\s*input\.projectId\s*,\s*fingerprint\s*\)/);
	assert.match(claimSource, /if\s*\(\s*!entry\s*\)\s*return null;/, "等待超时/失败必须回退原有 spawn（返回 null）");
	assert.doesNotMatch(claimSource, /this\.createUnlocked\(|this\.create\(/, "claim 自身绝不发起 spawn，等待失败只交给调用方");
});

test("源码契约：预热成功先 put 再 settle；取消先 settle(null) 再 stop", () => {
	const createSource = methodSource(agentManagerSource, "private async createStandbyAgent(", "async draftCommands(");
	const putIndex = createSource.indexOf("this.standbyPool.put(");
	const successSettleIndex = createSource.indexOf("this.standbyWarmup.settle(tab.id)");
	assert.ok(putIndex >= 0 && successSettleIndex > putIndex, "等待者醒来会立刻 take：成功路径必须先 put 再 settle");

	const cancelStart = createSource.indexOf("if (this.standbyWarmup.isCancelled())");
	assert.ok(cancelStart >= 0, "取消分支必须显式判断 isCancelled");
	const cancelEnd = createSource.indexOf(`if (tab.status !== "idle")`, cancelStart);
	assert.ok(cancelEnd > cancelStart);
	const cancelSource = createSource.slice(cancelStart, cancelEnd);
	assert.ok(cancelSource.indexOf("this.standbyWarmup.settle(null)") >= 0, "取消路径必须唤醒等待者");
	assert.ok(cancelSource.indexOf("this.standbyWarmup.settle(null)") < cancelSource.indexOf("this.stop(tab.id)"), "取消路径先 settle(null) 再 stop(agentId)");
	assert.doesNotMatch(cancelSource, /standbyPool\.put/, "取消的预热绝不入池");
});

test("源码契约：ensureStandbyAgent 使用 tracker 做单飞去重与目标接力", () => {
	const ensureSource = methodSource(agentManagerSource, "ensureStandbyAgent(projectId: string): void {", "/** 登记并启动一次后台预热");
	assert.match(ensureSource, /this\.standbyWarmup\.hasPending\(\)/);
	assert.match(ensureSource, /this\.standbyWarmup\.matches\(\s*projectId\s*,\s*fingerprint\s*\)/);
	assert.match(ensureSource, /this\.standbyWarmup\.requestProject\(\s*projectId\s*,\s*fingerprint\s*\)/);
	assert.doesNotMatch(agentManagerSource, /standbySpawnPending/, "旧的布尔去重必须被 tracker 取代");
	const relaySource = methodSource(agentManagerSource, "private warmLatestRequestedStandby(): void {", "/**\n\t * 丢弃指定项目未被认领的 standby 进程");
	assert.match(relaySource, /this\.standbyWarmup\.takeRequestedProject\(\)/);
	assert.match(relaySource, /this\.startStandbyWarmup\(\s*requested\.projectId\s*,\s*requested\.fingerprint\s*\)/, "settle 后必须为最新目标补热");
});

test("源码契约：releaseStandbyAgent / stopAll 取消进行中预热", () => {
	const releaseSource = methodSource(agentManagerSource, "releaseStandbyAgent(projectId: string): boolean {", "async claimStandbyAgent(");
	assert.match(releaseSource, /this\.standbyWarmup\.cancelPending\(\s*projectId\s*\)/);

	const stopAllSource = methodSource(agentManagerSource, "stopAll() {", "private attachPiProcessLifecycle(");
	assert.match(stopAllSource, /this\.standbyWarmup\.cancelPending\(\)/);
	assert.match(stopAllSource, /this\.standbyWarmup\.clearRequestedProject\(\)/);
	assert.ok(stopAllSource.indexOf("standbyWarmup.cancelPending()") < stopAllSource.indexOf("standbyPool.clear()"), "取消预热必须在清池之前，避免预热完成时补热回池");
});

test("源码契约：tracker 无 electron 依赖，定时器显式取自 node:timers（测试沙箱不注入 Node 全局）", () => {
	assert.match(standbyWarmupSource, /import\s*\{\s*clearTimeout\s*,\s*setTimeout\s*\}\s*from\s*"node:timers"/);
	assert.match(standbyWarmupSource, /export const STANDBY_CLAIM_WAIT_MS = 30_000;/);
	assert.doesNotMatch(standbyWarmupSource, /from\s+"electron"/);
	assert.doesNotMatch(standbyWarmupSource, /from\s+"\.\.?\//, "tracker 必须保持纯逻辑（无本地依赖），才能被 node --test 直接加载");
});
