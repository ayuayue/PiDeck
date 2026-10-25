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
