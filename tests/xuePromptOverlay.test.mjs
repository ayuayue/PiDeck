/**
 * XuePromptManager 官方模板覆盖层叠加测试。
 *
 * 提示词商店热更新（PromptStoreUpdater）把远端有差异的模板写进 userData 覆盖层，
 * 查询侧叠加规则（与 scripts/add-builtin-prompts.mjs 的 frontmatter 语义一致）：
 * - 同名 slug：title/description/category 缺省时回退 db 同名条目，promptContent 取覆盖层正文；
 * - 新增 slug：直接以新条目出现在商店列表；
 * - 无覆盖层：行为与纯 db 完全一致（零回归）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testsDir, "..");
const dbPath = join(projectRoot, "resources", "xueprompts.db");
const dbAvailable = existsSync(dbPath);

function loadXuePromptManager() {
	return loadTsCommonJs("src/main/prompts/XuePromptManager.ts", {
		stubs: {
			electron: {
				app: {
					isPackaged: false,
					getAppPath: () => projectRoot,
				},
			},
			// PromptManager 只是被构造，不参与 list/detail；给一个空壳即可
			"./PromptManager": {
				PromptManager: class {
					configureWsl() {}
				},
			},
		},
	});
}

test("detail：覆盖层同名 slug 优先，title 缺省时回退 db，正文为覆盖层内容", { skip: !dbAvailable }, async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const overlayDir = mkdtempSync(join(tmpdir(), "pideck-prompt-overlay-"));
	try {
		// 覆盖 enhance-prompt：只写正文（无 frontmatter），title 应回退 db 里的中文标题
		writeFileSync(join(overlayDir, "enhance-prompt.md"), "# 覆盖层增强正文\n\n（热更新后的新版本）\n", "utf8");
		const manager = new XuePromptManager(undefined, () => overlayDir);

		const detail = await manager.detail("enhance-prompt", "编程提示词");
		assert.ok(detail, "覆盖层存在时 detail 必须返回");
		assert.equal(detail.promptContent, "# 覆盖层增强正文\n\n（热更新后的新版本）\n");
		assert.ok(detail.fullContent.includes("source: xueprompt-overlay"), "fullContent 标记来源为覆盖层");
		// 无 frontmatter → title/description 回退 db 同名条目（商店表格仍显示友好标题）
		assert.ok(detail.title.length > 0 && detail.title !== "enhance-prompt", "title 应回退 db 值");
	} finally {
		rm(overlayDir);
	}
});

test("detail：frontmatter 提供 title/description 时优先于 db", { skip: !dbAvailable }, async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const overlayDir = mkdtempSync(join(tmpdir(), "pideck-prompt-overlay-"));
	try {
		writeFileSync(join(overlayDir, "enhance-prompt.md"), "---\ntitle: 覆盖层新标题\ndescription: 覆盖层新描述\n---\n\n# 正文\n", "utf8");
		const manager = new XuePromptManager(undefined, () => overlayDir);

		const detail = await manager.detail("enhance-prompt", "编程提示词");
		assert.equal(detail.title, "覆盖层新标题");
		assert.equal(detail.description, "覆盖层新描述");
		// frontmatter 分隔后正文保留前导换行（解析器行为），trimStart 后对比可读内容
		assert.equal(detail.promptContent.trimStart(), "# 正文\n");
	} finally {
		rm(overlayDir);
	}
});

test("list：覆盖层新增 slug 直接出现在商店列表", { skip: !dbAvailable }, async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const overlayDir = mkdtempSync(join(tmpdir(), "pideck-prompt-overlay-"));
	try {
		writeFileSync(join(overlayDir, "brand-new.md"), "---\ntitle: 全新模板\ndescription: 远端新增的模板\n---\n\n# 全新内容\n", "utf8");
		const manager = new XuePromptManager(undefined, () => overlayDir);

		// 用搜索词定位新增条目（全量 4000+ 条按 category,title 排序，brand-new 会被分页截断）
		const result = await manager.list({ category: "编程提示词", search: "全新模板", page: 1, pageSize: 20 });
		const hit = result.prompts.find((item) => item.slug === "brand-new");
		assert.ok(hit, `期望商店列表出现新增 slug=brand-new，实际命中 [${result.prompts.map((p) => p.slug).join(", ")}]`);
		assert.equal(hit.title, "全新模板");
		assert.equal(result.total, 1, "搜索后 total 基于过滤后集合");
	} finally {
		rm(overlayDir);
	}
});

test("list：覆盖层为空时行为与纯 db 一致（无覆盖层零回归）", { skip: !dbAvailable }, async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const manager = new XuePromptManager(undefined, () => null);
	const result = await manager.list({ category: "编程提示词", page: 1, pageSize: 20 });
	assert.ok(result.prompts.length > 0);
});

/** 清理临时目录（Windows 上文件刚写完可能被句柄占用，失败也容忍）。 */
function rm(dir) {
	try {
		require("node:fs").rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}
