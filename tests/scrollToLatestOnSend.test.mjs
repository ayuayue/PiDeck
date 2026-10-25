import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 「发送消息后自动滚动到最新」开关（外观设置 → 聊天排版）。
 *
 * 默认开启 = 历史行为（发送时定位到新消息并回底）；显式 false 才关闭，
 * 关闭后发送不动视口，上翻读历史时不会被拽回底部。
 * SettingsStore 依赖 electron / 日志 / git 路径解析器，用 stub 顶掉（与
 * tests/settingsStoreHiddenModules.test.mjs 同款）。
 */
function makeStore() {
	const userData = mkdtempSync(join(tmpdir(), "pideck-scroll-on-send-user-"));
	const home = mkdtempSync(join(tmpdir(), "pideck-scroll-on-send-home-"));
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: {
			electron: {
				app: {
					getPath: (key) => (key === "userData" ? userData : key === "home" ? home : tmpdir()),
				},
				BrowserWindow: class {},
				Menu: { setApplicationMenu: () => undefined },
			},
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../git/gitExecutable": { setConfiguredGitPath: () => undefined },
		},
	});
	return { SettingsStore, userData };
}

/** 预置最小 settings.json：installationType / chatContentWidthPct 避免 load 尾部迁移钩子额外写盘。 */
function seed(userData, extra) {
	writeFileSync(join(userData, "settings.json"), JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, ...extra }));
}

const plain = (value) => JSON.parse(JSON.stringify(value));

it("老 settings.json 缺字段按开启处理：默认就是现有行为，零迁移", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, {});
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().scrollToLatestOnSend, true);

	// 脏值不能隐式关掉（字符串 "false" 若原样透传会被真值判断误读成关闭）
	seed(userData, { scrollToLatestOnSend: "false" });
	const dirty = new SettingsStore();
	await dirty.load();
	assert.equal(dirty.get().scrollToLatestOnSend, true);
});

it("显式 false 可持久化；update 只认布尔，脏值不落盘", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, { scrollToLatestOnSend: false });
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().scrollToLatestOnSend, false);

	const enabled = await store.update({ scrollToLatestOnSend: true });
	assert.equal(enabled.scrollToLatestOnSend, true);
	assert.equal(JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")).scrollToLatestOnSend, true);

	const dirty = await store.update({ scrollToLatestOnSend: "no" });
	assert.equal(dirty.scrollToLatestOnSend, true, "非布尔 patch 保持原值");
	assert.equal(JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")).scrollToLatestOnSend, true);
});

it("两处默认值同口径：主进程 defaultSettings 与渲染层 createDefaultAppSettings", () => {
	const mainStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
	assert.match(mainStore, /scrollToLatestOnSend:\s*true/, "主进程默认开启");
	const sharedTypes = readFileSync("src/shared/types/settings.ts", "utf8");
	assert.match(sharedTypes, /scrollToLatestOnSend\?:\s*boolean/, "类型是可选字段（兼容旧 settings.json）");
	assert.match(sharedTypes, /scrollToLatestOnSend:\s*true/, "渲染层首屏默认同口径开启");
});

it("发送定位 effect：关闭时提前返回，不 pin、不强制回底", () => {
	const controller = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
	const gate = controller.indexOf("store.get(scrollToLatestOnSendAtom) === false");
	const pin = controller.indexOf("sendScrollRef.current.pin(");
	assert.ok(gate > 0, "controller 必须读开关");
	assert.ok(pin > 0, "发送定位仍走 SendScrollPositioner.pin");
	assert.ok(gate < pin, "门控必须在 pin 之前（关闭即返回）");
	// 关闭时也要推进 positioned 标记，避免重新打开开关后把旧消息当新发送再拽一次
	const gateBlock = controller.slice(gate, gate + 320);
	assert.match(gateBlock, /positionedSendMessageRef\.current = sendMessageId/);
	assert.match(gateBlock, /pendingSendScrollRef\.current = undefined/);
});

it("外观设置提供开关行、锚点登记、未保存变更归到外观 tab", () => {
	const appearance = readFileSync("src/renderer/src/components/app/settings/AppearanceTab.tsx", "utf8");
	assert.match(appearance, /anchor="appearance-scroll-on-send"/);
	assert.match(appearance, /checked=\{draft\.scrollToLatestOnSend !== false\}/, "缺省显示为开");
	assert.match(appearance, /updateDraft\(\{ scrollToLatestOnSend: checked \}\)/);

	const anchors = readFileSync("src/renderer/src/utils/settingsFieldAnchors.ts", "utf8");
	assert.match(anchors, /slug: "appearance-scroll-on-send"/, "命令面板可直达该设置项");

	const unsaved = readFileSync("src/renderer/src/components/app/settings/unsavedChangesSummary.ts", "utf8");
	assert.match(unsaved, /field: "scrollToLatestOnSend",\s*tab: "appearance"/, "关闭设置弹窗时的未保存摘要能点名该项");
});

it("三语词典都有开关文案（zh-TW 为生成物）", () => {
	for (const locale of ["zh-CN", "zh-TW", "en-US"]) {
		const copy = readFileSync(`src/renderer/src/i18n/rendererCopy.${locale}.ts`, "utf8");
		assert.match(copy, /"settings\.scrollToLatestOnSend": /, `${locale} 缺 settings.scrollToLatestOnSend`);
		assert.match(copy, /"settings\.scrollToLatestOnSendDesc": /, `${locale} 缺 settings.scrollToLatestOnSendDesc`);
	}
});
