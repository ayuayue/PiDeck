import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const head = await loadTsCommonJs("src/main/sessions/sessionSourceHead.ts");

test("readJsonlObjects：正常多行流式产出已解析对象", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jsonl-head-"));
	const file = join(dir, "s.jsonl");
	await writeFile(file, `${JSON.stringify({ a: 1 })}\n\n${JSON.stringify({ b: "x" })}\n`, "utf8");
	const out = [];
	for await (const obj of head.readJsonlObjects(file)) out.push(obj);
	assert.equal(JSON.stringify(out), JSON.stringify([{ a: 1 }, { b: "x" }]));
});

test("readJsonlObjects：坏行抛结构化错误（含行前缀）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jsonl-head-"));
	const file = join(dir, "bad.jsonl");
	await writeFile(file, `${JSON.stringify({ ok: true })}\nnot-json-line\n`, "utf8");
	// 逐条消费直到迭代器抛错（首行正常，第二行坏）
	const seen = [];
	await assert.rejects(async () => {
		for await (const obj of head.readJsonlObjects(file)) seen.push(obj);
	}, /Invalid JSON line in .*not-json-line/);
	assert.equal(seen.length, 1);
});

test("readJsonlObjects：超长行抛错而非无界缓冲（防导入 OOM）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jsonl-head-"));
	const file = join(dir, "huge.jsonl");
	// 小上限注入（1KB）：生产默认 64MiB；超过即抛——修复前用裸 readline 无限缓冲
	await writeFile(file, `${JSON.stringify({ pad: "x".repeat(4096) })}\n`, "utf8");
	await assert.rejects(() => head.readJsonlObjects(file, { maxLineBytes: 1024 }).next(), /Oversized line/);
});

test("readJsonlObjects：磁盘零填充区段跳过（严格模式也不让整条会话导入失败）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jsonl-head-"));
	const file = join(dir, "zero.jsonl");
	// 第 2 行模拟 NTFS「长度已扩展、数据未落盘」读回的全 0 区
	// （2026-11 实测 CodeBuddy 会话 01a1a03a 的 2999 字节坏区，修复前整条会话 ✗）
	await writeFile(file, `${JSON.stringify({ ok: 1 })}\n${"\u0000".repeat(2999)}\n${JSON.stringify({ ok: 2 })}\n`, "utf8");
	const out = [];
	for await (const obj of head.readJsonlObjects(file)) out.push(obj);
	// 跨 realm 对象：按序列化比（deepStrictEqual 会比原型链）
	assert.equal(JSON.stringify(out), JSON.stringify([{ ok: 1 }, { ok: 2 }]));
});

test("readJsonlObjects：坏区切在半行上也跳过（行内 NUL 而非整行 NUL）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jsonl-head-"));
	const file = join(dir, "half.jsonl");
	await writeFile(file, `${JSON.stringify({ ok: 1 })}\n{"ok":2,"x":"\u0000\u0000"}\n${JSON.stringify({ ok: 3 })}\n`, "utf8");
	const out = [];
	for await (const obj of head.readJsonlObjects(file)) out.push(obj);
	assert.equal(JSON.stringify(out), JSON.stringify([{ ok: 1 }, { ok: 3 }]));
});

test("readJsonlObjects：真坏行的报错前缀转义控制字符，不再渲染成空白", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jsonl-head-"));
	const file = join(dir, "ctrl.jsonl");
	// \u0001 不是 NUL：不触发零填充跳过，仍要报错；但报错文案里必须可见
	await writeFile(file, `${JSON.stringify({ ok: 1 })}\nnot-json\u0001tail\n`, "utf8");
	await assert.rejects(async () => {
		for await (const _obj of head.readJsonlObjects(file)) void _obj;
	}, /Invalid JSON line in .*not-json\\u0001tail/);
});

test("readJsonlObjects：消费方提前 break 不炸（后台扫描自然收尾）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jsonl-head-"));
	const file = join(dir, "many.jsonl");
	const lines = Array.from({ length: 500 }, (_, i) => JSON.stringify({ i }));
	await writeFile(file, `${lines.join("\n")}\n`, "utf8");
	const seen = [];
	for await (const obj of head.readJsonlObjects(file)) {
		seen.push(obj.i);
		if (seen.length === 3) break;
	}
	assert.deepEqual(seen, [0, 1, 2]);
});
