/**
 * 自定义增强模板的落盘语义：
 * - 合法字符串 trim 后保存；
 * - null / 空白 = 恢复内置模板（落盘 null）；
 * - 非字符串 / 超长是脏值，不覆盖既有设置。
 * 读盘与 update 两条路径必须同口径，否则手改 settings.json 或脏 IPC 会绕过校验。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ENHANCE_SYSTEM_PROMPT_MAX_CHARS } = loadTsCommonJs("src/shared/enhanceSystemPrompt.ts");

function createStore(initial) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-enhance-template-"));
	const file = join(dir, "settings.json");
	writeFileSync(file, JSON.stringify(initial, null, 2));
	const electronStub = {
		app: { getPath: (key) => (key === "userData" ? dir : tmpdir()), getLocale: () => "zh-CN", on: () => {}, getVersion: () => "0.0.0", isReady: () => true, whenReady: () => Promise.resolve() },
		BrowserWindow: class {},
		Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
	};
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", { stubs: { electron: electronStub } });
	if (!SettingsStore) assert.fail("SettingsStore 未能加载");
	return { store: new SettingsStore(), file };
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** update() 的持久化挂在防抖保存链上，脚本里直接冲刷。 */
async function saveNow(store, patch) {
	void store.update(patch);
	await store.flushPendingSave();
	await new Promise((resolve) => setTimeout(resolve, 30));
}

test("读盘：合法模板 trim 后生效，空白与超长回落内置（null）", async () => {
	const custom = createStore({ theme: "system", enhanceSystemPrompt: "  自定义增强模板  " });
	await custom.store.load();
	assert.equal(custom.store.get().enhanceSystemPrompt, "自定义增强模板");

	const blank = createStore({ theme: "system", enhanceSystemPrompt: " \n\t " });
	await blank.store.load();
	assert.equal(blank.store.get().enhanceSystemPrompt, null, "空白模板必须回落内置");

	const tooLong = createStore({ theme: "system", enhanceSystemPrompt: "x".repeat(ENHANCE_SYSTEM_PROMPT_MAX_CHARS + 1) });
	await tooLong.store.load();
	assert.equal(tooLong.store.get().enhanceSystemPrompt, null, "超长模板不得进内存/落盘");
});

test("update：空白清除为 null，合法值 trim 后保存并落盘", async () => {
	const { store, file } = createStore({ theme: "system" });
	await store.load();

	await saveNow(store, { enhanceSystemPrompt: "  第一版模板  " });
	assert.equal(store.get().enhanceSystemPrompt, "第一版模板");
	assert.equal(readJson(file).enhanceSystemPrompt, "第一版模板");

	await saveNow(store, { enhanceSystemPrompt: "   " });
	assert.equal(store.get().enhanceSystemPrompt, null);
	assert.equal(readJson(file).enhanceSystemPrompt, null);
});

test("update：非字符串与超长模板视为脏值，不覆盖既有自定义模板", async () => {
	const { store } = createStore({ theme: "system", enhanceSystemPrompt: "保留的模板" });
	await store.load();

	await saveNow(store, { enhanceSystemPrompt: 123 });
	assert.equal(store.get().enhanceSystemPrompt, "保留的模板");

	await saveNow(store, { enhanceSystemPrompt: "x".repeat(ENHANCE_SYSTEM_PROMPT_MAX_CHARS + 1) });
	assert.equal(store.get().enhanceSystemPrompt, "保留的模板");
});
