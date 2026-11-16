import { agentManagerSource } from "./helpers/agentManagerSources.mjs";
/**
 * 远端 trust 的解析与传递（P4.4b）：四态 → 参数。
 *
 * 这组用例是「远端项目 `.pi` 资源是否执行」这条链路的**行为级**判据，全部走真实现：
 * `RemoteProjectTrustService`（真决策表 + 替身持久化端口）→ `createRemoteRuntimePort.prepare`
 * → `buildRemotePiRuntimePlan` → `buildRemotePiArgs`。
 *
 * 钉住的行为：
 * - 未决策（含「没写过决策」「材料缺失」「endpoint 变更作废」「解析失败」）⇒ 参数里**一个 trust flag 都没有**
 *   （与 PiDeck 历史行为逐字一致；禁止任何形式的默认 approve）；
 * - approve / deny ⇒ 恰好一个对应的 flag，位置与 base 参数无关地追加；
 * - 撤销在**下一次 prepare** 即生效（不要求重启应用）；
 * - 未注入 trust 解析器（正式包/旧装配/测试替身）⇒ 与「未决策」同一条路径，不传 flag。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteRuntimePort } = loadTsCommonJs("src/main/pi/remoteRuntimePort.ts");
const { createRemoteProjectTrustService } = loadTsCommonJs("src/main/remote/RemoteProjectTrustService.ts");
const { buildRemotePiArgs, basePiRpcArgs } = loadTsCommonJs("src/main/pi/piRpcArgs.ts");
const { buildRemotePiRuntimePlan } = loadTsCommonJs("src/main/pi/piRemoteRuntimePlan.ts");

const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const REMOTE_CWD = "/srv/remote-app";
const BASE_ARGS = ["--mode", "rpc", "--no-themes", "--offline"];
const FACTS = { nodePath: "/usr/local/bin/node", piPath: "/usr/local/bin/pi", version: "1.0.4", runnerPath: "/home/dev/.pideck/remote-host/bundles/deadbeef/runner.mjs" };

const endpoint = (fingerprint = "SHA256:zzz") => ({
	hostName: "10.81.2.15",
	user: "zhadainian",
	port: 22,
	pinAlias: `pideck-${HOST_ID}`,
	routeDigest: "a".repeat(64),
	knownHostsSha256: "b".repeat(64),
	hostKeyFingerprints: [fingerprint],
});

/** 决策表替身：真 service + 内存里的 settings 段 + 固定的主机事实。 */
function createTrust({ fingerprint = "SHA256:zzz", catalog } = {}) {
	const state = { raw: undefined, writes: 0 };
	const hosts = catalog === undefined ? [{ hostId: HOST_ID, label: "Build box", endpoint: endpoint(fingerprint) }] : catalog;
	const service = createRemoteProjectTrustService({
		settings: {
			read: () => state.raw,
			write: async (records) => {
				state.writes += 1;
				state.raw = JSON.parse(JSON.stringify(records));
			},
		},
		hostFacts: {
			catalog: async () => (hosts === null ? undefined : { hosts, retired: [], complete: true }),
		},
		now: () => Date.parse("2026-10-01T00:00:00.000Z"),
	});
	return { service, state, hostId: HOST_ID };
}

function createPort(resolveTrust) {
	return createRemoteRuntimePort({
		resolveService: () => ({
			async remotePiRuntimeFacts() {
				return FACTS;
			},
			// 本组只断言 trust flag：快照部署固定失败 ⇒ 不注入扩展 ⇒ 参数面与历史逐字一致。
			async ensureRemoteExtensionSnapshot() {
				return { ok: false, code: "REMOTE_EXTENSIONS_UNAVAILABLE" };
			},
			createPiRuntimeLauncher() {
				// 本组只断言 plan（prepare 的返回值），启动器只需形状正确。
				return {
					async launch() {
						throw new Error("LAUNCHER_NOT_USED_IN_THIS_SUITE");
					},
				};
			},
		}),
		settings: () => ({}),
		...(resolveTrust === undefined ? {} : { resolveTrust }),
	});
}

