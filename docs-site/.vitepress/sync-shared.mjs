import { syncSharedGuideDocs } from "./sharedGuideDocs.ts";
import { syncSharedReadmeImages } from "./sharedReadmeImages.ts";

/**
 * 构建前置同步：共用指南（docs/host-plugin-dev-guide.md → docs-site/guide/host-plugins.md）
 * 与共用图片（docs/images/* → docs-site/public/images/*）。
 *
 * 为什么不放在 Vite 插件的 configResolved 里：
 * VitePress 在读取配置的阶段就已经把 srcDir 下的页面 glob 收进内存了，插件钩子拿到的
 * 时机晚于页面发现——本地因为文件残留看着正常，CI 干净检出上则整页不会生成（线上
 * /guide/host-plugins 长期 404，sitemap 里也一直没有它）。同步必须跑在 vitepress 启动之前，
 * 因此由 package.json 的 docs:dev / docs:build 显式先执行本脚本。
 *
 * 直接导入 .ts：Node 24 的类型剥离可以直接加载这两个模块，避免把常量表和路径解析再抄一份。
 */
syncSharedReadmeImages();
syncSharedGuideDocs();

console.log("[sync-shared] 共用指南与共用图片已同步");
