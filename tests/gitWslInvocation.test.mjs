/**
 * WSL 内 git 执行适配层测试。
 *
 * 分两块：
 * 1) gitWsl.ts 纯规划（路由判定 / argv 改写 / env 转发 / 输出回译 / 解码）；
 * 2) gitRun.ts 两个入口的 spawn 形态（宿主分支仍走 execFile + 用户配置的 git；
 *    WSL 分支走 wsl.exe + sh 守卫，stdout 保留 NUL、stderr 按 UTF-16 特征解码）。
 *
 * 不依赖真实 wsl.exe / 真实发行版：路由判定与 argv 组装都在纯函数与 stub 上验证，
 * 真实发行版冒烟见 issue #295 的验证记录（本机 Debian 内装 git 后手工跑通）。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const WSL_EXE = "C:\\Windows\\System32\\wsl.exe";
const CUSTOM_GIT = "C:/tools/portable-git/cmd/git.exe";
const UNC_REPO = "\\\\wsl.localhost\\Debian\\home\\dev\\proj";
const UNC_FILE = "\\\\wsl.localhost\\Debian\\home\\dev\\proj\\src\\a.ts";

const gitWsl = loadTsCommonJs("src/main/git/gitWsl.ts");
// 真实 wslExe 只提供解码与发行版解析；getWslExe 换成固定路径，避免依赖宿主是否装了 WSL。
const realWslExe = loadTsCommonJs("src/main/wsl/wslExe.ts");

/** VM 模块产出的对象/数组跨 realm，deepStrictEqual 会因原型不同失败；统一转成同 realm 纯数据。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

// ── 执行入口：同一份 loader 内共享模块状态，测试用可变 handler 注入假进程 ──────
let execFileHandler = () => {
	throw new Error("execFile was not expected in this test");
};
let spawnHandler = () => {
	throw new Error("spawn was not expected in this test");
};

const { execGit, runGitCommand } = loadTsCommonJs("src/main/git/gitRun.ts", {
	stubs: {
		"node:child_process": {
			execFile: (command, args, options, callback) => execFileHandler(command, args, options, callback),
			spawn: (command, args, options) => spawnHandler(command, args, options),
		},
		// Key 与源级 specifier 逐字一致（gitRun/gitWsl 的本地 import 带 .ts 扩展名，
		// 与 Node type stripping 直跑 checkpointCore 的约定配套；见 gitRun.ts 顶部注释）。
		"./gitExecutable.ts": { currentGitExecutable: () => CUSTOM_GIT },
		"../wsl/wslExe.ts": { ...realWslExe, getWslExe: () => ({ command: WSL_EXE, shell: false }) },
	},
});

/** 假 execFile（promisify 语义：回调收 (err, { stdout, stderr })）。 */
function fakeExecFile(result) {
	const calls = [];
	const handler = (command, args, options, callback) => {
		calls.push({ command, args: plain(args), options: plain(options) });
		callback(null, result);
	};
	return { handler, calls };
}

