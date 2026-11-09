import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端 pi 定位 + 版本兼容矩阵（Phase 4 / P4.1）。
 *
 * 这组用例要锁住四件事：
 * 1. 候选来源与本地 `PiLocator` 同源（四种候选名、只取绝对目录、按 PATH 顺序、去重）；
 * 2. 远端命令只由 `buildRemotePiVersionCommand` 构造，逐 token POSIX 单引号引用，
 *    且**每个候选都用同一个已解析的 node 当解释器**；
 * 3. 版本解析/分类是纯数值逻辑（字符串比较会把 0.9.0 判成比 0.85.1 新）；
 * 4. 探测流程的形状与 `resolveRemoteNodeExecutable` 同构：登录 shell 只读 PATH、
 *    坏候选 continue、全部耗尽才抛稳定码、探测次数有硬上限。
 *
 * 真机背景（`serve`）：非交互式 `command -v pi` 完全没命中，登录后是
 * `/home/zhadainian/.nvm/versions/node/v24.11.0/bin/pi`（`#!/usr/bin/env node` shim），
 * `pi --version` = `0.85.1`。裸执行该 shim 会落到非交互式 PATH 里的系统 node（v12.22.9）上，
 * 在 pi bundle 首条语句 SyntaxError、exit 1、stdout 空——所以版本命令必须写成
 * `'<已解析 node>' '<pi>' '--version'`（真机三条实测见 `RemotePiDiscovery.ts` 文件头）。
 */

const MODULE = "src/main/remote/RemotePiDiscovery.ts";
const SSH = { executable: "/usr/bin/ssh", args: ["-T", "-o", "BatchMode=yes", "--", "pideck-alias"], env: {}, openSshVersion: "OpenSSH_10.0p2" };
const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SENTINEL = "a1b2c3d4e5f6a7b8";
/** 真机上 `resolveRemoteNodeExecutable` 解析出来的解释器（nvm 的 node，v24.11.0）。 */
const NODE_PATH = "/home/zhadainian/.nvm/versions/node/v24.11.0/bin/node";

/** 跨沙箱返回的数组原型与测试 realm 不同，深比较前先归一为普通数组。 */
const plain = (value) => Array.from(value);
/** 远端命令以最后一个 argv 元素下发；这里取出来做「脚本化远端」的分派依据。 */
const remoteCommandOf = (args) => String(args.at(-1));
const pathAnswer = (value) => `PIDECK_PATH_BEGIN_${SENTINEL}${value}_PIDECK_PATH_END`;

/**
 * 纯函数部分：`./SshVerifiedConnection` 在真实模块里会拉起主机存储/pin 存储，离线单测不需要，
 * 因此一律用「被调用即失败」的替身，确保纯函数用例一个远端帧都不发。
 */
function loadPure() {
	return loadTsCommonJs(MODULE, {
		stubs: {
			"./SshVerifiedConnection": {
				async buildPinnedSshInvocation() {
					throw new Error("pure tests must not build invocations");
				},
			},
		},
	});
}

const { listPiCandidatesFromPath, buildRemotePiVersionCommand, normalizeRemotePiPath, parsePiVersionOutput, comparePiVersions, classifyRemotePiVersion, PI_CANDIDATE_NAMES, MAX_PI_CANDIDATES, REMOTE_PI_MIN_SUPPORTED, REMOTE_PI_VERIFIED_CEILING } = loadPure();

test("the exported matrix constants are the contract, not incidental values", () => {
	// 候选名必须与本地 PiLocator 同源（pi + 三种 JS 源文件别名），顺序即优先级。
	assert.deepEqual(plain(PI_CANDIDATE_NAMES), ["pi", "pi.js", "pi.mjs", "pi.cjs"]);
	assert.equal(MAX_PI_CANDIDATES, 3, "the probe walk is bounded like MAX_NODE_CANDIDATES");
	assert.deepEqual({ ...REMOTE_PI_MIN_SUPPORTED }, { major: 0, minor: 85, patch: 0 });
	assert.deepEqual({ ...REMOTE_PI_VERIFIED_CEILING }, { major: 0, minor: 85, patch: 999 });
});

