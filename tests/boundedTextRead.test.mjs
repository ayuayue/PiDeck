/**
 * readTextBounded 有界读取契约：
 * - 小文件等价整读（不进截断分支）；
 * - head 截断丢弃末尾半行、tail 截断丢弃开头半行（行对齐，半行必然 JSON 解析失败）；
 * - 单行超窗口时返回空串（整个窗口都是半个不可用行）；
 * - 文件不存在向上抛（与 readFile 语义一致，调用方兜底）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTextBounded } from "../src/main/fs/boundedTextRead.ts";

async function makeDir() {
	return mkdtemp(join(tmpdir(), "bounded-read-"));
}

test("小文件：head/tail 都等价于整读", async () => {
	const dir = await makeDir();
	try {
		const file = join(dir, "small.jsonl");
		await writeFile(file, "a\nb\nc\n", "utf8");
		assert.equal(await readTextBounded(file, 1024, "head"), "a\nb\nc\n");
		assert.equal(await readTextBounded(file, 1024, "tail"), "a\nb\nc\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("tail 截断：只返回末尾窗口且丢弃开头半行", async () => {
	const dir = await makeDir();
	try {
		const file = join(dir, "big.log");
		// 10 行 × 每行 10 字节（含 \n），窗口取 25 字节：读到末尾 25 字节，首行必被切开
		const lines = Array.from({ length: 10 }, (_, i) => `line-${String(i).padStart(4, "0")}`);
		await writeFile(file, lines.join("\n") + "\n", "utf8");
		const text = await readTextBounded(file, 25, "tail");
		const got = text.split("\n").filter(Boolean);
		// 必须是完整行的后缀子序列，且包含最后一行
		assert.ok(got.length >= 1 && got.every((l) => lines.includes(l)), `只允许完整行: ${JSON.stringify(got)}`);
		assert.equal(got[got.length - 1], "line-0009");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("head 截断：只返回开头窗口且丢弃末尾半行", async () => {
	const dir = await makeDir();
	try {
		const file = join(dir, "agents.md");
		const lines = Array.from({ length: 10 }, (_, i) => `row-${String(i).padStart(4, "0")}`);
		await writeFile(file, lines.join("\n") + "\n", "utf8");
		const text = await readTextBounded(file, 25, "head");
		const got = text.split("\n").filter(Boolean);
		assert.ok(got.length >= 1 && got.every((l) => lines.includes(l)), `只允许完整行: ${JSON.stringify(got)}`);
		assert.equal(got[0], "row-0000");
		assert.ok(!text.includes("row-0009"), "窗口外的行不得出现");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("单行超过窗口：tail/head 都返回空串（无完整行可给）", async () => {
	const dir = await makeDir();
	try {
		const file = join(dir, "oneline.log");
		await writeFile(file, `${"x".repeat(500)}\n`, "utf8");
		assert.equal(await readTextBounded(file, 100, "tail"), "");
		assert.equal(await readTextBounded(file, 100, "head"), "");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("文件不存在：与 readFile 一致向上抛", async () => {
	const dir = await makeDir();
	try {
		await assert.rejects(() => readTextBounded(join(dir, "missing.log"), 100, "tail"), /ENOENT/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
