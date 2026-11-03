import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const readSource = (path) => readFileSync(path, "utf8");

/**
 * 智能体市场列表纯策略回归（AGENTS.md「纯策略可单测」）：
 * 1) 搜索大小写不敏感 + 首尾空白容忍，只命中名称/简介；
 * 2) 分类筛选与搜索组合；
 * 3) 市场排序内置优先（内置翻译最前），其余创建时间倒序；
 * 4) 划词默认智能体在被删除/未配置时回退内置翻译，空市场返回 null。
 */

const { EMPTY_AGENT_MARKET_FILTER, filterAgents, matchesAgentCategory, matchesAgentQuery, resolveDefaultSelectionAgent, sortAgentsForMarket } = loadTsCommonJs("src/renderer/src/components/agents/agentMarketFilters.ts");

/** 完整 AgentProfile 工厂：字段齐全，避免测试只覆盖部分字段时漏掉新契约字段。 */
function makeAgent(overrides = {}) {
	return {
		id: "agent-1",
		name: "Tech translator",
		description: "Translates technical documentation",
		icon: "🌐",
		systemPrompt: "You translate technical docs.",
		category: "general",
		createdAt: 1_000,
		updatedAt: 1_000,
		usageCount: 0,
		...overrides,
	};
}

const translateBuiltin = makeAgent({ id: "builtin-translate", name: "翻译助手", description: "中英互译", category: "translation", builtin: true, createdAt: 1 });
const generalBuiltin = makeAgent({ id: "builtin-general", name: "通用助手", description: "通用问答", category: "general", builtin: true, createdAt: 2 });
const writingAgent = makeAgent({ id: "custom-writing", name: "Copy editor", description: "Polishes marketing copy", category: "writing", createdAt: 5_000 });
const codingAgent = makeAgent({ id: "custom-coding", name: "Code reviewer", description: "Reviews pull requests", category: "coding", createdAt: 9_000 });

test("搜索命中名称，忽略大小写与首尾空白", () => {
	assert.equal(matchesAgentQuery(makeAgent({ name: "Tech Translator" }), "  tech TRANSLATOR  "), true);
});

test("搜索命中简介（描述里的关键词也算命中）", () => {
	assert.equal(matchesAgentQuery(makeAgent(), "technical documentation"), true);
});

test("空查询（含纯空白）匹配所有智能体", () => {
	const agent = makeAgent();
	assert.equal(matchesAgentQuery(agent, ""), true);
	assert.equal(matchesAgentQuery(agent, "   "), true);
});

test("名称与简介都不包含关键词时不命中", () => {
	assert.equal(matchesAgentQuery(makeAgent(), "kubernetes"), false);
});

test("分类筛选：all 不过滤，指定分类只命中同类", () => {
	assert.equal(matchesAgentCategory(codingAgent, "all"), true);
	assert.equal(matchesAgentCategory(codingAgent, "coding"), true);
	assert.equal(matchesAgentCategory(codingAgent, "writing"), false);
});

test("过滤组合分类与搜索，且不改动入参数组", () => {
	const agents = [translateBuiltin, writingAgent, codingAgent];
	const filtered = filterAgents(agents, { query: "reviewer", category: "coding" });
	// 展开成宿主数组再比：vm 沙箱里的数组原型与宿主不同，deepStrictEqual 会因原型不相等而误判。
	assert.deepEqual([...filtered.map((agent) => agent.id)], ["custom-coding"]);
	assert.equal(filterAgents(agents, { query: "reviewer", category: "writing" }).length, 0, "分类不匹配时搜索命中也不能返回");
	assert.equal(agents.length, 3, "过滤必须返回新数组，不能改动快照");
	assert.equal(EMPTY_AGENT_MARKET_FILTER.query, "");
	assert.equal(EMPTY_AGENT_MARKET_FILTER.category, "all");
});

test("市场排序：内置优先、内置翻译最前、其余创建时间倒序", () => {
	const sorted = sortAgentsForMarket([writingAgent, generalBuiltin, codingAgent, translateBuiltin]);
	assert.deepEqual([...sorted.map((agent) => agent.id)], ["builtin-translate", "builtin-general", "custom-coding", "custom-writing"]);
});

test("同一创建时间按名称稳定排序（刷新快照后卡片不跳位）", () => {
	const alpha = makeAgent({ id: "alpha", name: "Alpha", createdAt: 7_000 });
	const beta = makeAgent({ id: "beta", name: "Beta", createdAt: 7_000 });
	assert.deepEqual([...sortAgentsForMarket([beta, alpha]).map((agent) => agent.id)], ["alpha", "beta"]);
});

