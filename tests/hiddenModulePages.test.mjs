import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 功能模块新增「定时任务」「智能体」（页面式工作区）：
 * 隐藏只摘入口——侧栏行 / 项目菜单项消失，已建任务照常调度、智能体绑定照常生效，
 * 命令面板（Ctrl+P）保留直达路径并标注「已隐藏」。
 */
const { HIDEABLE_MODULE_IDS, HIDEABLE_SETTINGS_TAB_IDS, isModuleHidden, toggleHiddenModule } = loadTsCommonJs("src/shared/hiddenModules.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("定时任务 / 智能体 / 收藏进入可隐藏清单：默认显示，且不是设置 tab", () => {
	for (const id of ["automation", "agents", "favorites"]) {
		assert.ok(plain(HIDEABLE_MODULE_IDS).includes(id), `${id} 应可隐藏`);
		assert.equal(plain(HIDEABLE_SETTINGS_TAB_IDS).includes(id), false, `${id} 是会话 Tab 栏里的页面，不是设置 tab`);
		assert.equal(isModuleHidden([], id), false, `${id} 默认显示（空清单 = 全显示）`);
		assert.deepEqual(plain(toggleHiddenModule([], id, true)), [id]);
		assert.deepEqual(plain(toggleHiddenModule([id], id, false)), []);
	}
});

test("侧栏与项目菜单入口：隐藏时不渲染（只摘入口，不停功能）", () => {
	const automation = readFileSync("src/renderer/src/components/automation/AutomationDockButton.tsx", "utf8");
	assert.match(automation, /useAtomValue\(automationModuleHiddenAtom\)/);
	assert.match(automation, /if \(hidden\)\s*return null;/);
	// 隐藏不影响调度：组件仍读 activeRuns（父层调度器与任务数据源不涉及）
	assert.match(automation, /automationActiveRunsAtom/);

	const agents = readFileSync("src/renderer/src/components/agents/AgentMarketDockButton.tsx", "utf8");
	assert.match(agents, /useAtomValue\(agentsModuleHiddenAtom\)/);
	assert.match(agents, /if \(hidden\)\s*return null;/);

	const sidebar = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
	assert.match(sidebar, /const automationHidden = useAtomValue\(automationModuleHiddenAtom\)/);
	assert.match(sidebar, /onManageAutomations=\{\s*automationHidden\s*\?\s*undefined/, "项目菜单入口跟随隐藏");

	const menu = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
	assert.match(menu, /onManageAutomations\?:\s*\(\) => void/, "入口 handler 改为可选");
	assert.match(menu, /\{props\.onManageAutomations && \(/, "未注入时不渲染菜单项");
});

test("外观设置的功能模块分区：两行开关 + 定时任务运行中徽标", () => {
	const section = readFileSync("src/renderer/src/components/app/settings/ModuleVisibilitySection.tsx", "utf8");
	assert.match(section, /automation: "automation\.title"/, "标题与页面 Tab / 侧栏入口同源");
	assert.match(section, /agents: "agentMarket\.title"/);
	assert.match(section, /favorites: "favorites\.title"/);
	assert.match(section, /automation: "settings\.modules\.automationDesc"/);
	assert.match(section, /agents: "settings\.modules\.agentsDesc"/);
	assert.match(section, /favorites: "settings\.modules\.favoritesDesc"/);
	assert.match(section, /case "automation":[\s\S]{0,120}?activeRuns\.length > 0[\s\S]{0,60}?settings\.modules\.statusRunning/, "有任务在执行时挂运行中徽标");
	assert.match(section, /case "agents":/, "智能体没有活动态，归入无徽标分支");
	assert.match(section, /case "favorites":/, "收藏没有活动态，归入无徽标分支");
	// 开关仍写同一个 hiddenModules 字段：隐藏只改 UI，不清配置
	assert.match(section, /toggleHiddenModule\(hiddenModules, moduleId, !checked\)/);
});

test("命令面板保留隐藏页面的直达路径，并标注已隐藏", () => {
	const palette = readFileSync("src/renderer/src/hooks/app/useCommandPalette.ts", "utf8");
	assert.match(palette, /id: "action:open-automation"/);
	assert.match(palette, /id: "action:open-agents"/);
	assert.match(palette, /id: "action:open-favorites"/);
	assert.match(palette, /isModuleHidden\(hiddenModules, "automation"\) \? t\("command\.openHiddenPageHint"\)/);
	assert.match(palette, /isModuleHidden\(hiddenModules, "agents"\) \? t\("command\.openHiddenPageHint"\)/);
	assert.match(palette, /isModuleHidden\(hiddenModules, "favorites"\) \? t\("command\.openHiddenPageHint"\)/);
	assert.match(palette, /run: \(\) => actions\.openAutomationPage\(\)/);
	assert.match(palette, /run: \(\) => actions\.openAgentMarketPage\(\)/);
	assert.match(palette, /run: \(\) => actions\.openFavoritesPage\(\)/);

	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(app, /openAutomationPage: \(\) => openAutomationPage\(\)/, "App 装配定时任务动作");
	assert.match(app, /openAgentMarketPage: \(\) => openAgentMarketPage\(\)/, "App 装配智能体动作");
	assert.match(app, /const openAgentMarketPage = useSetAtom\(openAgentMarketPageAtom\)/);
	assert.match(app, /const openFavoritesPage = useSetAtom\(openFavoritesPageAtom\)/);
	assert.match(app, /openFavoritesPage: \(\) => openFavoritesPage\(\)/);
});

test("三语文案：模块描述与命令面板文案齐全", () => {
	const keys = ["settings.modules.automationDesc", "settings.modules.agentsDesc", "settings.modules.favoritesDesc", "command.actionOpenAutomation", "command.actionOpenAgents", "command.actionOpenFavorites", "command.openHiddenPageHint"];
	for (const locale of ["zh-CN", "zh-TW", "en-US"]) {
		const copy = readFileSync(`src/renderer/src/i18n/rendererCopy.${locale}.ts`, "utf8");
		for (const key of keys) {
			assert.match(copy, new RegExp(`"${key.replace(/\./g, "\\.")}": `), `${locale} 缺 ${key}`);
		}
	}
});
