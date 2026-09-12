#!/usr/bin/env node
/**
 * 安装第三方 DSH 插件到 PiDeck 的 DSH runtime 环境（自包含、与 runtime 解耦）。
 *
 *   node scripts/install-dsh-plugin.mjs <npm spec> [--runtime <...\dsh-runtime>] [--dest <插件目录>]
 *                                      [--dsh-home <dir>] [--dry-run]
 *
 * 例：
 *   node scripts/install-dsh-plugin.mjs dsh-plugin-model-proxy@0.1.3
 *
 * 为什么不是简单 `npm i`：
 * - host 的模块解析锚点只有 runtime 的 node_modules（`--dsh-node-modules`），ESM 没有
 *   NODE_PATH 双源回退；装到 app / 别的目录的包 host 根本看不见。
 * - 但把插件装进 runtime node_modules 会被 runtime 的升级/重装（含 PiDeck 的自动更新）
 *   整目录删掉。所以这里采用「插件放独立目录 + Loader 行用绝对路径」的形态：
 *   插件目录自带它静态 import 的依赖（undici/schemastery 等），runtime 换版本也不影响。
 *
 * 安装后做的事：
 * 1. npm pack 取包 → 解包到 <dest>/<pkg>；
 * 2. 扫描插件代码里的静态 import 裸包名，从 runtime 解析并**嵌套**进插件自己的
 *    node_modules（含依赖闭包），让插件在 runtime 之外也能自包含解析；
 * 3. 打印可直接粘进 $DSH_HOME/cordis.patch.yml 的 Loader 行（**不自动改用户文件**：
 *    该文件是用户自管的官方补丁层，可能已有内容，脚本不越权合并）。
 *
 * 安全边界：第三方插件在 host 进程内执行任意代码，安装前请自行确认来源可信。
 * 想撤销：删掉 <dest>/<pkg> 目录，并从 $DSH_HOME/cordis.patch.yml 移除对应行。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as tar from "tar";

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const argValue = (flag) => {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
};
const spec = positional[0];
const dryRun = argv.includes("--dry-run");
/** --register：把 Loader 行自动追加进 $DSH_HOME/cordis.patch.yml（带备份，幂等）。 */
const register = argv.includes("--register");

if (!spec) {
	console.error("用法: node scripts/install-dsh-plugin.mjs <npm spec> [--runtime <...\\dsh-runtime>] [--dest <dir>] [--dsh-home <dir>] [--register] [--dry-run]");
	process.exit(1);
}

const userData = join(process.env.APPDATA ?? join(homedir(), ".config"), "pi-desktop");
/** 自动探测已安装 runtime：userData/runtimes/dsh/<version>/dsh-runtime（取版本号最大的一个）。 */
const detectRuntime = () => {
	const root = join(userData, "runtimes", "dsh");
	if (!existsSync(root)) return undefined;
	const candidates = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({ dirName: entry.name, dir: join(root, entry.name, "dsh-runtime") }))
		.filter((entry) => existsSync(join(entry.dir, "manifest.json")));
	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => a.dirName.localeCompare(b.dirName, undefined, { numeric: true }));
	return candidates[candidates.length - 1].dir;
};
const runtimeRoot = resolve(argValue("--runtime") ?? detectRuntime() ?? join(userData, "runtimes", "dsh", "declared", "dsh-runtime"));
const destRoot = resolve(argValue("--dest") ?? join(userData, "dsh-plugins"));
const dshHome = resolve(argValue("--dsh-home") ?? join(homedir(), ".dsh"));

if (!existsSync(join(runtimeRoot, "node_modules"))) {
	console.error(
		`✗ 找不到 runtime node_modules: ${join(runtimeRoot, "node_modules")}\n` +
			"  请用 --runtime 指定已安装的 runtime 目录（…/runtimes/dsh/<version>/dsh-runtime）。\n" +
			"  插件依赖需要从 runtime 取（不联网装 @deepseek-ai/* 以免版本漂移）。",
	);
	process.exit(1);
}
const nmRoot = join(runtimeRoot, "node_modules");

// ── 1. npm pack 取包 ──
const tmp = join(destRoot, ".tmp-" + Date.now());
mkdirSync(tmp, { recursive: true });
console.log(`[1/3] npm pack ${spec} …`);
const packed = execFileSync("npm", ["pack", spec, "--pack-destination", tmp, "--silent"], {
	encoding: "utf8",
	shell: true,
})
	.trim()
	.split(/\r?\n/)
	.pop();

const unpacked = join(tmp, "unpacked");
mkdirSync(unpacked, { recursive: true });
await tar.x({ file: join(tmp, packed), cwd: unpacked, strip: 1 });
const pkg = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8"));
const destDir = join(destRoot, ...pkg.name.split("/"));
console.log(`       → ${pkg.name}@${pkg.version}`);

if (dryRun) {
	console.log("--dry-run：仅下载校验，不落位");
	rmSync(tmp, { recursive: true, force: true });
	process.exit(0);
}

