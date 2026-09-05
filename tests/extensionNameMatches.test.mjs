import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadWslPaths() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

/** 复用 ExtensionManager 的 WSL mock 加载方式，只导出冲突匹配相关符号。 */
function loadExtensionConflictHelpers() {
	const wslPaths = loadWslPaths();
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "../wsl/WslPaths") return wslPaths;
			// ExtensionManager 依赖内置扩展清单；名字匹配测试用空清单即可
			if (id === "./builtInExtensions") return { BUILT_IN_EXTENSIONS: [] };
			// 删除走系统回收站统一入口；本测试不触达删除路径，提供 noop stub 即可。
			if (id === "../fs/trash") return { trashPath: async () => {} };
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			if (id === "./extensionVersionGate") {
				return require("../src/main/extensions/extensionVersionGate.ts");
			}
			// ExtensionManager 依赖 ../utils/versionCompare 的 compareVersions；.ts 经 node 类型剥离可 require。
			if (id === "../utils/versionCompare") {
				return require("../src/main/utils/versionCompare.ts");
			}
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/extensions/ExtensionManager.ts"), sandbox, {
		filename: "ExtensionManager.ts",
	});
	return {
		extensionNameMatches: sandbox.exports.extensionNameMatches,
		BUILT_IN_CONFLICT_KEYWORDS: sandbox.exports.BUILT_IN_CONFLICT_KEYWORDS,
	};
}

const { extensionNameMatches, BUILT_IN_CONFLICT_KEYWORDS } = loadExtensionConflictHelpers();

test("only todo / plan / goal / ask built-ins participate in conflict detection", () => {
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS.length, 4);
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[0][0], "pi-deck-todo.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[0][1], "todo");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[1][0], "pi-deck-plan-mode.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[1][1], "plan");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[2][0], "pi-deck-goal-mode.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[2][1], "goal");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[3][0], "pi-deck-ask-question.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[3][1], "ask");
});

test("names containing todo conflict with system todo keyword", () => {
	assert.equal(extensionNameMatches("npm:todo", "todo"), true);
	assert.equal(extensionNameMatches("todo.ts", "todo"), true);
	assert.equal(extensionNameMatches("npm:@juicesharp/rpiv-todo", "todo"), true);
	assert.equal(extensionNameMatches("npm:my-todo-helper", "todo"), true);
});

test("names containing plan conflict with system plan keyword", () => {
	assert.equal(extensionNameMatches("npm:plan-mode", "plan"), true);
	assert.equal(extensionNameMatches("foo-plan-mode.ts", "plan"), true);
	assert.equal(extensionNameMatches("npm:my-plan-helper", "plan"), true);
});

test("names containing ask conflict with system ask keyword", () => {
	assert.equal(extensionNameMatches("npm:ask-question", "ask"), true);
	assert.equal(extensionNameMatches("ask-question.ts", "ask"), true);
	assert.equal(extensionNameMatches("npm:@juicesharp/rpiv-ask-user-question", "ask"), true);
	assert.equal(extensionNameMatches("npm:my-ask-helper", "ask"), true);
});

test("unrelated packages do not match todo/plan/goal/ask keywords", () => {
	// 本次 bug：context-mode 与 plan-mode 不冲突
	assert.equal(extensionNameMatches("npm:context-mode", "plan"), false);
	assert.equal(extensionNameMatches("context-mode", "todo"), false);
	assert.equal(extensionNameMatches("npm:context-mode", "ask"), false);
	assert.equal(extensionNameMatches("npm:context-mode", "goal"), false);
	assert.equal(extensionNameMatches("npm:pi-web-access", "plan"), false);
	assert.equal(extensionNameMatches("npm:pi-web-access", "todo"), false);
	assert.equal(extensionNameMatches("npm:pi-web-access", "ask"), false);
});

test("names containing goal conflict with system goal keyword", () => {
	assert.equal(extensionNameMatches("npm:goal-mode", "goal"), true);
	assert.equal(extensionNameMatches("foo-goal-mode.ts", "goal"), true);
});
