/**
 * pi-ai 内置目录匹配 + listing 解析（替代 sqlite model-specs）。
 *
 * 覆盖：精确 id / 大小写 / 路径尾段命中；contains 不误匹配；
 * listing 容量优先、catalog 只补空字段；真实 catalog 能读到 gpt-4o。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const catalog = loadTsCommonJs("src/main/pi/piAiBuiltinCatalog.ts");
const { parseProviderModelsResponse } = loadTsCommonJs("src/main/config/parseProviderModels.ts");
const { buildPiAiCatalogIndex, lookupPiAiCatalogEntry, getPiAiCatalogIndex, parsePiAiCatalogArtifact, positiveInt, readBuiltinPiAiCatalogVersion } = catalog;

function sampleIndex() {
	return buildPiAiCatalogIndex([
		{
			id: "gpt-4o",
			name: "GPT-4o",
			provider: "openai",
			contextWindow: 128000,
			maxTokens: 16384,
			reasoning: false,
			input: ["text", "image"],
		},
		{
			id: "gpt-4o",
			name: "GPT-4o (gateway)",
			provider: "opencode",
			contextWindow: 128000,
			maxTokens: 16384,
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			provider: "deepseek",
			contextWindow: 1000000,
			maxTokens: 384000,
			reasoning: true,
			thinkingLevelMap: { off: null, low: "low", high: "high", xhigh: "xhigh", max: "max" },
			input: ["text"],
		},
		{
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			provider: "anthropic",
			contextWindow: 1000000,
			maxTokens: 64000,
			reasoning: true,
			input: ["text", "image"],
		},
	]);
}

test("positiveInt: 只接受正整数", () => {
	assert.equal(positiveInt(128000), 128000);
	assert.equal(positiveInt(0), undefined);
	assert.equal(positiveInt(-1), undefined);
	assert.equal(positiveInt(1.5), undefined);
	assert.equal(positiveInt("128000"), undefined);
});

test("lookup: 精确 id / 本 provider 优先 / 跨 provider 中转站命中", () => {
	const index = sampleIndex();
	const openai = lookupPiAiCatalogEntry(index, "openai", "gpt-4o");
	assert.equal(openai?.provider, "openai");
	const relay = lookupPiAiCatalogEntry(index, "myrelay", "gpt-4o");
	assert.equal(relay?.id, "gpt-4o");
	assert.equal(relay?.contextWindow, 128000);
	const named = lookupPiAiCatalogEntry(index, "opencode", "gpt-4o");
	assert.equal(named?.provider, "opencode");
});

test("lookup: 大小写与路径尾段命中，contains 不误匹配", () => {
	const index = sampleIndex();
	assert.equal(lookupPiAiCatalogEntry(index, "relay", "GPT-4O")?.id, "gpt-4o");
	assert.equal(lookupPiAiCatalogEntry(index, "relay", "openai/gpt-4o")?.id, "gpt-4o");
	assert.equal(lookupPiAiCatalogEntry(index, "relay", "gpt-4"), undefined);
	assert.equal(lookupPiAiCatalogEntry(index, "relay", "claude"), undefined);
	assert.equal(lookupPiAiCatalogEntry(index, "relay", ""), undefined);
});

test("parseProviderModelsResponse: 读 listing 容量字段，缺则省略", () => {
	const models = parseProviderModelsResponse({
		data: [
			{
				id: "foo",
				name: "Foo Display",
				context_window: 64000,
				max_output_tokens: 4096,
			},
			{ id: "bar", context_length: 128000, max_tokens: 8192 },
			{ id: "bare" },
			{ display_name: "no-id" },
			{ id: "", name: "empty" },
		],
	});
	assert.deepEqual(JSON.parse(JSON.stringify(models)), [
		// 按展示名正序（shared/modelOrder 与下拉列表/配置页同一套排序）：bar < bare < foo display
		{ id: "bar", contextWindow: 128000, maxTokens: 8192 },
		{ id: "bare" },
		{ id: "foo", name: "Foo Display", contextWindow: 64000, maxTokens: 4096 },
	]);
});

test("parseProviderModelsResponse: 读端点实报的推理/模态/档位声明", () => {
	const models = parseProviderModelsResponse({
		data: [
			{
				id: "minimax-m2.7",
				contextWindow: 200000,
				maxTokens: 131072,
				reasoning: true,
				input: ["text"],
				thinkingLevelMap: { off: null, minimal: null, low: null, medium: null },
			},
			{
				id: "vision",
				reasoning: false,
				input: ["text", "image"],
				thinkingLevelMap: { high: "high", xhigh: "xhigh", junk: "drop" },
			},
			{
				id: "weird",
				reasoning: "yes", // 非法布尔 → 丢弃
				input: ["audio", "image", 42], // 过滤后只留 image
				thinkingLevelMap: { medium: 7 }, // 非法值 → 丢弃
			},
		],
	});
	assert.deepEqual(JSON.parse(JSON.stringify(models)), [
		{
			id: "minimax-m2.7",
			contextWindow: 200000,
			maxTokens: 131072,
			reasoning: true,
			input: ["text"],
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null },
		},
		{
			id: "vision",
			reasoning: false,
			input: ["text", "image"],
			thinkingLevelMap: { high: "high", xhigh: "xhigh" },
		},
		{ id: "weird", input: ["image"] },
	]);
});

test("parseProviderModelsResponse: 空/非法声明不出现（不猜默认值）", () => {
	const models = parseProviderModelsResponse({
		data: [{ id: "plain", input: [], thinkingLevelMap: {} }],
	});
	assert.deepEqual(JSON.parse(JSON.stringify(models)), [{ id: "plain" }]);
});

test("parseProviderModelsResponse: 荒唐容量不回传给配置页（实测有中转回 32763840008）", () => {
	const models = parseProviderModelsResponse({
		data: [
			// 超上限的输出上限与 max > ctx 都是坏数据；上下文窗口本身合法则保留
			{ id: "junk-max", context_length: 1000000, max_output_tokens: 32763840008 },
			{ id: "max-over-ctx", context_length: 1000000, max_output_tokens: 2000000 },
			{ id: "junk-ctx", context_length: 999999999999 },
		],
	});
	assert.deepEqual(JSON.parse(JSON.stringify(models)), [{ id: "junk-ctx" }, { id: "junk-max", contextWindow: 1000000 }, { id: "max-over-ctx", contextWindow: 1000000 }]);
});

test("parseProviderModelsResponse: Gemini models/ 前缀与 inputTokenLimit", () => {
	const models = parseProviderModelsResponse(
		{
			models: [
				{
					name: "models/gemini-2.5-pro",
					displayName: "Gemini 2.5 Pro",
					inputTokenLimit: 1048576,
					outputTokenLimit: 65536,
				},
			],
		},
		"google-generative-ai",
	);
	assert.deepEqual(JSON.parse(JSON.stringify(models)), [
		{
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro",
			contextWindow: 1048576,
			maxTokens: 65536,
		},
	]);
});

test("artifact manifest 校验失败时拒绝使用模型目录", () => {
	const catalogRaw = `${JSON.stringify(
		{
			schemaVersion: 2,
			entries: [
				{
					id: "artifact-model",
					provider: "demo",
					contextWindow: 128000,
					input: ["text", "image", "video"],
					thinkingLevelMap: { off: null, high: "high", future: "drop" },
				},
			],
		},
		null,
		2,
	)}\n`;
	const manifest = {
		schemaVersion: 2,
		source: {
			packageName: "@earendil-works/pi-ai",
			packageVersion: "0.85.0",
			dataSha256: "a".repeat(64),
			fileCount: 1,
		},
		catalogSha256: createHash("sha256").update(catalogRaw, "utf8").digest("hex"),
		entryCount: 1,
	};
	const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
	assert.deepEqual(JSON.parse(JSON.stringify(parsePiAiCatalogArtifact(catalogRaw, manifestRaw))), [
		{
			id: "artifact-model",
			provider: "demo",
			contextWindow: 128000,
			input: ["text", "image"],
			thinkingLevelMap: { off: null, high: "high" },
		},
	]);
	manifest.catalogSha256 = "0".repeat(64);
	assert.equal(parsePiAiCatalogArtifact(catalogRaw, `${JSON.stringify(manifest)}\n`).length, 0);
});

const { piAiCatalogEntryType, buildPiAiCatalogIndex: buildIndex } = catalog;

/** 构造一份最小可校验 artifact（catalog + manifest 哈希配对），用于 schema / 类型用例。 */
function makeArtifact(entries, schemaVersion = 2) {
	const catalogRaw = `${JSON.stringify({ schemaVersion, entries })}\n`;
	const manifestRaw = `${JSON.stringify({
		schemaVersion,
		source: { packageName: "@earendil-works/pi-ai", packageVersion: "1.0.4", dataSha256: "a".repeat(64), fileCount: 1 },
		catalogSha256: createHash("sha256").update(catalogRaw, "utf8").digest("hex"),
		entryCount: entries.length,
	})}\n`;
	return { catalogRaw, manifestRaw };
}

