import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildProviderConfigFromDraft, mergeProviderDraft, resolveInitialReasoningContentReplay } = loadTsCommonJs("src/renderer/src/config/addProviderDraft.ts");

// loadTsCommonJs 在独立 VM realm 执行，对象原型不同导致 deepStrictEqual 报
// “same structure but not reference-equal”，统一用 JSON 比较跨 realm 结果。
const json = (value) => JSON.stringify(value);

function emptyDraft() {
	return {
		name: "deepseek",
		baseUrl: "",
		api: "",
		apiKey: "",
		userAgent: "",
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
		models: [],
	};
}

function sampleModels() {
	return [
		{
			id: "deepseek-chat",
			name: "DeepSeek Chat",
			inputCost: 1,
			outputCost: 2,
			thinking: true,
		},
		{ id: "deepseek-reasoner" },
	];
}

test("resolveInitialReasoningContentReplay：显式值回显、未表态且是 DeepSeek 系才预置 true", () => {
	// 文件里已有显式值 → 原样回显（false 是用户否决自动判定的表态，不能重新打开）
	assert.equal(
		resolveInitialReasoningContentReplay({
			name: "relay",
			compat: { requiresReasoningContentOnAssistantMessages: false },
		}),
		false,
	);
	assert.equal(
		resolveInitialReasoningContentReplay({
			name: "relay",
			compat: { requiresReasoningContentOnAssistantMessages: true },
		}),
		true,
	);
	// 未表态 + DeepSeek 系后端（模型 ID 命中）→ 预置勾选，与保存时 derive 的判定一致
	assert.equal(
		resolveInitialReasoningContentReplay({
			name: "ai88",
			models: [{ id: "deepseek-v4.1-flash" }],
		}),
		true,
	);
	// 未表态 + 非 DeepSeek 后端 → 保持未表态（不写噪声键）
	assert.equal(resolveInitialReasoningContentReplay({ name: "openai", models: [{ id: "gpt-5.6" }] }), undefined);
	// add 模式（无 initial）→ 未表态
	assert.equal(resolveInitialReasoningContentReplay(undefined), undefined);
});

test("空草稿：只写 models: []，不写入任何空字段（与手写 models.json 一致）", () => {
	const provider = buildProviderConfigFromDraft(emptyDraft());
	assert.equal(json(provider), json({ models: [] }));
});

test("完整草稿：baseUrl/api/apiKey 原样写入并 trim", () => {
	const provider = buildProviderConfigFromDraft({
		...emptyDraft(),
		baseUrl: "  https://api.deepseek.com/v1  ",
		api: "openai-completions",
		apiKey: "  sk-test  ",
	});
	assert.equal(provider.baseUrl, "https://api.deepseek.com/v1");
	assert.equal(provider.api, "openai-completions");
	assert.equal(provider.apiKey, "sk-test");
	assert.equal(json(provider.models), json([]));
});

test("User-Agent 草稿：写入 headers（与卡片手填同一存储位置）", () => {
	const provider = buildProviderConfigFromDraft({
		...emptyDraft(),
		userAgent: "pi-coding-agent",
	});
	assert.equal(json(provider.headers), json({ "User-Agent": "pi-coding-agent" }));
});

test("compat 全 false 不写入（与 pi 默认一致）", () => {
	const provider = buildProviderConfigFromDraft(emptyDraft());
	assert.equal(provider.compat, undefined);
});

test("compat 勾选任一项即写入两个布尔字段", () => {
	const devRole = buildProviderConfigFromDraft({
		...emptyDraft(),
		compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
	});
	assert.equal(json(devRole.compat), json({ supportsDeveloperRole: true, supportsReasoningEffort: false }));

	const reasoning = buildProviderConfigFromDraft({
		...emptyDraft(),
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
	});
	assert.equal(json(reasoning.compat), json({ supportsDeveloperRole: false, supportsReasoningEffort: true }));
});

