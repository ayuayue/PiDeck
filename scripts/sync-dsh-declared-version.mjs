/**
 * 同步 DSH 声明版本到 package.json 根字段。
 *
 * 背景：DSH runtime 版本一致性门控（isDshRuntimeVersionMismatch）依赖「当前 app
 * 声明的配套 dsh 版本」。该版本历史上只声明在 devDependencies["@deepseek-ai/dsh"]，
 * 但 electron-builder 打包时会从 app.asar 内的 package.json 删除 devDependencies
 * （fileTransformer 的 cleanupPackageJson 对主 package.json 强制 isMain: true），
 * 打包版里 readDeclaredDshVersion 恒为 undefined → 门控失效 → 旧 runtime 被静默
 * 放行启动，直到 cordis 插件加载崩溃才暴露。
 *
 * 修复：把版本提为根字段 `dshRuntimeVersion`——不在 electron-builder 的删除名单
 * （_开头、dist/gitHead/build/jspm/ava/xo/nyc/eslintConfig/contributors/
 * bundleDependencies/tags/scripts/keywords/devDependencies/babel）里，会原样进入
 * 打包产物。本脚本在每次打包前从 devDependencies 同步该字段，避免双处维护漂移；
 * 值一致时不写文件（保持 git 工作区干净）。
 *
 * 用法：
 *   node scripts/sync-dsh-declared-version.mjs           同步（差异时改写）
 *   node scripts/sync-dsh-declared-version.mjs --check   仅校验，不一致则退出码 1
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkgPath = resolve(root, "package.json");
const DECLARED_FIELD = "dshRuntimeVersion";
const SOURCE_DEP = "@deepseek-ai/dsh";

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const sourceVersion = pkg.devDependencies?.[SOURCE_DEP] ?? pkg.dependencies?.[SOURCE_DEP];
if (!sourceVersion || typeof sourceVersion !== "string") {
	console.error(`✗ package.json 未声明 ${SOURCE_DEP}（dependencies/devDependencies 均无），无法同步 ${DECLARED_FIELD}`);
	process.exit(1);
}

const current = pkg[DECLARED_FIELD];
if (current === sourceVersion) {
	console.log(`✓ package.json ${DECLARED_FIELD} 已与 ${SOURCE_DEP}@${sourceVersion} 一致`);
	process.exit(0);
}

if (process.argv.includes("--check")) {
	console.error(`✗ package.json ${DECLARED_FIELD}="${current ?? "(缺省)"}" 与 ${SOURCE_DEP}@${sourceVersion} 不一致，请运行 npm run sync:dsh-version`);
	process.exit(1);
}

// 根字段放紧跟 version 之后，读起来与「app 版本 → 配套 runtime 版本」的语义对齐。
// 注意：已有旧值时必须在循环里跳过，否则循环走到该键会用旧值覆盖刚插入的新值。
const ordered = {};
for (const [key, value] of Object.entries(pkg)) {
	if (key === DECLARED_FIELD) continue;
	ordered[key] = value;
	if (key === "version") ordered[DECLARED_FIELD] = sourceVersion;
}
if (!(DECLARED_FIELD in ordered)) ordered[DECLARED_FIELD] = sourceVersion;
writeFileSync(pkgPath, JSON.stringify(ordered, null, 2) + "\n");
// 落盘自检：立即回读，确保写入真的生效（文件被锁/路径解析错误时当场暴露）。
const reread = JSON.parse(readFileSync(pkgPath, "utf8"));
if (reread[DECLARED_FIELD] !== sourceVersion) {
	console.error(`✗ ${pkgPath} 写入后回读值仍为 ${reread[DECLARED_FIELD] ?? "(缺省)"}，请检查文件占用`);
	process.exit(1);
}
console.log(`✓ package.json ${DECLARED_FIELD}: ${current ?? "(缺省)"} → ${sourceVersion}`);
