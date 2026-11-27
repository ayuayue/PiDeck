import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 统一沙箱必须自己解决解析与身份两件事，测试才能放心复用它。
 *
 * 两条都是维护者在 #613 里用探针实测出来的（手写 require 桥的失败形态）：
 *
 * ① 目录导入：`import { X } from "./lib"`（lib 是目录 + index.ts）。手写解析把 "./lib"
 *    解析成目录本身再读文件 —— 报 EISDIR，整片测试在加载阶段失败。
 * ② 菱形依赖：a 引 b 和 c，b、c 都引 leaf。手写桥给每个 specifier 各自一份缓存，
 *    于是 b.leaf !== c.leaf；真实模块语义是同一份实例。引用比较为 false 时
 *    instanceof、模块级单例、atom 身份判断全部失真，而单元断言照样能过。
 */
function fixture(files) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-sandbox-"));
	for (const [name, source] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, source, "utf8");
	}
	return dir;
}

test("目录导入按 index.ts 解析，不再把目录当文件读", (t) => {
	const dir = fixture({
		"lib/index.ts": "export const answer = 42;\n",
		"entry.ts": 'import { answer } from "./lib";\nexport const value = answer;\n',
	});
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// 陷阱本身存在：把目录当文件读就是 EISDIR（手写解析器的失败形态）。
	assert.throws(() => readFileSync(join(dir, "lib"), "utf8"), /EISDIR|illegal operation/i);
	assert.equal(createTsSandbox()(join(dir, "entry.ts")).value, 42);
});

test("菱形依赖的两个分支拿到同一份模块实例", (t) => {
	const dir = fixture({
		"leaf.ts": "export const singleton = { hits: 0 };\n",
		"b.ts": 'import { singleton } from "./leaf";\nexport const fromB = singleton;\n',
		"c.ts": 'import { singleton } from "./leaf";\nexport const fromC = singleton;\n',
		"entry.ts": 'import { fromB } from "./b";\nimport { fromC } from "./c";\nexport const same = fromB === fromC;\n',
	});
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.equal(createTsSandbox()(join(dir, "entry.ts")).same, true);
});

test("循环依赖：后填入的导出对先读到的那一侧可见", (t) => {
	const dir = fixture({
		"a.ts": 'import { ping } from "./b";\nexport const pong = (n: number) => n + 1;\nexport const call = () => ping(1);\n',
		"b.ts": 'import * as a from "./a";\nexport const ping = (n: number) => a.pong(n);\n',
	});
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const load = createTsSandbox();
	assert.equal(load(join(dir, "a.ts")).call(), 2);
	assert.equal(load(join(dir, "b.ts")).ping(5), 6);
});
