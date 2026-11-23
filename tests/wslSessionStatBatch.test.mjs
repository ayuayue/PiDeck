import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Issue #588：WSL pi 模式下「创建项目 / 新建工作区」页面未响应。
 *
 * 根因是侧栏会话扫描在 WSL 模式对**每个会话文件**拉一个 wsl.exe 读 mtime/size
 * （本机实测 90–105ms/文件、并发 4），上千会话即超过 SessionScanner 的 18s 看门狗
 * ——列表永远超时、看门狗再触发一轮，每轮重新拉起几百个 wsl.exe。
 *
 * 这里锁三件事：
 * 1. 批量 plan 的形状（distro/user/`--exec /bin/sh`，路径只走 stdin，绝不进 argv/脚本）；
 * 2. 批量输出的解析口径（NUL 分隔、路径含空格、截断记录丢弃、与单文件同口径）；
 * 3. SessionScanner 接了这条快路：预热后逐文件读取不再 spawn，失败即回退，快照不跨轮残留。
 */

const NUL = "\u0000";
const BATCH = loadTsCommonJs("src/main/sessions/scanner/wslFileStatBatch.ts");

/**
 * 生产模块跑在 vm 沙箱里，返回的数组/对象属于另一个 realm：`assert.deepEqual`（strict）会按
 * 原型链比较，即使结构一致也判「not reference-equal」。断言前先过一遍 JSON 拷贝回到本 realm。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

test("批量 stat 的 argv 只有固定脚本，路径不进命令行", () => {
	const args = BATCH.buildWslStatBatchArgs("Debian", "root");
	assert.deepEqual(plain(args), ["-d", "Debian", "-u", "root", "--exec", "/bin/sh", "-c", BATCH.WSL_STAT_BATCH_SCRIPT]);
	// 路径占位来自 stdin（read 循环），脚本里不能出现任何数据拼接
	assert.match(BATCH.WSL_STAT_BATCH_SCRIPT, /while IFS= read -r pideck_path; do stat --printf "%Y %s %n\\0" -- "\$pideck_path" 2>\/dev\/null; done/);
	assert.equal(BATCH.WSL_STAT_BATCH_SCRIPT.includes("/home/"), false);
});

test("stdin 输入一行一路径并补尾换行（少尾换行会静默丢最后一条）", () => {
	assert.equal(BATCH.buildWslStatBatchInput([]), "");
	assert.equal(BATCH.buildWslStatBatchInput(["/a/b.jsonl"]), "/a/b.jsonl\n");
	assert.equal(BATCH.buildWslStatBatchInput(["/a/b.jsonl", "/a/c.jsonl"]), "/a/b.jsonl\n/a/c.jsonl\n");
});

test("路径按批切分：空表不产生空批，条数不丢不重", () => {
	assert.deepEqual(plain(BATCH.chunkWslStatPaths([], 2)), []);
	assert.deepEqual(plain(BATCH.chunkWslStatPaths(["1", "2", "3"], 2)), [["1", "2"], ["3"]]);
	const many = Array.from({ length: 1201 }, (_, index) => `/s/${index}.jsonl`);
	const batches = BATCH.chunkWslStatPaths(many);
	assert.equal(batches.flat().length, 1201);
	assert.ok(batches.every((batch) => batch.length <= BATCH.WSL_STAT_BATCH_SIZE));
});

test("解析 NUL 分隔记录：路径含空格也不切错，与单文件 stat 同口径（秒→毫秒）", () => {
	const stdout = [`1712345678 42 /home/u/.pi/agent/sessions/--home-u-my proj--/s1.jsonl`, "1712345679 7 /home/u/s2.jsonl"].join(NUL) + NUL;
	const versions = BATCH.parseWslStatBatchOutput(stdout);
	assert.deepEqual(plain([...versions.entries()]), [
		["/home/u/.pi/agent/sessions/--home-u-my proj--/s1.jsonl", { mtimeMs: 1712345678000, size: 42 }],
		["/home/u/s2.jsonl", { mtimeMs: 1712345679000, size: 7 }],
	]);
});

test("解析丢弃被截断/畸形记录：缺的路径由调用方逐文件补齐，绝不留半条路径", () => {
	assert.equal(BATCH.parseWslStatBatchOutput("").size, 0);
	assert.equal(BATCH.parseWslStatBatchOutput("1712345678").size, 0, "只有 mtime 的残记录必须丢");
	assert.equal(BATCH.parseWslStatBatchOutput("1712345678 42 ").size, 0, "缺路径的残记录必须丢");
	assert.equal(BATCH.parseWslStatBatchOutput(`x 42 /a.jsonl${NUL}`).size, 0, "非数字 mtime 必须丢");
	const partial = BATCH.parseWslStatBatchOutput(`1712345678 42 /a.jsonl${NUL}1712345678 9 /b.js`);
	assert.deepEqual([...partial.keys()], ["/a.jsonl"], "末尾残段（无 NUL 终止）必须丢弃");
});

/**
 * 记录沙箱里所有 execFile 调用。
 * respond(call) 返回字符串 = 成功输出；返回 { code } = 该失败形态（数字=非零退出，字符串=ENOENT/超时）。
 * 单文件 stat（args 里带独立的 `stat`）与批量（`-c` + 脚本，路径走 stdin）分开调度：真实 execFile
 * 不碰 stdin 也会回调，批量那条才需要等 stdin 写完，混成一条会让回退路径的 promise 永不 settled。
 */
