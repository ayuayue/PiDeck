// @ts-check
/**
 * 构建所有本地 workspace「包」的产物。
 *
 * 背景：`dsh-tool-pwsh-persistent` 等 `file:` 本地包把 `src/*.ts` 源码留仓库、
 * `lib/` 由 `tsc` 产出（并被 .gitignore 忽略）。若在打包/启动前不先构建，
 * hostEntry 运行时 `require.resolve("dsh-tool-pwsh-persistent")` 会因命中
 * 不存在的 `lib/index.js` 抛 MODULE_NOT_FOUND，导致 DSH host 以 code=1 退出。
 *
 * 本脚本在 `npm run build` 与 `dev` 启动前调用：遍历 `packages` 下每个子目录的
 * package.json，有 `scripts.build` 的包依次执行其构建，保证每个本地包进入打包目录前
 * 都已产出 `lib/`。
 */
const { execSync } = require("node:child_process");
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { join, delimiter } = require("node:path");

const root = join(__dirname, "..");
const packagesRoot = join(root, "packages");

/**
 * 组装子包构建用的 PATH：把子包与仓库根的 node_modules/.bin 前置。
 *
 * 为什么不直接依赖外部 PATH：npm run 会注入 .bin 的前提是「npm 本身工作正常」，
 * 但在部分终端/沙箱环境（如 WorkBuddy 托管终端）里 PATH 注入链会断——表现是
 * `npm run build` 能跑起来、脚本里的 `tsc`/`electron-vite` 却报
 * 「不是内部或外部命令」。前置 .bin 后，无论外部环境如何垫片都可达。
 */
function buildEnv(pkgDir) {
	const binDirs = [
		join(pkgDir, "node_modules", ".bin"),
		join(root, "node_modules", ".bin"),
	];
	const existingPath = process.env.PATH || process.env.Path || "";
	return {
		...process.env,
		PATH: [...binDirs, existingPath].filter(Boolean).join(delimiter),
	};
}

function buildPackages() {
	if (!existsSync(packagesRoot)) {
		console.log("[build-local-packages] 无 packages/ 目录，跳过");
		return;
	}
	const entries = readdirSync(packagesRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
	for (const entry of entries) {
		const pkgDir = join(packagesRoot, entry.name);
		const pkgJsonPath = join(pkgDir, "package.json");
		if (!existsSync(pkgJsonPath)) continue;
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
		if (!pkg.scripts || typeof pkg.scripts.build !== "string") {
			console.log(`[build-local-packages] ${entry.name}: 无 build 脚本，跳过`);
			continue;
		}
		console.log(`[build-local-packages] 构建 ${entry.name} …`);
		execSync("npm run build", { cwd: pkgDir, stdio: "inherit", shell: true, env: buildEnv(pkgDir) });
	}
}

if (require.main === module) {
	buildPackages();
}

module.exports = { buildPackages };
