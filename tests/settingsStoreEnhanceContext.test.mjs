import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 隔离目录验证真实设置落盘，避免读取或改写用户配置。 */
function makeStore(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-enhance-settings-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: {
			electron: { app: { getPath: () => root }, BrowserWindow: class {}, Menu: { setApplicationMenu: () => undefined } },
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../git/gitExecutable": { setConfiguredGitPath: () => undefined },
		},
	});
	return {
		load: async (extra) => {
			if (extra !== undefined) writeFileSync(path, JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, ...extra }));
			const store = new SettingsStore();
			await store.load();
			return store;
		},
		persisted: () => JSON.parse(readFileSync(path, "utf8")),
	};
}

test("新安装与旧设置都默认不发送上下文，只有字面 true 能启用", async (t) => {
	const h = makeStore(t);
	assert.equal((await h.load()).get().enhanceIncludeContext, false);
	assert.equal((await h.load({})).get().enhanceIncludeContext, false);
	for (const value of ["true", 1, {}, [], null, false]) {
		assert.equal((await h.load({ enhanceIncludeContext: value })).get().enhanceIncludeContext, false);
	}
	assert.equal((await h.load({ enhanceIncludeContext: true })).get().enhanceIncludeContext, true);
});

test("上下文开关单独落盘且保留增强模型，关闭后重载仍关闭", async (t) => {
	const h = makeStore(t);
	const model = { provider: "pi", modelId: "fixed" };
	const store = await h.load({ enhanceModel: model });
	assert.equal((await store.update({ enhanceIncludeContext: true })).enhanceIncludeContext, true);
	assert.equal(h.persisted().enhanceIncludeContext, true);
	assert.deepEqual(h.persisted().enhanceModel, model);
	assert.equal((await h.load()).get().enhanceIncludeContext, true);
	assert.equal((await store.update({ enhanceIncludeContext: false })).enhanceIncludeContext, false);
	assert.equal((await h.load()).get().enhanceIncludeContext, false);
	assert.equal((await store.update({ enhanceIncludeContext: "true" })).enhanceIncludeContext, false);
	assert.equal(h.persisted().enhanceIncludeContext, false);
});