test("市场排序：自定义 agentOrder 优先，未列出的按默认权重追加", () => {
	const sorted = sortAgentsForMarket([translateBuiltin, generalBuiltin, writingAgent, codingAgent], ["custom-writing", "builtin-general"]);
	assert.deepEqual(
		Array.from(sorted, (agent) => agent.id),
		["custom-writing", "builtin-general", "builtin-translate", "custom-coding"],
		"列出的按名次前置；未列出的内置翻译仍按默认权重排在最前，其余按创建时间倒序",
	);
});

test("市场排序：空/缺失 agentOrder 完全等价于旧行为（没拖过就不改变顺序）", () => {
	const base = Array.from(sortAgentsForMarket([translateBuiltin, generalBuiltin, writingAgent, codingAgent]), (agent) => agent.id);
	assert.deepEqual(
		Array.from(sortAgentsForMarket([translateBuiltin, generalBuiltin, writingAgent, codingAgent], []), (agent) => agent.id),
		base,
	);
	assert.deepEqual(
		Array.from(sortAgentsForMarket([translateBuiltin, generalBuiltin, writingAgent, codingAgent], null), (agent) => agent.id),
		base,
	);
});

test("市场排序：agentOrder 里的未知 id / 重复 id 不制造空位", () => {
	const sorted = sortAgentsForMarket([generalBuiltin, writingAgent], ["missing", "custom-writing", "custom-writing"]);
	assert.deepEqual(
		Array.from(sorted, (agent) => agent.id),
		["custom-writing", "builtin-general"],
	);
});

test("划词默认智能体：配置值命中即用", () => {
	const settings = { selectionToolEnabled: true, systemSelectionEnabled: true, selectionToolAgentId: "custom-coding", sessionAgentBindings: {} };
	assert.equal(resolveDefaultSelectionAgent([translateBuiltin, codingAgent], settings)?.id, "custom-coding");
});

test("划词默认智能体被删除后回退内置翻译智能体", () => {
	const settings = { selectionToolEnabled: true, systemSelectionEnabled: true, selectionToolAgentId: "deleted-agent", sessionAgentBindings: {} };
	assert.equal(resolveDefaultSelectionAgent([writingAgent, translateBuiltin], settings)?.id, "builtin-translate");
});

test("未配置默认智能体时同样回退内置翻译；没有内置时退第一个；空市场返回 null", () => {
	const unset = { selectionToolEnabled: true, systemSelectionEnabled: true, selectionToolAgentId: null, sessionAgentBindings: {} };
	assert.equal(resolveDefaultSelectionAgent([writingAgent, translateBuiltin], unset)?.id, "builtin-translate");
	assert.equal(resolveDefaultSelectionAgent([codingAgent, writingAgent], unset)?.id, "custom-coding");
	assert.equal(resolveDefaultSelectionAgent([], unset), null);
});

/**
 * 市场 UI 装配契约（源码扫描，空白容忍）：这些是跨模块约定，改错会让 Lead 的 App 装配
 * 或「使用」链路静默失联，必须被测试钉住。扫描正则刻意容忍空白/换行（AGENTS.md 格式约定）。
 */
const PAGE_PATH = "src/renderer/src/components/agents/AgentMarketPage.tsx";
const WORKSPACE_PATH = "src/renderer/src/components/agents/market/AgentMarketWorkspace.tsx";
const EDITOR_PATH = "src/renderer/src/components/agents/market/AgentMarketEditor.tsx";
const USE_TARGET_MENU_PATH = "src/renderer/src/components/agents/market/AgentUseTargetMenu.tsx";
const PROMPT_BAR_PATH = "src/renderer/src/components/session/SessionAgentPromptBar.tsx";
const CARD_PATH = "src/renderer/src/components/agents/market/AgentMarketCard.tsx";
const DETAIL_PATH = "src/renderer/src/components/agents/market/AgentMarketDetail.tsx";