test("compat 回传 reasoning_content：三态写入（未表态不写、true/false 都落盘）", () => {
	// 未表态（undefined）：不写该键，留给保存时的 DeepSeek 特征判定
	const unset = buildProviderConfigFromDraft(emptyDraft());
	assert.equal(unset.compat, undefined);

	// 勾选：即使另两项都是 false 也要写 compat
	const enabled = buildProviderConfigFromDraft({
		...emptyDraft(),
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			requiresReasoningContentOnAssistantMessages: true,
		},
	});
	assert.equal(
		json(enabled.compat),
		json({
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			requiresReasoningContentOnAssistantMessages: true,
		}),
	);

	// 显式 false：必须落盘（它是用户否决自动判定的表态，省略=未表态会被重新打开）
	const disabled = buildProviderConfigFromDraft({
		...emptyDraft(),
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			requiresReasoningContentOnAssistantMessages: false,
		},
	});
	assert.equal(
		json(disabled.compat),
		json({
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			requiresReasoningContentOnAssistantMessages: false,
		}),
	);
});

test("models 草稿：整体透传（含空列表），与页面模型列表一一对应", () => {
	const provider = buildProviderConfigFromDraft({
		...emptyDraft(),
		models: sampleModels(),
	});
	assert.equal(json(provider.models), json(sampleModels()));

	// 空列表也显式写入 []，保证「清空模型」的编辑操作能落盘
	const cleared = buildProviderConfigFromDraft(emptyDraft());
	assert.equal(json(cleared.models), json([]));
});

test("models 字段未提供时兜底为空数组（兼容旧调用方）", () => {
	const draft = emptyDraft();
	delete draft.models;
	const provider = buildProviderConfigFromDraft(draft);
	assert.equal(json(provider.models), json([]));
});

// ── mergeProviderDraft（编辑页保存：保留表单不拥有的字段）────────────────

/** 带高级字段的原 provider（模拟手写 models.json / 其他工具写入）。 */
function originalWithAdvanced() {
	return {
		models: [{ id: "m1" }],
		baseUrl: "https://old.example.com/v1",
		api: "openai-completions",
		apiKey: "sk-old",
		headers: { "User-Agent": "old-ua", "X-App-URL": "https://pideck.app" },
		compat: { supportsDeveloperRole: true, supportsReasoningEffort: false, customFlag: true },
		oauth: { refreshToken: "r1" },
		authHeader: "X-Api-Key",
		modelOverrides: { m1: { maxTokens: 4096 } },
		customUnknown: { keep: 1 },
	};
}

test("mergeProviderDraft: 新增模式（无原 provider）等价于 buildProviderConfigFromDraft", () => {
	const draft = {
		...emptyDraft(),
		baseUrl: "https://new.example.com/v1",
		api: "openai",
		apiKey: "sk-new",
		userAgent: "ua",
	};
	assert.equal(json(mergeProviderDraft(undefined, draft)), json(buildProviderConfigFromDraft(draft)));
});

test("mergeProviderDraft: 保留 oauth/authHeader/modelOverrides/自定义字段（不静默丢字段）", () => {
	const merged = mergeProviderDraft(originalWithAdvanced(), {
		...emptyDraft(),
		models: [{ id: "m2" }],
	});
	assert.equal(json(merged.oauth), json({ refreshToken: "r1" }));
	assert.equal(merged.authHeader, "X-Api-Key");
	assert.equal(json(merged.modelOverrides), json({ m1: { maxTokens: 4096 } }));
	assert.equal(json(merged.customUnknown), json({ keep: 1 }));
	assert.equal(json(merged.models), json([{ id: "m2" }]));
});

test("mergeProviderDraft: 表单字段以草稿为准，空值删除字段", () => {
	const merged = mergeProviderDraft(originalWithAdvanced(), { ...emptyDraft(), models: [] });
	assert.ok(!("baseUrl" in merged));
	assert.ok(!("api" in merged));
	assert.ok(!("apiKey" in merged));
	assert.equal(json(merged.models), json([]));
	// 未知字段不因表单空值而被删
	assert.equal(json(merged.oauth), json({ refreshToken: "r1" }));
});

