/**
 * 智能体记忆开关（settings.agentMemoryEnabled）的默认值与接线守卫。
 *
 * 这个开关决定「是否往用户的 ~/.pi/agent/mcp.json 写东西」，默认必须是关：
 * 疏忽一次就会变成所有用户装上就改 pi 配置。所以默认值、非法入参、
 * 以及渲染层/预览/词典/锚点四处接线都要钉住。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createDefaultAppSettings } = loadTsCommonJs("src/shared/types/settings.ts");

/** 隔离 userData/home，避免默认值测试读写真实设置或 pi 配置。 */
function makeStore(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-agent-memory-settings-"));
	const userData = join(root, "userData");
	const home = join(root, "home");
	mkdirSync(userData);
	mkdirSync(home);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: {
			electron: {
				app: { getPath: (key) => (key === "userData" ? userData : home) },
				BrowserWindow: class {},
				Menu: { setApplicationMenu: () => undefined },
			},
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../git/gitExecutable": { setConfiguredGitPath: () => undefined },
		},
	});
	return { SettingsStore, filePath: join(userData, "settings.json") };
}

test("默认关闭：共享默认值与全新的 SettingsStore 一致", async (t) => {
	assert.equal(createDefaultAppSettings().agentMemoryEnabled, false);
	const { SettingsStore } = makeStore(t);
	const store = new SettingsStore();
	assert.equal(store.get().agentMemoryEnabled, false, "构造后、加载前就应该是关的");
	await store.load();
	assert.equal(store.get().agentMemoryEnabled, false);
});

test("显式开启会落盘并在重启后保持", async (t) => {
	const { SettingsStore, filePath } = makeStore(t);
	writeFileSync(filePath, JSON.stringify({ installationType: "installed", chatContentWidthPct: 80 }));
	const store = new SettingsStore();
	await store.load();
	await store.update({ agentMemoryEnabled: true });
	assert.equal(JSON.parse(readFileSync(filePath, "utf8")).agentMemoryEnabled, true);
	const reloaded = new SettingsStore();
	await reloaded.load();
	assert.equal(reloaded.get().agentMemoryEnabled, true);
});

test("非法 IPC 入参不会打开开关（只接受布尔值）", async (t) => {
	const { SettingsStore } = makeStore(t);
	const store = new SettingsStore();
	await store.update({ agentMemoryEnabled: "yes" });
	assert.equal(store.get().agentMemoryEnabled, false);
	await store.update({ agentMemoryEnabled: 1 });
	assert.equal(store.get().agentMemoryEnabled, false);
});

test("渲染层、预览、词典与锚点都接上了这个开关", () => {
	const preview = readFileSync("src/renderer/src/previewApi.ts", "utf8");
	assert.match(preview, /agentMemoryEnabled\s*:\s*false\b/);

	const memoryTab = readFileSync("src/renderer/src/components/app/settings/AgentMemoryTab.tsx", "utf8");
	assert.match(memoryTab, /draft\.agentMemoryEnabled\s*\?\?\s*false/);
	assert.match(memoryTab, /settings-section-memory-switches/);
	// 独立 tab：常用页不再承载记忆开关，否则又变回两屏。
	const commonTab = readFileSync("src/renderer/src/components/app/settings/CommonTab.tsx", "utf8");
	assert.ok(!commonTab.includes("AgentMemory"), "记忆已搬出常用页");

	const fieldAnchors = readFileSync("src/renderer/src/utils/settingsFieldAnchors.ts", "utf8");
	assert.match(fieldAnchors, /slug: "memory-enabled"/);
	assert.match(fieldAnchors, /slug: "memory-usage"/, "记忆用量要有设置项锚点");
	const sectionAnchors = readFileSync("src/renderer/src/utils/settingsSectionAnchors.ts", "utf8");
	assert.match(sectionAnchors, /slug: "memory-switches"/);

	const zhCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	for (const key of ["settings.agentMemorySection", "settings.agentMemorySectionDesc", "settings.agentMemoryEnabled", "settings.agentMemoryEnabledDesc"]) {
		assert.ok(zhCopy.includes(`"${key}"`), `missing i18n key: ${key}`);
	}
	const zhTw = readFileSync("src/renderer/src/i18n/rendererCopy.zh-TW.ts", "utf8");
	assert.ok(zhTw.includes('"settings.agentMemoryEnabled"'), "zh-TW 没重新生成");
	const enCopy = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.ok(enCopy.includes('"settings.agentMemoryEnabled"'), "en-US 词典缺键");
});

test("自动学习开关：默认关、依赖启用开关、四端接线齐全", async () => {
	assert.equal(createDefaultAppSettings().agentMemoryAutoLearnEnabled, false, "学习会花模型调用费用，默认必须关");
	const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
	assert.match(store, /agentMemoryAutoLearnEnabled:\s*false/, "SettingsStore 缺默认值");
	assert.match(store, /"agentMemoryAutoLearnEnabled" in safePatch/, "SettingsStore 缺非法入参守卫");

	const preview = readFileSync("src/renderer/src/previewApi.ts", "utf8");
	assert.match(preview, /agentMemoryAutoLearnEnabled\s*:\s*false/);

	const memoryTab = readFileSync("src/renderer/src/components/app/settings/AgentMemoryTab.tsx", "utf8");
	assert.match(memoryTab, /draft\.agentMemoryAutoLearnEnabled\s*\?\?\s*false/);
	assert.match(memoryTab, /disabled=\{!\(draft\.agentMemoryEnabled/, "未启用记忆时学习开关应置灰");

	const fieldAnchors = readFileSync("src/renderer/src/utils/settingsFieldAnchors.ts", "utf8");
	assert.match(fieldAnchors, /slug: "memory-auto-learn"/);

	// 学习循环必须挂在「回合结算」上，并且真的读这两个开关（否则开了也不跑）。
	const main = readFileSync("src/main/index.ts", "utf8");
	assert.match(main, /runLearnerPass\(/, "主进程没接学习循环");
	assert.match(main, /!\s*settings\??\.agentMemoryEnabled\s*\|\|\s*!\s*settings\.agentMemoryAutoLearnEnabled/, "学习循环必须同时看两个开关");
	for (const key of ["settings.agentMemoryAutoLearn", "settings.agentMemoryAutoLearnDesc"]) {
		assert.ok(readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8").includes(`"${key}"`), `missing i18n key: ${key}`);
		assert.ok(readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8").includes(`"${key}"`), `missing en key: ${key}`);
		assert.ok(readFileSync("src/renderer/src/i18n/rendererCopy.zh-TW.ts", "utf8").includes(`"${key}"`), `zh-TW 没重新生成：${key}`);
	}
});

test("设置变更会触发注册/撤销（IPC 与主进程两端都接了）", () => {
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	assert.match(systemIpc, /reactToAgentMemorySettings\?/);
	assert.match(systemIpc, /"agentMemoryEnabled" in patch[\s\S]{0,120}reactToAgentMemorySettings/);

	const main = readFileSync("src/main/index.ts", "utf8");
	assert.match(main, /reactToAgentMemorySettings:/);
	// 启动时按开关注册/撤销，而不是无条件写用户 mcp.json
	assert.match(main, /syncAgentMemoryRegistration\(\{\s*enabled:\s*settingsStore\.get\(\)\.agentMemoryEnabled/);
	// ACP 会话只在开关打开时才挂服务器
	assert.match(main, /settingsStore\.get\(\)\.agentMemoryEnabled\s*\?\s*buildAcpMcpServers/);
});
