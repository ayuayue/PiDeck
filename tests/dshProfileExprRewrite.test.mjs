import test from "node:test";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { rewriteLoaderExprPackageResolves } = loadTsCommonJs("src/main/dsh/dshProfileExprRewrite.ts");
const { dumpProfilePatches, parseProfilePatches } = loadTsCommonJs("src/main/dsh/dshProfileSettings.ts");

/** 官方 0.2.0-rc.2 cordis 预设 cordis.patch.yml:147 的原样表达式（回归锚点）。 */
const OFFICIAL_CORDIS_EXPR = "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')";
const PRESET_PKG_JSON = "@deepseek-ai/dsh-agent-preset/package.json";
const RESOLVED = "/runtime/node_modules/@deepseek-ai/dsh-agent-preset/package.json";
const resolver = (specifier) => (specifier === PRESET_PKG_JSON ? RESOLVED : undefined);

/** 模拟 dump 前的 composition：patch 行 → insert → preset config → plugins 数组深处的表达式。 */
function compositionTree() {
	return [
		{ id: "skill-filesystem", disabled: true },
		{
			insert: [
				{
					id: "preset-cordis",
					name: "@deepseek-ai/dsh-agent-preset",
					config: {
						id: "cordis",
						plugins: [{ id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem", config: { customSkillDirs: [{ __jsExpr: OFFICIAL_CORDIS_EXPR }] } }],
					},
				},
			],
		},
	];
}

test("official cordis customSkillDirs expression is rewritten to the runtime-resolved path", () => {
	const rewritten = rewriteLoaderExprPackageResolves(compositionTree(), resolver);
	const expr = rewritten[1].insert[0].config.plugins[0].config.customSkillDirs[0].__jsExpr;
	assert.equal(expr.includes("createRequire"), false, "createRequire fragment must be gone");
	// loader 求值等价：表达式不再依赖 baseUrl，直接求值应得到 skills 目录。
	const evaluated = new Function(`return (${expr})`)();
	assert.equal(evaluated, join(dirname(RESOLVED), "skills"));
	// 与表达式无关的行保持不变。
	// vm 沙箱产物与 host 字面量不同 realm，deepEqual 需先 JSON 归一化。
	assert.deepEqual(JSON.parse(JSON.stringify(rewritten[0])), { id: "skill-filesystem", disabled: true });
});

test("rewrite returns a structurally identical new tree and never mutates its input", () => {
	const input = compositionTree();
	const snapshot = structuredClone(input);
	const rewritten = rewriteLoaderExprPackageResolves(input, resolver);
	const expectedExpr = OFFICIAL_CORDIS_EXPR.replace("process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')", JSON.stringify(RESOLVED));
	assert.deepEqual(JSON.parse(JSON.stringify(rewritten[1].insert[0])), {
		id: "preset-cordis",
		name: "@deepseek-ai/dsh-agent-preset",
		config: {
			id: "cordis",
			plugins: [{ id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem", config: { customSkillDirs: [{ __jsExpr: expectedExpr }] } }],
		},
	});
	assert.deepEqual(JSON.parse(JSON.stringify(input)), JSON.parse(JSON.stringify(snapshot)), "input tree must stay untouched");
});

test("runtime resolve failure keeps the original expression (fail-safe)", () => {
	const rewritten = rewriteLoaderExprPackageResolves(compositionTree(), () => undefined);
	assert.equal(rewritten[1].insert[0].config.plugins[0].config.customSkillDirs[0].__jsExpr, OFFICIAL_CORDIS_EXPR);
});

test("expressions without package resolves pass through unchanged, including disabled predicates", () => {
	const input = [{ id: "hmr", disabled: { __jsExpr: "!ctx.get('profileContext')" }, config: { note: { __jsExpr: "process.platform === 'win32'" } } }];
	const snapshot = structuredClone(input);
	assert.deepEqual(JSON.parse(JSON.stringify(rewriteLoaderExprPackageResolves(input, resolver))), JSON.parse(JSON.stringify(snapshot)));
});

test("windows runtime paths are embedded as escaped JSON string literals", () => {
	const windowsPath = "C:\\runtimes\\dsh\\node_modules\\@deepseek-ai\\dsh-agent-preset\\package.json";
	const rewritten = rewriteLoaderExprPackageResolves(compositionTree(), () => windowsPath);
	const expr = rewritten[1].insert[0].config.plugins[0].config.customSkillDirs[0].__jsExpr;
	const embedded = JSON.stringify(windowsPath);
	assert.ok(expr.includes(embedded), `expr must embed ${embedded}: ${expr}`);
	// 嵌入的字面量本身必须是合法 JS 字符串（eval 还原出原始 Windows 路径）。
	assert.equal(new Function(`return (${embedded})`)(), windowsPath);
});

test("dump/parse round trip keeps the rewritten path as an evaluatable expression", () => {
	const yamlText = dumpProfilePatches(rewriteLoaderExprPackageResolves(compositionTree(), resolver));
	assert.equal(yamlText.includes("createRequire"), false);
	const parsed = parseProfilePatches(yamlText);
	const expr = parsed[1].insert[0].config.plugins[0].config.customSkillDirs[0].__jsExpr;
	assert.equal(new Function(`return (${expr})`)(), join(dirname(RESOLVED), "skills"));
});