test("页面是会话 Tab 栏里的专属页面 Tab（非弹窗）：覆盖会话列、失活隐藏、Esc/关闭按钮收起", () => {
	const page = readSource(PAGE_PATH);
	// 与 HostPluginPageOverlay 同一层级约定：absolute inset-0 z-30 只覆盖会话列（侧栏保持可交互）。
	assert.match(page, /absolute\s+inset-0\s+z-30\s+flex\s+flex-col\s+bg-background/);
	// 切到会话只失活（子树保持挂载、hidden 隐藏），搜索/详情/编辑状态不丢；关闭 Tab 才卸载。
	assert.match(page, /!active\s*&&\s*"hidden"/);
	assert.match(page, /active:\s*boolean/);
	assert.ok(!/ui-shadcn\/dialog/.test(page), "页面不得再引入 Dialog（用户反馈：不要弹窗）");
	assert.ok(!/AgentMarketModal/.test(page), "页面不得回退到旧弹框宿主");
	assert.match(page, /agentMarketPageOpenAtom/);
	assert.match(page, /closeAgentMarketPageAtom/);
	// Esc 关闭：keydown 监听必须与 cleanup 成对（AGENTS.md 生命周期配对）。
	assert.match(page, /addEventListener\("keydown"/);
	assert.match(page, /removeEventListener\("keydown"/);
});

test("旧市场弹框与市场内设置视图已删除（划词设置搬到 PiDesk 设置页）", () => {
	assert.equal(existsSync("src/renderer/src/components/agents/AgentMarketModal.tsx"), false);
	assert.equal(existsSync("src/renderer/src/components/agents/market/AgentMarketSettingsView.tsx"), false);
	const workspace = readSource(WORKSPACE_PATH);
	assert.ok(!/AgentMarketSettingsView/.test(workspace), "工作区不得再引用已删除的设置视图");
	assert.ok(!/kind:\s*"settings"/.test(workspace), "市场内部路由不得再有 settings（开关归设置页）");
});

test("侧栏入口进入市场页面（page atom），不再打开弹框", () => {
	const dock = readSource("src/renderer/src/components/agents/AgentMarketDockButton.tsx");
	assert.match(dock, /openAgentMarketPageAtom/);
	assert.ok(!/agentMarketModalOpenAtom|openAgentMarketModalAtom/.test(dock), "侧栏入口不得再触达旧弹框 atom");
});

test("「使用」交给页面宿主 onUseAgent：带着智能体打开新会话页，成功收起页面、失败留在市场", () => {
	const workspace = readSource(WORKSPACE_PATH);
	assert.match(workspace, /onUseAgent:\s*\(agent:\s*AgentProfile\)\s*=>\s*Promise<boolean>/, "工作区接收页面宿主注入的 onUseAgent（只带智能体，目录由新会话页决定）");
	assert.match(workspace, /if\s*\(await\s+onUseAgent\(agent\)\)\s*onClose\(\)/, "使用成功才收起市场，失败要留在市场");
	assert.ok(!/openAgentInvokePanelAtom|openInvokePanel/.test(workspace), "市场不得再打开划词调用面板");
	const page = readSource(PAGE_PATH);
	assert.match(page, /<AgentMarketWorkspace\s+initialEditingAgentId=\{editingAgentId\}/, "页面宿主必须把 initialEditingAgentId 透传给工作区");
	assert.match(page, /onUseAgent=\{onUseAgent\}/, "页面宿主必须透传 onUseAgent");
	assert.match(page, /onClose=\{close\}/, "页面宿主必须透传 onClose");
});

test("「使用」入口带绑定会话语义提示（useInSessionHint）", () => {
	for (const path of ["src/renderer/src/components/agents/market/AgentMarketCard.tsx", "src/renderer/src/components/agents/market/AgentMarketDetail.tsx"]) {
		assert.match(readSource(path), /agentMarket\.useInSessionHint/, path + " 必须展示「使用=绑定会话、角色设定隐藏」的提示");
	}
});

test("「使用」直达新会话页：只记待绑定 id + 回引导页，目录在输入框上方换，首次发送才建会话并绑定", () => {
	// 不再有目录选择菜单（项目多时下拉难用，且真实会话的项目条是只读的）。
	assert.equal(existsSync(USE_TARGET_MENU_PATH), false, "目录选择菜单已删除（改用新会话页的项目选择器）");
	for (const path of [CARD_PATH, DETAIL_PATH]) {
		assert.ok(!/AgentUseTargetMenu/.test(readSource(path)), path + " 的「使用」不得再弹目录菜单");
		assert.match(readSource(path), /onClick=\{\(\) => onUse\(agent\)\}/, path + " 的「使用」必须直接带智能体跳转");
	}
	const app = readSource("src/renderer/src/App.tsx");
	// 宿主：只 arm 待绑定 id + 切到该项目的引导页，不发请求、不建草稿。
	assert.match(app, /handleAgentUseAgent = useCallback\(\s*async \(agent: AgentProfile\): Promise<boolean>/, "宿主不得再要求选定目录（目录来自新会话页）");
	assert.match(app, /store\.set\(pendingAgentBindingAtom, agent\.id\)/, "「使用」只记待绑定智能体 id");
	assert.match(app, /selectProjectCommand\(project\.id\)/, "「使用」要落到该项目的引导页（新会话页）");
	assert.match(app, /const liveProjects = store\.get\(projectInventoryAtom\)/, "判定能否跳转前现取项目清单（可能刚增删过）");
	// 首次发送：建会话时落绑定，并在选中会话前完成（主进程按绑定拼角色设定）。
	const promo = app.slice(app.indexOf("const ensureSessionForSend"));
	assert.match(promo, /const pendingAgentId = store\.get\(pendingAgentBindingAtom\)/, "建会话时必须读待绑定 id");
	assert.match(promo, /api\.agentProfiles\.bindSession\(\{ sessionId: session\.id, agentId: pendingAgent\.id \}\)/, "建会话时落绑定");
	assert.ok(promo.indexOf("bindSession") < promo.indexOf("selectSessionCommand(project.id, session.id"), "绑定必须早于选中会话（否则首条消息不带人设）");
	assert.match(promo, /store\.set\(pendingAgentBindingAtom, null\)/, "落地后要清掉待绑定 id");
	assert.match(app, /title: pendingAgent \? buildAgentSessionTitle\(pendingAgent\)/, "绑定了智能体的会话用智能体名做标题");
	// 真实会话里提示条只反映落盘绑定：离开引导页就丢掉待绑定 id。
	assert.match(app, /if \(!currentSessionId\) return;[\s\S]{0,120}store\.set\(pendingAgentBindingAtom, null\)/, "进入真实会话后要清空待绑定 id");
	// 新会话页的提示条：待绑定形态 + 取消。
	const bar = readSource(PROMPT_BAR_PATH);
	assert.match(bar, /pendingAgentBindingAtom/, "提示条要读待绑定智能体");
	assert.match(bar, /sessionId === GUIDE_BOOTSTRAP_SESSION_ID/, "待绑定形态只在引导页（新会话页）显示");
	assert.match(bar, /agentPromptBar\.pendingCancel/, "待绑定提示条要能取消");
	assert.match(bar, /agentPromptBar\.pendingLabel/, "待绑定状态要有可辨认的标签（否则用户以为已绑定）");
});

test("编辑器图标字段走图标选择器（内置组件图标 + emoji），不再需要手输字符", () => {
	const editor = readSource(EDITOR_PATH);
	assert.match(editor, /<AgentIconPicker[\s\S]*?value=\{icon\}[\s\S]*?onChange=\{setIcon\}/, "图标字段必须是选择器且双向绑定 icon 状态");
	assert.ok(!editor.includes('id="agent-market-icon"'), "不得再有手输图标的 Input（id=agent-market-icon）");
	const picker = readSource("src/renderer/src/components/agents/market/AgentIconPicker.tsx");
	assert.match(picker, /AGENT_ICON_LUCIDE_IDS/, "选择器必须提供内置组件图标网格");
	assert.match(picker, /agentIconValueOfLucide/, "选中内置图标要写成 lucide:<id> 编码");
	assert.match(picker, /agentMarket\.iconPickerClear/, "要能把图标清回机器人默认");
	// 所有渲染点都走同一个 AgentIcon，否则 emoji 之外的新编码会在某处显示成原文（lucide:bot）。
	for (const path of [
		CARD_PATH,
		DETAIL_PATH,
		"src/renderer/src/components/session/SessionAgentPromptBar.tsx",
		"src/renderer/src/components/selectionTool/AgentInvokeAgentPicker.tsx",
		"src/renderer/src/components/selectionTool/SelectionToolHost.tsx",
		"src/renderer/src/components/app/settings/SelectionToolSettingsSection.tsx",
	]) {
		const source = readSource(path);
		assert.match(source, /<AgentIcon\b/, path + " 必须用 AgentIcon 渲染图标");
		assert.ok(!/>\s*\{[^}]*\.icon\b/.test(source), path + " 不得把 icon 字符串当文本直接渲染");
	}
});

test("编辑器后端下拉：跟随默认 + AGENT_PROFILE_BACKENDS，create/update payload 都带 backend", () => {
	const editor = readSource(EDITOR_PATH);
	const options = readSource("src/renderer/src/components/agents/market/agentBackendOptions.ts");
	// 跟随默认的哨兵文案与真实后端选项同源（Radix SelectItem 不允许空串 value）。
	assert.match(options, /FOLLOW_DEFAULT_BACKEND_VALUE/);
	assert.match(options, /t\("agentMarket\.backendFollow"\)/);
	assert.match(editor, /AGENT_PROFILE_BACKENDS\.map/);
	assert.match(editor, /t\("agentMarket\.backend"\)/);
	assert.match(editor, /t\("agentMarket\.backendHint"\)/);
	// update 必须显式带 backend 键：值为 undefined 时主进程按「删除字段 = 跟随默认」处理。
	assert.match(editor, /actions\.updateAgent\(agent\.id,\s*\{[^}]*\bbackend\b[^}]*\}\)/, "更新 payload 必须显式带 backend（undefined 清除）");
	assert.match(editor, /\.\.\.\(backend\s*\?\s*\{\s*backend\s*\}\s*:\s*\{\}\)/, "新建 payload 必须带上已选后端");
});

test("「智能体」页面头部保留标题/说明/搜索/新建，不再放关闭叉（关闭由会话 Tab 负责）", () => {
	const header = readSource("src/renderer/src/components/agents/market/AgentMarketHeader.tsx");
	for (const key of ["agentMarket.title", "agentMarket.subtitle", "agentMarket.searchPlaceholder", "agentMarket.create"]) {
		assert.match(header, new RegExp('t\\("' + key.replace(/\./g, "\\.") + '"\\)'), key + " 必须保留在页面头部");
	}
	assert.ok(!/onOpenSettings|Settings2/.test(header), "页面头部不得再有设置入口（设置搬到 PiDeck 设置页）");
	assert.ok(!/common\.close/.test(header), "页面头部不得再有关闭按钮（Tab 负责关闭）");
	assert.ok(!/<X\s/.test(header), "页面头部不得再渲染 X 图标");
});

test("「设为划词默认」走 agentProfiles.updateSettings（不自己拼快照）", () => {
	const actions = readSource("src/renderer/src/components/agents/market/useAgentMarketActions.ts");
	assert.match(actions, /desktopApi\.agentProfiles\.updateSettings\(\{\s*selectionToolAgentId:\s*agent\.id\s*\}\)/);
});

test("内置智能体删除入口禁用且带原因提示，普通智能体走确认弹框", () => {
	const card = readSource("src/renderer/src/components/agents/market/AgentMarketCard.tsx");
	// builtinNoDelete 同时用于按钮 title 与 Tooltip 内容：禁用按钮不触发指针事件，必须靠外层 span 承载提示。
	assert.ok((card.match(/agentMarket\.builtinNoDelete/g) ?? []).length >= 2, "内置删除原因必须同时出现在 title 与 Tooltip 文案里");
	assert.match(card, /agent\.builtin\s*\?/, "删除按钮必须按 builtin 分支禁用");
	const workspace = readSource(WORKSPACE_PATH);
	assert.match(workspace, /<ConfirmDialog/, "删除自定义智能体必须经 ConfirmDialog 二次确认");
});

test("市场空态区分「还没有自定义智能体」与「没有匹配的智能体」", () => {
	const grid = readSource("src/renderer/src/components/agents/market/AgentMarketGrid.tsx");
	assert.match(grid, /t\("agentMarket\.empty"\)/);
	assert.match(grid, /t\("agentMarket\.noResults"\)/);
});

test("拖拽排序：展示顺序由快照 agentOrder 驱动，拖拽结果经 IPC 落盘", () => {
	const atoms = readSource("src/renderer/src/atoms/agent-atoms.ts");
	assert.match(atoms, /sortAgentsForMarket\(snapshot\.agents,\s*snapshot\.agentOrder\)/, "atom 必须用快照里的 agentOrder 排序（未自定义时才是默认权重）");
	const workspace = readSource(WORKSPACE_PATH);
	assert.match(workspace, /desktopApi\.agentProfiles\.reorder\(nextOrder\)/, "拖拽结果必须经 agent-profiles:reorder 落盘");
	assert.match(workspace, /setSnapshot\(\(current\) => \(current \? \{ \.\.\.current, agentOrder: nextOrder \} : current\)\)/, "落盘前先乐观更新快照，卡片立即落位");
	const grid = readSource("src/renderer/src/components/agents/market/AgentMarketGrid.tsx");
	assert.match(grid, /useListReorder\(/, "网格必须启用通用列表重排接线");
	assert.match(grid, /\{\.\.\.reorder\.containerProps\}/, "容器要挂 dragover/drop 处理器");
	const card = readSource("src/renderer/src/components/agents/market/AgentMarketCard.tsx");
	assert.match(card, /reorder\.gripProps/, "卡片必须有可拖拽手柄");
	assert.match(card, /reorder\.register/, "卡片必须注册到重排容器（FLIP 与落点测量依赖它）");
	assert.match(card, /reorder\.dropPosition/, "落点处必须渲染插入指示线");
});
