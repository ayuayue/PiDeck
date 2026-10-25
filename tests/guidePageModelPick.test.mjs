import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 复现回路（diagnosing-bugs Phase 1）：用户报告的两个症状
 *   (a) 新建 agent 页配置了默认模型后，切换到别的模型「切不动」，一直显示默认模型；
 *   (b) 页面看起来切换成功了，但发送后实际用的还是切换前的模型。
 *
 * 引导页（无 record）选择模型时，渲染层唯一写入点是 localStorage 的
 * WELCOME_MODEL_KEY（ComposerPickerHost.pickModel 的 !record 分支），发送时经
 * App.ensureSessionForSend 作为 `welcomeModel` 传给 createDraft，最终由
 * resolveLaunchDefaultOptions 决定首次真实套用的模型。
 * 因此「用户刚做的选择是否生效」这个用户可见结果，完全由该解析器裁决——
 * 这里用真实解析器驱动，断言的是用户症状本身（选了就生效），不是内部实现。
 *
 * 修复后状态：优先级已按用户决策改为「引导页点选 > 显式默认 > enabledModels > 上次使用」。
 * tests/launchDefaults.test.mjs 中原先固化旧规则的两条断言（「显式默认优先于一切」
 * 「enabledModels 优先于欢迎偏好」）已同步改写为新规则，并保留「无点选时显式默认 /
 * enabledModels 仍各自胜出」的覆盖，防止旧优先级被悄悄恢复。
 *
 * 加载走 createTsSandbox（相对 import 按源文件目录解析），生产侧新增本地
 * import 不再让本文件 MODULE_NOT_FOUND。
 */
const load = createTsSandbox();
const { resolveLaunchDefaultOptions: resolve } = load("src/main/sessions/launchDefaults.ts");

// 本文件验证选择优先级，名称快照由 launchDefaults.test.mjs 单独验证。
const plain = (value) => {
	const normalized = value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
	if (!normalized || typeof normalized !== "object" || !("modelName" in normalized)) return normalized;
	const { modelName: _modelName, ...identity } = normalized;
	return identity;
};

const MODELS = {
	providers: {
		openai: { models: [{ id: "gpt-5.2" }] },
		zhipu: { models: [{ id: "glm-5" }] },
		anthropic: { models: [{ id: "claude-opus-4-6" }] },
	},
};

// 用户在引导页刚点选的那个模型（写入 WELCOME_MODEL_KEY 的内容）。
const PICKED = { provider: "anthropic", modelId: "claude-opus-4-6" };

test("症状(a)：配置了默认模型时，引导页刚选的模型应成为首次套用的模型", () => {
	const result = resolve({
		settings: { defaultProvider: "openai", defaultModel: "gpt-5.2" },
		models: MODELS,
		welcomeModel: PICKED,
	});
	assert.deepEqual(plain(result.model), PICKED, "引导页显式点选的模型被「配置默认模型」静默覆盖——用户表现为「切不动」");
});

test("症状(b)：无配置默认但设了 enabledModels 时，引导页刚选的模型应成为首次套用的模型", () => {
	const result = resolve({
		settings: { enabledModels: ["openai/gpt-5.2"] },
		models: MODELS,
		welcomeModel: PICKED,
	});
	// 该场景下 defaultModelConfigured 为 false，渲染层展示回退会让欢迎偏好参与，
	// 所以页面显示的是用户刚选的 anthropic/claude-opus-4-6；
	// 但创建解析把 enabledModels 排在欢迎偏好之前 → 实际跑 openai/gpt-5.2，
	// 即「页面切了、发送后变回去」。展示与套用在此分叉。
	assert.equal(result.defaultModelConfigured, undefined, "前提：展示层会让欢迎偏好参与回退");
	assert.deepEqual(plain(result.model), PICKED, "enabledModels 把引导页点选挤掉了，导致底栏显示与实际套用不一致");
});

test("症状(c)：点选换模型后，思考档位也必须跟着换成该模型的每模型默认", () => {
	const result = resolve({
		settings: {
			defaultProvider: "openai",
			defaultModel: "gpt-5.2",
			defaultThinkingLevel: "low",
			modelThinkingLevels: { "openai/gpt-5.2": "low", "anthropic/claude-opus-4-6": "max" },
		},
		models: MODELS,
		welcomeModel: PICKED,
	});
	// 展示（底栏档位）与实际套用同源：都按最终生效的 anthropic/claude-opus-4-6 查表，
	// 若这里仍取全局 low，用户就会看到「显示 low、实际 max」的第二次分叉。
	assert.deepEqual(plain(result.model), PICKED);
	assert.equal(result.thinkingLevel, "max");
});
