/**
 * VisionBridgeConfigManager（主进程）单测。
 *
 * 覆盖：白名单校验（provider/model 必填、api 枚举、baseUrl 协议、数值范围）、
 * 文件读写（PIDECK_VISION_CONFIG_DIR 覆盖目录）、getState 供应商列表组装。
 * 与扩展测试 tests/visionBridgeExtension.test.mjs 共用同一套配置契约。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

const MODULE_PATH = "src/main/settings/visionBridgeConfig.ts";

function compile(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => {
		if (specifier.startsWith("node:")) return require(specifier);
		// 共享日志器：测试环境未注册实例，返回 null 让调用方静默跳过
		if (specifier === "../logging/sharedLogger") return { getAppLogger: () => null };
		return {};
	};
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: localRequire,
			console,
			process,
		},
		{ filename: filePath },
	);
	return module.exports;
}

const mod = compile(MODULE_PATH);
const { VisionBridgeConfigManager, VISION_DEFAULT_PROMPT } = mod;

/** 在临时目录下创建 manager（PIDECK_VISION_CONFIG_DIR 指向该目录）。 */
function makeManager(modelsProviders = {}) {
	const dir = mkdtempSync(join(tmpdir(), "vision-mgr-"));
	process.env.PIDECK_VISION_CONFIG_DIR = dir;
	const configManager = {
		getModelsConfig: async () => ({
			raw: "{}",
			parsed: { providers: modelsProviders },
			diagnostic: undefined,
		}),
	};
	return { dir, manager: new VisionBridgeConfigManager(configManager) };
}

