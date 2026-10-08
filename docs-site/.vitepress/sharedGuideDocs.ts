import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vitepress";

/**
 * 仓库文档与官网共用的指南页（单一数据源）。
 *
 * 要解决的问题：插件开发指南这类「仓库读者和官网读者都要看」的长文档，一旦两边各存一份，
 * 改一次要同步两处，迟早出现「官网挂着旧版 API、仓库已是新版」。
 *
 * 做法：`docs/host-plugin-dev-guide.md` 是唯一数据源，dev 启动与 build 打包前由本插件
 * 复制为 `docs-site/guide/host-plugins.md`（构建产物，已 gitignore），官网路径 /guide/host-plugins。
 * 与 sharedReadmeImages 同一套机制（configResolved 时机 + 可注入路径 + 缺源硬失败），
 * 差别仅在目标是 markdown 页面而非 publicDir 图片——VitePress 的 srcDir 内页面同样要求
 * 构建前落盘，时机选择理由一致。
 *
 * 指南内禁止使用仓库相对链接（官网侧会变破链），自包含文本即可双向成立。
 */
export const SHARED_GUIDE_DOCS = ["host-plugin-dev-guide.md"] as const;

// 本文件位于 docs-site/.vitepress/，上溯两级为 docs-site/，再上溯一级是仓库根。
const DOCS_SITE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GUIDE_SOURCES_DIR = path.join(path.dirname(DOCS_SITE_DIR), "docs");
const GUIDE_PAGES_DIR = path.join(DOCS_SITE_DIR, "guide");

/** 生成页（guide/<名>.md）对应的站点路由。 */
export function sharedGuideRoute(sourceName: string): string {
	const base = sourceName.replace(/\.md$/, "");
	// host-plugin-dev-guide → /guide/host-plugins（发布名不含 "dev"，面向插件使用者）
	const published: Record<string, string> = { "host-plugin-dev-guide.md": "host-plugins" };
	return `/guide/${published[sourceName] ?? base}`;
}

/** 共用指南在仓库里的绝对路径（唯一数据源）。 */
export function resolveSharedGuideSource(name: string, sourceDir: string = GUIDE_SOURCES_DIR): string {
	return path.join(sourceDir, name);
}

/**
 * 把共用指南同步为站点页面。由插件 configResolved 调用（dev / build 同一实现）。
 * 源文件缺失直接抛错：侧边栏已挂载该路由，静默跳过等于官网上线一条 404。
 */
export function syncSharedGuideDocs(pagesDir: string = GUIDE_PAGES_DIR, sourceDir: string = GUIDE_SOURCES_DIR): void {
	for (const name of SHARED_GUIDE_DOCS) {
		const source = resolveSharedGuideSource(name, sourceDir);
		if (!existsSync(source)) {
			throw new Error(`[pideck-shared-guide-docs] 缺少共用指南 ${source}；官网侧边栏引用了它，构建产物会 404`);
		}
		const route = sharedGuideRoute(name);
		const target = path.join(pagesDir, `${path.posix.basename(route)}.md`);
		mkdirSync(path.dirname(target), { recursive: true });
		copyFileSync(source, target);
	}
}

/** Vite 插件：在 dev / build 把共用指南同步进站点 guide/。用法：`vite: { plugins: [sharedGuideDocsPlugin()] }`。 */
export function sharedGuideDocsPlugin(): Plugin {
	return {
		name: "pideck-shared-guide-docs",

		// 与 sharedReadmeImagesPlugin 同理：必须在 configResolved 落盘，
		// build 的页面发现阶段（buildStart 前）就要能看到目标 md。
		configResolved() {
			syncSharedGuideDocs();
		},

		configureServer(server) {
			// dev 下源文档不在 srcDir 监听范围内，改动需要重新同步并整页刷新。
			server.watcher.add(GUIDE_SOURCES_DIR);
			server.watcher.on("change", (changed: string) => {
				const name = SHARED_GUIDE_DOCS.find((candidate) => path.resolve(changed) === resolveSharedGuideSource(candidate));
				if (!name) return;
				syncSharedGuideDocs();
				server.ws.send({ type: "full-reload" });
			});
		},
	};
}
