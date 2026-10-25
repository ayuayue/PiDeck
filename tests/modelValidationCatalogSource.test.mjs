import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * issue #340 回归：新会话首发的模型存在性校验必须与模型选择器同源。
 *
 * 症状：引导页/侧栏新建 pi 会话，先点选 auth 渠道模型（如登录态管理的
 * OpenAI 渠道 GPT-6.1Sol），发送第一条消息后模型被静默换成配置默认模型
 * （另一个渠道，如 clinepass 的 deepseek）。首次回复后重新点选就正常。
 *
 * 根因：选择器展示的是 PiModelCapabilityCache 快照（get_available_models，
 * 含 auth.json 官方 provider 与 models-store 目录），而 createDraft /
 * createAnonymousSession / sessionsResolveLaunchDefaults 三处校验只读
 * getCachedModelList()（CLI 缓存：models.json ∪ pi --list-models）。CLI 缓存
 * 只在 capability 快照不可用时才被预热，正常启动路径下长期为 null，于是
 * 「选择器里选得到」的 auth 渠道模型被判不存在，launchDefaults 静默回退到
 * 配置默认 / 上次使用。pi 目录随登录态变化，故症状呈概率性。
 *
 * 加载走 createTsSandbox（相对 import 按源文件目录解析）；契约断言用
 * readFileSync + 空白容忍正则（AGENTS.md 格式契约要求）。
 */
const load = createTsSandbox();
const { resolveLaunchDefaultOptions: resolve } = load("src/main/sessions/launchDefaults.ts");
const { mergeCatalogModels } = load("src/main/pi/catalogModelsForValidation.ts");

const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const mainIndex = readFileSync("src/main/index.ts", "utf8");

// 名称快照由 launchDefaults.test.mjs 单独验证，这里只比身份。
const plain = (value) => {
	if (!value || typeof value !== "object" || !("modelName" in value)) return value;
	const { modelName: _modelName, ...identity } = value;
	return identity;
};

// models.json：只有配置默认模型所在的渠道。
const MODELS = { providers: { clinepass: { models: [{ id: "deepseek-v4.1-flash" }] } } };
// capability 快照：auth 渠道模型只在这里（models.json 无 openai-auth 供应商）。
const SNAPSHOT = [{ provider: "openai-auth", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }];
const CONFIG_DEFAULT = { provider: "clinepass", modelId: "deepseek-v4.1-flash" };
// 用户在引导页刚点选的模型（写入 WELCOME_MODEL_KEY 的内容）。
const PICKED = { provider: "openai-auth", modelId: "gpt-6.1-sol" };

test("mergeCatalogModels：capability 快照优先，快照冷时退回 CLI 缓存，两处都冷返回 undefined", () => {
	assert.deepEqual(mergeCatalogModels({ models: SNAPSHOT }, [{ provider: "cli", id: "x" }]), SNAPSHOT, "快照有模型时必须用它——它才是选择器的可选范围");
	assert.deepEqual(mergeCatalogModels({ models: [] }, [{ provider: "cli", id: "x" }]), [{ provider: "cli", id: "x" }], "快照为空（未 hydration/降级）时退回 CLI 缓存");
	assert.equal(mergeCatalogModels(undefined, null), undefined, "两处都冷：交给 launchDefaults 按旧行为处理");
});

test("issue #340：点选只在 pi 目录快照里的 auth 渠道模型，首发不被换成配置默认模型", () => {
	const result = resolve({
		settings: { defaultProvider: "clinepass", defaultModel: "deepseek-v4.1-flash" },
		models: MODELS,
		catalogModels: SNAPSHOT,
		welcomeModel: PICKED,
	});
	assert.deepEqual(plain(result.model), PICKED, "auth 渠道的点选被配置默认模型挤掉——用户表现为「选好的模型发送后被换渠道」");
});

test("反向对照：校验拿不到目录快照（旧行为）时同一个点选会被判无效并回退配置默认", () => {
	// 说明修复对象是数据源而不是优先级：只要 createDraft 传的还是冷缓存，
	// auth 渠道模型就仍会被判死。所以创建链路必须传 capability 快照 ∪ CLI 缓存。
	const result = resolve({
		settings: { defaultProvider: "clinepass", defaultModel: "deepseek-v4.1-flash" },
		models: MODELS,
		catalogModels: undefined,
		welcomeModel: PICKED,
	});
	assert.deepEqual(plain(result.model), CONFIG_DEFAULT, "旧数据源下点选确实会被丢弃（回归测试的前提）");
});

test("createDraft / resolveLaunchDefaults 走与选择器同源的目录数据源，不再直接读冷缓存", () => {
	// 缺省退回 CLI 缓存：单测/无 pi 运行时宿主保持旧行为。
	assert.match(sessionIpc, /const\s+selectableModels\s*=\s*validationCatalogModels\s*\?\?\s*getCachedModelList;/, "缺少 validationCatalogModels → CLI 缓存的兜底装配");
	const createDraft = sessionIpc.slice(sessionIpc.indexOf("ipcChannels.sessionsCatalogCreateDraft"), sessionIpc.indexOf("ipcChannels.sessionsResolveLaunchDefaults"));
	assert.match(createDraft, /selectableModels\(\)/, "createDraft 的显式模型校验与默认解析必须用同源目录");
	assert.doesNotMatch(createDraft, /getCachedModelList\(\)/, "createDraft 不能再直接读 CLI 缓存（auth 渠道模型在 models.json 里不存在）");
	const resolveDefaults = sessionIpc.slice(sessionIpc.indexOf("ipcChannels.sessionsResolveLaunchDefaults"), sessionIpc.indexOf("ipcChannels.sessionsCreateAnonymous"));
	assert.match(resolveDefaults, /catalogModels:\s*selectableModels\(\)/, "引导页默认解析必须与 createDraft 同源，否则展示与首次套用再次分叉");
	assert.doesNotMatch(resolveDefaults, /getCachedModelList\(\)/);
});

test("main 进程用 capability 快照 ∪ CLI 缓存装配创建校验数据源", () => {
	assert.match(mainIndex, /mergeCatalogModels\(\s*piModelCapabilityCache\?\.getSnapshot\(\),\s*getCachedModelList\(\),?\s*\)/, "装配必须合并 capability 快照（含 auth.json 官方 provider）");
	assert.match(mainIndex, /registerSessionIpc\(\{[\s\S]*validationCatalogModels,[\s\S]*\}\)/, "registerSessionIpc 未装配 validationCatalogModels 时退回冷缓存");
	assert.match(mainIndex, /isModelInModelsConfig\(modelsResult\.parsed,\s*model,\s*validationCatalogModels\(\)\)/, "匿名会话同源校验");
});