test("mergeProviderDraft: headers 逐键合并，只覆盖 User-Agent 并保留自定义头", () => {
	const changed = mergeProviderDraft(originalWithAdvanced(), {
		...emptyDraft(),
		userAgent: "new-ua",
	});
	// 键顺序会因 setHeaderValue 先删后加而变化，按字段断言而非 JSON 字符串
	assert.equal(changed.headers["User-Agent"], "new-ua");
	assert.equal(changed.headers["X-App-URL"], "https://pideck.app");
	assert.equal(Object.keys(changed.headers).length, 2);
	// 清空 User-Agent：只移除它，自定义头保留
	const clearedUa = mergeProviderDraft(originalWithAdvanced(), { ...emptyDraft(), userAgent: "" });
	assert.ok(!("User-Agent" in clearedUa.headers));
	assert.equal(clearedUa.headers["X-App-URL"], "https://pideck.app");
	// 原本没有 headers 且草稿为空：不写入空对象
	const none = mergeProviderDraft({ models: [] }, { ...emptyDraft(), userAgent: "" });
	assert.ok(!("headers" in none));
});

test("mergeProviderDraft: compat 合并保留未知子键；原无 compat 且全 false 不创建", () => {
	const merged = mergeProviderDraft(originalWithAdvanced(), {
		...emptyDraft(),
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
	});
	assert.equal(json(merged.compat), json({ supportsDeveloperRole: false, supportsReasoningEffort: true, customFlag: true }));
	const noCompat = mergeProviderDraft({ models: [] }, emptyDraft());
	assert.ok(!("compat" in noCompat));
});

test("mergeProviderDraft: reasoning_content 回传的显式值覆盖，未表态则保留文件里的值", () => {
	const withFlag = {
		models: [],
		compat: { supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true },
	};
	// 未表态（undefined）→ 保留文件里的 true，不能被一次无关编辑抹成空
	const kept = mergeProviderDraft(withFlag, { ...emptyDraft(), baseUrl: "https://x.dev/v1" });
	assert.equal(kept.compat.requiresReasoningContentOnAssistantMessages, true);
	// 用户取消勾选 → 落盘 false（表态否决自动判定）
	const optedOut = mergeProviderDraft(withFlag, {
		...emptyDraft(),
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, requiresReasoningContentOnAssistantMessages: false },
	});
	assert.equal(optedOut.compat.requiresReasoningContentOnAssistantMessages, false);
	// 原无 compat，只勾了这项 → 创建 compat 且另两项显式为 false
	const created = mergeProviderDraft(
		{ models: [] },
		{
			...emptyDraft(),
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, requiresReasoningContentOnAssistantMessages: true },
		},
	);
	assert.equal(json(created.compat), json({ supportsDeveloperRole: false, supportsReasoningEffort: false, requiresReasoningContentOnAssistantMessages: true }));
});

test("mergeProviderDraft: 改名场景（调用方迁移 key）内容不丢", () => {
	const merged = mergeProviderDraft(originalWithAdvanced(), {
		...emptyDraft(),
		name: "renamed",
		baseUrl: "https://renamed.example.com/v1",
	});
	assert.equal(merged.baseUrl, "https://renamed.example.com/v1");
	assert.equal(json(merged.oauth), json({ refreshToken: "r1" }));
	assert.equal(merged.authHeader, "X-Api-Key");
});

// ── supportsStrictMode（pi 0.86 的 strict JSON-schema 工具采样，三态）──────────

