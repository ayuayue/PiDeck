/**
 * DSH 用量查询端点解析（settings.yaml 的 llm-pi-ai.providers / llm-deepseek）。
 * backend="dsh" 时用量查询以 DSH 自身 profile 为准——自定义 route 的 baseURL/api/headers
 * 与 pi 侧 models.json 或 pi-ai catalog 默认可能不同，只靠兜底会「时而查得对、时而判不支持」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { loadDshUsageProviderProfile } = loadTsCommonJs("src/main/config/dshUsageEndpoint.ts");

const SETTINGS = [
	"llm-pi-ai:",
	"  providers:",
	"    wbx:",
	"      displayName: WBX",
	"      apiKeyEnv: WBX_API_KEY",
	"      api: openai-completions",
	"      baseURL: https://api.wbx918.com/v1",
	"      headers:",
	"        X-Trace: pideck",
	"    opencode:",
	"      apiKeyEnv: OPENCODE_API_KEY",
	"    组:",
	"      displayName: 组",
	"      baseURL: https://ai.shitai.cc/v1",
	"      api: openai-responses",
	"llm-deepseek:",
	"  apiKeyEnv: DEEPSEEK_API_KEY",
].join("\n");

async function withSettings(content, fn) {
	const dir = await mkdtemp(join(tmpdir(), "dsh-usage-"));
	try {
		if (content != null) await writeFile(join(dir, "settings.yaml"), content, "utf8");
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("自定义 route：profile 的 baseURL/api/headers 与凭据 ref 原样返回", async () => {
	await withSettings(SETTINGS, async (dir) => {
		const wbx = await loadDshUsageProviderProfile(dir, "wbx");
		assert.equal(wbx.namespace, "llm-pi-ai");
		assert.equal(wbx.baseUrl, "https://api.wbx918.com/v1");
		assert.equal(wbx.api, "openai-completions");
		assert.equal(JSON.stringify(wbx.headers), JSON.stringify({ "X-Trace": "pideck" }));
		assert.equal(wbx.credentialRef, "WBX_API_KEY");
	});
});

test("route 未写 baseURL（如 opencode）：baseUrl 为空，留给 catalog 兜底", async () => {
	await withSettings(SETTINGS, async (dir) => {
		const opencode = await loadDshUsageProviderProfile(dir, "opencode");
		assert.equal(opencode.namespace, "llm-pi-ai");
		assert.equal(opencode.baseUrl, undefined);
		assert.equal(opencode.credentialRef, "OPENCODE_API_KEY");
	});
});

test("官方 DeepSeek 走 llm-deepseek 命名空间，ref 为 DEEPSEEK_API_KEY", async () => {
	await withSettings(SETTINGS, async (dir) => {
		const deepseek = await loadDshUsageProviderProfile(dir, "deepseek");
		assert.equal(deepseek.namespace, "llm-deepseek");
		assert.equal(deepseek.credentialRef, "DEEPSEEK_API_KEY");
	});
});

test("官方 DeepSeek 的 llm.models 组 id 别名归一：deepseek-official / llm-deepseek", async () => {
	// 回归：模型选择器分组行与 runtime state 的 provider 是组 id "deepseek-official"
	// （e2e 实测 deepseek-official/deepseek-v4-pro），用量配置面却是 "deepseek"。
	// 不归一化会掉进 pi/catalog 兜底 → 「DSH 卡片能显示、选择器/圆球查不到」。
	await withSettings(SETTINGS, async (dir) => {
		const fromGroupId = await loadDshUsageProviderProfile(dir, "deepseek-official");
		assert.equal(fromGroupId.namespace, "llm-deepseek");
		assert.equal(fromGroupId.credentialRef, "DEEPSEEK_API_KEY");
		const fromNamespace = await loadDshUsageProviderProfile(dir, "llm-deepseek");
		assert.equal(fromNamespace.namespace, "llm-deepseek");
		assert.equal(fromNamespace.credentialRef, "DEEPSEEK_API_KEY");
	});
});

test("无 apiKeyEnv 的非 ASCII route（如「组」）：ref 用 PiDeck 稳定摘要", async () => {
	await withSettings(SETTINGS, async (dir) => {
		const group = await loadDshUsageProviderProfile(dir, "组");
		assert.equal(group.baseUrl, "https://ai.shitai.cc/v1");
		assert.equal(group.api, "openai-responses");
		assert.match(group.credentialRef, /^PIDECK_[0-9A-F]{8}_API_KEY$/);
	});
});

test("settings.yaml 缺失 / 空内容 / 畸形 → undefined（回落 pi/catalog 解析）", async () => {
	await withSettings(null, async (dir) => {
		assert.equal(await loadDshUsageProviderProfile(dir, "wbx"), undefined);
	});
	await withSettings("", async (dir) => {
		assert.equal(await loadDshUsageProviderProfile(dir, "wbx"), undefined);
	});
	await withSettings("not: [valid: yaml\n  - broken", async (dir) => {
		assert.equal(await loadDshUsageProviderProfile(dir, "wbx"), undefined);
	});
});

test("无该 route / 空 provider 名 → undefined", async () => {
	await withSettings(SETTINGS, async (dir) => {
		assert.equal(await loadDshUsageProviderProfile(dir, "nope"), undefined);
		assert.equal(await loadDshUsageProviderProfile(dir, ""), undefined);
		assert.equal(await loadDshUsageProviderProfile(dir, "pideck-root-usage-probes"), undefined);
	});
});
