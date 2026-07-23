/**
 * 本地快速编译为单 exe 文件（便携版）。
 * 跳过 tsc 类型检查，ASAR 不压缩，输出 PiDeck-*-x64.exe 便携单文件。
 * 用于日常自测，发版请用 npm run dist:win（完整压缩 + 全格式）。
 */
const { execSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

console.log("[1/2] 打包代码（跳过类型检查）…");
execSync("npx electron-vite build", { cwd: root, stdio: "inherit" });

console.log("\n[2/2] 编译便携单 exe（不压缩 ASAR）…");
execSync(
  "npx electron-builder --win portable -c.compression=store",
  { cwd: root, stdio: "inherit" },
);

console.log("\n✅ 完成！便携 exe 在 release/ 目录下");
