/**
 * verify-asar-runtime —— 验证打包产物 asar 的运行时依赖完整性。
 *
 * 用途：package.json 的 build.files 里维护了一大批 `!node_modules/xxx` 排除模式，
 * 目的是剔除已被 electron-vite 打进 out/renderer 的渲染层包。风险是：一旦某个
 * 运行时真正需要的包被误排除，只有到用户机器上才会以 MODULE_NOT_FOUND 崩溃。
 * 本脚本在打包后断言「必须保留的包都在、已知冗余包已移除」，作为回归防线。
 *
 * 用法：node scripts/verify-asar-runtime.js [win-unpacked 目录]
 *   默认 release/win-unpacked
 *
 * 维护提示：新增主进程运行时依赖时，同步加入 MUST_KEEP；否则排除配置可能误伤。
 */
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const unpackedDir = process.argv[2] || "release/win-unpacked";
const asarPath = path.join(unpackedDir, "resources", "app.asar");

if (!fs.existsSync(asarPath)) {
	console.error(`找不到 asar: ${asarPath}`);
	process.exit(2);
}

// 运行时必须保留：主进程 external 包 + 动态 import 目标 + hostEntry 动态加载树根 + 原生/asarUnpack 包
// 注意：@deepseek-ai/* 与 dsh-bill/dsh-tool-pwsh-persistent 已依赖分区（仅 devDependencies），
// 不进 app.asar——它们的加载锚点在外部 runtime（resources/dsh-runtime 归档 / userData 已装目录），
// 归档完整性由 scripts/check-dsh-asar.mjs + check-dsh-boot.mjs 守护，这里不再断言。
const MUST_KEEP = [
	"node-pty",
	"sql.js",
	"@larksuiteoapi/node-sdk",
	"@img/sharp-win32-x64",
	"@vscode/ripgrep-win32-x64",
	"openai",
	"@anthropic-ai/sdk",
	"@mistralai/mistralai",
	"@google/genai",
	"zod",
	"undici",
	"@electron-toolkit/utils",
	"koffi",
];

// 已知冗余（已打进 out/renderer）：抽样式验证排除规则确实生效
const SHOULD_BE_GONE = [
	"date-fns",
	"recharts",
	"shiki",
	"framer-motion",
	"@reduxjs/toolkit",
	"@tiptap/core",
	"prosemirror-view",
	"pngjs",
	"linkifyjs",
];

// 主进程模型目录是 extraResources，不再依赖根 pi-ai SDK；DSH 自身的 pi-ai
// 仍由 @deepseek-ai 闭包按需保留，不能把它当作 PiDeck 主进程的 MUST_KEEP 根。
const REQUIRED_RESOURCE_FILES = ["pi-ai-catalog.json", "pi-ai-catalog.manifest.json"];
const resourcesDir = path.join(unpackedDir, "resources");
const missingResources = REQUIRED_RESOURCE_FILES.filter((name) => !fs.existsSync(path.join(resourcesDir, name)));

const header = asar.getRawHeader(asarPath).header;
const nmNode = header.files["node_modules"];

/** 按 `scope/name` 逐级下钻判断包是否存在于 asar */
function has(pkgName) {
	let node = nmNode;
	for (const part of pkgName.split("/")) {
		node = node && node.files && node.files[part];
		if (!node) return false;
	}
	return true;
}

/** 读取 asar 内所有 pi-ai package.json，兼容 Windows 的反斜杠目录表。 */
function piAiVersionsInAsar() {
	return Array.from(new Set(
		asar.listPackage(asarPath)
			.filter((listedPath) => listedPath.replace(/[\\/]/g, "/").endsWith("/node_modules/@earendil-works/pi-ai/package.json"))
			.map((listedPath) => {
				try {
					const relativePath = listedPath.replace(/^[\\/]+/, "");
					const pkg = JSON.parse(asar.extractFile(asarPath, relativePath).toString("utf8"));
					return typeof pkg.version === "string" ? pkg.version : undefined;
				} catch {
					return undefined;
				}
			})
			.filter(Boolean),
	));
}

function catalogSourceVersion() {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(resourcesDir, "pi-ai-catalog.manifest.json"), "utf8"));
		return typeof manifest?.source?.packageVersion === "string" ? manifest.source.packageVersion : undefined;
	} catch {
		return undefined;
	}
}

const missing = MUST_KEEP.filter((n) => !has(n));
const remain = SHOULD_BE_GONE.filter((n) => has(n));

let failed = false;
if (missingResources.length === 0) {
	console.log(`OK 模型目录资源完整：${REQUIRED_RESOURCE_FILES.join(", ")}`);
} else {
	failed = true;
	console.error(`FAIL 模型目录资源缺失：${missingResources.join(", ")}`);
}

// 主进程只需 artifact，catalog 的构建期 pi-ai 版本绝不能被 electron-builder
// 一并带入 app.asar；DSH 自己保留的 0.82.x 则允许继续存在。
const sourceVersion = catalogSourceVersion();
const packedPiAiVersions = piAiVersionsInAsar();
if (!sourceVersion) {
	failed = true;
	console.error("FAIL 无法读取 pi-ai catalog manifest 的来源版本");
} else if (packedPiAiVersions.includes(sourceVersion)) {
	failed = true;
	console.error(`FAIL catalog 来源 pi-ai@${sourceVersion} 泄漏进 app.asar：${packedPiAiVersions.join(", ")}`);
} else {
	console.log(`OK catalog 来源 pi-ai@${sourceVersion} 未进入 app.asar（DSH 保留：${packedPiAiVersions.join(", ") || "无"}）`);
}

if (missing.length === 0) {
	console.log(`OK 运行时依赖完整：${MUST_KEEP.length} 个关键包全部保留`);
} else {
	failed = true;
	console.error(`FAIL 运行时包丢失：${missing.join(", ")}`);
}

if (remain.length === 0) {
	console.log(`OK 冗余已剔除：${SHOULD_BE_GONE.length} 个抽查冗余包均不在 asar 内`);
} else {
	failed = true;
	console.error(`FAIL 冗余包仍在：${remain.join(", ")}`);
}

// sql.js 只需 wasm 引擎，asm/debug/browser/worker 变体应被排除
const sqlDist = nmNode && nmNode.files["sql.js"] && nmNode.files["sql.js"].files["dist"];
if (sqlDist) {
	console.log(`OK sql.js dist 保留：${Object.keys(sqlDist.files).join(", ")}`);
} else {
	failed = true;
	console.error("FAIL sql.js dist 缺失");
}

// app-builder-bin 是 electron-builder 的构建期二进制（207MB），绝不能进产物
if (has("app-builder-bin")) {
	failed = true;
	console.error("FAIL app-builder-bin 混入产物（应为 devDependencies）");
} else {
	console.log("OK app-builder-bin 未混入产物");
}

process.exit(failed ? 1 : 0);
