import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Plugin 类型从 vitepress 取（它转导出自己依赖的那份 vite）：仓库根 node_modules/vite 与
// vitepress/node_modules/vite 是两个副本，直接 import "vite" 的 Plugin 无法赋给 config.vite.plugins。
import type { Plugin } from "vitepress";

/**
 * README 与官网共用的图片（单一数据源）。
 *
 * 要解决的问题：README 用仓库相对路径 `docs/images/wechat-qrcode.png` 引用，官网用站点根路径
 * `/images/wechat-qrcode.png`。两者指向不同物理位置，微信群二维码这类需要周期性更换的图片
 * 一旦两边各存一份，迟早出现「README 换了新图、官网还挂着过期二维码」。
 *
 * 做法：`docs/images/<名>` 是唯一数据源，在 dev 启动与 build 打包前由本插件复制一份到
 * `docs-site/public/images/<名>`（构建产物，已 gitignore）。为什么不走 Vite 别名 /
 * 自定义中间件：markdown 里的绝对路径 `/images/x.png` 由 @vitejs/plugin-vue 的 asset url
 * 转换在**打包阶段**解析，只存在于 publicDir 才会被当成公共资源放行（否则报
 * "Rollup failed to resolve import"），dev 侧还得再维护一条中间件——两套解析路径迟早不一致，
 * 而生成物放在 publicDir 让 dev / build / sitemap 走与现有 wechat_pay.png 完全相同的链路。
 *
 * 与 wechat_pay.png 那种「两份拷贝长期共存」的历史做法不同，这里第二份是生成物、不进版本库，
 * 更新二维码只需要覆盖 `docs/images/` 下那一个文件。
 *
 * 白名单显式列名（而不是整目录透传）：docs/images 下还有赞助商 logo 等只服务于仓库文档的图，
 * 不该被顺手发布到公网站点。官网单独引用的功能截图（config/files/overview/...）也走同一白名单：
 * 它们的源同样在 docs/images，public 下的副本只是构建产物，不再入库。
 */
export const SHARED_README_IMAGES = [
	"wechat-qrcode.png",
	"gpt-recharge-price.png",
	"config.png",
	"files.png",
	"overview.png",
	"slash-commands.png",
	"terminal.png",
	"wechat_pay.png",
] as const;

// 本文件位于 docs-site/.vitepress/，上溯两级为 docs-site/，再上溯一级是仓库根。
// 不用相对 cwd 的路径：docs:dev / docs:build 的 cwd 虽然是仓库根，但构建脚本可能改。
const DOCS_SITE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHARED_IMAGES_DIR = path.join(path.dirname(DOCS_SITE_DIR), "docs", "images");

/** 共用图片在仓库里的绝对路径（唯一数据源）。 */
export function resolveSharedImageSource(name: string, sourceDir: string = SHARED_IMAGES_DIR): string {
	return path.join(sourceDir, name);
}

/**
 * 把这些共用图片同步到站点 publicDir（`docs-site/public/images/`）。
 *
 * 由插件的 configResolved 调用（dev 启动与 build 打包的最早期阶段），
 * 因此 dev 与 build 用的是同一份实现，不存在「dev 能看到、打包后丢图」这类只在一种模式下暴露的问题。
 *
 * 源文件缺失直接抛错而不是跳过：官网首页与 README 都引用了它，
 * 静默跳过等于把一张破图发到线上（构建产物里那个路径也会直接 404）。
 *
 * sourceDir / publicDir 可注入（默认取仓库真实路径），便于单测用临时目录驱动成功 / 缺失两条分支。
 */
export function syncSharedReadmeImages(
	publicDir: string = path.join(DOCS_SITE_DIR, "public"),
	sourceDir: string = SHARED_IMAGES_DIR,
): void {
	for (const name of SHARED_README_IMAGES) {
		const source = resolveSharedImageSource(name, sourceDir);
		if (!existsSync(source)) {
			throw new Error(
				`[pideck-shared-readme-images] 缺少共用图片 ${source}；README 与官网首页引用了它，构建产物会显示破图`,
			);
		}
		const target = path.join(publicDir, "images", name);
		mkdirSync(path.dirname(target), { recursive: true });
		copyFileSync(source, target);
	}
}

/**
 * Vite 插件：在 dev / build 把 README 共用图片同步进站点 publicDir。
 * 用法：`vite: { plugins: [sharedReadmeImagesPlugin()] }`。
 */
export function sharedReadmeImagesPlugin(): Plugin {
	return {
		name: "pideck-shared-readme-images",

		// 同步必须发生在 configResolved：Vite 在 createServer 一开始就把 publicDir 的文件清单
		// 快照进内存（`initPublicFiles`），之后落盘的文件不会被当成公共资源（dev 下会回落成
		// index.html 的 SPA fallback，build 下 asset url 转换直接报解析失败）。
		// 这个钩子在 resolveConfig 阶段执行，早于 buildStart 与 configureServer，dev / build 都够早。
		configResolved() {
			syncSharedReadmeImages();
		},

		configureServer(server) {
			// dev 下源图（docs/images）不在 publicDir 的监听范围内，
			// 改动它需要重新同步一次，否则页面上的二维码要等重启才更新。
			server.watcher.add(SHARED_IMAGES_DIR);
			server.watcher.on("change", (changed: string) => {
				const name = SHARED_README_IMAGES.find(
					(candidate) => path.resolve(changed) === resolveSharedImageSource(candidate),
				);
				if (!name) return;
				syncSharedReadmeImages();
				server.ws.send({ type: "full-reload" });
			});
		},
	};
}
