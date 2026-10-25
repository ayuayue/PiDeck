import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// isWelcomeModelLost：欢迎页（引导页）localStorage 偏好中的模型是否已从模型目录消失。
// 回归场景：用户删除供应商/模型后，底栏/选择器仍把残留偏好当作默认模型显示
// （用户反馈「模型都删了，默认还是之前的」）。目录未就绪（空）时不判定，
// 避免误清仍有效的偏好。
//
// shouldClearWelcomePreference：是否该真的把偏好从 localStorage 删掉（唯一会销毁
// 用户点选的路径）。展示判定可以宽容，但销毁判定必须保守：只有「一次成功的
// 完整加载」且「全局范围目录」确实缺项时才清。

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
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: () => ({}),
		},
		{ filename: "chatSessionBootstrap.ts" },
	);
	return module.exports;
}

const { isWelcomeModelLost, shouldClearWelcomePreference } = loadFunction();

const CATALOG = [
	{ provider: "thetoken", id: "deepseek-v4-flash-0731" },
	{ provider: "openai", id: "gpt-5" },
];

test("偏好模型仍在目录：未失效，继续作为默认展示", () => {
	assert.equal(isWelcomeModelLost({ provider: "thetoken", modelId: "deepseek-v4-flash-0731" }, CATALOG), false);
});

test("偏好模型已被删除：失效", () => {
	assert.equal(isWelcomeModelLost({ provider: "thetoken", modelId: "old-deleted-model" }, CATALOG), true);
});

test("偏好供应商整体已被删除：失效", () => {
	assert.equal(isWelcomeModelLost({ provider: "removed-provider", modelId: "x" }, CATALOG), true);
});

test("无偏好：不判定（不误伤空场景）", () => {
	assert.equal(isWelcomeModelLost(undefined, CATALOG), false);
});

test("目录为空（未就绪/加载失败）：不判定，避免误清仍有效的偏好", () => {
	assert.equal(isWelcomeModelLost({ provider: "thetoken", modelId: "deepseek-v4-flash-0731" }, []), false);
});

// ---- shouldClearWelcomePreference：销毁偏好的保守判定 ----
// 回归场景：偏好是全局 localStorage，而 ComposerPickerHost 在有 record 时按
// record.projectId 加载「项目范围」目录；项目列表合法地不含该模型时，
// 旧逻辑会直接 removeItem，把用户仍然有效的点选静默销毁。

const PICK = { provider: "thetoken", modelId: "deepseek-v4-flash-0731" };
const GLOBAL_OK = { models: CATALOG, catalogLoaded: true, catalogIsGlobal: true };

test("全局目录加载成功且确实缺项：清掉残留偏好", () => {
	assert.equal(shouldClearWelcomePreference({ ...GLOBAL_OK, welcomeModel: { provider: "thetoken", modelId: "old-deleted" } }), true);
});

test("目录尚未加载成功（加载中/IPC 失败）：不得销毁偏好", () => {
	assert.equal(
		shouldClearWelcomePreference({
			models: [{ provider: "openai", id: "gpt-5" }],
			welcomeModel: PICK,
			catalogLoaded: false,
			catalogIsGlobal: true,
		}),
		false,
	);
});

test("项目范围目录缺项：不得判死全局偏好", () => {
	assert.equal(
		shouldClearWelcomePreference({
			models: [{ provider: "openai", id: "gpt-5" }],
			welcomeModel: PICK,
			catalogLoaded: true,
			catalogIsGlobal: false,
		}),
		false,
	);
});

test("目录为空：不销毁偏好（与展示判定同样宽容）", () => {
	assert.equal(shouldClearWelcomePreference({ ...GLOBAL_OK, models: [], welcomeModel: PICK }), false);
});

test("无偏好 / 偏好仍在目录：不销毁", () => {
	assert.equal(shouldClearWelcomePreference({ ...GLOBAL_OK, welcomeModel: undefined }), false);
	assert.equal(shouldClearWelcomePreference({ ...GLOBAL_OK, welcomeModel: PICK }), false);
});
