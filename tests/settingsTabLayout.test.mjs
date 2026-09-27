import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// settingsTabLayout.ts 只含 type-only import（编译期擦除），无运行时依赖，可直接加载。
const { SETTINGS_TAB_LAYOUT, SETTINGS_TAB_IDS } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsTabLayout.ts");

test("布局覆盖全部 18 个 tab 且不重复", () => {
	// loadTsCommonJs 在 vm 里执行，数组原型属于另一 realm，先展开到测试侧再比较
	const ids = [...SETTINGS_TAB_LAYOUT.map((entry) => entry.id)];
	assert.equal(ids.length, 18);
	assert.equal(new Set(ids).size, ids.length);
	// SETTINGS_TAB_IDS 由布局派生，两者必须一致（单一事实来源）
	assert.deepEqual([...SETTINGS_TAB_IDS], ids);
});

test("展示顺序按 基础 → 扩展集成 → 开发者工具 → 开发与维护 排列", () => {
	assert.deepEqual([...SETTINGS_TAB_LAYOUT.map((entry) => entry.id)], ["common", "shortcuts", "notification", "appearance", "proxy", "connections", "im", "pet", "vision", "imagegen", "web", "editors", "git", "dev", "usage", "process", "storage", "backup"]);
});

test("分割线只出现在三个簇边界前，首项不带分割线", () => {
	assert.deepEqual([...SETTINGS_TAB_LAYOUT.filter((e) => e.dividerBefore).map((e) => e.id)], ["im", "web", "dev"]);
	assert.equal(SETTINGS_TAB_LAYOUT[0].dividerBefore, undefined);
});

test("每个 tab 的中英标题都在两份词典里存在", () => {
	// 侧栏标题只从 SETTINGS_TAB_LABEL_KEYS 取；键缺失时界面会直接显示原始 key（settings.tabs.xxx），
	// 这类问题在代码里看不出来，只有比对词典才能发现。
	const { SETTINGS_TAB_LABEL_KEYS } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsTabLayout.ts");
	// 先从**布局**取 tab 清单，而不是从 LABEL_KEYS 取：后者少一项时前者根本不会去看它，
	// 于是「删掉某个 tab 的标题映射」这种改动能整组通过（本用例曾被这个漏洞骗过）。
	const layoutIds = [...SETTINGS_TAB_LAYOUT.map((entry) => entry.id)];
	for (const id of layoutIds) {
		const key = SETTINGS_TAB_LABEL_KEYS[id];
		assert.ok(typeof key === "string" && key.length > 0, `${id} 在 SETTINGS_TAB_LABEL_KEYS 里没有标题映射`);
		assert.match(key, /^settings\.tabs\./, `${id} 的标题键必须以 settings.tabs. 开头`);
	}
	// 反向也不能多：映射里有布局不认识的 id 同样说明两边漂移了。
	assert.deepEqual([...Object.keys(SETTINGS_TAB_LABEL_KEYS)].sort(), [...layoutIds].sort());
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const id of layoutIds) {
		const key = SETTINGS_TAB_LABEL_KEYS[id];
		assert.ok(zh.includes(`"${key}":`), `${id} 缺中文标题 ${key}`);
		assert.ok(en.includes(`"${key}":`), `${id} 缺英文标题 ${key}`);
	}
});

test("连接 tab 的每个主机状态都有中英文案", () => {
	// 状态文案由模板拼接（settings.connections.state.<state>），拼错只会静默回退成 key 本身。
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	const states = ["disconnected", "connecting", "probing", "bootstrapping", "ready", "degraded", "reconnecting", "offline", "needs-attention"];
	for (const state of states) {
		assert.ok(zh.includes(`"settings.connections.state.${state}":`), `缺中文状态文案 ${state}`);
		assert.ok(en.includes(`"settings.connections.state.${state}":`), `缺英文状态文案 ${state}`);
	}
	// 状态字面量必须与 shared 契约一致，否则 UI 会漏掉某个真实状态。
	const shared = readFileSync("src/shared/types/remoteHost.ts", "utf8");
	for (const state of states) assert.ok(shared.includes(`"${state}"`), `shared 契约里没有状态 ${state}`);
});

test("连接面板引用的每个 i18n key 都在两份词典里存在", () => {
	// 文案键拼错时界面会直接显示原始 key（settings.connections.xxx），代码里完全看不出来；
	// 而这两个面板的文案量最大（添加/指纹确认），所以单独守一道。
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	const panels = ["src/renderer/src/components/app/settings/ConnectionsTab.tsx", "src/renderer/src/components/app/settings/AddHostDialog.tsx", "src/renderer/src/components/app/settings/FingerprintConfirmDialog.tsx", "src/renderer/src/components/app/settings/RepairPanel.tsx"];
	const keys = new Set();
	for (const file of panels) for (const match of readFileSync(file, "utf8").matchAll(/t\("([^"]+)"\)/g)) keys.add(match[1]);
	assert.ok(keys.size > 20, "expected the connection panels to reference a substantial set of keys");
	for (const key of keys) {
		assert.ok(zh.includes(`"${key}":`), `缺中文文案 ${key}`);
		assert.ok(en.includes(`"${key}":`), `缺英文文案 ${key}`);
	}
});

test("修复面板只提供会执行的动作，并把只读/人工动作显示为说明", () => {
	// 修复会写 store 或删信任锚，因此只有白名单里的动作可以做成按钮；其余只呈现说明。
	// 主进程还会再校验一次，界面不是权威——但界面也不该给出点了没用的按钮。
	const panel = readFileSync("src/renderer/src/components/app/settings/RepairPanel.tsx", "utf8");
	assert.match(panel, /const EXECUTABLE: ReadonlySet<RemoteHostRepairAction> = new Set\(\["complete-activation-from-pin", "discard-orphan-pin", "clear-stale-lock", "forget-trust-anchor"\]\)/);
	// 动作文案必须是显式映射：远端回来的字符串拼出的 key 不存在。
	assert.match(panel, /function actionLabel\(action: RemoteHostRepairAction\): string \{[\s\S]{0,200}?switch \(action\)/);
	// 确认推送必须订阅且退订。
	assert.match(panel, /const unsubscribe = desktopApi\.remoteHosts\.onRepairConfirm/);
	assert.match(panel, /return unsubscribe;/);
});
