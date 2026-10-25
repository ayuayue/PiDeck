/**
 * XuePromptManager 的 Go 通道接入与降级语义回归测试。
 *
 * 覆盖 #2 接入层三种形态：dbStore 未就绪返回空态（渲染层显示下载/重试）、
 * Go 通道失败静默回退 sql.js（商店永不可用性归零）、Go 通道可用时直接采用
 * sidecar 结果。db 用真实 resources/xueprompts.db（sql.js 路径需要真库）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
				app: { isPackaged: false, getAppPath: () => projectRoot },
			},
			"./PromptManager": {
				PromptManager: class {
					configureWsl() {}
				},
			},
		},
	});
}

const MISSING = { state: "missing" };
const readyState = (path) => ({ state: "ready", path, sha256: null, source: "cache" });

test("dbStore 未就绪：list 返回空态（dbState=missing），detail 返回 null", async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const manager = new XuePromptManager(undefined, () => null, {
		dbStore: { ensureReady: async () => MISSING },
		xueIndex: { list: async () => ({ ok: false, reason: "binary-missing", message: "" }), get: async () => ({ ok: false, reason: "binary-missing", message: "" }) },
	});
	const result = await manager.list({});
	// 注：不能对沙箱返回的数组用 deepEqual（跨 realm 原型不同），断言长度与状态
	assert.equal(result.categories.length, 0);
	assert.equal(result.prompts.length, 0);
	assert.equal(result.dbState, "missing");
	assert.equal(await manager.detail("whatever", ""), null);
});

test("Go 通道失败：静默回退 sql.js，真实库检索照常返回", { skip: !dbAvailable }, async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const goDown = { list: async () => ({ ok: false, reason: "boot-failed", message: "" }), get: async () => ({ ok: false, reason: "boot-failed", message: "" }) };
	const manager = new XuePromptManager(undefined, () => null, { dbStore: { ensureReady: async () => readyState(dbPath) }, xueIndex: goDown });

	const result = await manager.list({ search: "修复" });
	assert.equal(result.dbState, "ready");
	assert.ok(result.categories.length > 0);
	// 命中语义的精确断言由 xuePromptSearch.test.mjs 覆盖；这里只验证降级后检索功能可用
	assert.ok(result.prompts.length > 0);
	// detail 也走 sql.js 兜底
	const detail = await manager.detail("borrow-skill", "编程提示词");
	assert.ok(detail);
	assert.ok(detail.promptContent.length > 0);
});

test("Go 通道可用：直接采用 sidecar 结果并带 dbState=ready", async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const fake = { categories: [{ slug: "cat", name: "分类", count: 1 }], prompts: [{ slug: "s1", title: "来自 Go", category: "分类", subcategory: "", tags: [], description: "d", path: "s1" }], total: 1, page: 1, pageSize: 20 };
	const manager = new XuePromptManager(undefined, () => null, {
		dbStore: { ensureReady: async () => readyState("/cache/fake.db") },
		xueIndex: { list: async () => ({ ok: true, value: fake }), get: async () => ({ ok: false, reason: "request-failed", message: "" }) },
	});
	const result = await manager.list({ search: "任意" });
	assert.equal(result.dbState, "ready");
	assert.equal(result.repoPath, "/cache/fake.db");
	assert.equal(result.prompts[0].title, "来自 Go");
	assert.equal(result.total, 1);
});

test("detail：overlay 命中时经 Go 取 db 回退字段组装 frontmatter", async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const overlayDir = mkdtempSync(join(tmpdir(), "xue-overlay-"));
	try {
		writeFileSync(join(overlayDir, "overlay-slug.md"), "---\ntitle: 覆盖层标题\ndescription: 覆盖层描述\n---\n\n覆盖层正文。\n", "utf8");
		const manager = new XuePromptManager(undefined, () => overlayDir, {
			dbStore: { ensureReady: async () => readyState("/cache/fake.db") },
			xueIndex: {
				list: async () => ({ ok: false, reason: "boot-failed", message: "" }),
				get: async () => ({ ok: true, value: { slug: "overlay-slug", url: "https://example.com/x", title: "db 标题", category: "db 分类", content: "db 正文", description: "db 描述" } }),
			},
		});
		const detail = await manager.detail("overlay-slug", "");
		assert.ok(detail);
		assert.equal(detail.title, "覆盖层标题");
		// fullContent：frontmatter（overlay 的 title/description）+ 覆盖层正文 + db 的 url 来源
		assert.ok(detail.fullContent.includes("title: 覆盖层标题"));
		assert.ok(detail.fullContent.includes("description: 覆盖层描述"));
		assert.ok(detail.fullContent.includes("覆盖层正文"));
		assert.ok(detail.fullContent.includes("https://example.com/x"));
	} finally {
		rmSync(overlayDir, { recursive: true, force: true });
	}
});
