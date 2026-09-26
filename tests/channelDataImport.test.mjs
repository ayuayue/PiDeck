/**
 * 数据导入管线单测（真实 tmp 目录，不 mock fs）：
 * - planImportItems：按存在性过滤 + 受限 glob（pi-desktop/feishu*.json）展开 + 目录字节递归求和；
 * - estimateImportBytes：清单项字节汇总；
 * - copyImportItems：逐项复制后目标结构与源一致（walk 比对）+ done 进度；
 * - 取消：抛 ImportCancelledError，已复制内容保留（规格 §6「取消保留已建目录」）；
 * - 跳过清单不进入 items（白名单语义 + IMPORT_SKIP_PATHS 双保险）；
 * - R7：IMPORT_PATHS 的 prompts overlay 项取自 promptStoreUpdater 现有常量（含 .bak），不硬编码猜测。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const { IMPORT_PATHS, IMPORT_SKIP_PATHS, ImportCancelledError, planImportItems, estimateImportBytes, copyImportItems, runImport } = load("src/main/dataEnv/channelDataImport.ts");
const { PROMPT_OVERLAY_DIR_NAME, PROMPT_OVERLAY_BACKUP_DIR_NAME } = load("src/main/prompts/promptStoreUpdater.ts");

/** 建一次性临时目录，测试结束后清理。 */
function makeTempDir(t, prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** 递归收集相对文件路径（/ 分隔，排序后用于结构比对）。 */
function walkFiles(root) {
	const out = [];
	const walk = (dir, rel) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(join(dir, entry.name), childRel);
			else out.push(childRel);
		}
	};
	walk(root, "");
	return out.sort();
}

test("planImportItems 按存在性过滤并展开 feishu glob", (t) => {
	const root = makeTempDir(t, "pideck-import-plan-");
	writeFileSync(join(root, "settings.json"), "0123456789", "utf8"); // 存在
	// projects.json 不写（不存在 → 过滤掉）
	mkdirSync(join(root, "pi-desktop"));
	writeFileSync(join(root, "pi-desktop", "feishu-a.json"), "{}", "utf8");
	writeFileSync(join(root, "pi-desktop", "feishu-b.json"), "{}", "utf8");
	writeFileSync(join(root, "pi-desktop", "feishu-notes.txt"), "not json", "utf8"); // 受限 glob 只吃 *.json

	const rels = planImportItems(root).map((item) => item.relPath);
	assert.ok(rels.includes("settings.json"));
	assert.ok(rels.includes("pi-desktop/feishu-a.json"));
	assert.ok(rels.includes("pi-desktop/feishu-b.json"));
	assert.ok(!rels.includes("projects.json"));
	assert.ok(!rels.includes("pi-desktop/feishu-notes.txt"));
});

test("estimateImportBytes 汇总文件与目录字节数", (t) => {
	const root = makeTempDir(t, "pideck-import-bytes-");
	writeFileSync(join(root, "settings.json"), "0123456789", "utf8"); // 10 字节
	mkdirSync(join(root, "chat-workspace"));
	writeFileSync(join(root, "chat-workspace", "a.json"), "12345", "utf8"); // 5 字节
	writeFileSync(join(root, "chat-workspace", "b.json"), "12345", "utf8"); // 5 字节

	const items = planImportItems(root);
	assert.equal(estimateImportBytes(items), 20);
	const dirItem = items.find((item) => item.relPath === "chat-workspace");
	assert.equal(dirItem.isDir, true);
	assert.equal(dirItem.bytes, 10);
});

test("copyImportItems 逐项复制后目标结构与源一致", async (t) => {
	const source = makeTempDir(t, "pideck-import-src-");
	const target = makeTempDir(t, "pideck-import-dst-");
	writeFileSync(join(source, "settings.json"), '{"k":1}', "utf8");
	mkdirSync(join(source, "chat-workspace", "sub"), { recursive: true });
	writeFileSync(join(source, "chat-workspace", "a.json"), "aaa", "utf8");
	writeFileSync(join(source, "chat-workspace", "sub", "b.json"), "bbb", "utf8");

	const items = planImportItems(source);
	const progress = [];
	await copyImportItems(source, target, items, { onProgress: (p) => progress.push(p), isCancelled: () => false, totalBytes: estimateImportBytes(items) });

	assert.deepEqual(walkFiles(target), walkFiles(source));
	assert.equal(progress.at(-1).phase, "done");
	assert.equal(progress.at(-1).copiedBytes, progress.at(-1).totalBytes);
});

test("取消：抛 ImportCancelledError，已复制内容保留", async (t) => {
	const source = makeTempDir(t, "pideck-import-cancel-");
	const target = makeTempDir(t, "pideck-import-cancel-dst-");
	writeFileSync(join(source, "settings.json"), '{"k":1}', "utf8");
	writeFileSync(join(source, "session-catalog.json"), '{"sessions":[]}', "utf8");

	let cancelChecks = 0;
	await assert.rejects(runImport(source, target, { onProgress: () => {}, isCancelled: () => ++cancelChecks > 1 }), (error) => error instanceof ImportCancelledError);
	// 第 1 项已复制保留，第 2 项未开始
	const copied = walkFiles(target);
	assert.ok(copied.includes("settings.json"));
	assert.ok(!copied.includes("session-catalog.json"));
});

test("跳过清单不进入 items（instance-locks/、logs/ 存在也不出现）", (t) => {
	const root = makeTempDir(t, "pideck-import-skip-");
	writeFileSync(join(root, "settings.json"), "{}", "utf8");
	mkdirSync(join(root, "instance-locks"));
	writeFileSync(join(root, "instance-locks", "0.8.0.lock"), "x", "utf8");
	mkdirSync(join(root, "logs"));
	writeFileSync(join(root, "logs", "app.log"), "x", "utf8");

	// Array.from 落回外层 realm：vm 沙箱数组与字面量数组原型不同，deepStrictEqual 会误报
	const rels = Array.from(planImportItems(root), (item) => item.relPath);
	assert.deepEqual(rels, ["settings.json"]);
	assert.ok(IMPORT_SKIP_PATHS.includes("instance-locks/"));
	assert.ok(IMPORT_SKIP_PATHS.includes("logs/"));
});

test("R7：IMPORT_PATHS 的 prompts overlay 项取自 promptStoreUpdater 现有常量（含 .bak 整目录）", () => {
	assert.ok(IMPORT_PATHS.includes(`${PROMPT_OVERLAY_DIR_NAME}/`));
	assert.ok(IMPORT_PATHS.includes(`${PROMPT_OVERLAY_BACKUP_DIR_NAME}/`));
});
