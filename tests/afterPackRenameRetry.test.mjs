import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { renameWithRetry } = require("../scripts/after-pack-file-utils.js");

function codeError(code) {
	return Object.assign(new Error(`${code}: blocked`), { code });
}

test("renameWithRetry 在瞬时占用后重试到成功", async () => {
	const codes = ["EPERM", "EBUSY"];
	let calls = 0;
	await renameWithRetry("a.tmp", "a", {
		delayMs: 1,
		rename: async () => {
			calls += 1;
			if (codes.length) throw codeError(codes.shift());
		},
	});
	assert.equal(calls, 3, "两次占用后第三次就位");
});

test("renameWithRetry 不为非瞬时错误重试", async () => {
	let calls = 0;
	await assert.rejects(
		renameWithRetry("a.tmp", "a", {
			delayMs: 1,
			rename: async () => {
				calls += 1;
				throw codeError("ENOENT");
			},
		}),
		/ENOENT: blocked/,
	);
	assert.equal(calls, 1, "真实失败立即抛出，不掩盖成重试");
});

test("renameWithRetry 有界重试耗尽后抛出原始错误", async () => {
	let calls = 0;
	await assert.rejects(
		renameWithRetry("a.tmp", "a", {
			maxAttempts: 3,
			delayMs: 1,
			rename: async () => {
				calls += 1;
				throw codeError("EPERM");
			},
		}),
		/EPERM: blocked/,
	);
	assert.equal(calls, 3);
});

test("renameWithRetry 默认走真实文件系统改名", async () => {
	const dir = await mkdtemp(join(tmpdir(), "after-pack-rename-"));
	const from = join(dir, "app.asar.tmp");
	const to = join(dir, "app.asar");
	await writeFile(from, "payload", "utf8");
	await renameWithRetry(from, to, { delayMs: 1 });
	assert.equal(await readFile(to, "utf8"), "payload");
});