test("candidates follow PATH order, cover the four install shapes, and are deduplicated", () => {
	const loginPath = "/home/zhadainian/.nvm/versions/node/v24.11.0/bin:/usr/local/bin:/usr/bin";
	assert.deepEqual(plain(listPiCandidatesFromPath(loginPath)), [
		"/home/zhadainian/.nvm/versions/node/v24.11.0/bin/pi",
		"/home/zhadainian/.nvm/versions/node/v24.11.0/bin/pi.js",
		"/home/zhadainian/.nvm/versions/node/v24.11.0/bin/pi.mjs",
		"/home/zhadainian/.nvm/versions/node/v24.11.0/bin/pi.cjs",
		"/usr/local/bin/pi",
		"/usr/local/bin/pi.js",
		"/usr/local/bin/pi.mjs",
		"/usr/local/bin/pi.cjs",
		"/usr/bin/pi",
		"/usr/bin/pi.js",
		"/usr/bin/pi.mjs",
		"/usr/bin/pi.cjs",
	]);
	// 去重：同一目录出现两次只给一遍候选。
	assert.deepEqual(plain(listPiCandidatesFromPath("/usr/bin:/usr/bin")), ["/usr/bin/pi", "/usr/bin/pi.js", "/usr/bin/pi.mjs", "/usr/bin/pi.cjs"]);
	// 只取绝对目录：相对条目、空条目、尾斜杠、含 . / .. 的条目一律丢弃（与 node 侧同款判据）。
	assert.deepEqual(plain(listPiCandidatesFromPath("bin:.:..:/usr/bin/:~/.nvm")), []);
	assert.deepEqual(plain(listPiCandidatesFromPath("/a/../b:/usr/bin")), ["/usr/bin/pi", "/usr/bin/pi.js", "/usr/bin/pi.mjs", "/usr/bin/pi.cjs"]);
});

test("a malformed or oversized PATH yields no candidates instead of throwing", () => {
	assert.deepEqual(plain(listPiCandidatesFromPath("")), []);
	assert.deepEqual(plain(listPiCandidatesFromPath(null)), []);
	assert.deepEqual(plain(listPiCandidatesFromPath(123)), []);
	assert.deepEqual(plain(listPiCandidatesFromPath(undefined)), []);
	// 超长 PATH 视为畸形：不做解析（与 RemoteNodeDiscovery 的 32 KiB 上限同值）。
	assert.deepEqual(plain(listPiCandidatesFromPath(`/${"a".repeat(33_000)}`)), []);
	assert.deepEqual(plain(listPiCandidatesFromPath("/usr/bin:".repeat(4000))), [], "a PATH over the cap is malformed, not truncated");
	// 上限之内照常解析（去重后仍只有一个目录的候选）。
	assert.deepEqual(plain(listPiCandidatesFromPath("/usr/bin:".repeat(1000))), ["/usr/bin/pi", "/usr/bin/pi.js", "/usr/bin/pi.mjs", "/usr/bin/pi.cjs"]);
});

test("the version command runs the resolved node as interpreter and quotes both paths", () => {
	// 形态：'<node>' '<pi>' '--version'——唯一在真机上能读出版本的形状（裸执行 shim 会落到 Node 12）。
	assert.equal(buildRemotePiVersionCommand("/usr/local/bin/pi", NODE_PATH), `'${NODE_PATH}' '/usr/local/bin/pi' '--version'`);
	assert.equal(buildRemotePiVersionCommand("/x/pi", "/usr/bin/node"), "'/usr/bin/node' '/x/pi' '--version'");
	// 两个路径都要能承载空格/单引号/美元符号：`'\''`（收引号、转义引号、重开引号）是唯一转义形态，
	// 且命令里不得出现未经引用的原始串。
	const weirdPi = "/home/o'brien/bin dir/$PATH/pi";
	const weirdNode = "/opt/nvm versions/v'24/bin/$NODE/node";
	const command = buildRemotePiVersionCommand(weirdPi, weirdNode);
	assert.equal(command, `'/opt/nvm versions/v'\\''24/bin/$NODE/node' '/home/o'\\''brien/bin dir/$PATH/pi' '--version'`);
	assert.ok(!command.includes(weirdPi) && !command.includes(weirdNode), "raw paths must never appear unescaped in the command");
	// 反引号与分号同样只是字面量：引号包里没有裸引号，也没有引号外的尾巴。
	assert.match(buildRemotePiVersionCommand("/opt/`whoami`;rm -rf/pi", NODE_PATH), /^'[^']*' '[^']*' '--version'$/, "metacharacters must sit inside the quotes, with no unquoted tail");
	// 任一非法路径都抛既有 REMOTE_PI_PATH_INVALID，不能进入命令（pi 与 node 两个位置都查）。
	// 注：pi 路径**不**要求末段是候选名——候选名只约束按 PATH 自动发现（见 listPiCandidatesFromPath），
	// 用户手填的路径（主机档案的 remotePiCommand）可以是任意可执行名。
	const badPiPaths = ["", "pi", "bin/pi", "/usr/../bin/pi", "/usr//pi", "/usr/bin/pi/", "/usr/bin/pi\n", "/usr/bin/pi; rm -rf /", `/usr/bin/${"p".repeat(4090)}/pi`, null, 42];
	const badNodePaths = ["", "node", "bin/node", "/usr/../bin/node", "/usr//node", "/usr/bin/node/", "/usr/bin/node\n", "/usr/bin/node; rm -rf /", null, 42];
	for (const bad of badPiPaths) assert.throws(() => buildRemotePiVersionCommand(bad, NODE_PATH), /REMOTE_PI_PATH_INVALID/, `must reject pi path ${String(bad)}`);
	for (const bad of badNodePaths) assert.throws(() => buildRemotePiVersionCommand("/usr/local/bin/pi", bad), /REMOTE_PI_PATH_INVALID/, `must reject node path ${String(bad)}`);
});

