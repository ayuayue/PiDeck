import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * resolveRemoteNodeExecutable：把「用户在登录 shell 里真正能用的 node」解析出来并做版本门禁。
 *
 * 这是方案 A 的第二步：第一步（RemoteNodeDiscovery）只做纯解析，这一步把它接进探针，
 * 让候选按 PATH 顺序逐个探测版本、取第一个满足 ≥22.3 的。
 *
 * 真实场景（`serve`）：登录后 nvm 给 v24.11.0，非交互是 /usr/bin/node v12.22.9。
 * 旧行为直接探非交互路径 → 冻 结入口在 require("node:fs") 首条语句即死（try 之外，零帧）。
 */

const SSH = { executable: "/usr/bin/ssh", args: ["-T", "-o", "BatchMode=yes", "--", "pideck-alias"], env: {}, openSshVersion: "OpenSSH_10.0p2" };
const SCP = { executable: "/usr/bin/scp", args: ["-q", "-B", "--", "pideck-alias"], env: {}, openSshVersion: "OpenSSH_10.0p2" };
const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SENTINEL = "a1b2c3d4e5f6a7b8";
/** 远端命令以最后一个 argv 元素下发；这里取出来做「脚本化远端」的分派依据。 */
const remoteCommandOf = (args) => String(args.at(-1));
const pathAnswer = (value) => `PIDECK_PATH_BEGIN_${SENTINEL}${value}_PIDECK_PATH_END`;

