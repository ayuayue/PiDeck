/**
 * pi 配置文件读取必须容忍 UTF-8 BOM（数据丢失回归测试）。
 *
 * 背景：Windows PowerShell 5.1 的 `Out-File` / `Set-Content` 默认写 BOM。用户手改一次
 * `models.json` / `settings.json` 就带上三个字节，裸 `JSON.parse` 直接失败。
 * ConfigManager.readJsonFile 失败后 parsed 退回空对象兜底——页面显示「配置是空的」，
 * 用户一点保存就把真配置写没。
 *
 * pi 自身（settings.json / mcp.json，后者 1.4.0 起 #11191）读取都走 stripBom，
 * 两边口径必须一致，否则同一份文件 pi 能用、PiDeck 报损坏或清空。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ConfigManager } = loadTsCommonJs("src/main/config/ConfigManager.ts", {
	// ConfigManager 顶层只引用 electron 的 net/session；读取路径不触发网络。
	stubs: { electron: { net: {}, session: {} } },
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "pideck-config-bom-"));
	return {
		dir,
		manager: new ConfigManager(dir, (key) => key),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("models.json 带 BOM 时仍能读出供应商（不回落成空对象）", async () => {
	const { dir, manager, cleanup } = setup();
	try {
		const models = { providers: { myrelay: { baseUrl: "https://relay.example/v1", api: "openai-completions", models: [{ id: "gpt-4o" }] } } };
		writeFileSync(join(dir, "models.json"), `\uFEFF${JSON.stringify(models, null, 2)}`, "utf8");
		const result = await manager.getModelsConfig();
		assert.equal(result.diagnostic, undefined, `带 BOM 的 models.json 不应产生解析诊断：${result.diagnostic?.message ?? ""}`);
		assert.deepEqual(Object.keys(result.parsed.providers), ["myrelay"]);
		assert.equal(result.parsed.providers.myrelay.baseUrl, "https://relay.example/v1");
	} finally {
		cleanup();
	}
});

test("settings.json / auth.json 带 BOM 时同样正常解析", async () => {
	const { dir, manager, cleanup } = setup();
	try {
		writeFileSync(join(dir, "settings.json"), `\uFEFF${JSON.stringify({ defaultProvider: "myrelay", theme: "dark" })}`, "utf8");
		writeFileSync(join(dir, "auth.json"), `\uFEFF${JSON.stringify({ myrelay: { type: "api_key", key: "sk-test" } })}`, "utf8");
		const settings = await manager.getSettingsConfig();
		assert.equal(settings.diagnostic, undefined);
		assert.equal(settings.parsed.defaultProvider, "myrelay");
		const auth = await manager.getAuthConfig();
		assert.equal(auth.diagnostic, undefined);
		assert.equal(auth.parsed.myrelay.key, "sk-test");
	} finally {
		cleanup();
	}
});

test("BOM 之外的损坏 JSON 仍如实报诊断（不能把兼容扩成静默容错）", async () => {
	const { dir, manager, cleanup } = setup();
	try {
		writeFileSync(join(dir, "models.json"), `\uFEFF{"providers": {`, "utf8");
		const result = await manager.getModelsConfig();
		assert.ok(result.diagnostic, "截断的 JSON 必须仍然报诊断");
		// 损坏时回落到空对象，供页面打开 Raw 页修复（跨 VM 对象先取键再比）。
		assert.deepEqual(Object.keys(result.parsed.providers), []);
	} finally {
		cleanup();
	}
});