/**
 * 旧版产物（schemaVersion 1）只留 9 个白名单字段，`type` 已被丢弃，无法在读取时
 * 可靠区分 chat / image / classifier。不兼容旧版 —— 用户机器上可能存着旧版下载的
 * 覆盖层，必须拒绝并回落到随包目录，而不是把生图模型当聊天模型填参数。
 */
test("schemaVersion 1 旧产物被拒绝（缺少 type，无法区分模型类型）", () => {
	const legacy = makeArtifact([{ id: "legacy-model", provider: "demo", contextWindow: 1000 }], 1);
	assert.equal(parsePiAiCatalogArtifact(legacy.catalogRaw, legacy.manifestRaw).length, 0, "v1 产物必须被拒绝");
	const current = makeArtifact([{ id: "current-model", provider: "demo", contextWindow: 1000 }], 2);
	assert.equal(parsePiAiCatalogArtifact(current.catalogRaw, current.manifestRaw).length, 1, "v2 产物应照常通过");
});

test("解析保留 type：chat / image / classifier 原样透传，非法值归为缺省（chat）", () => {
	const { catalogRaw, manifestRaw } = makeArtifact([
		{ id: "a-chat", provider: "demo", type: "chat" },
		{ id: "b-image", provider: "demo", type: "image" },
		{ id: "c-classifier", provider: "demo", type: "classifier" },
		{ id: "d-implicit", provider: "demo" },
		{ id: "e-bogus", provider: "demo", type: "not-a-type" },
	]);
	const byId = new Map(parsePiAiCatalogArtifact(catalogRaw, manifestRaw).map((entry) => [entry.id, entry]));
	assert.equal(byId.get("a-chat")?.type, "chat");
	assert.equal(byId.get("b-image")?.type, "image");
	assert.equal(byId.get("c-classifier")?.type, "classifier");
	// 官方约定 type 缺省即 chat；非法值不伪造出第四种类型，同归缺省。
	assert.equal(byId.get("d-implicit")?.type, undefined);
	assert.equal(byId.get("e-bogus")?.type, undefined);
	assert.equal(piAiCatalogEntryType(byId.get("d-implicit")), "chat", "缺省视为 chat");
	assert.equal(piAiCatalogEntryType(byId.get("e-bogus")), "chat", "非法值视为 chat");
	assert.equal(piAiCatalogEntryType(byId.get("b-image")), "image");
});

