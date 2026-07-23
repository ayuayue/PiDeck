import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * KaTeX 字体精简 Vite 插件
 *
 * katex.min.css 中的每个 @font-face 声明了三种格式（woff2 / woff / truetype），
 * Electron 的 Chromium 只需 woff2（最高压缩比）。本插件在构建时移除 woff 和 truetype
 * 的 src 引用，使 Vite 不再将 .ttf 和 .woff 文件复制到产物目录。
 *
 * 效果：59 个字体文件 → 19 个 woff2 文件，节省 ~1.2MB。
 */
function katexWoff2OnlyPlugin(): Plugin {
	const KATEX_CSS = /katex[\\\/]dist[\\\/]katex\.min\.css/;
	// 匹配 @font-face 块，提取 src 属性中仅保留 woff2 的 url
	const FONT_FACE_RE =
		/@font-face\s*\{([^}]*?src\s*:\s*)([^}]*?)\};?/gi;

	return {
		name: "katex-woff2-only",
		enforce: "pre",
		transform(code, id) {
			if (!KATEX_CSS.test(id)) return;

			const replaced = code.replace(FONT_FACE_RE, (_match, prefix, srcValue) => {
				// 从 src 中提取 woff2 的 url() 部分
				const woff2Match = srcValue.match(/url\([^)]+\)\s*format\(['"]?woff2['"]?\)/i);
				if (!woff2Match) {
					// 没有 woff2 格式（理论上不存在）→ 仅保留 url() 引用，去掉 format 声明
					const firstUrl = srcValue.match(/url\([^)]+\)/i);
					if (firstUrl) return `@font-face{${prefix}${firstUrl[0]};}`;
					return _match;
				}
				// 只保留 woff2 这一行，去掉后续的逗号和其它格式
				return `@font-face{${prefix}${woff2Match[0]};}`;
			});

			return { code: replaced, map: null };
		},
	};
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    // Windows 上 localhost 可能优先解析到 IPv6 ::1，Electron 加载 dev server 时会超时；固定 IPv4 保证本机访问稳定。
    server: {
      host: "127.0.0.1",
      // 5173 落在部分 Windows/Hyper-V 动态端口排除范围内时会 EACCES；使用相邻的未保留端口保证 dev server 可监听。
      port: 5181,
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react(), katexWoff2OnlyPlugin()],
    build: {
      // 不计算 gzip 压缩后大小（节约构建时间）
      reportCompressedSize: false,
      // CSS 压缩使用 esbuild（比 cssnano 快）
      cssMinify: "esbuild",
      rollupOptions: {
        // 缓存模块解析结果，增量构建时跳过未变更模块，加速二次打包
        cache: true,
        // 多入口：主窗口 index.html + 桌面宠物悬浮窗 pet.html
        input: {
          index: resolve("src/renderer/index.html"),
          pet: resolve("src/renderer/pet.html"),
        },
        output: {
          // 将大体积的第三方依赖拆分为独立 chunk，减少首屏需要加载和解析的 JS 体积。
          // 拆分策略：React 全家桶、Monaco Editor、图标库、Markdown 渲染栈各归一类。
          // 利用 Rollup 的 chunk 缓存机制：vendor 不变时浏览器复用缓存，加快二次加载。
          // Mermaid 已在渲染层用 dynamic import 惰性加载，此处不额外聚合，避免破坏已有 code splitting。
          manualChunks(id) {
            if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/scheduler/")) {
              return "vendor-react";
            }
            if (id.includes("/node_modules/monaco-editor/")) {
              return "vendor-monaco";
            }
            if (id.includes("/node_modules/lucide-react/")) {
              return "vendor-icons";
            }
            if (id.includes("/node_modules/react-markdown/") || id.includes("/node_modules/remark-") || id.includes("/node_modules/rehype-") || id.includes("/node_modules/unified/") || id.includes("/node_modules/katex/") || id.includes("/node_modules/mdast-") || id.includes("/node_modules/hast-") || id.includes("/node_modules/micromark-") || id.includes("/node_modules/vfile") || id.includes("/node_modules/unist-") || id.includes("/node_modules/trough") || id.includes("/node_modules/bail") || id.includes("/node_modules/dequal") || id.includes("/node_modules/devlop") || id.includes("/node_modules/html-to-image/")) {
              return "vendor-markdown";
            }
          },
        },
      },
    },
  },
});