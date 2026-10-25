import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const i18n = loadTsCommonJs("src/renderer/src/i18n.ts");
const imTab = readFileSync("src/renderer/src/components/app/settings/ImTab.tsx", "utf8");
const hook = readFileSync("src/renderer/src/hooks/useFeishuBridge.ts", "utf8");
const hookModule = loadTsCommonJs("src/renderer/src/hooks/useFeishuBridge.ts", {
	stubs: {
		react: {
			useState: () => undefined,
			useEffect: () => undefined,
			useCallback: (callback) => callback,
		},
	},
	globals: { window: {} },
});

test("renderer Feishu copy exists in both supported locales", async () => {
	// 词典按需加载：非 zh-CN 必须先 ensure，否则 t() 回退 zh-CN。
	await i18n.ensureI18nLocale("en-US");
	i18n.setI18nLocale("zh-CN");
	assert.equal(i18n.t("config.im.connectingToFeishu"), "正在连接飞书…");
	assert.equal(i18n.t("config.im.saveBot"), "保存 Bot");
	assert.equal(i18n.t("feishu.apiUnavailable"), "飞书服务暂不可用");

	i18n.setI18nLocale("en-US");
	assert.equal(i18n.t("config.im.connectingToFeishu"), "Connecting to Feishu…");
	assert.equal(i18n.t("config.im.saveBot"), "Save Bot");
	assert.equal(i18n.t("feishu.apiUnavailable"), "Feishu service is temporarily unavailable");
});

test("Feishu configuration UI uses i18n without changing its visible structure", () => {
	assert.match(imTab, /className="config-im-test-result info">⏳ \{t\("config\.im\.connectingToFeishu"\)\}/);
	assert.match(imTab, /className="config-im-connected-info">✅ \{t\("config\.im\.connectedToFeishu"\)\}/);
	assert.match(imTab, /title=\{!addFormOpenId\.trim\(\) \? t\("config\.im\.openIdRequired"\) : undefined\}/);
	assert.match(imTab, /adding \? t\("config\.im\.saving"\) : t\("config\.im\.saveBot"\)/);
	assert.match(imTab, /formatI18nDateTime\(binding\.createdAt\)/);
	assert.doesNotMatch(imTab, /正在连接飞书|已连接到飞书|请先获取 Open ID|"保存 Bot"/);
});

test("Feishu hook keeps raw IPC exceptions in logs and returns localized product errors", () => {
	assert.doesNotMatch(hook, /API 未就绪/);
	assert.match(hook, /t\("feishu\.apiUnavailable"\)/);
	assert.match(hook, /console\.error\("\[Feishu\] Connection failed", e\)/);
	assert.match(hook, /const msg = t\("config\.im\.connectFailed"\)/);
	assert.match(hook, /return \{ success: false, message: t\("config\.im\.testFailed"\) \}/);
	assert.doesNotMatch(hook, /const msg = e instanceof Error \? e\.message : String\(e\)/);
});

test("Feishu Session Bot cache changes only after explicit main-process success", () => {
	const current = { "session-a": "bot-a" };
	assert.equal(hookModule.applySessionBotAssignment(current, "session-a", "bot-b", { success: false }), current);
	assert.equal(JSON.stringify(hookModule.applySessionBotAssignment(current, "session-a", "bot-b", { success: true })), JSON.stringify({ "session-a": "bot-b" }));
	assert.equal(JSON.stringify(hookModule.applySessionBotAssignment(current, "session-a", null, { success: true })), JSON.stringify({}));
});

test("Feishu binding pushes retain stable Session keys across runtime replacement", () => {
	const retained = hookModule.retainBoundSessionBots({ "session-a": "bot-a", "session-b": "bot-b" }, [{ sessionId: "session-a" }]);
	assert.equal(JSON.stringify(retained), JSON.stringify({ "session-a": "bot-a" }));
});

test("Feishu binding timestamps follow the application locale", () => {
	const value = Date.UTC(2025, 0, 2, 3, 4, 5);
	i18n.setI18nLocale("en-US");
	assert.equal(i18n.formatI18nDateTime(value), new Date(value).toLocaleString("en-US"));
	i18n.setI18nLocale("zh-CN");
	assert.equal(i18n.formatI18nDateTime(value), new Date(value).toLocaleString("zh-CN"));
});
