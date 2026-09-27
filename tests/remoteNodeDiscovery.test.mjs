import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端 node 定位：登录 shell PATH 解析。
 *
 * 背景：非交互式 SSH 不加载用户 shell 初始化，nvm 因此不可见——`serve` 实测登录后
 * 是 v24.11.0、非交互是 /usr/bin/node v12.22.9。冻结入口的 `require("node:fs")`
 * 需要 Node ≥14.18，旧 node 死在首条语句（try 之外）→ 零帧退出。
 *
 * 这些用例锁定「按登录 shell 语义取 PATH」以及「shell 噪声不得被当成答案」。
 */

const { extractSentinelValue, buildLoginShellPathCommand, listNodeCandidatesFromPath, parseLoginShellPath, createPathSentinel } = loadTsCommonJs("src/main/remote/RemoteNodeDiscovery.ts");

/** 跨沙箱返回的数组原型与测试 realm 不同，深比较前先归一为普通数组。 */
const plain = (value) => Array.from(value);

const SENTINEL = "a1b2c3d4e5f6a7b8";
const wrap = (value) => `PIDECK_PATH_BEGIN_${SENTINEL}${value}_PIDECK_PATH_END`;

test("a clean shell answer yields exactly the PATH", () => {
	assert.equal(extractSentinelValue(wrap("/usr/bin:/bin"), SENTINEL), "/usr/bin:/bin");
	assert.equal(parseLoginShellPath(wrap("/usr/bin:/bin"), SENTINEL), "/usr/bin:/bin");
});

test("shell init noise around the answer is discarded, not concatenated", () => {
	// 这是本地实现（String(stdout).trim()）容忍不了、而远端必须处理的形态：
	// ~/.bashrc 里的欢迎语/conda 提示会混进 stdout。若用 trim() 拼接，PATH 会变成
	// "Welcome!\n/usr/bin:/bin"，后续按 ":" 切分得到的首项就不是绝对目录。
	const noisy = ["Welcome to Ubuntu 22.04!", "", wrap("/usr/bin:/bin"), "", "conda: base activated"].join("\n");
	assert.equal(parseLoginShellPath(noisy, SENTINEL), "/usr/bin:/bin");

	// 噪声里即使含有疑似路径也不得被采纳：只有哨兵之间的内容算数。
	const decoy = `export PATH=${wrap("/real/bin")}/decoy/bin\n`;
	assert.equal(parseLoginShellPath(decoy, SENTINEL), "/real/bin");
});

test("a missing, duplicated or truncated sentinel fails closed instead of guessing", () => {
	// 拿不到可信 PATH 时必须失败关闭：退回非交互 PATH 等于放行旧 node。
	assert.equal(extractSentinelValue("/usr/bin:/bin", SENTINEL), null);
	assert.equal(extractSentinelValue(`${wrap("/a")}${wrap("/b")}`, SENTINEL), null);
	assert.equal(extractSentinelValue(`PIDECK_PATH_BEGIN_${SENTINEL}/a`, SENTINEL), null);
	assert.equal(extractSentinelValue("", SENTINEL), null);
	assert.equal(extractSentinelValue(undefined, SENTINEL), null);
	assert.equal(extractSentinelValue(42, SENTINEL), null);
	// 另一个哨兵的值不能被当成这次的结果。
	assert.equal(extractSentinelValue(wrap("/a").replace(SENTINEL, "ffffffffffffffff"), SENTINEL), null);
	assert.throws(() => parseLoginShellPath("/usr/bin:/bin", SENTINEL), /REMOTE_NODE_SHELL_PATH_UNREADABLE/);
	assert.throws(() => parseLoginShellPath(wrap(""), SENTINEL), /REMOTE_NODE_SHELL_PATH_EMPTY/);
	assert.throws(() => parseLoginShellPath(wrap("   "), SENTINEL), /REMOTE_NODE_SHELL_PATH_EMPTY/);
});