test("the built command really splits into exactly three arguments on a POSIX shell", (t) => {
	// 行为验证（非文本扫描）：`set --` 只做词切分、不执行任何进程，因此可以证明
	// 「含空格/单引号/$ 的路径各是一个参数」而不是被 shell 拆成多个词。
	if (process.platform === "win32") return t.skip("POSIX shell required");
	const weirdPi = "/home/o'brien/bin dir/$PATH/pi";
	const weirdNode = "/opt/nvm versions/v'24/bin/$NODE/node";
	const command = buildRemotePiVersionCommand(weirdPi, weirdNode);
	const stdout = execFileSync("/bin/sh", ["-c", `set -- ${command}; printf '%s\\n%s\\n%s\\n%s' "$#" "$1" "$2" "$3"`], { encoding: "utf8", timeout: 10_000 });
	assert.equal(stdout, `3\n${weirdNode}\n${weirdPi}\n--version`, "both paths must survive as one literal argument each, unexpanded");
});

test("only a bare semver (optionally v-prefixed, trailing whitespace allowed) parses", () => {
	assert.deepEqual({ ...parsePiVersionOutput("0.85.1") }, { major: 0, minor: 85, patch: 1 });
	assert.deepEqual({ ...parsePiVersionOutput("v1.0.4") }, { major: 1, minor: 0, patch: 4 });
	assert.deepEqual({ ...parsePiVersionOutput("0.85.1\n") }, { major: 0, minor: 85, patch: 1 });
	assert.deepEqual({ ...parsePiVersionOutput("0.85.1 \r\n") }, { major: 0, minor: 85, patch: 1 });
	assert.deepEqual({ ...parsePiVersionOutput("v0.85.0") }, { major: 0, minor: 85, patch: 0 });
	// 其余一切返回 null（调用方语义是「这个候选不可用，试下一个」，不是失败关闭）。
	for (const bad of ["", "\n", "garbage", "pi 0.85.1", "1.0", "1.0.4.5", "0.85.1 extra", "0.85.1\nmore", "  0.85.1", "00.85.1", "v", "0.85", "-1.0.4", `0.85.1${" ".repeat(80)}`]) {
		assert.equal(parsePiVersionOutput(bad), null, `must reject ${JSON.stringify(bad)}`);
	}
	assert.equal(parsePiVersionOutput(undefined), null);
	assert.equal(parsePiVersionOutput(null), null);
	assert.equal(parsePiVersionOutput(851), null);
	assert.equal(parsePiVersionOutput({ version: "0.85.1" }), null);
});

