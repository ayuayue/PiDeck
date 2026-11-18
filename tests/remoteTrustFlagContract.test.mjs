/**
 * 远端项目 trust 的传递门禁（P4.4b：由「一律不得传 flag」等价迁移为「flag 只能来自 trust 解析」）。
 *
 * ── 为什么要迁移、迁移了什么 ─────────────────────────────────────────
 * P4.4a 的版本断言「远端 plan/launcher 源码里不得出现 `--approve/--no-approve/trustOverride`」——
 * 那是「PiDeck 不得替用户决定远端项目 `.pi` 资源是否执行」的**临时**门禁，前提是这件事**尚未授权**。
 * `docs/archive/remote/remote-trust-plan.md` §3 已给出授权（决策 1：传 flag；决策 2：未决策默认 = 不传任何 flag），
 * 所以门禁按授权等价迁移，而不是删除或放宽：
 *
 * 1. flag 字面量只允许出现在**已登记的解析点**（下面 `APPROVED_FLAG_SITES`，每一处都要写明理由）；
 *    新增一处会在本测试当场变红——「悄悄多一条传 flag 的路」仍然必须是一个看得见的动作。
 * 2. 远端 launcher 与 plan 构造点**不得自己拼 flag**：结构上它们只能透传 `args`
 *    （plan 类型的职责边界见 `PiSpawnHandle`，本测试同时钉住「远端 plan 类型里没有 trust 字段」）。
 * 3. **未决策时一个 flag 都不加**（缺省 / 材料缺失 / endpoint 变更作废 / 解析失败同一条路径），
 *    approve 与 deny 各只加一个对应 flag。这条行为断言是本批最关键的安全底线：
 *    禁止任何形式的默认 approve。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildRemotePiArgs, basePiRpcArgs } = loadTsCommonJs("src/main/pi/piRpcArgs.ts");
const { buildRemotePiRuntimePlan } = loadTsCommonJs("src/main/pi/piRemoteRuntimePlan.ts");

const FLAG_PATTERN = /--no-approve|--approve/g;

/**
 * 允许出现 trust flag 字面量的**闭集**：文件 → 该文件必须命中的形态。
 *
 * 登记标准（加新条目必须同时写清这三点）：flag 从哪来（谁解析出的决策）、作用于哪次 pi 启动、
 * 为什么不能复用已登记的点。没有理由的新条目不允许存在。
 */
const APPROVED_FLAG_SITES = [
	{
		file: "src/main/pi/piRpcArgs.ts",
		// 远端：唯一一处把「已解析的 trust 决策」翻成 flag 的映射（`input.trust` 来自
		// RemoteProjectTrustService，未决策时不传字段 ⇒ 一个 flag 都不加）。
		expected: /if \(input\.trust !== undefined\) args\.push\(input\.trust === "approve" \? "--approve" : "--no-approve"\);/,
		reason: "远端 pi 的 trust 映射（唯一来源：已解析的决策）",
	},
	{
		file: "src/main/pi/PiProcess.ts",
		// 本机：`AgentManager.ensureProjectTrust` 的决策，带 pi 版本能力判定（<0.79 不支持时 deny 必须失败关闭）。
		expected: /if \(supportsTrustFlags\) finalPiArgs\.push\(trustOverride === "approve" \? "--approve" : "--no-approve"\);/,
		reason: "本机 pi 的 trust 映射（历史行为，本批不得改动）",
	},
	{
		file: "src/main/config/RemotePiResourceBackend.ts",
		// 远端资源命令固定忽略项目级资源（列/读写技能、扩展等），不是会话启动的 trust 决策。
		expected: /\[facts\.nodePath, facts\.piPath, \.\.\.args, "--no-approve"\]/,
		reason: "远端资源命令固定忽略项目资源（与会话 trust 决策无关）",
	},
	{
		file: "src/main/extensions/ExtensionManager.ts",
		// 扩展更新命令固定忽略项目级资源（`pi update --extensions`），不是会话启动的 trust 决策。
		expected: /finalArgs\.push\("--no-approve"\);/,
		reason: "扩展更新命令固定忽略项目资源（与会话 trust 决策无关）",
	},
];

/** 剥掉注释后的代码（注释里讨论「不传 trust」是允许的，本仓本来就这么写）。 */
function codeOf(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\/[^\n]*/gm, "");
}

function collectSourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" ? [] : collectSourceFiles(path);
		return entry.name.endsWith(".ts") ? [path.split("\\").join("/")] : [];
	});
}

test("trust flag 字面量只允许出现在已登记的解析点（新增一处必须显式登记并说明理由）", () => {
	const approved = new Set(APPROVED_FLAG_SITES.map((site) => site.file));
	const offenders = [];
	for (const file of collectSourceFiles("src/main")) {
		const code = codeOf(readFileSync(file, "utf8"));
		const hits = code.match(FLAG_PATTERN) ?? [];
		if (hits.length > 0 && !approved.has(file)) offenders.push(`${file}（${hits.length} 处）`);
	}
	assert.deepEqual(offenders, [], "这些文件出现了 trust flag 字面量但没有登记解析点：请说明 flag 从哪来、作用于哪次启动，或改走 buildRemotePiArgs");

	// 闭集不许留死条目：登记了的每个点都必须真的还在（否则门禁会静默失效）。
	for (const site of APPROVED_FLAG_SITES) {
		assert.match(codeOf(readFileSync(site.file, "utf8")), site.expected, `${site.file} 不再是登记的形态（${site.reason}）：形态变了请同步本测试`);
	}
});

test("远端 launcher 与 plan 构造点不得自己拼 flag", () => {
	const launcher = codeOf(readFileSync("src/main/remote/SshPiRuntimeLauncher.ts", "utf8"));
	assert.doesNotMatch(launcher, FLAG_PATTERN, "远端 launcher 只能透传 plan.args，不得自己追加任何 trust flag");
	const plan = codeOf(readFileSync("src/main/pi/piRemoteRuntimePlan.ts", "utf8"));
	assert.doesNotMatch(plan, FLAG_PATTERN, "plan 构造点不认 flag 字面量，只把决策透传给 buildRemotePiArgs");
	assert.match(plan, /\.\.\.\(input\.trust === undefined \? \{\} : \{ trust: input\.trust \}\)/, "trust 必须是原样透传（缺省即不传，构造点不产生默认值）");
});

test("远端 plan 的类型里没有 trust 字段（flag 只能经 args 出去）", () => {
	// 类型定义在 PiSpawnHandle（远端与本地共用的 spawn 句柄模块），不在 plan 组装器里。
	const file = "src/main/pi/PiSpawnHandle.ts";
	const source = readFileSync(file, "utf8");
	const start = source.indexOf("export type RemoteSshPiRuntimeLaunchPlan");
	assert.ok(start >= 0, `${file} 里找不到远端 plan 类型（改名了？请同步本测试）`);
	const end = source.indexOf("\n};", start);
	assert.ok(end > start, "远端 plan 类型定义形态变了（请同步本测试）");
	const block = source.slice(start, end + 3);
	assert.doesNotMatch(block, /trust|approve/i, "远端 plan 类型出现了 trust 字段：决策只能经 args 传递，不能在类型上另开一条路");
});

test("行为：未决策 ⇒ 一个 flag 都不加；approve/deny ⇒ 恰好一个", () => {
	const base = [...basePiRpcArgs()];
	const undecidedArgs = [...buildRemotePiArgs()];
	assert.deepEqual(undecidedArgs, base, "缺省 = 未决策 = 零行为变更");
	assert.equal(undecidedArgs.includes("--approve"), false);
	assert.equal(undecidedArgs.includes("--no-approve"), false);
	assert.deepEqual([...buildRemotePiArgs({ trust: undefined })], base, "显式 undefined 与缺省同判");

	const approve = [...buildRemotePiArgs({ trust: "approve" })];
	const deny = [...buildRemotePiArgs({ trust: "no-approve" })];
	assert.deepEqual(approve, [...base, "--approve"]);
	assert.deepEqual(deny, [...base, "--no-approve"]);

	const planInput = { hostId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", generation: 1, remoteCwd: "/srv/app", nodePath: "/usr/local/bin/node", piPath: "/usr/local/bin/pi", runnerPath: "/home/dev/.pideck/remote-host/bundles/deadbeef/runner.mjs", nonce: "n".repeat(16) };
	assert.deepEqual([...buildRemotePiRuntimePlan(planInput).args], base, "plan 缺省同样不加 flag");
	assert.deepEqual([...buildRemotePiRuntimePlan({ ...planInput, trust: "approve" }).args], [...base, "--approve"]);
});
