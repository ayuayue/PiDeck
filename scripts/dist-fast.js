/**
 * dist:fast —— 快速验证打包（日常迭代用）。
 *
 * 用法：
 *   npm run dist:fast                 → 默认仅 nsis 安装包
 *   npm run dist:fast -- portable      → 仅便携 exe
 *   npm run dist:fast -- zip           → 仅 zip
 *   npm run dist:fast -- nsis zip      → 多个指定格式
 *
 * 与 dist:win 的区别（即提速来源）：
 * 1. 跳过 tsc 全量类型检查 —— 类型正确性交给 IDE / npm run verify 兜底；
 * 2. compression=store —— electron-builder 不做 zlib 最高档压缩（maximum 是发布档）；
 * 3. 默认只打单个目标 —— 跳过其余格式的重复压缩（可用参数按需指定）；
 * 4. PI_FAST_PACK=1 —— 跳过 afterPack 的 asar 解包清理/重打包（打包耗时大头）。
 *
 * 注意：发布正式版前必须跑完整 dist:win（maximum + 三格式 + 完整 afterPack 清理），
 * 且合并前照常执行 npm run typecheck，不要用本产物对外发布。
 */
const { execSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

// npm run 会把 -- 后面的参数放到 process.argv 的 2..n（与 dist-win.js 一致）
const args = process.argv.slice(2);
const formats = args.length > 0 ? args.join(" ") : "nsis";

console.log(`[1/4] 构建本地 packages（file: 依赖需要 lib/ 产物）…`);
execSync("npm run build:packages", { cwd: root, stdio: "inherit", shell: true });

// DSH runtime 随包资源：electron-builder 的 extraResources 会去 dist-runtime/dsh-runtime
// 取，目录为空（只有 .gitkeep）时打出来的包 DSH 不可用。--if-missing 让后续快速打包
// 跳过重打（依赖没变的话产物是一样的），只有首次或手动删除后才花那 20 秒。
console.log(`\n[2/4] 准备 DSH runtime 随包资源（--if-missing）…`);
execSync("node scripts/pack-dsh-runtime.mjs --if-missing", { cwd: root, stdio: "inherit", shell: true });

// build:fast 同步生成 pi-ai catalog，避免快速包带上升级前的静态模型目录。
console.log(`\n[3/4] 生成 catalog + electron-vite build（跳过 tsc 全量类型检查）…`);
execSync("npm run build:fast", { cwd: root, stdio: "inherit", shell: true });

console.log(`\n[4/4] electron-builder --win ${formats}（compression=store + 跳过 asar 重打包）…`);
execSync(`npx electron-builder --win ${formats} --config.compression=store`, {
	cwd: root,
	stdio: "inherit",
	shell: true,
	env: { ...process.env, PI_FAST_PACK: "1" },
});

console.log(`\n✅ 快速打包完成！产物在 release/ 目录。`);