// ── 2. 落位 + 依赖闭包嵌套 ──
console.log(`[2/3] 落位到 ${destDir} 并嵌套依赖 …`);
if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
mkdirSync(dirname(destDir), { recursive: true });
cpSync(unpacked, destDir, { recursive: true });

const targetNm = join(destDir, "node_modules");
const resolveIn = (fromDir, name) => {
	let current = fromDir;
	for (;;) {
		const candidate = join(current, "node_modules", ...name.split("/"));
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
};
const listJs = (dir, out = []) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) listJs(full, out);
		else if (entry.name.endsWith(".js")) out.push(full);
	}
	return out;
};
/** 代码里静态 import 的裸包名（跳过 node: 内置与相对路径）。 */
const collectImports = (dir) => {
	const found = new Set();
	for (const file of listJs(dir)) {
		const code = readFileSync(file, "utf8");
		const re = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = re.exec(code)) !== null) {
			const value = match[1] ?? match[2];
			if (!value || value.startsWith(".") || value.startsWith("node:")) continue;
			const parts = value.split("/");
			found.add(value.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
		}
	}
	return found;
};

const seen = new Set();
const nest = (pkgDir, name) => {
	if (seen.has(name)) return;
	seen.add(name);
	const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	const deps = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };
	for (const depName of Object.keys(deps)) {
		const dest = join(targetNm, ...depName.split("/"));
		if (!existsSync(join(dest, "package.json"))) {
			const src = resolveIn(pkgDir, depName) ?? resolveIn(nmRoot, depName);
			if (!src) {
				console.warn(`      ! 依赖 ${depName} 在 runtime 里也找不到，插件加载可能失败`);
				continue;
			}
			mkdirSync(dirname(dest), { recursive: true });
			cpSync(src, dest, { recursive: true });
		}
		nest(dest, depName);
	}
};

const missing = [];
for (const name of collectImports(destDir)) {
	const dest = join(targetNm, ...name.split("/"));
	if (!existsSync(join(dest, "package.json"))) {
		const src = resolveIn(nmRoot, name);
		if (!src) {
			// 内置模块（不带 node: 前缀，如 http2/buffer）不需要嵌套
			try {
				createRequire(import.meta.url).resolve(name);
			} catch {
				missing.push(name);
			}
			continue;
		}
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(src, dest, { recursive: true });
	}
	nest(dest, name);
}
if (missing.length > 0) {
	console.warn(`      ! 以下 import 在 runtime 与 Node 内置里都找不到：${missing.join(", ")}`);
}

const entry = join(destDir, pkg.main ?? "index.js");
const entryUrl = "file:///" + entry.replace(/\\/g, "/");
rmSync(tmp, { recursive: true, force: true });

// ── 3. 登记 Loader 行 ──
const patchPath = join(dshHome, "cordis.patch.yml");
const rowId = `${pkg.name.replace(/^.*\//, "")}/host`;
const rowText = [
	"- insert:",
	`    - id: ${rowId}`,
	`      name: ${entryUrl}`,
	"      config: {}",
	"",
].join("\n");
console.log(`[3/3] 安装完成：${destDir}`);
console.log(`      entry: ${entry}`);

if (register) {
	// 自动登记：追加到用户补丁层（先备份；已存在同 id 行则跳过，幂等）
	if (existsSync(patchPath)) {
		const current = readFileSync(patchPath, "utf8");
		if (current.includes(`id: ${rowId}`)) {
			console.log(`      补丁层已有 ${rowId} 行，跳过登记`);
		} else {
			const backupPath = `${patchPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			const { copyFileSync } = await import("node:fs");
			copyFileSync(patchPath, backupPath);
			const separator = current.endsWith("\n") ? "" : "\n";
			writeFileSync(patchPath, `${current}${separator}${rowText}\n`, "utf8");
			console.log(`      已登记到 ${patchPath}（备份：${backupPath}）`);
		}
	} else {
		mkdirSync(dshHome, { recursive: true });
		writeFileSync(
			patchPath,
			[
				"# PiDeck / DSH 用户补丁层（官方层级：作用于每个 profile）",
				"# 由 install-dsh-plugin.mjs 登记；Loader 行 name 用绝对路径引用，",
				"# 插件本体放在 userData/dsh-plugins/ 下（与 runtime 解耦）。",
				"# 第三方插件 = 在 host 进程内执行任意代码，安装前请自行确认来源可信。",
				"",
				rowText,
			].join("\n"),
			"utf8",
		);
		console.log(`      已创建 ${patchPath} 并登记`);
	}
} else if (existsSync(patchPath)) {
	console.log(`\n⚠ ${patchPath} 已存在，脚本不自动改写（加 --register 可自动追加）。`);
	console.log(`  请在其中加入（或确认已有）这个 Loader 行：\n`);
	console.log(rowText);
} else {
	console.log(`\n请创建 ${patchPath} 并写入以下内容（PiDeck host 会对每个 profile 应用该层）：\n`);
	console.log(rowText);
}
console.log("提示：改完重启 DSH host（配置页「重启 host」）生效；插件在 host 进程内执行代码，请确认来源可信。");
