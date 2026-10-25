import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * 内置扩展磁盘根统一守卫（AGENTS 领域速查「内置扩展热更新」第三条）：
 * 内置扩展的磁盘根必须统一走 index.ts 的 resolveBuiltInExtensionRoots() →
 * builtInExtensions.ts 的 resolve* 解析器（dev appPath / packaged resourcesPath /
 * userData 覆盖层三态），任何绕过解析器直拼路径的代码会破坏三态布局与覆盖层优先级。
 *
 * 守卫两条直拼形态：
 * 1. join(process.resourcesPath …, "extensions") / join(app.getAppPath() …, "extensions")——
 *    收口外直拼资源根（用户扩展目录 ~/.pi/agent/extensions 不在此列，是另一域）。
 * 2. 字面量 "builtin-extensions" / "builtin-extensions.bak"（覆盖层/备份目录名）——
 *    只允许出现在内置扩展模块自身与其实现装配点 index.ts。
 * 正则空白容忍（AGENTS 格式化纪律）。
 */

function mainTsFiles() {
	return execFileSync("git", ["ls-files", "src/main"], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".ts"));
}

/** 内置扩展三纪律的实现收口文件（允许出现目录名/资源根拼接）。 */
const ALLOWLIST = new Set([
	"src/main/extensions/builtInExtensions.ts", // roots 解析器与目录决策本体
	"src/main/extensions/builtInExtensionsManifest.ts", // 目录名常量定义
	"src/main/extensions/builtInExtensionsUpdater.ts", // 覆盖层写盘（经注入的 resolveOverlayDir）
	"src/main/index.ts", // resolveBuiltInExtensionRoots 装配点
]);

test("资源根「join × extensions」直拼只允许出现在收口文件", () => {
	const directJoin = /join\(\s*(?:process\.resourcesPath|app\.getAppPath\(\))/;
	const violations = [];
	for (const file of mainTsFiles()) {
		if (ALLOWLIST.has(file)) continue;
		const code = readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/[^\n]*/g, "");
		// 直拼 + 同串/近邻出现 extensions 段（粗匹配后人工看名单），排除用户扩展目录注释域
		if (directJoin.test(code) && /["']extensions["']/.test(code)) violations.push(file);
	}
	assert.deepEqual(violations, [], `内置扩展磁盘根必须经 resolveBuiltInExtensionRoots() 解析（AGENTS 内置扩展热更新第三条），直拼见：\n${violations.join("\n")}`);
});

test("覆盖层目录名字面量只允许出现在收口文件", () => {
	const violations = [];
	for (const file of mainTsFiles()) {
		if (ALLOWLIST.has(file)) continue;
		const code = readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/[^\n]*/g, "");
		if (/["']builtin-extensions(\.bak)?["']/.test(code)) violations.push(file);
	}
	assert.deepEqual(violations, [], `覆盖层/备份目录名必须引用 BUILT_IN_EXTENSIONS_OVERLAY_DIR_NAME 常量，不得散落字面量：\n${violations.join("\n")}`);
});

test("收口完整性：roots 解析器与目录名常量仍然存在且被 index.ts 装配", () => {
	const builtIn = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
	assert.match(builtIn, /export function resolveBuiltInExtensionsDir\(/, "resolveBuiltInExtensionsDir 解析器必须存在");
	assert.match(builtIn, /export function resolveVendorNodeModulesDir\(/, "vendored 依赖解析器必须存在");
	assert.match(builtIn, /export function listActiveBuiltInExtensionPaths\(/, "注入路径列表解析器必须存在");
	const index = readFileSync("src/main/index.ts", "utf8");
	assert.match(index, /resolveBuiltInExtensionRoots\(\)/, "index.ts 必须保留唯一装配点");
});