/**
 * 同一 provider + id 可能存在 chat 与 image 两种条目（官方 1.0.4 有 3 例，如
 * openrouter/openrouter/auto）。这些查询入口服务的是聊天语义，因此 chat 必须胜出 ——
 * 否则生图条目（无 contextWindow / maxTokens）会把聊天模型挤掉，配置页参数栏变成空。
 */
test("同一 provider+id 跨类型：聊天条目胜出，不被生图条目抢占", () => {
	const index = buildIndex([
		{ id: "auto", provider: "openrouter", type: "image", api: "openrouter-images" },
		{ id: "auto", provider: "openrouter", type: "chat", api: "openai-completions", contextWindow: 2000000, maxTokens: 128000 },
	]);
	const hit = lookupPiAiCatalogEntry(index, "openrouter", "auto");
	assert.equal(hit?.type, "chat");
	assert.equal(hit?.contextWindow, 2000000);
	// 全局（跨 provider）查找同样不能命中生图条目
	const viaRelay = lookupPiAiCatalogEntry(index, "myrelay", "auto");
	assert.equal(viaRelay?.type, "chat");
});

/** 生图条目即使先出现也不得覆盖已登记的聊天条目（顺序无关）。 */
test("同一 provider+id 跨类型：先登记聊天后再来生图条目也不覆盖", () => {
	const index = buildIndex([
		{ id: "auto", provider: "openrouter", type: "chat", api: "openai-completions", contextWindow: 2000000 },
		{ id: "auto", provider: "openrouter", type: "image", api: "openrouter-images" },
	]);
	assert.equal(lookupPiAiCatalogEntry(index, "openrouter", "auto")?.contextWindow, 2000000);
});