/** 假 spawn：EventEmitter 子进程，按 nextTick 喂 stdout/stderr 后 close。 */
function fakeSpawn({ stdout = "", stderr = Buffer.alloc(0), code = 0 } = {}) {
	const calls = [];
	const stdinChunks = [];
	let stdinErrorListenerCount = 0;
	const handler = (command, args, options) => {
		calls.push({ command, args: plain(args), options: plain(options) });
		const child = new EventEmitter();
		child.pid = 4321;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = {
			write: (chunk) => stdinChunks.push(chunk),
			end: () => {},
			// 断管兜底守卫：生产代码必须在 write 前注册 stdin error 监听
			// （wsl.exe 提前退出时排队写报 EOF/EPIPE，无监听会炸主进程）。
			on: (name) => {
				if (name === "error") stdinErrorListenerCount += 1;
			},
		};
		process.nextTick(() => {
			if (stdout.length > 0) child.stdout.emit("data", Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
			if (stderr.length > 0) child.stderr.emit("data", stderr);
			child.emit("close", code);
		});
		return child;
	};
	return { handler, calls, stdinChunks, stdinErrorListenerCount: () => stdinErrorListenerCount };
}

/** 完整 expect argv：wsl.exe -d <distro> -e /bin/sh -c <守卫> pideck <cwd> /usr/bin/env [K=V…] git <args…> */
function expectedWslArgs(distro, linuxCwd, gitArgs, envArgs = []) {
	return ["-d", distro, "-e", "/bin/sh", "-c", gitWsl.WSL_GIT_CD_GUARD, "pideck", linuxCwd, "/usr/bin/env", ...envArgs, "git", ...gitArgs];
}

test("resolveWslGitTarget：只认 Windows 上的 WSL UNC 路径，盘符与 Linux 路径不路由", () => {
	assert.deepEqual(plain(gitWsl.resolveWslGitTarget(UNC_REPO, "win32")), { distro: "Debian", linuxCwd: "/home/dev/proj" });
	assert.deepEqual(plain(gitWsl.resolveWslGitTarget("\\\\wsl$\\Ubuntu\\mnt\\c\\proj", "win32")), { distro: "Ubuntu", linuxCwd: "/mnt/c/proj" });
	// 盘符路径（含 /mnt/c 归一化后的 C:\）留在宿主 git 上——与 ProjectStore 的存储约定一致
	assert.equal(gitWsl.resolveWslGitTarget("C:\\proj", "win32"), null);
	assert.equal(gitWsl.resolveWslGitTarget("/home/dev/proj", "win32"), null);
	assert.equal(gitWsl.resolveWslGitTarget("/repo", "win32"), null);
	// 非 Windows 平台没有 wsl.exe
	assert.equal(gitWsl.resolveWslGitTarget(UNC_REPO, "darwin"), null);
	assert.equal(gitWsl.resolveWslGitTarget(UNC_REPO, "linux"), null);
});

test("守卫脚本：cd 失败与缺 git 都必须非零退出，命令经 exec 原样替换", () => {
	assert.match(gitWsl.WSL_GIT_CD_GUARD, /^cd "\$1" \|\| \{/);
	assert.match(gitWsl.WSL_GIT_CD_GUARD, /exit 90;/);
	assert.match(gitWsl.WSL_GIT_CD_GUARD, /command -v git >\/dev\/null 2>&1 \|\| \{/);
	assert.match(gitWsl.WSL_GIT_CD_GUARD, /git is not installed in this WSL distribution/);
	assert.match(gitWsl.WSL_GIT_CD_GUARD, /exit 91;/);
	assert.match(gitWsl.WSL_GIT_CD_GUARD, /exec "\$@"$/);
});

test("toWslGitArgs：-C 值与 -- 之后的路径转 Linux，其余位置原样", () => {
	const target = gitWsl.resolveWslGitTarget(UNC_REPO, "win32");
	assert.deepEqual(plain(gitWsl.toWslGitArgs(["-C", "\\\\wsl.localhost\\Debian\\home\\dev\\proj", "show", "HEAD:src/a.ts"], target)), ["-C", "/home/dev/proj", "show", "HEAD:src/a.ts"]);
	assert.deepEqual(plain(gitWsl.toWslGitArgs(["--literal-pathspecs", "add", "--", "\\\\wsl.localhost\\Debian\\home\\dev\\proj\\src\\a.ts", "src/b.ts", "."], target)), ["--literal-pathspecs", "add", "--", "/home/dev/proj/src/a.ts", "src/b.ts", "."]);
	assert.deepEqual(plain(gitWsl.toWslGitArgs(["log", "--format=%(refname:short)%00%H", "-z", "--topo-order", "-n32", "--exclude=refs/pi-checkpoints/*", "--all"], target)), ["log", "--format=%(refname:short)%00%H", "-z", "--topo-order", "-n32", "--exclude=refs/pi-checkpoints/*", "--all"]);
});

test("toWslGitArgs：路径位置之外的宿主绝对路径必须抛错（漏转不许静默通过）", () => {
	const target = gitWsl.resolveWslGitTarget(UNC_REPO, "win32");
	assert.throws(() => gitWsl.toWslGitArgs(["worktree", "add", "--no-checkout", "-b", "feat", "\\\\wsl.localhost\\Debian\\home\\dev\\feat"], target), /outside a path position/);
	assert.throws(() => gitWsl.toWslGitArgs(["checkout", "C:\\evil"], target), /outside a path position/);
	assert.throws(() => gitWsl.toWslGitArgs(["-C"], target), /requires a path argument/);
});

test("toWslGitEnv：路径型值转 Linux，相对值与时间戳原样转发", () => {
	const target = gitWsl.resolveWslGitTarget(UNC_REPO, "win32");
	assert.deepEqual(plain(gitWsl.toWslGitEnv(undefined, target)), []);
	assert.deepEqual(
		plain(
			gitWsl.toWslGitEnv(
				{
					GIT_INDEX_FILE: "C:/Users/dev/AppData/Local/Temp/pi-rewind-1/index",
					GIT_AUTHOR_DATE: "2026-09-29T00:00:00.000Z",
					GIT_AUTHOR_NAME: "pi-rewind",
				},
				target,
			),
		),
		["GIT_INDEX_FILE=/mnt/c/Users/dev/AppData/Local/Temp/pi-rewind-1/index", "GIT_AUTHOR_DATE=2026-09-29T00:00:00.000Z", "GIT_AUTHOR_NAME=pi-rewind"],
	);
	assert.deepEqual(plain(gitWsl.toWslGitEnv({ GIT_DIR: ".git", GIT_WORK_TREE: "/home/dev/proj" }, target)), ["GIT_DIR=.git", "GIT_WORK_TREE=/home/dev/proj"]);
});

test("toHostGitOutputPath：/mnt/c 回盘符、Linux 路径转 UNC、相对路径与宿主分支原样", () => {
	const target = gitWsl.resolveWslGitTarget(UNC_REPO, "win32");
	assert.equal(gitWsl.toHostGitOutputPath("/home/dev/proj", target), "\\\\wsl.localhost\\Debian\\home\\dev\\proj");
	assert.equal(gitWsl.toHostGitOutputPath("/mnt/c/proj", target), "C:\\proj");
	assert.equal(gitWsl.toHostGitOutputPath(".git", target), ".git");
	assert.equal(gitWsl.toHostGitOutputPath("C:\\proj", null), "C:\\proj");
});

test("decodeWslGitStdout：UTF-8 保留 NUL（-z 输出），UTF-16 特征按 UTF-16LE 解码", () => {
	assert.equal(gitWsl.decodeWslGitStdout(Buffer.from("a.txt\0b.txt\0", "utf8")), "a.txt\0b.txt\0");
	assert.equal(gitWsl.decodeWslGitStdout(Buffer.from("no such distro", "utf16le")), "no such distro");
	assert.equal(gitWsl.decodeWslGitStdout(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("bad", "utf16le")])), "bad");
});

test("resolveWslGitTimeout：冷启动下限对默认值与更小值生效，更大值保留", () => {
	assert.equal(gitWsl.resolveWslGitTimeout(undefined), gitWsl.WSL_GIT_TIMEOUT_FLOOR_MS);
	assert.equal(gitWsl.resolveWslGitTimeout(5_000), gitWsl.WSL_GIT_TIMEOUT_FLOOR_MS);
	assert.equal(gitWsl.resolveWslGitTimeout(120_000), 120_000);
});

test("planGitSpawn：宿主分支保留可执行文件/参数/cwd，WSL 分支换 wsl.exe 并重写 argv", () => {
	const native = gitWsl.planGitSpawn(["status", "--porcelain"], { cwd: "C:\\proj", nativeCommand: CUSTOM_GIT });
	assert.deepEqual(plain(native), { command: CUSTOM_GIT, args: ["status", "--porcelain"], cwd: "C:\\proj", target: null, display: `${CUSTOM_GIT} status --porcelain` });

	const wsl = gitWsl.planGitSpawn(["status", "--porcelain", "-z", "--", "."], { cwd: UNC_REPO, nativeCommand: CUSTOM_GIT, wslCommand: WSL_EXE, env: { GIT_INDEX_FILE: "C:/tmp/index" } });
	assert.equal(wsl.command, WSL_EXE);
	assert.equal(wsl.target.distro, "Debian");
	assert.equal(wsl.cwd, tmpdir());
	assert.deepEqual(plain(wsl.args), expectedWslArgs("Debian", "/home/dev/proj", ["status", "--porcelain", "-z", "--", "."], ["GIT_INDEX_FILE=/mnt/c/tmp/index"]));
	assert.equal(wsl.display, `${WSL_EXE} -d Debian git status --porcelain -z -- .`);
});

test("execGit：宿主项目仍 spawn 用户配置的 git，并把显式 env 叠加到 process.env", async () => {
	const fake = fakeExecFile({ stdout: "main\n", stderr: "" });
	execFileHandler = fake.handler;
	const { stdout } = await execGit(["branch", "--show-current"], { cwd: "C:\\proj", maxBuffer: 4096, env: { GIT_X: "1" } });
	assert.equal(stdout, "main\n");
	assert.equal(fake.calls.length, 1);
	assert.equal(fake.calls[0].command, CUSTOM_GIT);
	assert.deepEqual(fake.calls[0].args, ["branch", "--show-current"]);
	assert.equal(fake.calls[0].options.cwd, "C:\\proj");
	assert.equal(fake.calls[0].options.maxBuffer, 4096);
	assert.equal(fake.calls[0].options.env.GIT_X, "1");
	// Windows 上 {...process.env} 展开的是实际变量名 Path：GH runner 只有 Path、没有 PATH（本机
	// 两者都有，所以本地一直绿、CI 一直红）。契约是「显式 env 叠在完整父环境之上」，故对键名
	// 大小写不敏感地取——生产代码 PiLocator.ts 的 PATH 读取也是同样写法。
	const inheritedPath = fake.calls[0].options.env.PATH ?? fake.calls[0].options.env.Path;
	assert.equal(inheritedPath, process.env.PATH ?? process.env.Path);
});

test("execGit：WSL 项目经 wsl.exe 在发行版内执行，stdout 的 NUL 原样保留", async () => {
	const fake = fakeSpawn({ stdout: Buffer.from("a.ts\0b.ts\0", "utf8") });
	spawnHandler = fake.handler;
	const { stdout } = await execGit(["status", "--porcelain", "-z", "--", "."], { cwd: UNC_REPO });
	assert.equal(stdout, "a.ts\0b.ts\0");
	assert.equal(fake.calls.length, 1);
	assert.equal(fake.calls[0].command, WSL_EXE);
	assert.deepEqual(fake.calls[0].args, expectedWslArgs("Debian", "/home/dev/proj", ["status", "--porcelain", "-z", "--", "."]));
	assert.equal(fake.calls[0].options.cwd, tmpdir());
	assert.deepEqual(fake.calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
});

test("execGit：WSL 分支失败时把 UTF-16LE 的 wsl.exe 报错解码进错误消息", async () => {
	const failing = fakeSpawn({ stderr: Buffer.from("There is no distribution with the supplied name.", "utf16le"), code: 1 });
	spawnHandler = failing.handler;
	await assert.rejects(
		() => execGit(["rev-parse", "HEAD"], { cwd: UNC_REPO }),
		(error) => {
			assert.match(error.message, /^Command failed: .*wsl\.exe -d Debian git rev-parse HEAD\n/);
			assert.match(error.message, /There is no distribution with the supplied name\./);
			return true;
		},
	);
});

test("execGit：WSL 分支的 cd 守卫失败（exit 90）消息可读", async () => {
	const failing = fakeSpawn({ stderr: Buffer.from("pideck: cannot change directory to /home/dev/gone\n", "utf8"), code: 90 });
	spawnHandler = failing.handler;
	await assert.rejects(() => execGit(["status"], { cwd: "\\\\wsl.localhost\\Debian\\home\\dev\\gone" }), /pideck: cannot change directory to \/home\/dev\/gone/);
});

test("runGitCommand：WSL 分支把 stdin 转给 wsl.exe（commit-tree / cat-file --batch 依赖）", async () => {
	const fake = fakeSpawn({ stdout: "0".repeat(40) + "\n" });
	spawnHandler = fake.handler;
	const { stdout } = await runGitCommand(["commit-tree", "abc123"], { cwd: UNC_REPO, input: "pi-rewind:turn-1", env: { GIT_AUTHOR_NAME: "pi-rewind" } });
	assert.equal(stdout, "0".repeat(40) + "\n");
	assert.deepEqual(fake.calls[0].args, expectedWslArgs("Debian", "/home/dev/proj", ["commit-tree", "abc123"], ["GIT_AUTHOR_NAME=pi-rewind"]));
	assert.deepEqual(fake.calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
	assert.deepEqual(fake.stdinChunks, ["pi-rewind:turn-1"]);
	// 断管兜底守卫：stdin 必须在写入前注册 error 监听（wsl.exe 提前退出时排队写报 EOF/EPIPE，无监听炸主进程）。
	assert.equal(fake.stdinErrorListenerCount(), 1);
});

test("runGitCommand：宿主分支保持 (args, options, command) 调用形态", async () => {
	const spawnFake = fakeSpawn({ stdout: "" });
	spawnHandler = spawnFake.handler;
	await runGitCommand(["cherry-pick", "a".repeat(40)], { cwd: "C:\\proj", timeoutMs: 30_000 });
	assert.equal(spawnFake.calls.length, 1);
	assert.equal(spawnFake.calls[0].command, CUSTOM_GIT);
	assert.deepEqual(spawnFake.calls[0].args, ["cherry-pick", "a".repeat(40)]);
	assert.equal(spawnFake.calls[0].options.cwd, "C:\\proj");
});

test("UNC 文件路径也能路由（getOriginalContent 用 dirname 作为 cwd）", () => {
	const uncDir = "\\\\wsl.localhost\\Debian\\home\\dev\\proj\\src";
	assert.deepEqual(plain(gitWsl.resolveWslGitTarget(uncDir, "win32")), { distro: "Debian", linuxCwd: "/home/dev/proj/src" });
});
