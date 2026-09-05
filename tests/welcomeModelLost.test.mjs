import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// isWelcomeModelLost：欢迎页（引导页）localStorage 偏好中的模型是否已从模型目录消失。
// 回归场景：用户删除供应商/模型后，底栏/选择器仍把残留偏好当作默认模型显示
// （用户反馈「模型都删了，默认还是之前的」）。目录未就绪（空）时不判定，
// 避免误清仍有效的偏好。

function loadFunction() {
	const source = readFileSync("src/renderer/src/utils/chatSessionBootstrap.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "chatSessionBootstrap.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: () => ({}),
	}, { filename: "chatSessionBootstrap.ts" });
	return module.exports.isWelcomeModelLost;
}

const isWelcomeModelLost = loadFunction();

const CATALOG = [
	{ provider: "thetoken", id: "deepseek-v4-flash-0731" },
	{ provider: "openai", id: "gpt-5" },
];

test("偏好模型仍在目录：未失效，继续作为默认展示", () => {
	assert.equal(
		isWelcomeModelLost({ provider: "thetoken", modelId: "deepseek-v4-flash-0731" }, CATALOG),
		false,
	);
});

test("偏好模型已被删除：失效", () => {
	assert.equal(
		isWelcomeModelLost({ provider: "thetoken", modelId: "old-deleted-model" }, CATALOG),
		true,
	);
});

test("偏好供应商整体已被删除：失效", () => {
	assert.equal(isWelcomeModelLost({ provider: "removed-provider", modelId: "x" }, CATALOG), true);
});

test("无偏好：不判定（不误伤空场景）", () => {
	assert.equal(isWelcomeModelLost(undefined, CATALOG), false);
});

test("目录为空（未就绪/加载失败）：不判定，避免误清仍有效的偏好", () => {
	assert.equal(
		isWelcomeModelLost({ provider: "thetoken", modelId: "deepseek-v4-flash-0731" }, []),
		false,
	);
});