/** 同 provider+id 同类重复（不应出现，但坏资源可能造出来）：保留第一条，不翻倍。 */
test("同一 provider+id 同类重复：保留第一条", () => {
	const index = buildIndex([
		{ id: "dup", provider: "demo", contextWindow: 1000 },
		{ id: "dup", provider: "demo", contextWindow: 2000 },
	]);
	assert.equal(lookupPiAiCatalogEntry(index, "demo", "dup")?.contextWindow, 1000);
});

/** 随包官方产物必须真的带类型与官方字段（不是“只是代码支持”）。 */
test("真实生成 catalog：全部条目带 type，且官方字段未被裁剪", () => {
	const entries = getPiAiCatalogIndex().entries;
	assert.ok(entries.length > 1000, `目录条目异常：${entries.length}`);
	const typeCounts = {};
	for (const entry of entries) {
		const type = entry.type ?? "omitted";
		typeCounts[type] = (typeCounts[type] ?? 0) + 1;
	}
	// pi-ai 1.4.0 的 1713 条全部显式带 type；缺省（undefined）数量为 0。
	assert.equal(typeCounts.omitted, undefined, "官方条目应全部显式带 type");
	assert.ok(typeCounts.chat > 1000, `chat 条目异常：${typeCounts.chat}`);
	assert.ok(typeCounts.image > 0, "应包含 image 条目");
	assert.ok(typeCounts.classifier > 0, "应包含 classifier 条目");
});

/** 官方有 3 组同 provider+id 的 chat/image 重名（openrouter）；锁住它们仍能查到聊天语义。 */
test("真实生成 catalog：openrouter 重名条目命中聊天协议", () => {
	const entry = lookupPiAiCatalogEntry(getPiAiCatalogIndex(), "openrouter", "openrouter/auto");
	assert.ok(entry, "openrouter/auto 应命中文档");
	assert.equal(entry.type, "chat", "必须命中 chat 条目而非 openrouter-images 生图条目");
	assert.equal(entry.api, "openai-completions");
	assert.ok(entry.contextWindow > 0, "聊天条目应带容量（生图条目没有）");
});

test("真实生成 catalog：gpt-4o 有 contextWindow", () => {
	const entry = lookupPiAiCatalogEntry(getPiAiCatalogIndex(), "openai", "gpt-4o");
	assert.ok(entry, "gpt-4o 应命中 pi-ai 目录");
	assert.ok(entry.contextWindow != null && entry.contextWindow > 0, "gpt-4o 应有 contextWindow");
	assert.equal(lookupPiAiCatalogEntry(getPiAiCatalogIndex(), "myrelay", "definitely-not-a-model-xyz"), undefined);
});

test("真实生成 catalog：0.85.0 的 qwen3.8-max 可供主进程读取", () => {
	const entry = lookupPiAiCatalogEntry(getPiAiCatalogIndex(), "opencode-go", "qwen3.8-max");
	assert.ok(entry, "qwen3.8-max 应命中 PiDeck 0.85.0 artifact");
	assert.equal(entry.contextWindow, 1000000);
	assert.equal(entry.maxTokens, 131072);
});

test("真实生成 catalog：Haiku 5.5 可供聊天能力补全（1.3.0 起存在）", () => {
	const entry = lookupPiAiCatalogEntry(getPiAiCatalogIndex(), "anthropic", "claude-haiku-5-5");
	assert.ok(entry, "新版目录应包含 claude-haiku-5-5");
	assert.equal(entry.type, "chat");
	assert.equal(entry.reasoning, true);
	assert.ok(entry.contextWindow > 0);
	assert.ok(entry.maxTokens > 0);
});

test("真实生成 catalog：GPT-6 Luna 保留分类模型身份（1.3.0 起存在）", () => {
	const entry = getPiAiCatalogIndex().entries.find((model) => model.provider === "openai" && model.id === "gpt-6-luna");
	assert.ok(entry, "新版目录应包含 gpt-6-luna");
	assert.equal(entry.type, "classifier", "不能把分类模型伪装成聊天模型");
});