// prepare() 现在返回 { plan, extensions }；本组只关心参数面，helper 同时接受原始 plan。
const argsOf = (value) => [...(value && typeof value === "object" && "plan" in value ? value.plan : value).args];

test("参数构造：未决策 ⇒ 不出现任何 trust flag；approve/deny ⇒ 各就各位", () => {
	assert.deepEqual([...basePiRpcArgs()], BASE_ARGS, "本机与远端共享的基础参数不得被本轮改动碰");
	assert.deepEqual([...buildRemotePiArgs()], BASE_ARGS, "未决策：一个 flag 都不加（零行为变更）");
	assert.deepEqual([...buildRemotePiArgs({ sessionFile: "/home/dev/.pi/agent/sessions/a.jsonl" })], [...BASE_ARGS, "--session", "/home/dev/.pi/agent/sessions/a.jsonl"]);
	assert.deepEqual([...buildRemotePiArgs({ trust: "approve" })], [...BASE_ARGS, "--approve"]);
	assert.deepEqual([...buildRemotePiArgs({ trust: "no-approve" })], [...BASE_ARGS, "--no-approve"]);
	// 只允许一个 flag：approve 与 no-approve 不可能同时出现（词汇是单值枚举，不是开关位）。
	assert.equal(buildRemotePiArgs({ trust: "approve" }).includes("--no-approve"), false);
	assert.equal(buildRemotePiArgs({ trust: "no-approve" }).includes("--approve"), false);
});

test("plan 构造：trust 只做透传，缺省即不传（构造点不产生默认值）", () => {
	const input = { hostId: HOST_ID, generation: 1, remoteCwd: REMOTE_CWD, nodePath: FACTS.nodePath, piPath: FACTS.piPath, runnerPath: FACTS.runnerPath, nonce: "n".repeat(16) };
	assert.deepEqual(argsOf(buildRemotePiRuntimePlan(input)), BASE_ARGS);
	assert.deepEqual(argsOf(buildRemotePiRuntimePlan({ ...input, trust: "approve" })), [...BASE_ARGS, "--approve"]);
	assert.deepEqual(argsOf(buildRemotePiRuntimePlan({ ...input, trust: "no-approve" })), [...BASE_ARGS, "--no-approve"]);
});

test("端口：未注入 trust 解析器 ⇒ 与「未决策」同一条路径（不传 flag）", async () => {
	const plan = await createPort(undefined).prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD });
	assert.deepEqual(argsOf(plan), BASE_ARGS);
});

test("端口：解析器返回 undefined / 抛错 ⇒ 不传 flag，且不影响会话启动", async () => {
	const undecided = await createPort(() => ({ trustOverride: async () => undefined })).prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD });
	assert.deepEqual(argsOf(undecided), BASE_ARGS);

	const failing = await createPort(() => ({
		trustOverride: async () => {
			throw new Error("REMOTE_PROJECT_TRUST_UNAVAILABLE");
		},
	})).prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD });
	assert.deepEqual(argsOf(failing), BASE_ARGS, "读决策失败不得退化成默认 approve，也不得让远端会话起不来");

	const unresolved = await createPort(() => undefined).prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD });
	assert.deepEqual(argsOf(unresolved), BASE_ARGS);
});

test("端口 + 真决策表：approve/deny 各一个 flag；撤销下一次 prepare 即生效", async () => {
	const trust = createTrust();
	const port = createPort(() => trust.service);

	assert.deepEqual(argsOf(await port.prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD })), BASE_ARGS, "未决策");
	await trust.service.decide({ hostId: HOST_ID, remoteRoot: REMOTE_CWD, decision: "approve" });
	assert.deepEqual(argsOf(await port.prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD })), [...BASE_ARGS, "--approve"]);
	assert.deepEqual(argsOf(await port.prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD, noSession: true })), [...BASE_ARGS, "--approve", "--no-session"], "匿名会话与 trust flag 互不覆盖");

	// 改主意：同一个项目根改成拒绝 ⇒ 下一次 spawn 换成另一个 flag。
	await trust.service.decide({ hostId: HOST_ID, remoteRoot: REMOTE_CWD, decision: "deny" });
	assert.deepEqual(argsOf(await port.prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD })), [...BASE_ARGS, "--no-approve"]);

	// 撤销 ⇒ 下一次 spawn 不再带任何 flag（不要求重启应用）。
	assert.equal(await trust.service.revoke({ hostId: HOST_ID, remoteRoot: REMOTE_CWD }), true);
	assert.deepEqual(argsOf(await port.prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD })), BASE_ARGS);
});