test("version comparison is numeric, so 0.9.0 is older than 0.85.1", () => {
	assert.equal(comparePiVersions({ major: 0, minor: 85, patch: 1 }, { major: 0, minor: 85, patch: 1 }), 0);
	assert.equal(comparePiVersions({ major: 0, minor: 85, patch: 0 }, { major: 0, minor: 85, patch: 1 }), -1);
	assert.equal(comparePiVersions({ major: 0, minor: 85, patch: 2 }, { major: 0, minor: 85, patch: 1 }), 1);
	// 字符串比较会把这个答案翻成 +1（`"0.9.0" > "0.85.1"`）：这条断言就是「不得用字符串比较」的守卫。
	assert.equal(comparePiVersions({ major: 0, minor: 9, patch: 0 }, { major: 0, minor: 85, patch: 1 }), -1);
	assert.equal(comparePiVersions({ major: 1, minor: 0, patch: 4 }, { major: 0, minor: 85, patch: 999 }), 1);
	assert.equal(comparePiVersions({ major: 0, minor: 84, patch: 9 }, { major: 0, minor: 85, patch: 0 }), -1);
});

test("the compatibility matrix cuts on full semver below and on major.minor above", () => {
	assert.equal(classifyRemotePiVersion({ major: 0, minor: 84, patch: 9 }), "below-minimum");
	assert.equal(classifyRemotePiVersion({ major: 0, minor: 85, patch: 0 }), "supported");
	assert.equal(classifyRemotePiVersion({ major: 0, minor: 85, patch: 1 }), "supported");
	// 上限只看 major.minor：0.85 的任意补丁版都在同一个已核验窗口里。
	assert.equal(classifyRemotePiVersion({ major: 0, minor: 85, patch: 999 }), "supported");
	assert.equal(classifyRemotePiVersion({ major: 0, minor: 86, patch: 0 }), "above-verified");
	assert.equal(classifyRemotePiVersion({ major: 0, minor: 90, patch: 0 }), "above-verified");
	assert.equal(classifyRemotePiVersion({ major: 1, minor: 0, patch: 4 }), "above-verified");
});

/**
 * 探测流程：用假 client + 假 invocation 结果跑 `resolveRemotePiExecutable`，不联网、不碰真机。
 * 假 client 按远端命令分派：哨兵命令回脚本化 PATH，版本命令回脚本化版本输出，同时记录每一帧，
 * 以便断言「发了什么、发了几次、用的是哪个解释器」。
 */
function loadWithRemote(remotePath, versions, options = {}) {
	const probed = [];
	const { resolveRemotePiExecutable } = loadTsCommonJs(MODULE, {
		stubs: {
			"./SshVerifiedConnection": {
				async buildPinnedSshInvocation(_directory, hostId, kind, opts) {
					assert.equal(hostId, HOST_ID);
					assert.equal(kind, "ssh-batch");
					const remoteCommand = opts.remoteCommand;
					return { ...SSH, args: remoteCommand === undefined ? SSH.args : [...SSH.args, remoteCommand] };
				},
			},
		},
	});
	const client = {
		sshPath: SSH.executable,
		scpPath: "/usr/bin/scp",
		env: SSH.env,
		async run(_executable, args) {
			const command = remoteCommandOf(args);
			// 登录 shell PATH 探测：以哨兵命令区分，返回脚本化的 PATH（可注入噪声/坏输出）。
			if (command.includes("PIDECK_PATH_BEGIN_")) {
				probed.push({ kind: "path" });
				if (options.pathThrows) throw new Error("SSH_HOST_COMMAND_TIMEOUT");
				if (options.pathExitCode !== undefined && options.pathExitCode !== 0) return { exitCode: options.pathExitCode, stdout: options.pathStdout ?? "" };
				const body = typeof options.pathStdout === "string" ? options.pathStdout : pathAnswer(remotePath);
				return { exitCode: 0, stdout: options.noise ? `${options.noise}\n${body}\n${options.noise}\n` : body };
			}
			// 版本探测：命令必须正好是 `'<node>' '<pi>' '--version'`（逐 token 单引号引用）。
			const frame = /^'([^']*)' '([^']*)' '--version'$/.exec(command);
			assert.ok(frame, `version commands must come from buildRemotePiVersionCommand: ${command}`);
			const candidate = frame[2];
			probed.push({ kind: "version", candidate, node: frame[1], command });
			if (options.versionThrows && options.versionThrows.includes(candidate)) throw new Error("SSH_HOST_COMMAND_TIMEOUT");
			const mapped = versions[candidate];
			if (mapped === undefined) return { exitCode: 127, stdout: "" };
			if (typeof mapped === "object") return mapped;
			return { exitCode: 0, stdout: mapped };
		},
	};
	return { resolveRemotePiExecutable, client, probed };
}

