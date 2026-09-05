/**
 * analyze-asar-waste —— 分析打包产物 asar 内的 node_modules 冗余。
 *
 * 原理：以「运行时根集合」（主进程 external 包 + 动态 import 目标 + hostEntry 动态加载的
 * @deepseek-ai 树 + asarUnpack 声明的原生包）为起点求依赖传递闭包，
 * asar 内不在闭包中的包即为冗余 —— 它们已被 electron-vite 打进 out/renderer 或 out/main，
 * 在 asar 里保留源码副本属于纯浪费（运行时不会去读）。
 *
 * 用法：node scripts/analyze-asar-waste.js [asar 路径]
 *   默认 release/win-unpacked/resources/app.asar
 *
 * 维护提示：新增主进程运行时依赖（尤其动态 require.resolve / import 的包）时，
 * 需同步更新下方 roots，否则该包会被误判为冗余而被 files 排除，导致运行时 MODULE_NOT_FOUND。
 */
const path = require("node:path");
const asar = require("@electron/asar");

const NM = "node_modules";
const ASAR = process.argv[2] || "release/win-unpacked/resources/app.asar";

// 必须读取 asar 内实际打入的 package.json，而不是开发工作区 node_modules：
// catalog 来源 pi-ai@0.84.4 是 devDependency，但 DSH 在 app.asar 中保留的是 0.82.1，
// 从工作区读取会把 0.84.4 的依赖图错误地当成生产闭包。
function readPkg(name) {
	try {
		const p = path.join(NM, name, "package.json");
		return JSON.parse(asar.extractFile(ASAR, p).toString("utf8"));
	} catch {
		return null;
	}
}

const hdr = asar.getRawHeader(ASAR).header;
const inAsar = new Set();
for (const [name, child] of Object.entries(hdr.files[NM].files)) {
	if (name.startsWith("@")) {
		for (const n2 of Object.keys(child.files || {})) inAsar.add(name + "/" + n2);
	} else {
		inAsar.add(name);
	}
}

// 运行时根集合（依据：out/main 产物静态 require 扫描 + 动态 import 扫描 + hostEntry 的 @deepseek-ai 动态加载 + asarUnpack 声明 + 扩展运行时）
const roots = [...inAsar]
	.filter((n) => n.startsWith("@deepseek-ai/"))
	.concat([
		"node-pty",
		"sql.js",
		"@electron-toolkit/utils",
		"@larksuiteoapi/node-sdk",
		"@img/sharp-win32-x64",
		"@vscode/ripgrep-win32-x64",
		"koffi",
		"@koromix/koffi-win32-x64",
		"node-addon-require-builtin-win32-x64-msvc",
		"dsh-tool-pwsh-persistent",
		"dsh-bill",
		// PiDeck 主进程改读 extraResources catalog；DSH 的 pi-ai 由 @deepseek-ai 闭包追踪。
		"undici",
	]);

const closure = new Set();
const queue = roots.filter((n) => inAsar.has(n));
while (queue.length) {
	const name = queue.pop();
	if (closure.has(name)) continue;
	closure.add(name);
	const pkg = readPkg(name);
	if (!pkg) continue;
	for (const dep of Object.keys(pkg.dependencies || {})) {
		if (inAsar.has(dep)) queue.push(dep);
	}
}

// 在 asar header 里定位包节点（注意起始节点是 node_modules 节点本身，不是它的 files map）
function findPkgNode(name) {
	let node = hdr.files[NM];
	for (const part of name.split("/")) {
		if (!node || !node.files || !node.files[part]) return null;
		node = node.files[part];
	}
	return node;
}

function nodeSize(node) {
	if (!node.files) return node.size || 0;
	let t = 0;
	for (const c of Object.values(node.files)) t += nodeSize(c);
	return t;
}

const waste = [...inAsar].filter((n) => !closure.has(n));
const rows = waste
	.map((n) => [n, nodeSize(findPkgNode(n) || {})])
	.sort((a, b) => b[1] - a[1]);

console.log("=== 可安全排除（未被运行时闭包引用）Top 40 ===");
for (const [n, s] of rows.slice(0, 40)) console.log((s / 1024 / 1024).toFixed(1).padStart(8), "MB", n);
let total = 0;
for (const [, s] of rows) total += s;
console.log("--- 可排除总数:", rows.length, "个，合计", (total / 1024 / 1024).toFixed(1), "MB");
console.log("=== 保留闭包包数:", closure.size, "===");

// 输出可直接粘进 package.json build.files 的排除模式（每行 4 个，便于 diff 阅读）
// 需要落地文件时：node scripts/analyze-asar-waste.js | tail -n +<起始行> > list.txt
const wasteList = waste.slice().sort();
const groups = [];
for (let i = 0; i < wasteList.length; i += 4) {
	groups.push("\t\t\t" + wasteList.slice(i, i + 4).map((w) => JSON.stringify("!node_modules/" + w)).join(", "));
}
console.log("\n=== electron-builder files 排除模式（", wasteList.length, "个包）===");
console.log(groups.join(",\n"));