function createScannerWithWsl(respond) {
	const calls = [];
	const execFile = (command, args, options, callback) => {
		const call = { command, args, options, stdin: "" };
		calls.push(call);
		const finish = () => {
			const outcome = respond(call);
			if (typeof outcome === "string") callback(null, outcome);
			else callback(Object.assign(new Error("stub failure"), { code: outcome.code }));
		};
		// 单文件 stat 的 argv 里有独立的 `stat` 词元，批量的路径全走 stdin（argv 只有脚本）
		if (args.includes("stat")) {
			setImmediate(finish);
			return { stdin: { end: () => undefined } };
		}
		return {
			stdin: {
				end(text) {
					call.stdin = text;
					setImmediate(finish);
				},
			},
		};
	};
	const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
		stubs: {
			electron: { app: { getPath: () => tmpdir() }, shell: {} },
			"node:child_process": { execFile },
		},
	});
	const scanner = new SessionScanner();
	scanner.wslConfig = { distro: "Debian", user: "root", home: "/root" };
	return { scanner, calls };
}

/** 单文件 stat（readWslFileVersion 的回退路径）与批量各回一份可区分的输出。 */
const respondStat = (call) => (call.args.includes("stat") ? `1700000000 5 ${call.args[call.args.length - 1]}` : null);

test("预热后逐文件读版本不再 spawn（N 个会话只花一条 wsl.exe）", async () => {
	const files = ["/root/.pi/agent/sessions/a/s1.jsonl", "/root/.pi/agent/sessions/a/s2.jsonl"];
	const { scanner, calls } = createScannerWithWsl(
		(call) =>
			call.stdin
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((path, index) => `170000000${index} ${100 + index} ${path}`)
				.join(NUL) + NUL,
	);

	await scanner.primeWslFileVersions(files);
	assert.equal(calls.length, 1, "两个文件必须合并成一条 wsl.exe");
	assert.deepEqual(plain(calls[0].args), ["-d", "Debian", "-u", "root", "--exec", "/bin/sh", "-c", BATCH.WSL_STAT_BATCH_SCRIPT]);
	assert.equal(calls[0].options.shell, false);
	assert.equal(
		calls[0].args.some((arg) => arg.includes(".jsonl")),
		false,
		"路径不得出现在 argv（Windows 32KB 命令行上限 + 引号风险）",
	);
	assert.equal(calls[0].stdin, `${files.join("\n")}\n`);

	assert.deepEqual(plain(await scanner.readWslFileVersion(files[0])), { mtimeMs: 1700000000000, size: 100 });
	assert.deepEqual(plain(await scanner.readWslFileVersion(files[1])), { mtimeMs: 1700000001000, size: 101 });
	assert.equal(calls.length, 1, "命中快照不得再 spawn wsl.exe");

	// 快照是共享状态：调用方改不到它
	const version = await scanner.readWslFileVersion(files[0]);
	version.size = 999;
	assert.equal((await scanner.readWslFileVersion(files[0])).size, 100);
});