test("端口 + 真决策表：其它项目根 / 其它主机不受影响；endpoint 变更后旧决策不生效", async () => {
	const trust = createTrust();
	const port = createPort(() => trust.service);
	await trust.service.decide({ hostId: HOST_ID, remoteRoot: REMOTE_CWD, decision: "approve" });

	// 同一主机的另一个项目根：没有决策 ⇒ 不传 flag（信任是项目级的，不是主机级开关）。
	assert.deepEqual(argsOf(await port.prepare({ hostId: HOST_ID, remoteCwd: "/srv/another-app" })), BASE_ARGS);

	// endpoint 变了（换机 / 指纹变 / 用户端口变）⇒ 旧决策作废 ⇒ 不传 flag。
	const afterChange = createTrust({ fingerprint: "SHA256:other" });
	afterChange.state.raw = trust.state.raw;
	assert.deepEqual(argsOf(await createPort(() => afterChange.service).prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD })), BASE_ARGS, "endpoint 变更 = 换机/中间人 ⇒ fail-closed，绝不自动继承信任");
});

test("端口 + 真决策表：主机 pin 事实拿不到 ⇒ 不传 flag（材料缺失即不可判定）", async () => {
	const trust = createTrust({ catalog: null });
	await assert.rejects(() => trust.service.decide({ hostId: HOST_ID, remoteRoot: REMOTE_CWD, decision: "approve" }), /REMOTE_PROJECT_TRUST_ENDPOINT_UNVERIFIED/);
	// 即便配置里已有一条（在 pin 事实可用时写的），现在读不到事实也不得放行。
	const withRecord = createTrust();
	await withRecord.service.decide({ hostId: HOST_ID, remoteRoot: REMOTE_CWD, decision: "approve" });
	const lostFacts = createTrust({ catalog: null });
	lostFacts.state.raw = withRecord.state.raw;
	assert.deepEqual(argsOf(await createPort(() => lostFacts.service).prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD })), BASE_ARGS);
});

test("本机 trust 行为不变的回归守卫：本地分支依旧按决策传 flag（远端改动不得把本机一起改掉）", async () => {
	const { readFileSync } = await import("node:fs");
	const piProcess = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	// 本机映射仍是「approve ⇒ --approve；no-approve ⇒ --no-approve」，且带版本能力判定。
	assert.match(piProcess, /finalPiArgs\.push\(trustOverride === "approve" \? "--approve" : "--no-approve"\)/);
	assert.match(piProcess, /trustOverride === "no-approve" && !supportsTrustFlags/);
	const agentManager = agentManagerSource;
	// dev 把信任闸抽成 ProjectTrustGate（Wave 4C）：调用点变成 this.projectTrust.ensureProjectTrust，
	// 判定语义不变（本机会话仍在 spawn 前预检 trust）。
	assert.match(agentManager, /const trustOverride = await this\.projectTrust\.ensureProjectTrust\(project\)/, "本机会话仍由 ensureProjectTrust 预检 trust（经 projectTrust 网关）");
	// 远端分支不得偷偷改成本机那套（trust 由远端端口在 prepare 时解析）。
	const remoteBody = agentManager.slice(agentManager.indexOf("private async createRemoteUnlocked("), agentManager.indexOf("private async createUnlocked(input: CreateAgentInput)"));
	assert.doesNotMatch(remoteBody.replace(/\/\/[^\n]*/g, ""), /ensureProjectTrust|trustOverride/);
});