const run = (remotePath, versions, options = {}) => {
	const { resolveRemotePiExecutable, client, probed } = loadWithRemote(remotePath, versions, options);
	return { promise: resolveRemotePiExecutable({ userDataDir: "/ignored", hostId: HOST_ID, client, sentinel: SENTINEL, nodePath: options.nodePath ?? NODE_PATH }), probed };
};

const versionProbes = (probed) => probed.filter((entry) => entry.kind === "version");

test("the real host shape resolves: nvm pi 0.85.1 through the nvm node, one probe", async () => {
	// `serve` 复现：答案是 nvm bin 里的 pi，解释器是同一个 bin 目录里的 node。
	const loginPath = "/home/zhadainian/.nvm/versions/node/v24.11.0/bin:/usr/local/bin:/usr/bin:/bin";
	const { promise, probed } = run(loginPath, { "/home/zhadainian/.nvm/versions/node/v24.11.0/bin/pi": "0.85.1\n" });
	const observation = await promise;
	assert.equal(observation.piPath, "/home/zhadainian/.nvm/versions/node/v24.11.0/bin/pi");
	assert.equal(observation.version, "0.85.1");
	assert.deepEqual({ ...observation.versionParsed }, { major: 0, minor: 85, patch: 1 });
	assert.equal(observation.probed, 1, "the first candidate must succeed, so no further probe is spent");
	assert.equal(observation.warning, undefined, "a version inside the verified window carries no warning");
	assert.equal(classifyRemotePiVersion(observation.versionParsed), "supported");
	// 只发了两次帧：一次 PATH、一次版本；没有多余探测。
	assert.deepEqual(
		probed.map((entry) => entry.kind),
		["path", "version"],
	);
	assert.equal(versionProbes(probed)[0].node, NODE_PATH, "the resolved node must be the interpreter");
});

test("every version frame runs pi through the passed node interpreter", async () => {
	// 探测链的每个候选都必须复用同一个解释器：混用等于「探测用这个 node、启动用那个 node」。
	const { promise, probed } = run("/opt/a/bin", { "/opt/a/bin/pi": "pi 0.85.1\n", "/opt/a/bin/pi.js": "0.85.1\n" });
	const observation = await promise;
	assert.equal(observation.piPath, "/opt/a/bin/pi.js");
	const frames = versionProbes(probed);
	assert.equal(frames.length, 2);
	assert.ok(
		frames.every((entry) => entry.node === NODE_PATH),
		"every probe must use the same interpreter",
	);
	assert.ok(
		frames.every((entry) => entry.command === buildRemotePiVersionCommand(entry.candidate, NODE_PATH)),
		"the wire command must be the pure function's output, byte for byte",
	);
});

test("an invalid node interpreter is rejected before any remote frame", async () => {
	for (const bad of ["", "node", "bin/node", "   ", "/usr/../bin/node", "/usr//node", "/usr/bin/node/", "/usr/bin/node\n", null, 42]) {
		const { resolveRemotePiExecutable, client, probed } = loadWithRemote("/usr/bin", { "/usr/bin/pi": "0.85.1\n" });
		await assert.rejects(resolveRemotePiExecutable({ userDataDir: "/ignored", hostId: HOST_ID, client, sentinel: SENTINEL, nodePath: bad }), (error) => {
			assert.equal(error.message, "REMOTE_PI_NODE_PATH_INVALID", "the code must be the whole message");
			return true;
		});
		assert.equal(probed.length, 0, `no frame may be sent for nodePath ${String(bad)}`);
	}
});

test("shell init noise cannot smuggle a decoy PATH in", async () => {
	const { promise } = run("/usr/bin", { "/usr/bin/pi": "0.85.1\n" }, { noise: "export PATH=/decoy/bin:$PATH" });
	const observation = await promise;
	assert.equal(observation.piPath, "/usr/bin/pi");
});

