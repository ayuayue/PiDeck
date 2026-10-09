import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	projectResourceEnabled,
	setResourceRuleEnabled,
	stripExactResourceRules,
	stripPackageRootResourceRules,
	hasExactResourceEntry,
	resolveBuiltinExtensionState,
	setBuiltinExtensionEnabled,
	disablePackageFilters,
	isPackageFullyDisabled,
	hasPackageFilterKeys,
	collapsePackageEntry,
	disablePackageDeltaFilters,
	enablePackageDeltaFilters,
	isPackageDeltaFullyDisabled,
	PACKAGE_DELTA_DISABLE_PATTERNS,
	normalizeResourceValue,
} = loadTsCommonJs("src/main/config/piResourceRules.ts");

test("setResourceRuleEnabled adds exact +/- without touching user globs", () => {
	// 用户写了广域排除：PiDeck 启用时必须补精确 +，否则资源仍然不加载
	const entries = ["!*", "/home/me/keep.ts", "+/home/me/other.ts"];
	const on = setResourceRuleEnabled({ entries, value: "/home/me/keep.ts", enabled: true, platform: "linux" });
	assert.deepEqual([...on], ["!*", "/home/me/keep.ts", "+/home/me/other.ts", "+/home/me/keep.ts"]);
	// 停用：显式路径保留（删了再也匹配不到），加精确 -
	const off = setResourceRuleEnabled({ entries: on, value: "/home/me/keep.ts", enabled: false, platform: "linux" });
	assert.deepEqual([...off], ["!*", "/home/me/keep.ts", "+/home/me/other.ts", "-/home/me/keep.ts"]);
	// 再启用：不残留反向 token
	assert.deepEqual([...setResourceRuleEnabled({ entries: off, value: "/home/me/keep.ts", enabled: true, platform: "linux" })], ["!*", "/home/me/keep.ts", "+/home/me/other.ts", "+/home/me/keep.ts"]);
});

test("exact matching is case/separator tolerant on win32 only", () => {
	assert.equal(normalizeResourceValue("C:\\Users\\A\\x.ts", "win32"), "c:/users/a/x.ts");
	assert.equal(normalizeResourceValue("/home/A/x.ts", "linux"), "/home/A/x.ts");
	assert.equal(hasExactResourceEntry(["-c:\\users\\a\\x.ts"], "C:/Users/A/x.ts", "win32"), true);
	assert.equal(hasExactResourceEntry(["-c:\\users\\a\\x.ts"], "C:/Users/A/x.ts", "linux"), false);
	// 更宽的 glob 不算精确条目
	assert.equal(hasExactResourceEntry(["!/*.ts"], "/a/x.ts", "linux"), false);
});

test("stripExactResourceRules only removes rules pointing at the same value", () => {
	assert.deepEqual([...stripExactResourceRules(["-/a/x.ts", "-/a/y.ts", "!/a/*"], "/a/x.ts", "linux")], ["-/a/y.ts", "!/a/*"]);
});

test("builtin extension toggles use +builtin:/−builtin: specifiers", () => {
	const off = setBuiltinExtensionEnabled({ entries: ["!builtin:*"], name: "mcp", enabled: false });
	assert.deepEqual([...off], ["!builtin:*", "-builtin:mcp"]);
	const on = setBuiltinExtensionEnabled({ entries: off, name: "mcp", enabled: true });
	assert.deepEqual([...on], ["!builtin:*", "+builtin:mcp"]);
});

test("resolveBuiltinExtensionState reflects layer and inherited exact rules", () => {
	const state = resolveBuiltinExtensionState({ entries: ["-builtin:codemode"], name: "codemode", platform: "linux" });
	assert.equal(state.enabled, false);
	assert.equal(state.explicitInLayer, true);
	// 项目层 +builtin:mcp 覆盖全局 -builtin:mcp
	const project = resolveBuiltinExtensionState({ entries: ["+builtin:mcp"], name: "mcp", platform: "linux" });
	assert.equal(project.enabled, true);
	// 未显式写过 → 默认启用、继承
	const inherit = resolveBuiltinExtensionState({ entries: [], name: "llama.cpp", platform: "linux" });
	assert.equal(inherit.enabled, true);
	assert.equal(inherit.explicitInLayer, false);
});

test("builtin global exclusions honor globs and exact negative rules after includes", () => {
	for (const pattern of ["!builtin:*", "!builtin:{mcp,codemode}", "!builtin:code?ode"]) {
		const state = resolveBuiltinExtensionState({ entries: [pattern], name: "codemode" });
		assert.equal(state.enabled, false, pattern);
		assert.equal(state.explicitInLayer, true, pattern);
	}
	assert.equal(resolveBuiltinExtensionState({ entries: ["!builtin:*", "+builtin:codemode"], name: "codemode" }).enabled, true);
	assert.equal(resolveBuiltinExtensionState({ entries: ["-builtin:codemode", "+builtin:codemode"], name: "codemode" }).enabled, false);
	assert.equal(resolveBuiltinExtensionState({ entries: ["+builtin:*", "!builtin:codemode"], name: "codemode" }).enabled, false, "+ is exact, not a glob");
	assert.equal(resolveBuiltinExtensionState({ entries: ["builtin:codemode"], name: "codemode" }).explicitInLayer, false, "plain sources are not overrides");
});

