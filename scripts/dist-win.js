/**
 * dist:win 包装脚本，支持按需指定打包格式。
 *
 * 用法：
 *   npm run dist:win              → 全格式：nsis + portable + zip
 *   npm run dist:win -- nsis      → 仅 NSIS 安装包
 *   npm run dist:win -- portable  → 仅便携 exe
 *   npm run dist:win -- zip       → 仅 zip
 *   npm run dist:win -- nsis portable  → 多个指定格式
 */
const { execSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

// npm run 会把 -- 后面的参数放到 process.argv 的 2..n
const args = process.argv.slice(2);
const formats = args.length > 0
  ? args.join(" ")
  : "nsis portable zip";

console.log(`[1/2] 打包代码…`);
execSync("npm run build", { cwd: root, stdio: "inherit", shell: true });

console.log(`\n[2/2] electron-builder --win ${formats} …`);
execSync(`npx electron-builder --win ${formats}`, {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

console.log(`\n✅ 完成！产物在 release/ 目录下`);
