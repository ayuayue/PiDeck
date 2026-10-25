import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * 打包依赖完整性回归测试（对应线上事故：打包版 DSH host 启动即退，
 * "DSH host process exited before ready (code=1)"）。
 *
 * 根因：@deepseek-ai/* 的若干包只以 peerDependency 出现（npm 会装进本地
 * node_modules，dev 正常运行），但 electron-builder 只收集 package.json
 * dependencies 的传递闭包，peer-only 包不进 app.asar；hostEntry 在 utilityProcess
 * 里按 node_modules 路径动态 import 时 ERR_MODULE_NOT_FOUND → exit(1)。
 *
 * 不变量：凡是「会被打包代码静态引用」的 @deepseek-ai 包，必须能通过
 * dependencies 闭包到达（即会被 electron-builder 打进 asar）。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeModulesDir = join(repoRoot, "node_modules");
const SCOPE = "@deepseek-ai";

/** 读包名（@scope/name 或 name）的 package.json 依赖段（dependencies + optionalDependencies）。 */
function readDeps(packageDir) {
	const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	return {
		...pkg.dependencies,
		...pkg.optionalDependencies,
	};
}

/** 解析包的真实安装目录：优先顶层 hoisted，其次已解析父包的嵌套 node_modules。 */
function resolvePackageDir(name, parentDirs) {
	const candidates = [join(nodeModulesDir, ...name.split("/"))];
	for (const parent of parentDirs) {
		candidates.push(join(parent, "node_modules", ...name.split("/")));
	}
	return candidates.find((dir) => existsSync(join(dir, "package.json"))) ?? null;
}

/** electron-builder 视角的打包集合：package.json dependencies 的传递闭包（name → 安装目录）。 */
function computePackedSet() {
	const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const packed = new Map();
	const queue = [...Object.keys({ ...rootPkg.dependencies, ...rootPkg.optionalDependencies })];
	while (queue.length > 0) {
		const name = queue.shift();
		if (packed.has(name)) continue;
		const dir = resolvePackageDir(name, [...packed.values()]);
		if (!dir) continue; // 未安装（可选依赖缺失等）：无从打包，也无需检查
		packed.set(name, dir);
		for (const dep of Object.keys(readDeps(dir))) queue.push(dep);
	}
	return packed;
}

/** node_modules 下全部 @deepseek-ai 包（顶层 hoisted）。 */
function listTopLevelDshPackages() {
	return readdirSync(join(nodeModulesDir, SCOPE)).filter((name) => existsSync(join(nodeModulesDir, SCOPE, name, "package.json")));
}

const SCAN_EXTS = new Set([".js", ".mjs", ".cjs", ".yml", ".yaml"]);

/** 递归收集目录下所有运行时文件（跳过 .d.ts / map / 文档，打包清理也会删）。 */
function collectRuntimeFiles(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectRuntimeFiles(full, out);
		} else if (entry.isFile() && SCAN_EXTS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
			out.push(full);
		}
	}
	return out;
}

test("peer-only @deepseek-ai 包若被打包代码引用，必须声明进 dependencies", () => {
	const packed = computePackedSet();
	const allDsh = new Set(listTopLevelDshPackages());
	// 打包闭包外的 @deepseek-ai 包 = 打包时会丢失的包
	const missing = [...allDsh].filter((name) => !packed.has(`${SCOPE}/${name}`)).sort();

	// 只扫描会被打包的 @deepseek-ai 包目录（含其嵌套 node_modules）。
	// 打包闭包外的包不会出现在被打包目录下（嵌套副本意味着父包依赖它 → 已在闭包内）。
	const files = [];
	for (const [name, dir] of packed) {
		if (!name.startsWith(`${SCOPE}/`)) continue;
		collectRuntimeFiles(dir, files);
	}

	// 找出「丢失但被打包代码静态引用」的包（运行时 import 必然失败）。
	const referenced = [];
	for (const pkg of missing) {
		const needle = `${SCOPE}/${pkg}`;
		const hit = files.find((file) => readFileSync(file, "utf8").includes(needle));
		if (hit) referenced.push(`${pkg}（被 ${hit.slice(repoRoot.length + 1)} 引用）`);
	}

	assert.deepEqual(referenced, [], ["以下 @deepseek-ai 包仅以 peerDependency 存在（npm 本地安装使 dev 正常），", "但被打包代码静态引用，electron-builder 打包后会缺失，", "DSH host 启动即 ERR_MODULE_NOT_FOUND 退出。请把它们加入 package.json dependencies：", ...referenced].join("\n"));
});