test("builtin project overrides use the last matching rule and otherwise inherit", () => {
	const baseEntries = ["!builtin:*"];
	const inherited = resolveBuiltinExtensionState({ baseEntries, entries: ["-builtin:mcp"], name: "codemode" });
	assert.equal(inherited.enabled, false);
	assert.equal(inherited.explicitInLayer, false);
	assert.equal(inherited.explicitInBase, true);
	assert.equal(resolveBuiltinExtensionState({ baseEntries, entries: ["-builtin:codemode", "+builtin:codemode"], name: "codemode" }).enabled, true);
	assert.equal(resolveBuiltinExtensionState({ baseEntries, entries: ["+builtin:codemode", "!builtin:*"], name: "codemode" }).enabled, false);
	assert.equal(resolveBuiltinExtensionState({ baseEntries, entries: ["!builtin:*", "+builtin:codemode"], name: "codemode" }).enabled, true);
});

test("builtin exact rules match Pi's normalized virtual specifier without Windows case folding", () => {
	assert.equal(resolveBuiltinExtensionState({ entries: ["-./builtin:codemode"], name: "codemode", platform: "win32" }).enabled, false);
	assert.equal(resolveBuiltinExtensionState({ entries: ["-builtin:CODEMODE"], name: "codemode", platform: "win32" }).enabled, true);
	const on = setBuiltinExtensionEnabled({ entries: ["-./builtin:codemode", "!builtin:*", "-builtin:mcp"], name: "codemode", enabled: true });
	assert.deepEqual([...on], ["!builtin:*", "-builtin:mcp", "+builtin:codemode"]);
	assert.equal(resolveBuiltinExtensionState({ entries: on, name: "codemode" }).enabled, true);
});

test("package whole-disable writes empty filters for all four kinds", () => {
	const entry = { source: "npm:demo", version: "1.2.3", futureField: { keep: true } };
	const disabled = disablePackageFilters(entry);
	assert.equal(disabled.source, "npm:demo");
	assert.equal(disabled.version, "1.2.3");
	assert.deepEqual(JSON.parse(JSON.stringify(disabled.futureField)), { keep: true });
	for (const kind of ["extensions", "skills", "prompts", "themes"]) assert.deepEqual([...disabled[kind]], []);
	assert.equal(isPackageFullyDisabled(disabled), true);
	// 部分过滤不算整包停用
	assert.equal(isPackageFullyDisabled({ source: "npm:demo", extensions: [] }), false);
});

test("project package delta disable/enable use native pattern sets, not empty arrays", () => {
	const delta = { source: "npm:demo", autoload: false };
	const disabled = disablePackageDeltaFilters(delta);
	assert.deepEqual([...disabled.extensions], [...PACKAGE_DELTA_DISABLE_PATTERNS]);
	assert.equal(disabled.autoload, false);
	assert.equal(isPackageDeltaFullyDisabled(disabled), true);
	const enabled = enablePackageDeltaFilters(delta);
	assert.deepEqual([...enabled.skills], ["*", ".*"]);
	assert.equal(isPackageDeltaFullyDisabled(enabled), false);
	// 空的 delta 数组是「没有覆盖」，绝不能被当成停用
	assert.equal(isPackageDeltaFullyDisabled({ source: "npm:demo", autoload: false, extensions: [] }), false);
});

test("stripPackageRootResourceRules removes only rules pointing exactly at a package dir", () => {
	const entries = [
		"-/agent/npm/node_modules/billion-context-pi", // 迁移残留：包目录（pi 侧惰性）
		"+C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\demo", // 同一残留的正向形态
		"-builtin:llama.cpp", // 内置扩展规则：与包目录无关
		"!/agent/npm/node_modules/demo/*.ts", // glob 不是精确规则
		"-/agent/npm/node_modules/demo/dist/index.js", // 包内文件对 pi 有效，不能删
		"/agent/extensions/local.ts", // plain 声明：删了来源就消失
	];
	const result = stripPackageRootResourceRules({
		entries,
		packageDirs: ["/agent/npm/node_modules/billion-context-pi", "C:\\USERS\\ME\\.pi\\agent\\npm\\node_modules\\demo"],
		platform: "win32",
	});
	// win32：大小写与分隔符归一后再比对，包目录规则两个形态都命中
	assert.deepEqual([...result.removed], ["-/agent/npm/node_modules/billion-context-pi", "+C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\demo"]);
	assert.deepEqual([...result.entries], ["-builtin:llama.cpp", "!/agent/npm/node_modules/demo/*.ts", "-/agent/npm/node_modules/demo/dist/index.js", "/agent/extensions/local.ts"]);
	// posix：大小写不折叠，路径同样分隔符下命中
	const posix = stripPackageRootResourceRules({ entries: ["-/a/npm/node_modules/demo", "-/A/npm/node_modules/demo"], packageDirs: ["/a/npm/node_modules/demo"], platform: "linux" });
	assert.deepEqual([...posix.removed], ["-/a/npm/node_modules/demo"]);
	assert.deepEqual([...posix.entries], ["-/A/npm/node_modules/demo"]);
	// 没有目标时原样返回
	const untouched = stripPackageRootResourceRules({ entries: ["-builtin:mcp"], packageDirs: [], platform: "linux" });
	assert.deepEqual([...untouched.removed], []);
	assert.deepEqual([...untouched.entries], ["-builtin:mcp"]);
});

