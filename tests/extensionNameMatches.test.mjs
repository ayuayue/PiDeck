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

test("only todo / plan / ask built-ins participate in conflict detection", () => {
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS.length, 3);
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[0][0], "pi-deck-todo.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[0][1], "todo");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[1][0], "pi-deck-plan-mode.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[1][1], "plan");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[2][0], "pi-deck-ask-question.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[2][1], "ask");
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

test("unrelated packages do not match todo/plan/ask keywords", () => {
	// 本次 bug：context-mode 与 plan-mode 不冲突
	assert.equal(extensionNameMatches("npm:context-mode", "plan"), false);
	assert.equal(extensionNameMatches("context-mode", "todo"), false);
	assert.equal(extensionNameMatches("npm:context-mode", "ask"), false);
	assert.equal(extensionNameMatches("npm:pi-web-access", "plan"), false);
	assert.equal(extensionNameMatches("npm:pi-web-access", "todo"), false);
	assert.equal(extensionNameMatches("npm:pi-web-access", "ask"), false);
});
