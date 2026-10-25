import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { extensionNameMatches, BUILT_IN_CONFLICT_KEYWORDS } = loadTsCommonJs("src/main/extensions/ExtensionManager.ts", {
	stubs: {
		"../fs/trash": { trashPath: async () => {} },
		"../logging/sharedLogger": { getAppLogger: () => null },
		"../pi/PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
	},
});

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
