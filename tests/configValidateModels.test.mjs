/**
 * ConfigManager.validateModels 加固单测。
 *
 * 背景：用户反馈「改参数 + 改供应商名称后配置损坏，模型加载为空」。
 * 保存前在 main 侧做最终校验：provider 名（宽松安全校验，防路径穿越/控制字符）、
 * model id（拒绝控制字符/超长）、baseUrl（拒绝控制字符），阻断坏配置落盘。
 *
 * 注意：provider 名的严格白名单（字母开头、无空格特殊字符）仍只用于前端
 * 新增/重命名入口；main 侧用 isSafeProviderName 宽松校验，避免卡历史数据。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const syncRequire = createRequire(import.meta.url);
const MODULE_PATH = "src/main/config/ConfigManager.ts";

function compile() {
	const source = readFileSync(MODULE_PATH, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: MODULE_PATH,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => {
		if (specifier.startsWith("node:")) {
			// fs/promises 用 noop 替身，避免合法数据测试真的写盘。
			if (specifier === "node:fs/promises") {
				return {
					readFile: async () => {
						const e = new Error("ENOENT");
						e.code = "ENOENT";
						throw e;
					},
					writeFile: async () => {},
					mkdir: async () => {},
					rename: async () => {},
				};
			}
			return syncRequire(specifier);
		}
		if (specifier === "electron") return { net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) } };
		// provider 名宽松校验（与 providerMigration.isSafeProviderName 同规则）。
		if (specifier === "./providerMigration") {
			return {
				isSafeProviderName: (name) =>
					typeof name === "string" &&
					name.trim().length > 0 &&
					name.trim().length <= 80 &&
					!/[\\/]/.test(name) &&
					!name.includes(".."),
			};
		}
		// saveModelsConfig 会调用归因兜底（仅依赖纯常量，无副作用），加载真实实现避免空对象 stub
		if (specifier === "./tokendanceAttribution") {
			return loadTsCommonJs("src/main/config/tokendanceAttribution.ts");
		}
		if (specifier.includes("mainProcessCopy")) {
			return { mainProcessT: (_locale, key) => key };
		}
		// validateModels 路径不依赖其余模块（parse/usage/catalog 等），返回空对象即可。
		return {};
	};
	vm.runInNewContext(
		output,
		{ module, exports: module.exports, require: localRequire, console },
		{ filename: MODULE_PATH },
	);
	return module.exports;
}

const { ConfigManager } = compile();
const manager = new ConfigManager(undefined, (key) => key);

function makeModels(providerName, modelId = "gpt-4o", baseUrl = "https://api.example.com/v1") {
	return {
		providers: {
			[providerName]: { baseUrl, api: "openai-completions", models: [{ id: modelId }] },
		},
	};
}

test("合法配置通过校验", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai"));
	assert.equal(result.valid, true);
});

test("provider 名含路径分隔符被拒（路径穿越）", async () => {
	const result = await manager.saveModelsConfig(makeModels("../evil"));
	assert.equal(result.valid, false);
	assert.match(result.error, /providerNameInvalid/);
});

test("provider 名含换行控制字符被拒", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai\nmalicious"));
	assert.equal(result.valid, false);
	assert.match(result.error, /providerNameInvalid/);
});

test("model id 含换行控制字符被拒", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai", "gpt-4o\r\nx"));
	assert.equal(result.valid, false);
	assert.match(result.error, /modelIdInvalid/);
});

test("model id 超长被拒", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai", "x".repeat(300)));
	assert.equal(result.valid, false);
	assert.match(result.error, /modelIdInvalid/);
});

test("baseUrl 含换行控制字符被拒", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai", "gpt-4o", "https://api.example.com/v1\nx"));
	assert.equal(result.valid, false);
	assert.match(result.error, /baseUrlInvalid/);
});

test("model id 含 / 与 - 等常见字符仍合法", async () => {
	const result = await manager.saveModelsConfig(makeModels("openai", "deepseek-ai/DeepSeek-V3.2"));
	assert.equal(result.valid, true);
});

test("normalizeModelsForPi 剥离空 name 键（对齐 pi schema minLength:1）", () => {
	const data = {
		providers: {
			openai: {
				baseUrl: "https://api.example.com/v1",
				api: "openai-completions",
				models: [
					{ id: "gpt-4o", name: "" },
					{ id: "gpt-4o-mini", name: "GPT-4o mini" },
				],
			},
		},
	};
	// TS 的 private 只是编译期可见性，transpile 后是可调用普通方法，可直接断言归一结果。
	const result = manager.normalizeModelsForPi(data);
	const models = result.providers.openai.models;
	// 空 name 应删键（可选字段缺省，pi 视为合法），非空 name 原样保留。
	assert.equal(Object.hasOwn(models[0], "name"), false);
	assert.equal(models[1].name, "GPT-4o mini");
});