test("an unreadable sentinel fails closed with the pi-prefixed code", async () => {
	// 哨兵缺失时不得退回非交互 PATH（那正是「探不到 pi」的那条路），也不得报成 node 的问题。
	const missing = run("/usr/bin", {}, { pathStdout: "no sentinel here" });
	await assert.rejects(missing.promise, (error) => {
		assert.equal(error.message, "REMOTE_PI_SHELL_PATH_UNREADABLE", "the code must be the whole message");
		return true;
	});
	assert.equal(versionProbes(missing.probed).length, 0, "no version frame may be sent without a trusted PATH");
	// 传输层失败与非 0 退出同属「拿不到可信 PATH」。
	const thrown = run("/usr/bin", {}, { pathThrows: true });
	await assert.rejects(thrown.promise, /REMOTE_PI_SHELL_PATH_UNREADABLE/);
	const failed = run("/usr/bin", {}, { pathExitCode: 1 });
	await assert.rejects(failed.promise, /REMOTE_PI_SHELL_PATH_UNREADABLE/);
});

test("a PATH with no absolute entry is reported as not found, not as unreadable", async () => {
	const { promise, probed } = run("bin:.:..:relative/bin", {});
	await assert.rejects(promise, /REMOTE_PI_NOT_FOUND/);
	assert.equal(versionProbes(probed).length, 0, "no candidate means no probe");
});

test("an unusable candidate is skipped and the next install shape is used", async () => {
	// 同一目录里的 `pi` 跑不起来（exit 127），同目录的 `pi.js` 才是可用安装（#169 的形态）。
	const { promise, probed } = run("/opt/a/bin", { "/opt/a/bin/pi.js": "0.85.1\n" });
	const observation = await promise;
	assert.equal(observation.piPath, "/opt/a/bin/pi.js");
	assert.equal(observation.probed, 2);
	assert.deepEqual(
		versionProbes(probed).map((entry) => entry.candidate),
		["/opt/a/bin/pi", "/opt/a/bin/pi.js"],
		"probing must stop at the first accepted candidate",
	);
	// 候选连执行都失败（client.run 抛错）时同样只能 continue，不能把整次探测判死。
	const thrown = run("/opt/a/bin", { "/opt/a/bin/pi.js": "0.85.1\n" }, { versionThrows: ["/opt/a/bin/pi"] });
	const byThrow = await thrown.promise;
	assert.equal(byThrow.piPath, "/opt/a/bin/pi.js");
	assert.equal(byThrow.probed, 2);
});

test("an unparseable first candidate is skipped rather than failing the whole probe", async () => {
	const { promise, probed } = run("/opt/a/bin", { "/opt/a/bin/pi": "pi 0.85.1\n", "/opt/a/bin/pi.js": "0.85.1\n" });
	const observation = await promise;
	assert.equal(observation.piPath, "/opt/a/bin/pi.js");
	assert.equal(observation.probed, 2);
	assert.equal(versionProbes(probed).length, 2);
});

test("a readable but too-old pi fails closed with REMOTE_PI_TOO_OLD and upgrade detail", async () => {
	// 0.84.9 是「能读出版本、但低于下限」：必须拒绝，且细节挂在 error 属性上而不是消息里。
	const { promise, probed } = run("/usr/bin", { "/usr/bin/pi": "0.84.9\n" });
	await assert.rejects(promise, (error) => {
		assert.equal(error.message, "REMOTE_PI_TOO_OLD", "the code must be the whole message");
		assert.equal(error.piPath, "/usr/bin/pi");
		assert.equal(error.observedVersion, "0.84.9");
		assert.equal(error.probed, 1);
		return true;
	});
	assert.equal(versionProbes(probed).length, 1, "a definitive 'too old' verdict must not keep walking the PATH");
});

test("a version above the verified window is admitted, with a warning instead of a refusal", async () => {
	// 远端 pi 是用户自己的软件：1.0.4（本机就是这个版本）比核验窗口新是最常见情况，不能 fail-closed。
	const above = run("/usr/bin", { "/usr/bin/pi": "1.0.4\n" });
	const observation = await above.promise;
	assert.equal(observation.piPath, "/usr/bin/pi");
	assert.equal(observation.version, "1.0.4");
	assert.deepEqual({ ...observation.versionParsed }, { major: 1, minor: 0, patch: 4 });
	assert.equal(observation.warning, "REMOTE_PI_VERSION_UNVERIFIED");
	assert.equal(observation.probed, 1);
	// 0.86.0 同理（次版本刚越过窗口）。
	const next = run("/usr/bin", { "/usr/bin/pi": "v0.86.0\n" });
	assert.equal((await next.promise).warning, "REMOTE_PI_VERSION_UNVERIFIED");
});

