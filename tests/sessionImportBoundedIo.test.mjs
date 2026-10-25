import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 导入器「扫描/导入大源文件」的有界 IO 回归（2026-09 第三次同类闪退）。
 *
 * 背景：Claude / Cursor / WorkBuddy 三个导入器的 `scan()` 原先对**每个源文件**
 * `readFile(file, "utf8")` 全量解析，且用 `Promise.all` 并发。Codex 早在
 * 2e08da81 就改成「头部有界 + 分块并发 + 流式导入」，另外三家一直没跟上。
 *
 * 后果（主进程 V8 老生代堆被钉在 384MB）：
 *  - 单个大源文件整读 → 建出几百 MB 字符串 → `FatalProcessOutOfMemory`
 *    **abort 主进程**（无堆栈，用户看到应用闪退）；
 *  - 并发是**乘数**：12 个 60MB 文件并行整读 = 720MB，同样 abort（实测 exit 134）。
 *
 * 因此这里锁两条不变式：
 *  1. 扫描只读头部固定字节，且并发有上限（不得再出现 readFile 整读 + Promise.all）；
 *  2. 导入走流式（逐行读、批量写），内存与文件体积解耦。
 *
 * 这些用例**不造大文件**（CI 上不该为了验证有界性写几百 MB）：
 * 用 fs 替身统计真实读取的字节量，字节上界一旦失效立即失败。
 */

const importerFiles = ["src/main/sessions/ClaudeSessionImporter.ts", "src/main/sessions/CursorSessionImporter.ts", "src/main/sessions/WorkBuddySessionImporter.ts", "src/main/sessions/cursorSessionSource.ts", "src/main/sessions/workbuddySessionSource.ts"];