test("真实生成 catalog：1.3.0 修复的思考档位与上下文窗口在 1.4.0 仍成立", () => {
	const index = getPiAiCatalogIndex();
	// #10753：Claude Haiku 5.5 / Opus 5 支持 off（1.2.0 目录里被标为 null = 不支持）
	assert.equal(lookupPiAiCatalogEntry(index, "anthropic", "claude-haiku-5-5")?.thinkingLevelMap?.off, undefined);
	assert.equal(lookupPiAiCatalogEntry(index, "anthropic", "claude-opus-5")?.thinkingLevelMap?.off, undefined);
	// #10818：MiMo 只暴露 off 与 high，minimal 等其余档位显式禁用
	const mimo = lookupPiAiCatalogEntry(index, "xiaomi", "mimo-v2.6-pro");
	assert.equal(mimo?.thinkingLevelMap?.off, "off");
	assert.equal(mimo?.thinkingLevelMap?.high, "high");
	assert.equal(mimo?.thinkingLevelMap?.minimal, null);
	// #10840：openai-codex/gpt-6.1-sol 使用 500K 上下文窗口
	assert.equal(lookupPiAiCatalogEntry(index, "openai-codex", "gpt-6.1-sol")?.contextWindow, 500000);
});

test("真实生成 catalog：1.4.0 的新增模型、xhigh 档与 classifier 图像输入已随目录同步", () => {
	const index = getPiAiCatalogIndex();
	// 新增模型：MiniMax-M3.1-Flash（minimax 与 minimax-cn 两套 provider）
	const m31 = lookupPiAiCatalogEntry(index, "minimax", "MiniMax-M3.1-Flash");
	assert.ok(m31, "新版目录应包含 MiniMax-M3.1-Flash");
	assert.equal(m31.type, "chat");
	assert.equal(m31.reasoning, true);
	assert.ok(lookupPiAiCatalogEntry(index, "minimax-cn", "MiniMax-M3.1-Flash"), "minimax-cn 也应带上该模型");
	// xai：grok-4.3 / grok-4.5 新增 xhigh 档（PiDeck 思考选择器直接读 thinkingLevelMap）
	assert.equal(lookupPiAiCatalogEntry(index, "xai", "grok-4.3")?.thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(lookupPiAiCatalogEntry(index, "xai", "grok-4.5")?.thinkingLevelMap?.xhigh, "xhigh");
	// classifier 拿到图像输入：input 含 image 才允许 models.classify() 收图
	// （跨 VM 的数组不引用相等，先序列化再比）
	assert.deepEqual(JSON.parse(JSON.stringify(lookupPiAiCatalogEntry(index, "typesafe", "jev-latest")?.input)), ["text", "image"]);
	assert.deepEqual(JSON.parse(JSON.stringify(lookupPiAiCatalogEntry(index, "cloudflare-workers-ai", "@cf/cloudflare/clef")?.input)), ["text", "image"]);
});

test("真实生成 catalog：1.4.0 下线的模型不再出现在目录里", () => {
	const index = getPiAiCatalogIndex();
	// openai-codex 的 gpt-5.5 / gpt-5.3-codex-spark 对 ChatGPT 账号必然失败，1.4.0 已移除。
	// 目录留着它们会让设置页提供根本跑不通的选项。
	// 直接查索引而不是 lookup（后者有跨 provider 的中转站兜底，会命中 openai/azure 的同名模型）。
	const codexIds = new Set((index.byProviderId.get("openai-codex") ?? new Map()).keys());
	assert.equal(codexIds.has("gpt-5.5"), false);
	assert.equal(codexIds.has("gpt-5.3-codex-spark"), false);
	// 同名模型在其它 provider 下仍在：这是官方目录的事实，不是我们要隐藏的东西。
	assert.ok(index.byProviderId.get("openai")?.has("gpt-5.5"));
});

test("readBuiltinPiAiCatalogVersion：仓库内置 manifest 返回 pi-ai 包版本", () => {
	const version = readBuiltinPiAiCatalogVersion();
	assert.match(version ?? "", /^\d+\.\d+\.\d+/, "应从仓库 resources 读到 pi-ai 包版本");
});
