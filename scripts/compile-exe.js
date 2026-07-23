/**
 * 本地快速编译为单 exe 文件。
 * 跳过 tsc 类型检查，ASAR 不压缩，只输出 NSIS 安装包。
 * 用于日常自测，发版请用 npm run dist:win（完整压缩 + 全格式）。
 */
const { execSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

console.log("[1/2] 打包代码（跳过类型检查）…");
execSync("npx electron-vite build", { cwd: root, stdio: "inherit" });

console.log("\n[2/2] 编译单文件安装包（不压缩 ASAR，仅 nsis）…");
execSync(
  "npx electron-builder --win nsis -c.compression=store -c.nsis.unicode=true",
  { cwd: root, stdio: "inherit" },
);

console.log("\n✅ 完成！安装包在 release/ 目录下");