/** 剥掉注释与字符串字面量：守卫断言要针对代码，而不是解释性文字。 */
function stripCommentsAndStrings(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

test("三个导入器的 scan 都不得整读源文件，也不得用 Promise.all 并发读", () => {
	for (const file of importerFiles) {
		const source = stripCommentsAndStrings(readFileSyncUtf8(file));
		// readFile(...utf8) 是整读特征；导入器里只允许头部/流式读取
		assert.doesNotMatch(source, /readFile\s*\(/, `${file} 仍在整读源文件（大文件会 abort 主进程）`);
	}
});

test("scan 使用有界并发 + 头部读取；导入使用流式读取", () => {
	for (const file of importerFiles) {
		const source = stripCommentsAndStrings(readFileSyncUtf8(file));
		if (source.includes("async scan(")) {
			assert.match(source, /mapWithConcurrency\(/, `${file} 的 scan 必须用有界并发`);
			assert.match(source, /SESSION_SCAN_CONCURRENCY/, `${file} 的 scan 必须引用并发上限常量`);
		}
	}
	// 导入路径必须是逐行流式（readJsonlObjects）+ 批量写（createBufferedLineSink）
	for (const file of ["src/main/sessions/ClaudeSessionImporter.ts", "src/main/sessions/CursorSessionImporter.ts", "src/main/sessions/WorkBuddySessionImporter.ts"]) {
		const source = stripCommentsAndStrings(readFileSyncUtf8(file));
		assert.match(source, /readJsonlObjects\(/, `${file} 的导入必须逐行流式读取`);
		assert.match(source, /createBufferedLineSink\(/, `${file} 的导入必须批量写盘`);
	}
});

/** 同步读源文件（仅测试自身使用；生产代码禁止整读会话文件）。 */
function readFileSyncUtf8(path) {
	return readFileSync(path, "utf8");
}

test("readSessionSourceHead 只读头部固定字节：文件再大读取量也不变", async () => {
	const { readSessionSourceHead, SESSION_SCAN_HEAD_BYTES } = loadTsCommonJs("src/main/sessions/sessionSourceHead.ts");
	const dir = await mkdtemp(join(tmpdir(), "pideck-scanhead-"));
	try {
		// 造一个「头部 + 大尾部」的文件；用 fs 替身统计真实读取字节
		const file = join(dir, "big.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "session", id: "s" })}\n`);
		const h = await open(file, "a");
		const filler = `${"x".repeat(4096)}\n`;
		for (let i = 0; i < 512; i += 1) await h.write(filler, null, "utf8"); // 2MB 尾部
		await h.close();

		let maxRead = 0;
		const patched = loadTsCommonJs("src/main/sessions/sessionSourceHead.ts", {
			stubs: {
				"node:fs/promises": {
					open: async (...args) => {
						const handle = await open(...args);
						return {
							read: (buffer, offset, length, position) => {
								maxRead = Math.max(maxRead, length);
								return handle.read(buffer, offset, length, position);
							},
							close: () => handle.close(),
						};
					},
					stat,
				},
			},
		});
		const result = await patched.readSessionSourceHead(file);
		assert.ok(maxRead <= SESSION_SCAN_HEAD_BYTES, `单次读取不得超过头部上限（实际 ${maxRead}，上限 ${SESSION_SCAN_HEAD_BYTES}）`);
		assert.ok(Buffer.byteLength(result.head) <= SESSION_SCAN_HEAD_BYTES);
		// size 是真实文件大小（摘要/状态判定要用），与读取量无关
		assert.equal(result.size, (await stat(file)).size);
		assert.ok(result.size > 2 * 1024 * 1024, "夹具应大于头部上限");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("mapWithConcurrency 真的限制并发峰值，且结果顺序与输入一致", async () => {
	const { mapWithConcurrency } = loadTsCommonJs("src/main/sessions/sessionSourceHead.ts");
	let active = 0;
	let peak = 0;
	const items = Array.from({ length: 20 }, (_, i) => i);

	const results = await mapWithConcurrency(items, 3, async (item) => {
		active += 1;
		peak = Math.max(peak, active);
		// 让出事件循环，制造真实的并发窗口
		await new Promise((resolve) => setTimeout(resolve, 1));
		active -= 1;
		return item * 2;
	});

	assert.ok(peak <= 3, `并发峰值不得超过上限（实际 ${peak}）`);
	assert.ok(peak > 1, "应真的有并发（否则退化成串行，扫描会慢）");
	// 注意：vm 沙箱产出的数组有独立原型，不能与字面量 deepEqual（会报同构但非同一引用）
	assert.equal(results.length, items.length);
	results.forEach((value, index) => {
		assert.equal(value, index * 2, `第 ${index} 项应与输入顺序一致`);
	});
});

test("mapWithConcurrency 空输入与单元素不炸", async () => {
	const { mapWithConcurrency } = loadTsCommonJs("src/main/sessions/sessionSourceHead.ts");
	assert.equal((await mapWithConcurrency([], 4, async () => 1)).length, 0);
	const single = await mapWithConcurrency([7], 4, async (v) => v + 1);
	assert.equal(single.length, 1);
	assert.equal(single[0], 8);
});

test("readJsonlObjects 逐行产出对象，且坏行即抛错（导入要严格，不静默丢消息）", async () => {
	const { readJsonlObjects } = loadTsCommonJs("src/main/sessions/sessionSourceHead.ts");
	const dir = await mkdtemp(join(tmpdir(), "pideck-jsonlobj-"));
	try {
		const good = join(dir, "good.jsonl");
		await writeFile(good, [JSON.stringify({ type: "a", n: 1 }), "", JSON.stringify({ type: "b", n: 2 }), "   ", JSON.stringify({ type: "c", n: 3 })].join("\n") + "\n");
		const seen = [];
		for await (const obj of readJsonlObjects(good)) seen.push(obj.type);
		assert.equal(seen.join(","), "a,b,c", "空行跳过，其余按序产出");

		const bad = join(dir, "bad.jsonl");
		await writeFile(bad, `${JSON.stringify({ type: "a" })}\nnot-json{{{\n`);
		await assert.rejects(async () => {
			// eslint-disable-next-line no-unused-vars
			for await (const _ of readJsonlObjects(bad)) {
				// 消费到坏行即抛
			}
		}, /Invalid JSON line/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("三个导入器的 head-only 读取能从头部取出元数据（大文件也是）", async () => {
	const { readSessionSourceHead, SESSION_SCAN_HEAD_BYTES } = loadTsCommonJs("src/main/sessions/sessionSourceHead.ts");
	const dir = await mkdtemp(join(tmpdir(), "pideck-headmeta-"));
	try {
		// 模拟真实形态：元数据在前两行，随后是大量正文
		const file = join(dir, "sess.jsonl");
		await writeFile(file, [JSON.stringify({ type: "message", role: "user", sessionId: "sess_1", cwd: "C:/proj", timestamp: 1756800000000, content: [{ type: "input_text", text: "首条提问" }] }), JSON.stringify({ type: "ai-title", aiTitle: "标题" })].join("\n") + "\n");
		const h = await open(file, "a");
		const filler = `${JSON.stringify({ type: "message", role: "assistant", content: [{ type: "output_text", text: "正文".repeat(50) }] })}\n`;
		for (let i = 0; i < 20000; i += 1) await h.write(filler, null, "utf8");
		await h.close();

		const { head, size } = await readSessionSourceHead(file);
		assert.ok(size > 1024 * 1024, "夹具应超过头部上限");
		const first = JSON.parse(head.split("\n")[0]);
		assert.equal(first.sessionId, "sess_1");
		assert.equal(first.cwd, "C:/proj");
		// 头部包含多行（不是只读一行）
		assert.ok(head.split("\n").filter(Boolean).length >= 2);
		assert.ok(Buffer.byteLength(head) <= SESSION_SCAN_HEAD_BYTES);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("导入产物写入临时文件后原子改名，失败时不留残留", async () => {
	for (const file of ["src/main/sessions/ClaudeSessionImporter.ts", "src/main/sessions/CursorSessionImporter.ts", "src/main/sessions/WorkBuddySessionImporter.ts"]) {
		const source = stripCommentsAndStrings(readFileSyncUtf8(file));
		// 直接写目标文件会在失败时留下半截会话（污染列表）；必须 tmp + rename
		assert.match(source, /renameWithRetry\(/, `${file} 必须用临时文件 + 原子改名`);
		assert.match(source, /rm\(tempPath/, `${file} 失败时必须清理临时文件`);
	}
});

test("共享 helper 的并发/头部常量在合理区间", async () => {
	const mod = loadTsCommonJs("src/main/sessions/sessionSourceHead.ts");
	assert.ok(mod.SESSION_SCAN_HEAD_BYTES >= 4096, "头部上限过小读不到元数据");
	assert.ok(mod.SESSION_SCAN_HEAD_BYTES <= 1024 * 1024, "头部上限不应超过 1MB");
	assert.ok(mod.SESSION_SCAN_CONCURRENCY >= 1 && mod.SESSION_SCAN_CONCURRENCY <= 16, "并发上限应在 1..16（内存峰值 = 并发 × 头部缓冲）");
});

test("readFile 不再出现在导入器的导入语句里（防止回退整读）", async () => {
	const { readFile } = await import("node:fs/promises");
	for (const file of importerFiles) {
		const source = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		const importLines = source.split("\n").filter((l) => l.trim().startsWith("import"));
		for (const line of importLines) {
			assert.doesNotMatch(line, /\breadFile\b/, `${file} 的 import 里仍带 readFile：${line.trim()}`);
		}
	}
});
