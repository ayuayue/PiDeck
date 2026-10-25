/**
 * F2 · shared 契约层纯度守卫（TEST-PLAN §F2，7 例）。
 *
 * src/shared/api/ 是纯契约层（AGENTS.md「shared/ 不得反向依赖任何运行时层」）：
 * 静态扫描每个 .ts 文件的 import 边界、文件体量与禁用写法。本测试只读源码文本，
 * 不加载模块（加载路径守卫在 F1/F3）；后续阶段（T7 后）同一守卫扩展到 composeFacade.ts
 * 与 renderer 的 unifiedApi.ts——本文件先以「文件存在性条件跳过」预留，不写死名单。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const API_DIR = new URL("../src/shared/api/", import.meta.url);
const sourceFiles = readdirSync(API_DIR).filter((name) => name.endsWith(".ts"));

// F2-1 阶段口径：T4 后 shared/api 至少 5 个契约文件（domainTypes/domainCatalog/facadeTypes/importerCatalog/consolidations）。
const REQUIRED_AFTER_T4 = ["domainTypes.ts", "domainCatalog.ts", "facadeTypes.ts", "importerCatalog.ts", "consolidations.ts"];

// F2-6 禁入清单：相对路径逃逸出 src/shared/、electron/node 运行时模块、动态 import()。
const FORBIDDEN_SPECIFIER = /^(\.\.\/|\.\.\\)/;
const RUNTIME_SPECIFIERS = /^(electron|node:[a-z]|fs|path|os|util|crypto|child_process|http|https)(\/|$)/;

/** 提取一个源文件文本里的全部静态 import specifier（type 与 value import 都算）。 */
function extractImportSpecifiers(source) {
	const specifiers = [];
	const pattern = /import\s+(?:type\s+)?[\s\S]*?from\s+["']([^"']+)["']|import\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of source.matchAll(pattern)) specifiers.push(match[1] ?? match[2] ?? match[3]);
	return specifiers;
}

test("F2-1 src/shared/api/ 至少含 5 个契约文件且必备名单齐全", () => {
	assert.ok(sourceFiles.length >= 5, `契约文件数 ${sourceFiles.length} < 5`);
	for (const name of REQUIRED_AFTER_T4) assert.ok(sourceFiles.includes(name), `缺少契约文件 ${name}`);
});

test("F2-2 所有 import specifier 都落在 src/shared/ 内（无运行时层依赖）", () => {
	for (const name of sourceFiles) {
		const source = readFileSync(new URL(name, API_DIR), "utf8");
		for (const specifier of extractImportSpecifiers(source)) {
			assert.ok(!FORBIDDEN_SPECIFIER.test(specifier), `${name}: 禁止相对逃逸出 shared：${specifier}`);
			assert.ok(!RUNTIME_SPECIFIERS.test(specifier), `${name}: 禁止运行时模块依赖：${specifier}`);
		}
	}
});

test("F2-3 每个契约文件 ≤400 行（AGENTS.md 文件体量红线）", () => {
	for (const name of sourceFiles) {
		const source = readFileSync(new URL(name, API_DIR), "utf8");
		const lineCount = source.split("\n").length;
		assert.ok(lineCount <= 400, `${name}: ${lineCount} 行 > 400`);
	}
});

test("F2-4 composeFacade.ts（若已落盘，T7 交付）不得有模块顶层副作用调用", () => {
	if (!sourceFiles.includes("composeFacade.ts")) return; // T7 前允许缺席
	const source = readFileSync(new URL("composeFacade.ts", API_DIR), "utf8");
	// 顶层副作用：不在 export const/function/import 声明内的函数调用（粗粒度静态检查）。
	const stripped = source
		.replace(/^(?:import|export)\s[^\n]*$/gm, "")
		.replace(/^[\t ]*[/*][^\n]*$/gm, "")
		.replace(/^[\t ]*$/gm, "");
	assert.ok(!/^[\t ]*[a-zA-Z_$][\w$.]*\(/m.test(stripped), "composeFacade 顶层不得有副作用调用（工厂只登记不调用）");
});

test("F2-5 renderer unifiedApi.ts（若已落盘，T7 交付）同受 shared 边界约束", () => {
	let source;
	try {
		source = readFileSync(new URL("../src/renderer/src/unifiedApi.ts", import.meta.url), "utf8");
	} catch {
		return; // T7 前允许缺席
	}
	// 边界口径（S7）：入口只许两类 import——同目录引用（./desktopApi）与上溯两级进 shared/api
	// 契约层（renderer/src → ../../shared/api/）。白名单收紧：electron/node 运行时、main/preload、
	// 裸包、更深上溯、../../shared 其余子目录（如 types/）一律拒绝。
	const ALLOWED_SPECIFIER = /^(?:\.\/|\.\.\/\.\.\/shared\/api\/)/;
	for (const specifier of extractImportSpecifiers(source)) {
		assert.ok(ALLOWED_SPECIFIER.test(specifier), `unifiedApi.ts: import 越界（仅许同目录或 ../../shared/api/）：${specifier}`);
		assert.ok(!RUNTIME_SPECIFIERS.test(specifier), `unifiedApi.ts: 禁止运行时模块依赖：${specifier}`);
	}
	assert.ok(!/\bimport\s*\(/.test(source), "unifiedApi.ts: 禁止动态 import()");
});

test("F2-6 禁入清单双保险：main/preload/renderer 相对 import、electron/node 运行时模块、动态 import()", () => {
	for (const name of sourceFiles) {
		const source = readFileSync(new URL(name, API_DIR), "utf8");
		assert.ok(!/from\s+["']\.\.\/(?:main|preload|renderer)\//.test(source), `${name}: 禁止 import 运行时层`);
		assert.ok(!/from\s+["']electron["']/.test(source), `${name}: 禁止 import electron`);
		assert.ok(!/\bimport\s*\(/.test(source), `${name}: 禁止动态 import()`);
	}
});

test('F2-7 内联坏样本分辨力：禁用写法扫描（" any" / as any / as unknown as）对坏文本必红', () => {
	const scan = (text) => [": any", "as any", " as unknown as "].filter((bad) => text.includes(bad));
	for (const name of sourceFiles) {
		const source = readFileSync(new URL(name, API_DIR), "utf8");
		assert.deepEqual(scan(source), [], `${name} 含禁用 any/强转写法`);
	}
	// 分辨力：坏样本必须被同一扫描函数检出（测试自证不是恒真断言）。
	assert.deepEqual(scan("function f(x: any) { return x as any; } y = z as unknown as W;"), [": any", "as any", " as unknown as "]);
});