test("projectResourceEnabled reflects native include/exclude ordering (pi-verified)", () => {
	// 无规则 → 启用
	assert.equal(projectResourceEnabled({ entries: [], value: "/a/x/SKILL.md", baseDir: "/a/x" }), true);
	// 精确 - 停用
	assert.equal(projectResourceEnabled({ entries: ["-/a/x/SKILL.md"], value: "/a/x/SKILL.md", baseDir: "/a/x" }), false);
	// + 覆盖更宽的 ! 排除
	assert.equal(projectResourceEnabled({ entries: ["!*.md", "+/a/x/SKILL.md"], value: "/a/x/SKILL.md", baseDir: "/a/x" }), true);
	// - 又覆盖 +（pi 顺序：排除 → 强制包含 → 强制排除，- 最后生效）
	assert.equal(projectResourceEnabled({ entries: ["!*.md", "+/a/x/SKILL.md", "-/a/x/SKILL.md"], value: "/a/x/SKILL.md", baseDir: "/a/x" }), false);
	// 裸目录名不匹配（真实冒烟校准：pi 的 matchesAnyExactPattern 只认相对/绝对路径）
	assert.equal(projectResourceEnabled({ entries: ["-x"], value: "/a/x/SKILL.md", baseDir: "/a/x" }), true, "裸目录名在 pi 里不生效，投影不得显示为已停用");
	// 父目录相对路径形态：pi 对用户技能的 baseDir 是 agentDir，parentRel = "skills/x"
	assert.equal(projectResourceEnabled({ entries: ["-x"], value: "/agent/skills/x/SKILL.md", baseDir: "/agent" }), true, "baseDir=agentDir 时 -x 不等于 parentRel(skills/x)，不命中");
	assert.equal(projectResourceEnabled({ entries: ["-skills/x"], value: "/agent/skills/x/SKILL.md", baseDir: "/agent" }), false, "parentRel 完整形态命中");
	// baseDir 是技能目录的父目录时，parentRel 才是裸目录名
	assert.equal(projectResourceEnabled({ entries: ["-x"], value: "/agent/skills/x/SKILL.md", baseDir: "/agent/skills" }), false, "parentRel=x 时 -x 命中");
	// 父目录绝对路径
	assert.equal(projectResourceEnabled({ entries: ["-/agent/skills/x"], value: "/agent/skills/x/SKILL.md", baseDir: "/agent" }), false);
});

test("hasPackageFilterKeys treats explicit empty arrays as filters (they mean load-nothing)", () => {
	assert.equal(hasPackageFilterKeys({ source: "npm:a" }), false);
	assert.equal(hasPackageFilterKeys({ source: "npm:a", extensions: [] }), true, "空数组是「该类全关」的显式声明，不能当作没有过滤");
	assert.equal(hasPackageFilterKeys({ source: "npm:a", skills: ["-x/SKILL.md"] }), true);
});

test("collapsePackageEntry folds filter-free entries back to the plain string form (pi TUI parity)", () => {
	// 关过一次再启用、没有快照可用的场景：不折叠会被 pi list 永久标成 (filtered)
	assert.equal(collapsePackageEntry({ source: "npm:demo" }), "npm:demo");
	// 还有过滤 → 保持对象
	const filtered = { source: "npm:demo", extensions: ["keep.ts"] };
	assert.equal(collapsePackageEntry(filtered), filtered);
	// 过滤键还在但为空 → 仍算过滤，不折叠
	assert.equal(collapsePackageEntry({ source: "npm:demo", extensions: [] }).extensions.length, 0);
	// 有未知字段 → 保留对象，不丢数据
	const unknown = { source: "npm:demo", custom: 1 };
	assert.equal(collapsePackageEntry(unknown), unknown);
	// 缺 source → 原样返回（调用方不应写回这种条目）
	assert.deepEqual(collapsePackageEntry({ extensions: ["a"] }), { extensions: ["a"] });
});
