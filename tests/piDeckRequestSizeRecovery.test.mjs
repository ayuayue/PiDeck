import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

/**
 * 请求体大小超限恢复扩展的契约与纯函数测试。
 *
 * 通过 TypeScript transpile 移除扩展的 type-only pi 依赖，再直接测试实际导出。
 */

const extensionSource = readFileSync("resources/extensions/pi-deck-request-size-recovery.ts", "utf8");
const compiledExtension = ts.transpileModule(extensionSource, {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const extensionModule = await import(
	`data:text/javascript;base64,${Buffer.from(compiledExtension).toString("base64")}`
);
const {
	isRequestSizeLimitError,
	buildRecoveryModelOptions,
	modelKey,
	attemptModelRestore,
} = extensionModule;

// =========================================================================
// 纯函数：请求体大小超限识别
// =========================================================================

test("明确的请求体大小超限错误能够识别", () => {
	for (const errorMessage of [
		"413 Payload Too Large: <html><head><title>413</title></head><body>nginx</body></html>",
		"413 Request Entity Too Large",
		"unexpected status 413 from upstream gateway",
		"HTTP 413: request entity too large",
		"Provider error code: 413",
		"openai-completions (413): payload too large",
		"400 Bad Request: request body too large",
		"Maximum request body size exceeded",
		"request body size exceeds the maximum",
		"request size exceeds the limit of 10 MB",
		"client intended to send too large body",
		"nginx client_max_body_size exceeded",
	]) {
		assert.equal(isRequestSizeLimitError(errorMessage), true, `应识别: ${errorMessage}`);
	}
});

test("空响应与非请求体大小错误不识别", () => {
	for (const errorMessage of [
		"",
		"413 (no body)",
		"413 status code (no body)",
		"HTTP 413: empty response body",
		"HTTP 413: no response body",
		"400 status code (no body)",
		"500 status code (no body)",
		"404: model is not found",
		"429 Too Many Requests",
		"401 invalid API key",
		"4130 tokens used",
		"413 tokens used",
		"1413 tokens",
		"maximum request size exceeded: 413 tokens",
		"request size exceeds the maximum token count",
		"prompt is too long: 213462 tokens > 200000 maximum",
		"too many tokens",
	]) {
		assert.equal(isRequestSizeLimitError(errorMessage), false, `不应识别: ${errorMessage}`);
	}
});

// =========================================================================
// 纯函数：候选模型列表构建
// =========================================================================

test("候选列表排除未认证与当前模型，label 为 provider/modelId 形式", () => {
	const options = buildRecoveryModelOptions(
		[
			{ provider: "openai", modelId: "gpt-5", authenticated: true },
			{ provider: "anthropic", modelId: "claude-sonnet", authenticated: false },
			{ provider: "qwen-x1", modelId: "qwen3-max", authenticated: true },
			{ provider: "openai", modelId: "gpt-5", authenticated: true },
			{ provider: "deepseek", modelId: "deepseek-v3", authenticated: true },
		],
		{ provider: "qwen-x1", modelId: "qwen3-max" },
	);
	assert.deepEqual(options.map((o) => o.label), ["deepseek/deepseek-v3", "openai/gpt-5"]);
	assert.deepEqual(options[0], { provider: "deepseek", modelId: "deepseek-v3", label: "deepseek/deepseek-v3" });
});

test("current 为 undefined 时不排除任何模型", () => {
	const options = buildRecoveryModelOptions(
		[
			{ provider: "a", modelId: "m2", authenticated: true },
			{ provider: "a", modelId: "m1", authenticated: true },
		],
		undefined,
	);
	assert.deepEqual(options.map((o) => o.label), ["a/m1", "a/m2"]);
});

test("全部候选被排除时返回空数组", () => {
	const options = buildRecoveryModelOptions(
		[
			{ provider: "openai", modelId: "gpt-5", authenticated: true },
			{ provider: "anthropic", modelId: "claude", authenticated: false },
		],
		{ provider: "openai", modelId: "gpt-5" },
	);
	assert.deepEqual(options, []);
});

test("选项按 label 字典序稳定排序", () => {
	const options = buildRecoveryModelOptions(
		[
			{ provider: "zeta", modelId: "z1", authenticated: true },
			{ provider: "alpha", modelId: "a1", authenticated: true },
			{ provider: "mid", modelId: "m1", authenticated: true },
		],
		undefined,
	);
	assert.deepEqual(options.map((o) => o.label), ["alpha/a1", "mid/m1", "zeta/z1"]);
});

test("modelKey 为 provider/modelId 拼接", () => {
	assert.equal(modelKey("qwen-x1", "qwen3-max"), "qwen-x1/qwen3-max");
});

test("切回原模型抛错时返回失败而不是产生未处理拒绝", async () => {
	const original = { provider: "origin", id: "small" };
	const temporary = { provider: "backup", id: "large" };
	const restored = await attemptModelRestore({
		currentModel: temporary,
		temporaryModelKey: modelKey(temporary.provider, temporary.id),
		originalModelKey: modelKey(original.provider, original.id),
		findModel: (provider, modelId) =>
			provider === original.provider && modelId === original.id ? original : undefined,
		setModel: async () => {
			throw new Error("restore failed");
		},
	});
	assert.equal(restored, false);
});

// =========================================================================
// 契约：扩展源码结构与注册
// =========================================================================

const builtInsSource = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");

test("扩展识别请求体大小超限并走 confirm → select → setModel → compact 流程", () => {
	assert.match(extensionSource, /pi\.on\("message_end"/);
	assert.match(extensionSource, /export function isRequestSizeLimitError/);
	assert.match(extensionSource, /export function buildRecoveryModelOptions/);
	assert.match(extensionSource, /message\.role !== "assistant"/);
	assert.match(extensionSource, /message\.stopReason !== "error"/);
	assert.match(extensionSource, /isRequestSizeLimitError\(message\.errorMessage\)/);
	// 守卫：防重入 + hasUI + 冷却
	assert.match(extensionSource, /dialogPending \|\| recoveryActive/);
	assert.match(extensionSource, /ctx\.hasUI/);
	assert.match(extensionSource, /offerCooldownUntil/);
	// 恢复流程：confirm → select → 注册表 → setModel → compact
	assert.match(extensionSource, /ctx\.ui\.confirm\(/);
	assert.match(extensionSource, /ctx\.ui\.select\(/);
	assert.match(extensionSource, /ctx\.modelRegistry\.hasConfiguredAuth\(/);
	assert.match(extensionSource, /ctx\.modelRegistry\.find\(/);
	assert.match(extensionSource, /pi\.setModel\(/);
	assert.match(extensionSource, /ctx\.compact\(\{[\s\S]*?onComplete[\s\S]*?onError/);
	// 摘要请求走当前会话模型：必须先 setModel 再 compact
	const setModelIndex = extensionSource.indexOf("pi.setModel(model)");
	const compactIndex = extensionSource.indexOf("ctx.compact({");
	assert.ok(setModelIndex !== -1 && compactIndex !== -1 && setModelIndex < compactIndex);
});

test("扩展源码保留请求体错误与冷却期契约", () => {
	// 413 必须出现在明确的 HTTP 状态语境中，不能把普通数字当成状态码
	assert.match(extensionSource, /status\(\?:\\s\+code\)\?/);
	assert.match(extensionSource, /response\(\?:\\s\+status\)\?/);
	assert.match(extensionSource, /NO_BODY_RESPONSE_PATTERN/);
	assert.match(extensionSource, /client_max_body_size/);
	// 10 分钟冷却
	assert.match(extensionSource, /OFFER_COOLDOWN_MS = 10 \* 60 \* 1000/);
});

test("正常收尾与异常兜底都使用可控的模型恢复函数", () => {
	assert.equal(extensionSource.match(/await attemptModelRestore\(/g)?.length, 2);
	assert.doesNotMatch(extensionSource, /void pi\.setModel\(original\)/);
});

test("扩展已注册进 BUILT_IN_EXTENSIONS 白名单", () => {
	assert.match(builtInsSource, /"pi-deck-request-size-recovery\.ts"/);
});
