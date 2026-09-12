import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

/**
 * main+preload-only 构建配置（npm run build:main）。
 *
 * 用途：dev 监听失效（本机 electron-vite dev 的 watcher 偶发不再响应 src/main
 * 变更）或只想快速验证主进程改动时，~4 秒重建 out/main + out/preload——
 * 全量 electron-vite build 的耗时几乎全在渲染层 7600+ 模块 transform。
 *
 * 约束：main/preload 段与 electron.vite.config.ts 严格同构（entry/external/
 * define 不许漂移），仅省略 renderer——不写 out/renderer，与运行中的 dev
 * server 无冲突；改完重启应用（或等 dev 重启）即生效。
 * 回归锚点：tests/dshMainEntries.test.mjs 会校验 main.lib.entry 覆盖全部
 * join(__dirname) 稳定文件引用——两边 entry 必须同步维护。
 */
export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			lib: {
				entry: {
					index: resolve(__dirname, "src/main/index.ts"),
					hostEntry: resolve(__dirname, "src/main/dsh/hostEntry.ts"),
					runnerConsolePreload: resolve(__dirname, "src/main/dsh/runnerConsolePreload.ts"),
					pideckPluginBridge: resolve(__dirname, "src/main/dsh/pideckPluginBridge.ts"),
					pideckCommandsBridge: resolve(__dirname, "src/main/dsh/pideckCommandsBridge.ts"),
					// hostEntry 的 Loader 行按 join(__dirname, "pideckSessionBridge.js") 引用本文件；
					// 只作为静态 import 时 rollup 会打成带 hash 的共享 chunk，Loader 行找不到文件
					// （out/main 被清空重建后必然复现），必须保持独立入口产出稳定文件名。
					pideckSessionBridge: resolve(__dirname, "src/main/dsh/pideckSessionBridge.ts"),
				},
				formats: ["cjs"],
			},
			rollupOptions: {
				// @deepseek-ai/dsh 的子包（dsh-app-boot / dsh-llm / cordis 等）不在
				// package.json 顶层 dependencies，externalizeDepsPlugin 只外置
				// `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh/...`，不会匹配
				// `@deepseek-ai/dsh-app-boot`。打进 out/main 后 import.meta.url
				// 变成产物路径，createRequire(...)("../package.json") 会报
				// Cannot find module '../package.json'（发送 DSH 消息即触发）。
				external: [/^@deepseek-ai\//, "dsh-tool-pwsh-persistent", "dsh-bill"],
			},
		},
		define: {
			// 构建标记：npm run dist:win:dev 打包时注入 true，用于隔离 dev 构建的配置目录与 AppUserModelID。
			__PIDECK_DEV_BUILD__: JSON.stringify(process.env.PIDECK_DEV_BUILD === "1"),
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
	},
});