test("every candidate failing reports the version as unreadable, with the probe count attached", async () => {
	// 一个目录给 4 个候选名，上限 3——所以这里正好把 3 次探测用完（且各自失败方式不同）。
	const { promise, probed } = run("/a/bin", { "/a/bin/pi": "garbage", "/a/bin/pi.js": "1.0", "/a/bin/pi.mjs": { exitCode: 1, stdout: "" } });
	await assert.rejects(promise, (error) => {
		assert.equal(error.message, "REMOTE_PI_VERSION_UNREADABLE", "the code must be the whole message");
		assert.equal(error.probed, 3, "the probe count rides on the error, not in its message");
		assert.equal(error.observedVersion, "1.0");
		return true;
	});
	assert.equal(versionProbes(probed).length, 3);
});

test("the candidate walk is capped, so a hostile PATH cannot drive unlimited probes", async () => {
	// 上限 3：第 5 个候选（下一个 PATH 目录里的 `pi`）一个帧都不许发，即使它本来会成功。
	const remotePath = "/a/bin:/d/bin";
	const { promise, probed } = run(remotePath, { "/a/bin/pi": "1.0", "/a/bin/pi.js": "1.0", "/a/bin/pi.mjs": "1.0", "/d/bin/pi": "0.85.1\n" });
	await assert.rejects(promise, /REMOTE_PI_VERSION_UNREADABLE/);
	assert.equal(versionProbes(probed).length, 3, "at most MAX_PI_CANDIDATES candidates may be probed");
	assert.ok(
		versionProbes(probed).every((entry) => !entry.candidate.startsWith("/d/")),
		"the cap must hold even when a later candidate would have succeeded",
	);
});

test("an empty login-shell PATH reports the pi-prefixed code, not the node one", async () => {
	// P1-1 回归：空 PATH 与哨兵缺失是两个不同的失败，但都必须以 REMOTE_PI_ 前缀的码对外报告 ——
	// 报成 node 的码会让「这台机器读不到可信 PATH」被归到错的域（升级/诊断指引都会指错地方）。
	const { promise, probed } = run("", {});
	await assert.rejects(promise, (error) => {
		assert.equal(error.message, "REMOTE_PI_SHELL_PATH_UNREADABLE");
		return true;
	});
	assert.equal(versionProbes(probed).length, 0, "no version frame may be sent for an empty PATH");
});

test("a duplicated sentinel is a failed read, not a PATH to parse", async () => {
	// 重复哨兵 = 输出不可信（例如被回显两次）：与哨兵缺失同码，不得从中拼出一个 PATH 来用。
	const duplicated = `${pathAnswer("/usr/bin")}\n${pathAnswer("/usr/bin")}`;
	const { promise, probed } = run("/usr/bin", {}, { pathStdout: duplicated });
	await assert.rejects(promise, /REMOTE_PI_SHELL_PATH_UNREADABLE/);
	assert.equal(versionProbes(probed).length, 0);
});

test("every candidate exiting non-zero reports the version as unprobed", async () => {
	// 候选都存在但都跑不起来（exit≠0）：没有任何自述版本可回显，observedVersion 必须是 unprobed。
	const { promise, probed } = run("/a/bin", {});
	await assert.rejects(promise, (error) => {
		assert.equal(error.message, "REMOTE_PI_VERSION_UNREADABLE");
		assert.equal(error.probed, 3);
		assert.equal(error.observedVersion, "unprobed");
		return true;
	});
	assert.equal(versionProbes(probed).length, 3);
});

test("a version command longer than the ssh remote-command frame is refused at construction", async () => {
	// 两段路径各自的 4096 上限之和不加约束会超过 pinned ssh 的 8192 帧上限 —— 那在真实装配里会变成
	// 另一个域的 SSH_REMOTE_COMMAND_INVALID，归因就跑偏了；所以构造点用本模块自己的码拒。
	const node = `/${"n".repeat(4090)}/node`;
	const pi = `/${"p".repeat(4090)}/pi`;
	assert.ok(node.length <= 4096 && pi.length <= 4096, "both paths stay inside the per-path cap");
	assert.throws(() => buildRemotePiVersionCommand(pi, node), /REMOTE_PI_PATH_INVALID/);
	// 同样的两段路径但短到帧内：必须能构造（否则上面那条只是「总是拒绝」）。
	assert.ok(buildRemotePiVersionCommand("/usr/bin/pi", NODE_PATH).length < 8192);
});

