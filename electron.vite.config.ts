import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

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
    plugins: [react()],
    build: {
      rollupOptions: {
        // 多入口：主窗口 index.html + 桌面宠物悬浮窗 pet.html
        input: {
          index: resolve("src/renderer/index.html"),
          pet: resolve("src/renderer/pet.html"),
        },
      },
    },
  },
});