/** 用给定的 PATH 与「路径 → 版本输出」映射加载被测模块。 */
function loadWithRemote(remotePath, versions, options = {}) {
	const probed = [];
	const { resolveRemoteNodeExecutable } = loadTsCommonJs("src/main/remote/RemoteBootstrapSession.ts", {
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
		scpPath: SCP.executable,
		env: SSH.env,
		async run(_executable, args) {
			const command = remoteCommandOf(args);
			// 登录 shell PATH 探测：以哨兵命令区分，返回脚本化的 PATH（可注入噪声）。
			if (command.includes("PIDECK_PATH_BEGIN_")) {
				probed.push({ kind: "path" });
				if (options.pathExitCode !== undefined && options.pathExitCode !== 0) return { exitCode: options.pathExitCode, stdout: options.pathStdout ?? "" };
				const body = typeof options.pathStdout === "string" ? options.pathStdout : pathAnswer(remotePath);
				return { exitCode: 0, stdout: options.noise ? `${options.noise}\n${body}\n${options.noise}\n` : body };
			}
			// 版本探测：候选路径是逐 token POSIX 引用的 `'<path>' '--version'`。
			const candidate = command.slice(1, command.indexOf("'", 1));
			probed.push({ kind: "version", candidate });
			if (options.versionThrows && options.versionThrows.includes(candidate)) throw new Error("REMOTE_NODE_PROBE_FAILED");
			const mapped = versions[candidate];
			if (mapped === undefined) return { exitCode: 127, stdout: "" };
			if (typeof mapped === "object") return mapped;
			return { exitCode: 0, stdout: mapped };
		},
	};
	return { resolveRemoteNodeExecutable, client, probed };
}

const run = (remotePath, versions, options) => {
	const { resolveRemoteNodeExecutable, client, probed } = loadWithRemote(remotePath, versions, options);
	return { promise: resolveRemoteNodeExecutable({ userDataDir: "/ignored", hostId: HOST_ID, client, sentinel: SENTINEL }), probed };
};

test("the nvm node wins because it is first in the login shell PATH", async () => {
	// 真实 `serve` 的形态：nvm 的 bin 在 PATH 最前，系统 /usr/bin/node 是旧版。
	const loginPath = "/home/zhadainian/.nvm/versions/node/v24.11.0/bin:/usr/local/bin:/usr/bin:/bin";
	const { promise, probed } = run(loginPath, {
		"/home/zhadainian/.nvm/versions/node/v24.11.0/bin/node": "v24.11.0\n",
		"/usr/bin/node": "v12.22.9\n",
	});
	const resolved = await promise;
	assert.equal(resolved.nodePath, "/home/zhadainian/.nvm/versions/node/v24.11.0/bin/node");
	assert.equal(resolved.version, "v24.11.0");
	assert.equal(resolved.probed, 1, "the first candidate must succeed, so no further probe is spent");
	// 关键：绝不去探那个旧的系统 node。
	assert.deepEqual(
		probed.map((entry) => entry.kind),
		["path", "version"],
	);
});

test("an unusable first candidate is skipped and the next supported one is used", async () => {
	// PATH 前面有不合格/不可执行的 node 时，必须继续往后找，而不是直接失败。
	const loginPath = "/opt/old/bin:/usr/local/bin:/usr/bin";
	const { promise, probed } = run(loginPath, { "/opt/old/bin/node": "v12.22.9\n", "/usr/local/bin/node": "v22.3.0\n", "/usr/bin/node": "v20.0.0\n" }, { versionThrows: ["/opt/old/bin/node"] });
	const resolved = await promise;
	assert.equal(resolved.nodePath, "/usr/local/bin/node");
	assert.equal(resolved.probed, 2);
	assert.ok(
		probed.filter((entry) => entry.kind === "version").every((entry) => entry.candidate !== "/usr/bin/node"),
		"probing must stop at the first accepted candidate",
	);
});

test("the candidate walk is bounded, so a hostile PATH cannot drive unlimited probes", async () => {
	// 上限为 3：全部不合格时必须停止，并报告最后观察到的版本（可执行、不空洞）。
	const loginPath = "/a/bin:/b/bin:/c/bin:/d/bin:/e/bin:/f/bin";
	const { promise, probed } = run(loginPath, { "/a/bin/node": "v10.0.0\n", "/b/bin/node": "v11.0.0\n", "/c/bin/node": "v12.0.0\n", "/d/bin/node": "v24.0.0\n" });
	await assert.rejects(promise, (error) => {
		assert.match(error.message, /REMOTE_NODE_VERSION_UNSUPPORTED/);
		// 报出最后探到的版本，便于定位；不泄漏远端 stderr。
		assert.match(error.message, /v12\.0\.0/);
		return true;
	});
	assert.equal(probed.filter((entry) => entry.kind === "version").length, 3, "at most 3 candidates may be probed");
	// /d/bin/node 是合格的，但超出上限因此不该被探到——有界优先于「尽力找到」。
	assert.ok(
		probed.every((entry) => entry.candidate !== "/d/bin/node"),
		"the cap must hold even when a later candidate would have succeeded",
	);
});

test("shell init noise does not become the node path", async () => {
	// 横幅里的诱饵路径不得被采纳：只有哨兵之间的内容算数。
	const loginPath = "/usr/bin";
	const { promise } = run(loginPath, { "/usr/bin/node": "v22.5.0\n" }, { noise: "export PATH=/decoy/bin:$PATH" });
	const resolved = await promise;
	assert.equal(resolved.nodePath, "/usr/bin/node");
});

test("an unreadable shell PATH fails closed instead of falling back", async () => {
	// 哨兵缺失（例如 shell 初始化把输出吞了）时不得退回非交互 PATH——那正是旧 node 溜进来的路径。
	const { promise } = run("/usr/bin", {}, { pathStdout: "no sentinel here" });
	await assert.rejects(promise, /REMOTE_NODE_SHELL_PATH_UNREADABLE/);
});

test("a failed PATH probe is reported distinctly from an unsupported version", async () => {
	// 两种失败必须可区分：探不动（连接/shell 层）vs 探到了但版本不够。
	const failed = run("/usr/bin", {}, { pathExitCode: 1 });
	await assert.rejects(failed.promise, /REMOTE_NODE_SHELL_PROBE_FAILED/);
	// 空 PATH 由解析层以更精确的码报告（第一步已定义），不归入「找不到 node」。
	const emptyPath = run("", {}, {});
	await assert.rejects(emptyPath.promise, /REMOTE_NODE_SHELL_PATH_EMPTY/);
});

test("a PATH with no absolute entries is reported as not found, not as unsupported", async () => {
	const { promise, probed } = run("bin:.:..:relative/bin", {});
	await assert.rejects(promise, /REMOTE_NODE_NOT_FOUND/);
	assert.equal(probed.filter((entry) => entry.kind === "version").length, 0, "no candidate means no probe");
});

test("the resolved path satisfies the bootstrap contract's executable shape", async () => {
	// 解析结果会直接进 buildBootstrapCommand 的 nodeExecutable，因此形状必须满足
	// requireNodeExecutable（绝对、无 . / ..、以 /node 结尾）。
	const { promise } = run("/home/u/.nvm/versions/node/v24.11.0/bin", { "/home/u/.nvm/versions/node/v24.11.0/bin/node": "v24.11.0\n" });
	const resolved = await promise;
	const { buildBootstrapCommand } = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");
	assert.doesNotThrow(() => buildBootstrapCommand({ nodeExecutable: resolved.nodePath, protocolVersion: 1, bundleSha256: "a".repeat(64), nonce: "A1b2C3d4e5f6a7b8" }));
});
