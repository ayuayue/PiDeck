/**
 * pet-smoke.cjs require 白名单与 PetWindow.ts 运行时 import 的双向把关。
 *
 * 背景（2026-09-15）：#213 给 PetWindow 新增 `../v8HeapLimits` import 后，
 * tests/petWindowCaps.test.mjs 与 scripts/pet-smoke.cjs 的 require 钩子都要同步——
 * 当时只给测试加了兜底（现已统一到 tests/helpers/createTsSandbox.mjs），
 * pet-smoke.cjs 的白名单没同步，CI「Pet Linux smoke (xvfb)」一进 require 钩子就抛
 * `unexpected require(../v8HeapLimits)`，4 秒失败，且白名单随 import 演进还会再漂。
 *
 * 约定：PetWindow.ts 每个运行时 import 的说明符必须作为字面量出现在
 * pet-smoke.cjs 里（electron / node: 前缀 / 白名单分支）。纯类型 import
 * （`import type ...`）转译后消失，不在此列。
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const smokeScript = readFileSync("scripts/pet-smoke.cjs", "utf8");
const petWindowSource = readFileSync("src/main/pet/PetWindow.ts", "utf8");

test("契约: pet-smoke 白名单覆盖 PetWindow 的全部运行时 import", () => {
	// 提取运行时 import 的模块说明符：import 后面不是 type 的都算
	// （`import type {...} from "x"` 与 `import {..., type Y} from "x"` 需区分：
	//  仅整句 type import 可安全跳过；内联 type 说明符的模块仍可能有运行时导出）
	const runtimeImports = [];
	for (const match of petWindowSource.matchAll(/import\s+([\s\S]*?)from\s*["']([^"']+)["']/g)) {
		const clause = match[1].trim();
		const specifier = match[2];
		// 整句 import type：转译后整行消失
		if (clause.startsWith("type ")) continue;
		// 内联 type 说明符：剔除 type X 后若还有运行时说明符，模块仍需加载
		const runtimeSpecifiers = clause
			.replace(/[{}]/g, " ")
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part && !part.startsWith("type "));
		if (runtimeSpecifiers.length > 0 || clause === "") runtimeImports.push(specifier);
		// `import "x"` 裸导入（clause 为空）也要覆盖
	}
	assert.ok(runtimeImports.length > 0, "未能从 PetWindow.ts 解析出任何 import，解析器需维护");

	const missing = runtimeImports.filter((specifier) => {
		if (specifier.startsWith("node:")) return !smokeScript.includes('id.startsWith("node:")');
		return !smokeScript.includes(specifier);
	});
	assert.deepEqual(missing, [], `PetWindow.ts 的运行时 import 未被 pet-smoke.cjs 白名单覆盖：${missing.join(", ")}。` + "新增依赖若是纯常量/纯函数模块，用 loadPureTsModule 分支；有副作用的模块加 stub 分支。");
});
