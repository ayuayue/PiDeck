import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 删除会话文件时的回收站竞争（issue #364）：
 * pi 被停掉后 Windows 上可能仍短暂持有 JSONL 写句柄，此时 shell.trashItem 只报通用的
 * 「Failed to perform delete operation」，无法与「路径不存在」区分。删除必须：
 * 1) 有限重试并按 power-of-delay 收敛；2) 失败时抛带 code/target/attempts 的结构化错误；
 * 3) 先删文件、后清同级目录，且目录清理失败不能把文件已删除的会话报成失败。
 */
const home = mkdtempSync(join(tmpdir(), "pideck-scanner-delete-"));
const calls = [];
const warnings = [];
let trash = async () => undefined;

const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
	stubs: {
		electron: {
			app: { getPath: (key) => (key === "home" ? home : join(home, String(key))) },
			shell: {
				trashItem: async (targetPath) => {
					calls.push(targetPath);
					return trash(targetPath);
				},
			},
		},
		// getAppLogger 未注册时返回 null；这里换成捕获器，断言重试与忽略失败都留了痕。
		"../logging/sharedLogger": {
			getAppLogger: () => ({
				info: () => undefined,
				warn: (_scope, message, detail) => warnings.push({ message, detail }),
				error: () => undefined,
			}),
		},
	},
});

const scanner = new SessionScanner();

function reset() {
	calls.length = 0;
	warnings.length = 0;
	trash = async () => undefined;
}

function writeSessionFile(name) {
	const dir = join(home, "sessions");
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, `${name}.jsonl`);
	writeFileSync(filePath, `${JSON.stringify({ type: "session", id: name })}\n`);
	return filePath;
}

test("#364: delete retries a transient trash failure and then succeeds", async () => {
	reset();
	const filePath = writeSessionFile("retry-ok");
	let failures = 2;
	trash = async (targetPath) => {
		if (failures > 0) {
			failures -= 1;
			throw Object.assign(new Error("Failed to perform delete operation"), { code: "EBUSY" });
		}
		rmSync(targetPath, { force: true });
	};

	await scanner.delete(filePath);

	assert.equal(calls.length, 3);
	assert.equal(failures, 0);
	assert.equal(warnings.length, 2);
	assert.equal(warnings[0].message, "Trash target busy, retrying");
	assert.equal(warnings[0].detail.attempt, 1);
	assert.equal(warnings[0].detail.attempts, 3);
	assert.equal(warnings[0].detail.code, "EBUSY");
});

test("#364: delete reports a structured busy error after the retries are exhausted", async () => {
	reset();
	const filePath = writeSessionFile("retry-fail");
	trash = async () => {
		throw Object.assign(new Error("Failed to perform delete operation"), { code: "EPERM" });
	};

	await assert.rejects(scanner.delete(filePath), (error) => {
		assert.equal(error.code, "SESSION_FILE_BUSY");
		assert.equal(error.target, "session-file");
		assert.equal(error.attempts, 3);
		assert.equal(error.errno, "EPERM");
		assert.match(error.message, /占用/);
		return true;
	});
	assert.equal(calls.length, 3);
});

test("#364: deletes the file before the sibling dir and ignores sibling failures", async () => {
	reset();
	const filePath = writeSessionFile("with-children");
	const siblingDir = filePath.replace(/\.jsonl$/, "");
	mkdirSync(siblingDir, { recursive: true });
	writeFileSync(join(siblingDir, "child.jsonl"), "{}\n");
	trash = async (targetPath) => {
		if (targetPath === siblingDir) throw Object.assign(new Error("Failed to perform delete operation"), { code: "EBUSY" });
		rmSync(targetPath, { force: true });
	};

	await scanner.delete(filePath);

	// 文件本体一次成功；同级目录重试用尽后只记 warn，不再让整个删除失败。
	assert.deepEqual(calls, [filePath, siblingDir, siblingDir, siblingDir]);
	assert.equal(
		warnings.some((warning) => warning.message === "Sibling session dir trash failed (ignored)"),
		true,
	);
});

test("#364: deleting an already-missing session file stays idempotent", async () => {
	reset();
	const filePath = join(home, "sessions", "already-gone.jsonl");

	await scanner.delete(filePath);

	assert.deepEqual(calls, []);
	assert.deepEqual(warnings, []);
});

test.after(() => {
	rmSync(home, { recursive: true, force: true });
});
