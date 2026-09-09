/**
 * 徽章状态表契约：list-usage-probe-states（徽章常驻展示 + 启动预热选源）。
 *
 * 背景：全局「自动查询供应商用量」开关已删除，是否查询由每个 provider 的状态决定
 * （usage-probes.json 的 enabled，默认关）；开关只在「用量查询」弹窗里，徽章只读展示，
 * 所以渲染层只需要「一次拿到全部 provider 的生效开关」这一条通道。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const sharedTypes = readFileSync("src/shared/types/providerUsage.ts", "utf8");

const { ConfigManager } = loadTsCommonJs("src/main/config/ConfigManager.ts", {
	stubs: {
		// ConfigManager 只在拉模型/探测时用 electron.net，状态表链路不触网。
		electron: { net: { fetch: async () => ({ ok: false }) }, session: {} },
	},
});

async function withConfigDir(files, fn) {
	const dir = await mkdtemp(join(tmpdir(), "usage-states-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			await writeFile(join(dir, name), content, "utf8");
		}
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function modelsFile(providers) {
	return JSON.stringify({ providers });
}

test("listUsageProbeStates：内置识别命中也不自动开（默认关，显式开启才查）", async () => {
	await withConfigDir(
		{ "models.json": modelsFile({ deepseek: { baseUrl: "https://api.deepseek.com/v1" } }) },
		async (dir) => {
			const states = await new ConfigManager(dir, (key) => key).listUsageProbeStates("pi");
			const state = states.providers.deepseek;
			assert.equal(state.enabled, false);
			assert.equal(state.recognized, true);
			assert.equal(state.configured, false);
			assert.equal(state.template, "deepseek-balance");
			assert.equal(state.intervalMinutes, 5);
		},
	);
});

test("listUsageProbeStates：显式 enabled=true 才生效（内置识别与已配模板都不算开）", async () => {
	await withConfigDir(
		{
			"models.json": modelsFile({ deepseek: { baseUrl: "https://api.deepseek.com/v1" } }),
			"usage-probes.json": JSON.stringify({
				providers: { deepseek: { enabled: true, intervalMinutes: 30 } },
			}),
		},
		async (dir) => {
			const state = (await new ConfigManager(dir, (key) => key).listUsageProbeStates("pi")).providers.deepseek;
			assert.equal(state.enabled, true);
			assert.equal(state.configured, true);
			assert.equal(state.recognized, true);
			assert.equal(state.intervalMinutes, 30);
		},
	);
});

test("listUsageProbeStates：未识别且未配置 → 关；已配模板但未开启也 → 关", async () => {
	await withConfigDir(
		{
			"models.json": modelsFile({
				mystery: { baseUrl: "https://gateway.example.com/v1" },
				templated: { baseUrl: "https://other.example.com/v1" },
			}),
			"usage-probes.json": JSON.stringify({
				providers: { templated: { template: "newapi", accessToken: "tok", userId: "1" } },
			}),
		},
		async (dir) => {
			const states = await new ConfigManager(dir, (key) => key).listUsageProbeStates("pi");
			assert.equal(states.providers.mystery.enabled, false);
			assert.equal(states.providers.mystery.configured, false);
			assert.equal(states.providers.mystery.recognized, false);
			// 配置模板只说明「有可查询路径」；未显式开启就不查（默认关）。
			assert.equal(states.providers.templated.enabled, false);
			assert.equal(states.providers.templated.configured, true);
			assert.equal(states.providers.templated.template, "newapi");
		},
	);
});

test("listUsageProbeStates：覆盖认证页 provider（auth.json 并集）且不泄露密钥", async () => {
	await withConfigDir(
		{
			"models.json": modelsFile({}),
			"auth.json": JSON.stringify({ "auth-only": { type: "api_key", key: "sk-secret-value" } }),
		},
		async (dir) => {
			const states = await new ConfigManager(dir, (key) => key).listUsageProbeStates("pi");
			assert.ok(states.providers["auth-only"]);
			// 状态表只回开关/模板/间隔，任何密钥字段都不得出现。
			const serialized = JSON.stringify(states);
			assert.doesNotMatch(serialized, /sk-secret-value/);
			assert.doesNotMatch(serialized, /apiKey|accessToken|cookie/);
		},
	);
});

test("通道只在 shared/ipc.ts、主进程 handler、preload 三处同步（且不再有单独开关通道）", () => {
	assert.match(ipc, /configListUsageProbeStates: "config:list-usage-probe-states"/);
	// 开关走弹窗的整体保存（save-usage-probes），不再有单独的 enabled 合并写通道。
	assert.doesNotMatch(ipc, /configSetUsageProbeEnabled/);
	assert.match(systemIpc, /ipcChannels\.configListUsageProbeStates/);
	assert.match(preload, /ipcChannels\.configListUsageProbeStates/);
	assert.doesNotMatch(systemIpc, /configSetUsageProbeEnabled/);
	assert.doesNotMatch(preload, /setUsageProbeEnabled/);
	// 状态表 handler 只透传 backend + provider 名数组（路径/目录不接受渲染层输入）。
	const listHandler =
		systemIpc.match(/ipcMain\.handle\(ipcChannels\.configListUsageProbeStates,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(listHandler, /configManager\.listUsageProbeStates\(backend, providers\)/);
	// 共享契约：状态表类型在 shared/types/providerUsage.ts。
	assert.match(sharedTypes, /export type UsageProbeProviderState = \{/);
	assert.match(sharedTypes, /export type UsageProbeStatesResult = \{/);
});

test("弹窗保存后回读状态表（徽章的开关态/间隔来自状态表，不回读会停在「未启用」）", () => {
	const dialog = readFileSync("src/renderer/src/config/UsageProbeConfigDialog.tsx", "utf8");
	assert.match(dialog, /useRefreshProviderUsageState/);
	// 保存成功分支里必须同时「清缓存 + 回读状态」。
	const successBlock = dialog.match(/if \(result\.ok\) \{[\s\S]*?window\.setTimeout\(handleClose, 600\);/)?.[0] ?? "";
	assert.match(successBlock, /invalidateAll\(\);/);
	assert.match(successBlock, /void refreshProviderState\(props\.provider, props\.backend\);/);
});