test("buildProviderConfigFromDraft: strict 工具采样只在显式表态时写入", () => {
	// 未表态（undefined）：即使 compat 因其它字段被创建，也不能凭空写这个键——
	// pi 的 strict 默认值随协议不同（openai-completions 开、responses 系关），
	// PiDeck 写死一个布尔就等于替 pi 改线上行为。
	const untouched = buildProviderConfigFromDraft({
		...emptyDraft(),
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
	});
	assert.ok(!("supportsStrictMode" in untouched.compat));
	// 显式关闭（修中转站把工具调用漏成纯文本）→ 必须落盘，否则配置页看到的和实际不一致
	const optedOut = buildProviderConfigFromDraft({
		...emptyDraft(),
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false },
	});
	assert.equal(optedOut.compat.supportsStrictMode, false);
});

test("mergeProviderDraft: strict 工具采样显式表态覆盖，未表态保留文件里的值", () => {
	const withFlag = {
		models: [],
		compat: { supportsDeveloperRole: false, supportsStrictMode: false },
	};
	// 未表态（undefined）→ 保留文件里的 false：一次无关编辑不能把用户关掉的开关
	// 抹回「跟随 pi 默认」（那会重新发出 strict 工具定义）。
	const kept = mergeProviderDraft(withFlag, { ...emptyDraft(), baseUrl: "https://x.dev/v1" });
	assert.equal(kept.compat.supportsStrictMode, false);
	// 用户改回显式开启 → 覆盖落盘
	const turnedOn = mergeProviderDraft(withFlag, {
		...emptyDraft(),
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: true },
	});
	assert.equal(turnedOn.compat.supportsStrictMode, true);
});

// ── 新增页的「页内草稿」字段 ──

test("buildProviderConfigFromDraft: modelOverrides 写入 provider；空/未提供不写空对象", () => {
	const withOverrides = buildProviderConfigFromDraft({
		...emptyDraft(),
		modelOverrides: { "deepseek-chat": { headers: { "User-Agent": "custom/1.0" } } },
	});
	assert.equal(json(withOverrides.modelOverrides), json({ "deepseek-chat": { headers: { "User-Agent": "custom/1.0" } } }));
	assert.equal("modelOverrides" in buildProviderConfigFromDraft({ ...emptyDraft(), modelOverrides: {} }), false);
	assert.equal("modelOverrides" in buildProviderConfigFromDraft(emptyDraft()), false);
});

test("mergeProviderDraft: modelOverrides 三态（undefined 保留原值 / {} 清空 / 有值整体覆盖）", () => {
	const original = {
		models: [{ id: "keep" }],
		modelOverrides: { "deepseek-chat": { headers: { "User-Agent": "saved/1.0" } } },
	};
	// 表单不管这项（旧调用方/未接线）→ 原值原样保留
	assert.equal(json(mergeProviderDraft(original, emptyDraft()).modelOverrides), json(original.modelOverrides));
	// 显式清空（弹窗里删掉最后一个覆盖）→ 连字段一起删，不留空对象
	assert.equal("modelOverrides" in mergeProviderDraft(original, { ...emptyDraft(), modelOverrides: {} }), false);
	// 有值 → 整体以草稿为准（弹窗草稿初值来自原 provider，不会丢其它模型的覆盖）
	const replaced = mergeProviderDraft(original, { ...emptyDraft(), modelOverrides: { "gpt-5.2": { headers: { "User-Agent": "relay/2.0" } } } });
	assert.equal(json(replaced.modelOverrides), json({ "gpt-5.2": { headers: { "User-Agent": "relay/2.0" } } }));
});

test("新增页缓冲字段不进 models.json（只交给宿主落 settings/AppSettings）", () => {
	const draft = { ...emptyDraft(), modelThinkingLevelDefaults: { "deepseek-chat": "max" }, hiddenModelIds: ["deepseek-reasoner"] };
	const built = buildProviderConfigFromDraft(draft);
	assert.equal("modelThinkingLevelDefaults" in built, false);
	assert.equal("hiddenModelIds" in built, false);
	const merged = mergeProviderDraft({ models: [{ id: "deepseek-chat" }] }, draft);
	assert.equal("modelThinkingLevelDefaults" in merged, false);
	assert.equal("hiddenModelIds" in merged, false);
});