test("批次非零退出（个别文件消失）仍采纳已写出的记录；未覆盖的路径退回单文件 stat", async () => {
	const files = ["/root/s1.jsonl", "/root/s2.jsonl", "/root/gone.jsonl"];
	const { scanner, calls } = createScannerWithWsl((call) => {
		if (call.args.includes("stat")) return respondStat(call);
		assert.equal(call.stdin.includes("gone.jsonl"), true, "消失的文件也要在输入里，由 stat 自己失败");
		// 前两条成功，末尾一条被字节帽截断
		return `1700000000 1 /root/s1.jsonl${NUL}1700000000 2 /root/s2.jsonl${NUL}1700000000 3 /roo`;
	});
	await scanner.primeWslFileVersions(files);
	const batchCalls = calls.length;
	assert.deepEqual(plain(await scanner.readWslFileVersion("/root/s1.jsonl")), { mtimeMs: 1700000000000, size: 1 });
	assert.deepEqual(plain(await scanner.readWslFileVersion("/root/s2.jsonl")), { mtimeMs: 1700000000000, size: 2 });
	// 快照里没有 gone.jsonl（残记录丢弃）→ 退回单文件 stat，值来自真实 stat 而不是残段
	assert.deepEqual(plain(await scanner.readWslFileVersion("/root/gone.jsonl")), { mtimeMs: 1700000000000, size: 5 });
	assert.equal(calls.length, batchCalls + 1);
});

test("批量跑不起来（拉不起 wsl.exe / 超时）不抛错，回退逐文件 stat", async () => {
	for (const code of ["ENOENT", "ETIMEDOUT", 90]) {
		const { scanner } = createScannerWithWsl((call) => (call.args.includes("stat") ? respondStat(call) : { code }));
		await scanner.primeWslFileVersions(["/root/s1.jsonl"]);
		assert.deepEqual(plain(await scanner.readWslFileVersion("/root/s1.jsonl")), { mtimeMs: 1700000000000, size: 5 }, `失败形态 ${String(code)} 必须回退`);
	}
});

test("空表、无 WSL 配置、含换行的路径都不起批量进程", async () => {
	const empty = createScannerWithWsl(() => "");
	await empty.scanner.primeWslFileVersions([]);
	assert.equal(empty.calls.length, 0, "空表不该起进程");

	const local = createScannerWithWsl(() => "");
	local.scanner.wslConfig = null;
	await local.scanner.primeWslFileVersions(["/root/s1.jsonl"]);
	assert.equal(local.calls.length, 0, "本地模式不该起 wsl.exe");

	const newline = createScannerWithWsl(() => "");
	await newline.scanner.primeWslFileVersions(["/root/a\nb.jsonl"]);
	assert.equal(newline.calls.length, 0, "换行路径会破坏 stdin 协议，必须整体跳过并逐文件回退");
});

test("快照按轮次隔离：新一轮预热不会带着上一轮的文件继续命中", async () => {
	// list() 每轮开头预热、结尾清快照；这里直接验证可观察结果：上一轮的文件不得在新一轮继续命中。
	const { scanner, calls } = createScannerWithWsl((call) => (call.args.includes("stat") ? respondStat(call) : `1700000001 100 ${call.stdin.trim()}` + NUL));
	await scanner.primeWslFileVersions(["/root/a.jsonl"]);
	assert.deepEqual(plain(await scanner.readWslFileVersion("/root/a.jsonl")), { mtimeMs: 1700000001000, size: 100 });

	// 新一轮只预热了 b：a 必须回到单文件 stat（值来自 stat 而不是上一轮的 100）
	await scanner.primeWslFileVersions(["/root/b.jsonl"]);
	const after = calls.length;
	assert.deepEqual(plain(await scanner.readWslFileVersion("/root/a.jsonl")), { mtimeMs: 1700000000000, size: 5 });
	assert.equal(calls.length, after + 1, "上一轮的文件不得留在快照里");
});
