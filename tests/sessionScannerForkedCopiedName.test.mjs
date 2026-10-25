import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * fork/clone 产物里「复制来的父会话名」不是本文件的名字。
 *
 * 现场（2026-10-11 复现）：复制 12MB 会话后，新文件先被扫描（PiDeck 的 (fork) 名还没写进去），
 * 标题被锁成正文兜底；随后 rename 把权威名追加在文件尾部——大文件只读头/尾 64KB 窗口，
 * 后续消息一多就把它推出尾窗，标题永久停在首句上。
 *
 * 契约：pi/PiDeck 的 fork/clone 都是复制父会话文件再追加自己的 session_info，复制进来的那条
 * 时间戳早于本文件头 → 只能当弱候选（fromSessionInfo=false，可被权威名/命令标题升级）；
 * 本文件自己追加的 session_info（时间戳新于文件头）才是权威名。非 fork 文件行为不变。
 */

const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
	stubs: {
		electron: {
			app: { getPath: () => tmpdir() },
			shell: {},
		},
	},
});

const scanner = new SessionScanner();
const dir = mkdtempSync(join(tmpdir(), "pideck-fork-copied-name-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function writeSession(lines) {
	seq += 1;
	const file = join(dir, `2026-10-11T08-09-56-069Z_fork${seq}.jsonl`);
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	return file;
}

function header(overrides = {}) {
	return { type: "session", version: 3, id: "fixture", cwd: "C:/project", ...overrides };
}

function userMessage(id, timestamp, text) {
	return { type: "message", id, parentId: null, timestamp, message: { role: "user", content: text } };
}

function sessionInfo(id, timestamp, name) {
	return { type: "session_info", id, parentId: null, timestamp, name };
}

test("a copied parent session_info name is not authoritative for the fork file", async () => {
	const file = writeSession([
		// 克隆产物：本文件头时间戳 10:00:00，parentSession 指向父会话。
		header({ timestamp: "2026-10-11T10:00:00.000Z", parentSession: "C:/sessions/parent.jsonl" }),
		// 复制进来的父历史：父会话名时间戳早于本文件头。
		sessionInfo("i0", "2026-10-11T08:15:35.572Z", "父会话的名字"),
		userMessage("u1", "2026-10-11T08:16:00.000Z", "复制出来的第一条输入"),
	]);
	const result = await scanner.inferSessionNameAndValidity(file);
	assert.equal(result.name, "父会话的名字", "父名仍可当显示兜底（比首条消息更像会话名）");
	assert.equal(result.nameFromSessionInfo, false, "但不得当权威名锁定所有权");
});

test("a session_info appended after the fork header is authoritative", async () => {
	const file = writeSession([
		header({ timestamp: "2026-10-11T10:00:00.000Z", parentSession: "C:/sessions/parent.jsonl" }),
		sessionInfo("i0", "2026-10-11T08:15:35.572Z", "父会话的名字"),
		userMessage("u1", "2026-10-11T08:16:00.000Z", "复制出来的第一条输入"),
		// PiDeck/pi 在 clone 完成后追加的 (fork) 名。
		sessionInfo("i1", "2026-10-11T10:00:02.330Z", "父会话的名字 (fork)"),
	]);
	const result = await scanner.inferSessionNameAndValidity(file);
	assert.equal(result.name, "父会话的名字 (fork)");
	assert.equal(result.nameFromSessionInfo, true);
});

test("small fork files are streamed but still ignore the copied parent name", async () => {
	// 体量落在「窗口之外、全扫阈值之内」（>64KB 且 ≤1MB）：走流式全扫路径，
	// 那里也必须应用同一条时间戳规则。
	const padding = "x".repeat(200 * 1024);
	const file = writeSession([header({ timestamp: "2026-10-11T10:00:00.000Z", parentSession: "C:/sessions/parent.jsonl" }), sessionInfo("i0", "2026-10-11T08:15:35.572Z", "父会话的名字"), userMessage("u1", "2026-10-11T08:16:00.000Z", padding)]);
	assert.ok(statSync(file).size > 64 * 1024 && statSync(file).size < 1024 * 1024, "fixture must hit the streamed full-scan branch");
	const result = await scanner.inferSessionNameAndValidity(file);
	assert.equal(result.nameFromSessionInfo, false, "流式全扫同样不得把复制来的父名当权威名");
});

test("non-fork sessions keep their session_info name as authoritative", async () => {
	const file = writeSession([
		header({ timestamp: "2026-10-11T10:00:00.000Z" }),
		// 旧会话里早于文件头时间戳的 session_info（历史数据）不得被误判成父历史。
		sessionInfo("i0", "2026-10-11T08:15:35.572Z", "手动改过的会话名"),
		userMessage("u1", "2026-10-11T08:16:00.000Z", "第一条输入"),
	]);
	const result = await scanner.inferSessionNameAndValidity(file);
	assert.equal(result.name, "手动改过的会话名");
	assert.equal(result.nameFromSessionInfo, true);
});

// node:test 结束时清理夹具目录（临时目录随测试进程回收，这里保持显式）。
test.after(() => {
	rmSync(dir, { recursive: true, force: true });
});