/**
 * 用户手填的 pi 路径（主机档案的 `remotePiCommand`）：给了一个就不扫登录 shell 的 PATH，
 * 只对这条路径跑同一条版本命令、走同一道版本门。手填是用户对「我的 pi 装在哪」的明确声明，
 * 重新扫 PATH 只会拿别人目录里的 pi 去掩盖它。
 */
test("an explicit pi path skips the PATH scan and only runs the version gate", async () => {
	const explicit = "/home/me/bin/pi-coding-agent";
	const { resolveRemotePiExecutable, client, probed } = loadWithRemote("/usr/bin", { [explicit]: "0.85.1\n" });
	const observation = await resolveRemotePiExecutable({ userDataDir: "/ignored", hostId: HOST_ID, client, sentinel: SENTINEL, nodePath: NODE_PATH, piPath: explicit });
	assert.equal(observation.piPath, explicit);
	assert.equal(observation.version, "0.85.1");
	assert.equal(observation.probed, 1);
	assert.deepEqual(
		probed.map((entry) => entry.kind),
		["version"],
		"no login-shell PATH frame is spent when the path is explicit",
	);
	assert.equal(versionProbes(probed)[0].node, NODE_PATH, "the explicit path still runs through the resolved node");
});

test("an explicit pi path that fails its version check reports the code instead of scanning PATH", async () => {
	const explicit = "/home/me/bin/pi";
	const missing = loadWithRemote("/usr/bin", { "/usr/bin/pi": "0.85.1\n" });
	await assert.rejects(missing.resolveRemotePiExecutable({ userDataDir: "/ignored", hostId: HOST_ID, client: missing.client, sentinel: SENTINEL, nodePath: NODE_PATH, piPath: explicit }), /REMOTE_PI_VERSION_UNREADABLE/);
	assert.deepEqual(
		missing.probed.map((entry) => entry.kind),
		["version"],
		"a broken explicit path must not fall back to PATH discovery",
	);

	// 可读但低于下限：明确结论（该升级），不是「换个候选再试」。
	const tooOld = loadWithRemote("/usr/bin", { [explicit]: "0.84.9\n" });
	await assert.rejects(tooOld.resolveRemotePiExecutable({ userDataDir: "/ignored", hostId: HOST_ID, client: tooOld.client, sentinel: SENTINEL, nodePath: NODE_PATH, piPath: explicit }), /REMOTE_PI_TOO_OLD/);
	assert.equal(versionProbes(tooOld.probed).length, 1);
});

test("an invalid explicit pi path never reaches the wire", async () => {
	for (const bad of ["", "pi", "bin/pi", "/usr/../bin/pi", "/usr//pi", "/usr/bin/pi/", "/usr/bin/pi\n", "/usr/bin/pi; rm -rf /", null, 42]) {
		const { resolveRemotePiExecutable, client, probed } = loadWithRemote("/usr/bin", {});
		await assert.rejects(resolveRemotePiExecutable({ userDataDir: "/ignored", hostId: HOST_ID, client, sentinel: SENTINEL, nodePath: NODE_PATH, piPath: bad }), /REMOTE_PI_PATH_INVALID/, `must reject ${String(bad)}`);
		assert.equal(probed.length, 0, "no frame may be sent for a path that cannot be quoted");
	}
});

test("the persisted pi path is limited to the host-profile token charset", () => {
	// 手填路径会写进主机档案，而档案 codec 对 remotePiCommand 用的是 `[A-Za-z0-9._/-]` 规则；
	// 放宽这里等于写出一份「本机能存、下次读不出来」的档案（读取校验整份快照）。
	assert.equal(normalizeRemotePiPath("/home/me/.nvm/versions/node/v22.11.0/bin/pi"), "/home/me/.nvm/versions/node/v22.11.0/bin/pi");
	for (const bad of ["/home/me/bin dir/pi", "/home/用户/bin/pi", "~/bin/pi", "pi", "/usr/bin/pi~", "/usr/bin/pi\n", "", null, 42]) {
		assert.throws(() => normalizeRemotePiPath(bad), /REMOTE_PI_PATH_INVALID/, `must reject ${String(bad)}`);
	}
});
