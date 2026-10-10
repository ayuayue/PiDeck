import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// resolveBackendSwitchDefaults：切后端（pi ↔ dsh ↔ imagegen）时写回 record 的
// 默认模型/思考档位决策。回归场景：dsh→pi 切换曾直接清空 model/thinkingLevel，
// 导致用户 pi 配置里的 defaultProvider/defaultModel 不出现在切回后的会话
// （底栏回退到残留的 DSH 默认模型）。这里锁住「切回 pi 必须带出 pi 启动默认」。

function loadResolver() {
	const source = readFileSync("src/renderer/src/utils/backendSwitchDefaults.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "backendSwitchDefaults.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: () => ({}),
		},
		{ filename: "backendSwitchDefaults.ts" },
	);
	return module.exports.resolveBackendSwitchDefaults;
}

const resolve = loadResolver();

// vm 独立 realm 里创建的对象原型不同，deepEqual 会误报；JSON 往返归一到宿主 realm。
const plain = (value) => (value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value);

test("dsh→pi 切换：写入 pi 配置解析出的默认模型与思考档位", () => {
	const result = resolve("pi", {
		model: { provider: "thetoken", modelId: "deepseek-v4-flash-0731" },
		thinkingLevel: "max",
	});
	assert.deepEqual(plain(result), {
		model: { provider: "thetoken", modelId: "deepseek-v4-flash-0731" },
		thinkingLevel: "max",
	});
});

test("dsh→pi 切换：解析结果为空时清空（updateRecord null 语义）", () => {
	assert.deepEqual(plain(resolve("pi", undefined)), { model: null, thinkingLevel: null });
	assert.deepEqual(plain(resolve("pi", {})), { model: null, thinkingLevel: null });
});

test("pi→dsh 切换：模型由 DSH 部署默认决定，record 清空", () => {
	assert.deepEqual(
		plain(
			resolve("dsh", {
				model: { provider: "thetoken", modelId: "deepseek-v4-flash-0731" },
				thinkingLevel: "max",
			}),
		),
		{ model: null, thinkingLevel: null },
	);
});

test("切到 imagegen：独立生图配置，record 同样清空", () => {
	assert.deepEqual(
		plain(
			resolve("imagegen", {
				model: { provider: "thetoken", modelId: "deepseek-v4-flash-0731" },
				thinkingLevel: "max",
			}),
		),
		{ model: null, thinkingLevel: null },
	);
});

test("切到 acp：模型由 agent CLI 自决（ACP session/config options），record 清空", () => {
	assert.deepEqual(
		plain(
			resolve("acp", {
				model: { provider: "thetoken", modelId: "deepseek-v4-flash-0731" },
				thinkingLevel: "max",
			}),
		),
		{ model: null, thinkingLevel: null },
	);
});
