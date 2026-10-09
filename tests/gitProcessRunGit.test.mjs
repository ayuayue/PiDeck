import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runGit } from "../src/main/git/gitProcess.ts";

/**
 * runGit（src/main/git/gitProcess.ts）的行为测试。
 *
 * 通过注入 command（node）模拟 git，验证三个核心行为：
 * 1. 成功返回 stdout/stderr；
 * 2. 非 0 退出时 reject 且 message 对齐 execFile 的 "Command failed: <cmd>\n<stderr>" 格式；
 * 3. 超时后 promise 一定 settle，且杀掉孙进程树（复现并修复 execFile timeout 卡死 bug）。
 *
 * 用例 3 复现原 bug：execFile 超时只 kill git 自身，git spawn 的孙进程（SSH/credential-helper）
 * 继承 stdout/stderr 管道，git 死后孙进程仍持有管道 → close 永不触发 → promise 永不 settle。
 */

const node = process.execPath;

test("runGit 成功返回 stdout/stderr", async () => {
	const { stdout, stderr } = await runGit(["-e", "console.log('hi'); console.error('warn')"], { cwd: process.cwd() }, node);
	assert.equal(stdout, "hi\n");
	assert.equal(stderr, "warn\n");
});

test("runGit 非 0 退出码 reject 且 message 对齐 execFile 格式", async () => {
	await assert.rejects(
		() => runGit(["-e", "console.error('boom'); process.exit(3)"], { cwd: process.cwd() }, node),
		(err) => {
			assert.match(err.message, /^Command failed: .*\nboom/);
			return true;
		},
	);
});

test("runGit 大 input 写入时子进程提前退出不产生未处理的 stdin EPIPE", async () => {
	// 回归：checkpoint 的 cat-file --batch SHA 列表可达 MB 级，超出管道缓冲后剩余写
	// 在 stream 内排队；git 因非法输入立即退出时排队写触发 stdin 的 error 事件——
	// 无监听的 stream error 会炸掉主进程（与 enhance/auth helper 的 stdin EPIPE 同型）。
	const uncaught = [];
	const handler = (err) => uncaught.push(err);
	process.on("uncaughtException", handler);
	try {
		const invoke = () => runGit(["-e", "process.stdin.once('data', () => process.exit(3))"], { cwd: process.cwd(), input: "x".repeat(2 * 1024 * 1024), timeoutMs: 8000 }, node);
		await assert.rejects(invoke, (err) => {
			assert.match(err.message, /^Command failed: /);
			return true;
		});
		// EPIPE 异步到达：给排队写足够的落地窗口。
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(uncaught.length, 0, `不应有未处理的 stdin EPIPE：${uncaught[0]?.stack}`);
	} finally {
		process.off("uncaughtException", handler);
	}
});

test("runGit 超时后 settle 并杀掉孙进程树（复现 execFile 卡死场景）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rungit-"));
	const scriptPath = join(dir, "fake-git.mjs");
	const pidFile = join(dir, "grandchild.pid");

	// 模拟 git：spawn 一个继承 stdio 的孙进程（持有管道），把孙 PID 写入 argv[2] 指定文件后自身挂起。
	writeFileSync(
		scriptPath,
		[
			`import { spawn } from "node:child_process";`,
			`import { writeFileSync } from "node:fs";`,
			`const pidFile = process.argv[2];`,
			`const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" });`,
			`writeFileSync(pidFile, String(grandchild.pid));`,
			`setInterval(()=>{}, 1000);`,
			"",
		].join("\n"),
	);

	const started = Date.now();
	// timeoutMs 设短，加速测试；runGit 内部 killTree 成功后 close 触发，reject "Command failed"；
	// 若孙进程仍持有管道，则 2s 兜底后 reject "Command timed out"。两种情况都必须 settle。
	await assert.rejects(
		() => runGit([scriptPath, pidFile], { cwd: dir, timeoutMs: 800 }, node),
		(err) => {
			assert.match(err.message, /Command failed|Command timed out/);
			return true;
		},
	);
	assert.ok(Date.now() - started < 5000, "应在超时+兜底窗口内 settle，而非卡死");

	// 等 taskkill / SIGKILL 落地后，孙进程应已被杀（execFile 场景下它会残留并持有管道）。
	await new Promise((resolve) => setTimeout(resolve, 300));
	const grandPid = Number(readFileSync(pidFile, "utf8"));
	let alive = true;
	try {
		process.kill(grandPid, 0);
	} catch {
		alive = false;
	}
	assert.equal(alive, false, `孙进程 ${grandPid} 应被 runGit 终止`);

	rmSync(dir, { recursive: true, force: true });
});
