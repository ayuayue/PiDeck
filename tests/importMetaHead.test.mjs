import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 导入标记的有界头部读取（importMetaHead）。
 *
 * 2026-09 大会话闪退的第二个入口：各导入器判断「源是否已导入」时，原先用
 * `readFile(targetPath, "utf8")` 整读**导入产物**再看前 8 行。而 targetPath 正是那份
 * Codex/Claude 导入出来的 1GB 会话文件 → 主进程建出 1GB 字符串 → 撞 384MB 老生代堆
 * → V8 FatalProcessOutOfMemory **abort 主进程**（无堆栈，表现为应用闪退）。
 *
 * 这里锁死「只读固定头部字节」这一契约：只要有人改回整读，字节数断言立即失败。
 */

const mod = loadTsCommonJs("src/main/sessions/importMetaHead.ts");
const { readImportMetaHead, IMPORT_META_HEAD_BYTES } = mod;

/** 在临时目录写一个导入产物：head（session + import 标记）+ 可选填充正文。 */
async function makeImportedFile({ type = "codex_import", paddingMb = 0, marker = true } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-import-meta-"));
	const file = join(dir, "imported.jsonl");
	const head =
		[
			JSON.stringify({ type: "session", version: 3, id: "sess_x", cwd: "/proj" }),
			...(marker
				? [
						JSON.stringify({
							type,
							version: 1,
							sourcePath: "/src.jsonl",
							sourceMtime: 1756800000000,
							sourceSize: 998877,
						}),
					]
				: []),
		].join("\n") + "\n";
	await writeFile(file, head);
	if (paddingMb > 0) {
		// 追加大量正文：模拟导入产物本身就是大会话（旧实现的触发条件）
		const chunk = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			message: { role: "assistant", content: [{ type: "text", text: "中文填充内容".repeat(200) }] },
		})}\n`;
		const repeats = Math.ceil((paddingMb * 1024 * 1024) / Buffer.byteLength(chunk));
		const handle = await open(file, "a");
		try {
			for (let i = 0; i < repeats; i += 1) await handle.write(chunk, null, "utf8");
		} finally {
			await handle.close();
		}
	}
	return { dir, file };
}

test("readImportMetaHead: 命中标记时返回 sourceMtime / sourceSize", async () => {
	const { dir, file } = await makeImportedFile();
	try {
		const meta = await readImportMetaHead(file, "codex_import");
		// 注意：vm 沙箱里的对象有独立原型，不能与字面量做 deepEqual（会报同构但非同一引用）
		assert.equal(meta?.sourceMtime, 1756800000000);
		assert.equal(meta?.sourceSize, 998877);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readImportMetaHead: type 不匹配返回 undefined（各导入器互不误判）", async () => {
	const { dir, file } = await makeImportedFile({ type: "claude_import" });
	try {
		assert.equal(await readImportMetaHead(file, "codex_import"), undefined);
		const claudeMeta = await readImportMetaHead(file, "claude_import");
		assert.equal(claudeMeta?.sourceMtime, 1756800000000);
		assert.equal(claudeMeta?.sourceSize, 998877);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readImportMetaHead: 文件不存在 / 无标记返回 undefined（视为尚未导入）", async () => {
	const { dir, file } = await makeImportedFile({ marker: false });
	try {
		assert.equal(await readImportMetaHead(file, "codex_import"), undefined);
		assert.equal(await readImportMetaHead(join(dir, "missing.jsonl"), "codex_import"), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readImportMetaHead: 大会话上只读头部固定字节（不得整读，否则主进程 abort）", async () => {
	const { dir, file } = await makeImportedFile({ paddingMb: 8 });
	try {
		// 直接统计读取的字节数：用 fs 替身包一层 open，断言 read 的 length 有上界
		let maxRead = 0;
		const headMod = loadTsCommonJs("src/main/sessions/importMetaHead.ts", {
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
				},
			},
		});
		const meta = await headMod.readImportMetaHead(file, "codex_import");
		assert.equal(meta?.sourceMtime, 1756800000000);
		assert.equal(meta?.sourceSize, 998877);
		assert.ok(maxRead <= headMod.IMPORT_META_HEAD_BYTES, `单次读取不得超过头部上限（实际 ${maxRead}，上限 ${headMod.IMPORT_META_HEAD_BYTES}）`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("头部上限足够小：与文件体积解耦（常量守卫）", () => {
	// 上限必须远小于大会话（否则改常量就等于改回整读）
	assert.ok(IMPORT_META_HEAD_BYTES <= 1024 * 1024, "头部读取上限不应超过 1MB");
	assert.ok(IMPORT_META_HEAD_BYTES >= 4096, "上限过小会读不到 import 标记");
});

test("各导入器都走有界读取，源码中不再整读导入产物", async () => {
	const { readFile } = await import("node:fs/promises");
	const files = ["src/main/sessions/CodexSessionImporter.ts", "src/main/sessions/ClaudeSessionImporter.ts", "src/main/sessions/OpenCodeSessionImporter.ts", "src/main/sessions/ZCodeSessionImporter.ts", "src/main/sessions/cursorSessionSource.ts", "src/main/sessions/workbuddySessionSource.ts"];
	for (const file of files) {
		const source = (await readFile(file, "utf8"))
			// 剥掉注释与字符串，避免文档里提到的反例被误判
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/"(?:[^"\\]|\\.)*"/g, '""');
		// 原实现的特征写法：readFile(targetPath, "utf8") 后 split + slice(0, 8)
		assert.doesNotMatch(source, /readFile\(targetPath/, `${file} 仍在整读导入产物（1GB 会话会让主进程 abort）`);
		assert.match(source, /readImportMetaHead/, `${file} 未使用有界读取`);
	}
});
