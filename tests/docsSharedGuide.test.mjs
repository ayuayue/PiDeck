/**
 * 仓库文档与官网共用指南页（docs/host-plugin-dev-guide.md → 站点 /guide/host-plugins）的契约测试。
 *
 * 背景：插件开发指南要同时服务仓库读者与官网读者，两份拷贝迟早漂移（官网挂旧 API、仓库已是新版）。
 * 唯一数据源是 docs/host-plugin-dev-guide.md，dev / build 时由 VitePress 插件复制为
 * docs-site/guide/host-plugins.md（生成物，已 gitignore）。这里守护四件事：
 *   1. 唯一数据源真实存在（否则构建期才报错）；
 *   2. 生成的副本不进版本库（避免退化回两份手工同步的文档）；
 *   3. 官网侧边栏已挂载该路由（同步了但没入口等于隐身）；
 *   4. 同步函数在源缺失时硬失败、在正常时逐字复制，不静默跳过或改写。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SHARED_GUIDE_DOCS, sharedGuideRoute, syncSharedGuideDocs } from "../docs-site/.vitepress/sharedGuideDocs.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

test("共用指南源文件存在于 docs/（唯一数据源）", () => {
	for (const name of SHARED_GUIDE_DOCS) {
		const source = join(REPO_ROOT, "docs", name);
		assert.ok(existsSync(source), `缺少 docs/${name}，官网 /guide 路由会 404`);
	}
});

test("生成页被 gitignore，不会退化回两份手工同步的文档", () => {
	const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
	for (const name of SHARED_GUIDE_DOCS) {
		const page = `docs-site/guide/${sharedGuideRoute(name).split("/").pop()}.md`;
		const ignored = gitignore.split("\n").some((line) => line.trim() === page);
		assert.ok(ignored, `.gitignore 未忽略 ${page}`);
	}
});

test("官网侧边栏挂载了共用指南路由", () => {
	const config = readFileSync(join(REPO_ROOT, "docs-site", ".vitepress", "config.mts"), "utf8");
	for (const name of SHARED_GUIDE_DOCS) {
		const route = sharedGuideRoute(name);
		assert.ok(config.includes(`link: "${route}"`), `侧边栏未挂载 ${route}`);
	}
	// 注册了插件（只写 sidebar 不挂插件，生成页永远缺席）
	assert.ok(config.includes("sharedGuideDocsPlugin()"), "config.mts 未注册 sharedGuideDocsPlugin");
});

test("syncSharedGuideDocs 逐字复制源文档为站点页面", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pideck-shared-guide-"));
	try {
		const sourceDir = join(tmp, "source");
		const pagesDir = join(tmp, "guide");
		mkdirSync(sourceDir, { recursive: true });
		for (const name of SHARED_GUIDE_DOCS) {
			writeFileSync(join(sourceDir, name), `---\ntitle: 指南 ${name}\n---\n\n正文 ${name}\n`);
		}

		syncSharedGuideDocs(pagesDir, sourceDir);

		for (const name of SHARED_GUIDE_DOCS) {
			const page = join(pagesDir, `${sharedGuideRoute(name).split("/").pop()}.md`);
			assert.ok(existsSync(page), `未生成 ${page}`);
			assert.equal(readFileSync(page, "utf8"), `---\ntitle: 指南 ${name}\n---\n\n正文 ${name}\n`, "必须逐字复制，不得改写 frontmatter 或正文");
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("源文档缺失时硬失败，不静默跳过", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pideck-shared-guide-missing-"));
	try {
		const emptySource = join(tmp, "empty");
		mkdirSync(emptySource, { recursive: true });

		assert.throws(() => syncSharedGuideDocs(join(tmp, "guide"), emptySource), /缺少共用指南/, "缺源必须抛错，否则官网上线一条 404");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
