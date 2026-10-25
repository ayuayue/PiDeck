/**
 * 开发验证打包：固定输出到 release-dev/，不碰 release/（运行中的正式/便携进程
 * 锁着 release/ 下的 exe，electron-builder 写同名文件会报占用）。
 *
 * 用法：
 *   npm run dist:fast                 → win-unpacked（最快，默认）
 *   npm run dist:fast -- portable     → 便携 exe 到 release-dev/
 *   npm run dist:fast -- nsis         → NSIS 安装包到 release-dev/
 *   npm run dist:fast -- dir portable
 *
 * 数据目录提示：便携版数据 = exe 同级 data/。打到 release-dev/ 后新便携版会用
 * release-dev/data/（全新空目录）；想沿用旧数据，把 release/data 拷过去再删掉
 * 旧的坏 runtime（release-dev/data/runtimes/dsh/0.1.1-rc.1），让新包重装修复版。
 */
const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { electronBuilderEnv } = require("./electronBuilderEnv.js");

const root = path.resolve(__dirname, "..");

// 与 package.json 的 directories.output 区分开的独立 dev 输出目录。
// 如需换成别的名字，只改这里即可。
const DEV_OUTPUT_DIR = "release-dev";

const args = process.argv.slice(2);
// 默认 --dir（win-unpacked 目录，秒级验证）；传了格式参数就用传入的
const formats = args.length > 0 ? args.join(" ") : "--dir";

console.log(`[1/2] 打包代码（build 内置 runtime:pack + runtime:check）…`);
execSync("npm run build", { cwd: root, stdio: "inherit", shell: true });

console.log(`\n[2/2] electron-builder --win ${formats} → ${DEV_OUTPUT_DIR}/ …`);
execSync(`npx electron-builder --win ${formats} --config.directories.output=${DEV_OUTPUT_DIR}`, { cwd: root, stdio: "inherit", shell: true, env: electronBuilderEnv() });

const outDir = path.join(root, DEV_OUTPUT_DIR);
console.log(`\n✅ 打包完成，产物在 ${DEV_OUTPUT_DIR}/`);
if (fs.existsSync(outDir)) {
	const files = fs.readdirSync(outDir).filter((name) => !/\.(blockmap|yml)$/.test(name) && !name.startsWith("."));
	for (const name of files) console.log(`  - ${name}`);
}
console.log(`\n提示：这是独立 dev 目录，不影响 release/ 与正在运行的进程。`);
console.log(`验证通过、关掉旧进程后，正式产物仍用 npm run pack / npm run dist:win。`);