test("only absolute directory entries become node candidates", () => {
	// 形状必须满足引导契约的 requireNodeExecutable：绝对、无 . / ..、以 /node 结尾。
	assert.deepEqual(plain(listNodeCandidatesFromPath("/usr/local/bin:/usr/bin:/bin")), ["/usr/local/bin/node", "/usr/bin/node", "/bin/node"]);
	// 相对条目、空条目、含 . / .. 的条目、尾斜杠一律丢弃。
	assert.deepEqual(plain(listNodeCandidatesFromPath("bin:.:..:/usr/bin/:~/.nvm")), []);
	assert.deepEqual(plain(listNodeCandidatesFromPath("/a/../b:/usr/bin")), ["/usr/bin/node"]);
	// 非字符串/空输入不抛异常，只给空候选。
	assert.deepEqual(plain(listNodeCandidatesFromPath("")), []);
	assert.deepEqual(plain(listNodeCandidatesFromPath(null)), []);
	assert.deepEqual(plain(listNodeCandidatesFromPath(123)), []);
	// 去重：同一目录出现两次只给一个候选。
	assert.deepEqual(plain(listNodeCandidatesFromPath("/usr/bin:/usr/bin")), ["/usr/bin/node"]);
});

test("the nvm layout is recognised, because that is the real acceptance case", () => {
	// `serve` 登录后 nvm 的 PATH 前缀（顺序即优先级）。候选必须包含 nvm 的 node，
	// 否则方案 A 在真实机器上不成立。
	const loginPath = "/home/zhadainian/.nvm/versions/node/v24.11.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
	const candidates = plain(listNodeCandidatesFromPath(loginPath));
	assert.equal(candidates[0], "/home/zhadainian/.nvm/versions/node/v24.11.0/bin/node");
	// 系统那个旧 node 仍在候选里，但排在后面——由调用方按顺序探测版本后择优。
	assert.ok(candidates.includes("/usr/bin/node"));
	assert.ok(candidates.indexOf(candidates[0]) < candidates.indexOf("/usr/bin/node"), "the nvm node must outrank the system one");
});

test("the sentinel command is fixed apart from the validated sentinel, and is POSIX-quoted", () => {
	const command = buildLoginShellPathCommand(SENTINEL);
	// 只读 PATH：不执行用户命令，因此远端 shell 没有执行任意内容的余地。
	assert.match(command, /\/bin\/sh -lc/);
	assert.match(command, /printf %s "\$PATH"/);
	// 整段命令由单引号包夹，哨兵在双引号内展开——命令里没有用户可控文本。
	assert.ok(command.startsWith("/bin/sh -lc '"), "the -lc payload must be single-quoted as one word");
	assert.ok(command.endsWith("'"));
	// 非法哨兵必须被拒绝，不能进入命令。
	for (const bad of ["", "short", "has space", "has'quote", "has;semi", "../etc", "a".repeat(65)]) {
		assert.throws(() => buildLoginShellPathCommand(bad), /REMOTE_NODE_SENTINEL_INVALID/);
	}
	// createPathSentinel 只接受合法随机串，且不会把非法值放行。
	assert.equal(
		createPathSentinel(() => "0123456789abcdef"),
		"0123456789abcdef",
	);
	assert.throws(() => createPathSentinel(() => "bad!"), /REMOTE_NODE_SENTINEL_INVALID/);
});

test("the command actually reads the login shell PATH on a real POSIX shell", (t) => {
	// 行为验证（非文本扫描）：在真实 /bin/sh 上跑一次，确认哨兵出现在输出里，
	// 且提取出的 PATH 与 shell 自己报告的一致。
	if (process.platform === "win32") return t.skip("POSIX shell required");
	const command = buildLoginShellPathCommand(SENTINEL);
	const stdout = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 10_000 });
	const parsed = parseLoginShellPath(stdout, SENTINEL);
	const expected = execFileSync("/bin/sh", ["-lc", 'printf %s "$PATH"'], { encoding: "utf8", timeout: 10_000 });
	assert.equal(parsed, expected, "the sentinel probe must report the same PATH the login shell does");
	// 真实 PATH 至少给出一个候选，且遵循 PATH 顺序。
	const candidates = plain(listNodeCandidatesFromPath(parsed));
	assert.equal(candidates.length, new Set(parsed.split(":").filter((entry) => entry.startsWith("/") && !entry.endsWith("/"))).size);
});