test("saveConfig: writes sanitized config to file", async () => {
	const { dir, manager } = makeManager();
	const result = await manager.saveConfig({
		enabled: true,
		provider: "glm",
		model: "glm-4v-flash",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		apiKey: "sk-test",
		maxTokens: 2048,
		concurrency: 3,
	});
	assert.equal(result.ok, true);
	assert.equal(result.error, undefined);
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	assert.equal(saved.provider, "glm");
	assert.equal(saved.model, "glm-4v-flash");
	assert.equal(saved.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
	assert.equal(saved.apiKey, "sk-test");
	assert.equal(saved.maxTokens, 2048);
	assert.equal(saved.concurrency, 3);
	assert.equal(saved.enabled, true);
	rmSync(dir, { recursive: true, force: true });
});

test("saveConfig: writes default prompt template when none provided", async () => {
	const { dir, manager } = makeManager();
	const result = await manager.saveConfig({
		enabled: true,
		provider: "glm",
		model: "glm-4v-flash",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		apiKey: "sk-test",
	});
	assert.equal(result.ok, true);
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	// 模板永远落盘：未提供时写入默认模板，用户可直接编辑配置文件改提示词（不依赖扩展代码）
	assert.equal(saved.promptTemplate, VISION_DEFAULT_PROMPT);
	rmSync(dir, { recursive: true, force: true });
});

// 自定义模板原样保存（去首尾空白后截断到 4000 字符）
test("saveConfig: keeps custom prompt template trimmed", async () => {
	const { dir, manager } = makeManager();
	const custom = "  describe in english  ";
	const result = await manager.saveConfig({
		enabled: true,
		provider: "glm",
		model: "glm-4v-flash",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		apiKey: "sk-test",
		promptTemplate: custom,
	});
	assert.equal(result.ok, true);
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	assert.equal(saved.promptTemplate, "describe in english");
	rmSync(dir, { recursive: true, force: true });
});

test("saveConfig: rejects missing provider/model", async () => {
	const { dir, manager } = makeManager();
	const result = await manager.saveConfig({ provider: "", model: "" });
	assert.equal(result.ok, false);
	assert.ok(result.error);
	rmSync(dir, { recursive: true, force: true });
});

// ── 关闭状态（enabled:false）允许保存/读取（2026-08 反馈：视觉桥「存不了，强制开启」）──

test("saveConfig: disabled state saves without provider/model (closing the bridge)", async () => {
	const { dir, manager } = makeManager();
	const result = await manager.saveConfig({ enabled: false, provider: "", model: "" });
	assert.equal(result.ok, true, "关闭视觉桥不应要求模型");
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	assert.equal(saved.enabled, false);
	assert.equal(saved.provider, "");
	assert.equal(saved.model, "");
	rmSync(dir, { recursive: true, force: true });
});

test("saveConfig: disabled state keeps previously configured model", async () => {
	const { dir, manager } = makeManager();
	const result = await manager.saveConfig({
		enabled: false,
		provider: "glm",
		model: "glm-4v-flash",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		apiKey: "sk-test",
	});
	assert.equal(result.ok, true);
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	assert.equal(saved.enabled, false);
	// 模型信息保留：重新开启时无需重选
	assert.equal(saved.provider, "glm");
	assert.equal(saved.model, "glm-4v-flash");
	rmSync(dir, { recursive: true, force: true });
});

test("getConfig: reads disabled state back without model (not forced-on)", async () => {
	const { dir, manager } = makeManager();
	writeFileSync(join(dir, "pi-deck-vision.json"), JSON.stringify({ enabled: false, provider: "", model: "" }, null, 2), "utf8");
	const config = await manager.getConfig();
	assert.notEqual(config, null, "关闭状态是合法配置，必须能读回");
	assert.equal(config.enabled, false);
	assert.equal(config.provider, "");
	assert.equal(config.model, "");
	rmSync(dir, { recursive: true, force: true });
});

test("saveConfig: rejects non-object input", async () => {
	const { dir, manager } = makeManager();
	assert.equal((await manager.saveConfig(null)).ok, false);
	assert.equal((await manager.saveConfig("str")).ok, false);
	assert.equal((await manager.saveConfig(42)).ok, false);
	rmSync(dir, { recursive: true, force: true });
});

test("saveConfig: drops invalid api enum and non-http baseUrl", async () => {
	const { dir, manager } = makeManager();
	const result = await manager.saveConfig({
		provider: "p",
		model: "m",
		api: "file://evil",
		baseUrl: "javascript:alert(1)",
	});
	assert.equal(result.ok, true);
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	assert.equal(saved.api, undefined, "非法 api 枚举不写入");
	assert.equal(saved.baseUrl, undefined, "非 http(s) baseUrl 不写入");
	rmSync(dir, { recursive: true, force: true });
});

test("saveConfig: clamps numeric fields to sane ranges", async () => {
	const { dir, manager } = makeManager();
	await manager.saveConfig({
		provider: "p",
		model: "m",
		maxTokens: 999999999,
		timeoutMs: -5,
		concurrency: 0,
	});
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	// 非法/缺失数值回退到默认值落盘，保证配置文件自解释（用户可直接手改文件生效）
	assert.equal(saved.maxTokens, 0, "超上限数值回退默认 0（不限制）");
	assert.equal(saved.timeoutMs, 120_000, "负数回退默认 120000");
	assert.equal(saved.concurrency, 2, "0 回退默认 2");
	rmSync(dir, { recursive: true, force: true });
});

test("saveConfig: maxTokens 0 (unlimited) is preserved", async () => {
	const { dir, manager } = makeManager();
	const result = await manager.saveConfig({
		provider: "p",
		model: "m",
		maxTokens: 0,
	});
	assert.equal(result.ok, true);
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	assert.equal(saved.maxTokens, 0, "0 = 不限制，合法值原样落盘");
	rmSync(dir, { recursive: true, force: true });
});

test("saveConfig: numeric defaults always written when omitted", async () => {
	const { dir, manager } = makeManager();
	const result = await manager.saveConfig({
		enabled: true,
		provider: "glm",
		model: "glm-4v-flash",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		apiKey: "sk-test",
	});
	assert.equal(result.ok, true);
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	// 与扩展 DEFAULT_CONFIG 一致：0（不限制）/ 120000 / 2
	assert.equal(saved.maxTokens, 0);
	assert.equal(saved.timeoutMs, 120_000);
	assert.equal(saved.concurrency, 2);
	rmSync(dir, { recursive: true, force: true });
});

test("getConfig: missing file returns null, invalid json returns null", async () => {
	const { dir, manager } = makeManager();
	assert.equal(await manager.getConfig(), null);
	writeFileSync(join(dir, "pi-deck-vision.json"), "{ broken", "utf8");
	assert.equal(await manager.getConfig(), null);
	rmSync(dir, { recursive: true, force: true });
});

test("saveConfig: provider that is a URL fills baseUrl automatically", async () => {
	const { dir, manager } = makeManager();
	const result = await manager.saveConfig({
		enabled: true,
		provider: "https://open.mwy.asia",
		model: "gpt-5.6-luna",
		apiKey: "sk-gateway",
	});
	assert.equal(result.ok, true);
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	assert.equal(saved.baseUrl, "https://open.mwy.asia");
	// 带尾部斜杠的 URL provider 应去掉斜杠
	await manager.saveConfig({
		enabled: true,
		provider: "https://open.mwy.asia/",
		model: "gpt-5.6-luna",
		apiKey: "sk-gateway",
	});
	const saved2 = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	assert.equal(saved2.baseUrl, "https://open.mwy.asia");
});

test("saveConfig: explicit baseUrl wins over provider URL", async () => {
	const { dir, manager } = makeManager();
	await manager.saveConfig({
		enabled: true,
		provider: "https://open.mwy.asia",
		model: "gpt-5.6-luna",
		apiKey: "sk-gateway",
		baseUrl: "https://custom.example.com/v1",
	});
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	assert.equal(saved.baseUrl, "https://custom.example.com/v1");
});

test("saveConfig: fills missing apiKey/baseUrl from models.json provider", async () => {
	const { dir, manager } = makeManager({
		"my-gw": { apiKey: "sk-from-models", baseUrl: "https://gw.example.com/v1" },
	});
	const result = await manager.saveConfig({
		enabled: true,
		provider: "my-gw",
		model: "some-vl-model",
	});
	assert.equal(result.ok, true);
	const saved = JSON.parse(readFileSync(join(dir, "pi-deck-vision.json"), "utf8"));
	assert.equal(saved.apiKey, "sk-from-models");
	assert.equal(saved.baseUrl, "https://gw.example.com/v1");
});

test("getConfig: reads back what saveConfig wrote", async () => {
	const { dir, manager } = makeManager();
	await manager.saveConfig({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-1" });
	const config = await manager.getConfig();
	assert.equal(config.provider, "openai");
	assert.equal(config.model, "gpt-4o-mini");
	assert.equal(config.apiKey, "sk-1");
	rmSync(dir, { recursive: true, force: true });
});

test("getState: returns config + configDir (models list comes from listModels in UI)", async () => {
	const { dir, manager } = makeManager();
	const state = await manager.getState();
	assert.equal(state.configDir, dir);
	assert.equal(state.config, null);
	assert.equal(state.providers, undefined, "providers 字段已移除，模型列表由 UI 经 listModels 拉全量");
	assert.equal("providers" in state, false);
	rmSync(dir, { recursive: true, force: true });
});

test("getLog: missing log file returns empty record", async () => {
	const { dir, manager } = makeManager();
	const log = await manager.getLog();
	assert.equal(log.exists, false);
	assert.equal(log.content, "");
	rmSync(dir, { recursive: true, force: true });
});

test("getLog: reads extension log file (same dir as config)", async () => {
	const { dir, manager } = makeManager();
	writeFileSync(join(dir, "pi-deck-vision.log"), "[2025-01-01T00:00:00Z] [info] converted 1 image(s)\n");
	const log = await manager.getLog();
	assert.equal(log.exists, true);
	assert.ok(log.content.includes("converted 1 image(s)"));
	assert.equal(log.size, log.content.length);
	rmSync(dir, { recursive: true, force: true });
});

test("clearLog: removes log file, next getLog reports missing", async () => {
	const { dir, manager } = makeManager();
	writeFileSync(join(dir, "pi-deck-vision.log"), "some entries");
	const result = await manager.clearLog();
	assert.equal(result.ok, true);
	const log = await manager.getLog();
	assert.equal(log.exists, false, "清空后日志文件不存在");
	rmSync(dir, { recursive: true, force: true });
});
