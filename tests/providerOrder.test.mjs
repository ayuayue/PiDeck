import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 供应商卡片自定义顺序纯函数：应用顺序 / 拖拽落点 / 手柄方向键 / 边界
const { buildProviderRank, applyProviderOrder, buildProviderOrderScope, moveProviderRelative, neighborProvider, moveProviderByStep } = loadTsCommonJs("src/renderer/src/utils/providerOrder.ts");

// vm 沙箱里「数组字面量 / 展开语法」产出的数组原型属于沙箱 realm，与宿主 realm 的数组
// 原型不同，deepStrictEqual 会判不等。用宿主 realm 的 Array.from 归一化后再比较。
const list = (value) => Array.from(value);

test("applyProviderOrder 把列出的供应商按自定义名次前置，未列出的保持配置原序追加在后", () => {
	const names = ["alpha", "beta", "gamma", "delta"];
	// beta 排到最前，delta 排第二；alpha/gamma 没排过 → 保持它们在配置里的相对顺序
	assert.deepEqual(list(applyProviderOrder(names, ["beta", "delta"])), ["beta", "delta", "alpha", "gamma"]);
});

test("applyProviderOrder 未自定义排序时原样返回副本（不共享引用）", () => {
	const names = ["alpha", "beta"];
	const result = applyProviderOrder(names, undefined);
	assert.deepEqual(list(result), ["alpha", "beta"]);
	assert.notEqual(result, names);
	assert.deepEqual(list(applyProviderOrder(names, [])), ["alpha", "beta"]);
});

test("applyProviderOrder 忽略顺序数组里的未知名字与脏数据，重名只认首次位置", () => {
	const names = ["alpha", "beta"];
	assert.deepEqual(list(applyProviderOrder(names, ["beta", "ghost"])), ["beta", "alpha"]);
	// 重名取首次出现：beta 名次 0、alpha 名次 1 → 仍是 beta 在前
	assert.deepEqual(list(applyProviderOrder(names, ["beta", "alpha", "beta"])), ["beta", "alpha"]);
	// 空串/非字符串（旧 settings.json 脏数据）不产生名次
	const rank = buildProviderRank(["", null, "alpha"]);
	assert.equal(rank.size, 1);
	assert.equal(rank.get("alpha"), 0);
});

test("moveProviderRelative 按锚点前/后落位（拖拽落点语义）", () => {
	const names = ["a", "b", "c", "d"];
	assert.deepEqual(list(moveProviderRelative(names, "d", "b", "before")), ["a", "d", "b", "c"]);
	assert.deepEqual(list(moveProviderRelative(names, "a", "c", "after")), ["b", "c", "a", "d"]);
	// 拖到自己身上/未知名字：原序返回，调用方据此跳过写盘
	assert.deepEqual(list(moveProviderRelative(names, "b", "b", "before")), names);
	assert.deepEqual(list(moveProviderRelative(names, "ghost", "b", "before")), names);
});

test("neighborProvider 取可见列表的邻居，越界返回 null", () => {
	const visible = ["a", "c", "d"];
	assert.equal(neighborProvider(visible, "c", -1), "a");
	assert.equal(neighborProvider(visible, "c", 1), "d");
	assert.equal(neighborProvider(visible, "a", -1), null);
	assert.equal(neighborProvider(visible, "d", 1), null);
});

test("buildProviderOrderScope 把多个来源合成一份顺序：已排名的先上、其余保持来源序追加", () => {
	// 模型页与认证页的供应商集合不同：认证页独有的 gamma 也要进顺序，否则在认证页拖一次
	// 会把 gamma 从顺序里去掉，模型页的顺序随之回到默认。
	assert.deepEqual(
		list(
			buildProviderOrderScope(
				[
					["alpha", "beta"],
					["beta", "gamma"],
				],
				["gamma", "alpha"],
			),
		),
		["gamma", "alpha", "beta"],
	);
	// 没排过顺序：各来源按传入先后拼接（模型页在前、认证页独有的在后）
	assert.deepEqual(list(buildProviderOrderScope([["alpha", "beta"], ["gamma"]], undefined)), ["alpha", "beta", "gamma"]);
	// 同一名字出现在多个来源只保留一次；顺序数组里的未知名字不凭空造出供应商
	assert.deepEqual(list(buildProviderOrderScope([["alpha"], ["alpha"]], ["ghost"])), ["alpha"]);
	// 空集合 / 空顺序都安全
	assert.deepEqual(list(buildProviderOrderScope([], ["alpha"])), []);
});

test("moveProviderByStep 在完整列表上位移，跳过隐藏项且不打乱可见相对顺序", () => {
	// b 被隐藏：完整列表里 b 夹在 a、c 之间，可见列表是 a/c/d
	const full = ["a", "b", "c", "d"];
	const visible = ["a", "c", "d"];
	// c 上移 → 落到 a 前（隐藏的 b 被挤到中间，用户看不到）
	assert.deepEqual(list(moveProviderByStep(full, visible, "c", -1)), ["c", "a", "b", "d"]);
	// a 下移 → 落到 c 后
	assert.deepEqual(list(moveProviderByStep(full, visible, "a", 1)), ["b", "c", "a", "d"]);
	// 边界：首项上移 / 末项下移都返回 null，调用方保持原序
	assert.equal(moveProviderByStep(full, visible, "a", -1), null);
	assert.equal(moveProviderByStep(full, visible, "d", 1), null);
});

test("契约完整性：供应商排序在主进程设置、配置页两处、DSH 页与选择器链路都接线到位", () => {
	const read = (path) => readFileSync(path, "utf8");
	const configModal = read("src/renderer/src/ConfigModal.tsx");
	const settingsTypes = read("src/shared/types/settings.ts");
	const settingsStore = read("src/main/settings/SettingsStore.ts");
	const modelsTab = read("src/renderer/src/config/ModelsTab.tsx");
	const authTab = read("src/renderer/src/config/AuthTab.tsx");
	const dshCards = read("src/renderer/src/config/DshProviderCards.tsx");
	const dshTab = read("src/renderer/src/config/DshConfigTab.tsx");
	const preferenceState = read("src/renderer/src/hooks/useSessionPreferenceState.ts");
	const pickerOptions = read("src/renderer/src/components/session/sessionPickerOptions.ts");
	const pickerHost = read("src/renderer/src/components/session/ComposerPickerHost.tsx");
	const zhCopy = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const enCopy = read("src/renderer/src/i18n/rendererCopy.en-US.ts");

	// 持久化：两个字段都必须进 AppSettings 与 SettingsStore 的清洗名单（旧数据缺字段要有默认值）
	assert.ok(settingsTypes.includes("providerOrder"));
	assert.ok(settingsTypes.includes("dshProviderOrder"));
	assert.ok(settingsStore.includes('"providerOrder", "dshProviderOrder"'));
	// 配置页：读设置进 state，重排后落盘；顺序同时喂给模型页、认证页与 DSH 页
	assert.ok(configModal.includes("setProviderOrder(settings.providerOrder ?? [])"));
	assert.ok(configModal.includes("setDshProviderOrder(settings.dshProviderOrder ?? [])"));
	assert.ok(configModal.includes("api.settings.update({ providerOrder: next })"));
	assert.ok(configModal.includes("api.settings.update({ dshProviderOrder: next })"));
	assert.equal(configModal.includes("providerOrder={providerOrder}"), true);
	assert.ok(configModal.includes("providerOrder={dshProviderOrder}"));

	// Pi 模型页 / 认证页：同一份顺序（AuthTab 用 applyProviderOrder 排 allProviders）
	assert.ok(modelsTab.includes("applyProviderOrder(providerNames, props.providerOrder)"));
	assert.ok(modelsTab.includes("useProviderReorder("));
	assert.ok(modelsTab.includes("providerReorder.gripProps(name)"));
	assert.ok(modelsTab.includes("providerReorder.cardProps(name)"));
	assert.ok(modelsTab.includes("providerReorder.registerCard(name, element)"));
	assert.ok(modelsTab.includes('data-provider-head=""'));
	assert.ok(authTab.includes("applyProviderOrder(Object.keys(data), props.providerOrder)"));

	// DSH 模型页：卡片复用同一 hook；顺序不能写回 DSH providers（host 侧是 merge 语义 patch，表达不了键顺序）
	assert.ok(dshCards.includes("applyProviderOrder("));
	assert.ok(dshCards.includes("useProviderReorder("));
	assert.ok(dshCards.includes('data-provider-head=""'));
	assert.ok(dshTab.includes("providerOrder={props.providerOrder}"));

	// 模型选择器链路：偏好从 settings 读到 ComposerPickerHost，再传给按顺序分组的选项
	assert.ok(preferenceState.includes("setProviderOrder(settings.providerOrder ?? [])"));
	assert.ok(preferenceState.includes("dshProviderOrder"));
	assert.ok(pickerOptions.includes("orderProviderGroups("));
	// DSH 会话用 dshProviderOrder，Pi 会话用 providerOrder（同一入口三元切换，不能只传一个）
	assert.ok(pickerHost.includes("providerOrder={preference.isDshSession ? preference.dshProviderOrder : preference.providerOrder}"));

	// 拖拽手柄与两条排序说明的中英文案都要有（缺 key 会渲染成原始 key）；上移/下移按钮已删，
	// 相应文案 key 一并移除——若谁把按钮加回来，这里必须先把 key 和断言补回并说明理由。
	for (const key of ["config.dragProvider", "config.providerOrderHint", "config.providerOrderReset", "config.dsh.providerOrderHint"]) {
		assert.ok(zhCopy.includes(`"${key}"`), `zh-CN 缺少 ${key}`);
		assert.ok(enCopy.includes(`"${key}"`), `en-US 缺少 ${key}`);
	}
	for (const removedKey of ["config.moveProviderUp", "config.moveProviderDown"]) {
		assert.ok(!zhCopy.includes(`"${removedKey}"`), `zh-CN 不应再有已删按钮的 ${removedKey}`);
		assert.ok(!enCopy.includes(`"${removedKey}"`), `en-US 不应再有已删按钮的 ${removedKey}`);
	}
});

test("契约完整性：「模型」「认证」两页共享同一份顺序（providerOrderScope），拖完不会互相重置", () => {
	const read = (path) => readFileSync(path, "utf8");
	const configModal = read("src/renderer/src/ConfigModal.tsx");
	const modelsTab = read("src/renderer/src/config/ModelsTab.tsx");
	const authTab = read("src/renderer/src/config/AuthTab.tsx");

	// 作用域由「模型 + 认证」两页的并集算出（单页集合会让另一页独有的供应商掉队）
	assert.ok(configModal.includes("buildProviderOrderScope(["));
	assert.ok(configModal.includes("providerOrderScope={providerOrderScope}"));
	// 两页拖拽的作用域都必须优先用并集：只传自己的列表 = 认证页拖动会把模型页顺序重置
	for (const [label, source] of [
		["ModelsTab", modelsTab],
		["AuthTab", authTab],
	]) {
		assert.ok(source.includes("props.providerOrderScope?.length ? props.providerOrderScope"), `${label} 未用 providerOrderScope 作为拖拽作用域`);
		assert.ok(source.includes("providerReorder.gripProps("), `${label} 缺少拖拽手柄`);
		assert.ok(source.includes("providerReorder.registerCard("), `${label} 缺少卡片注册`);
		assert.ok(source.includes("color:var(--color-accent)") && source.includes("dropTarget.position ==="), `${label} 缺少插入指示线`);
	}
	// 认证页卡片也要有标题行标记，否则落点会按整张卡的中线算（展开态卡片偏移）
	assert.ok(authTab.includes('data-provider-head=""'));
});

test("契约完整性：排序提示与「恢复默认顺序」在四个页都渲染，重置写空数组", () => {
	const read = (path) => readFileSync(path, "utf8");
	const configModal = read("src/renderer/src/ConfigModal.tsx");
	const authTab = read("src/renderer/src/config/AuthTab.tsx");
	const modelsTab = read("src/renderer/src/config/ModelsTab.tsx");
	const dshCards = read("src/renderer/src/config/DshProviderCards.tsx");
	const dshTab = read("src/renderer/src/config/DshConfigTab.tsx");

	// 提示可发现性：排序行为写在设置里，用户遇到「另一页也变了」必须能从界面看到解释
	for (const [label, source] of [
		["ModelsTab", modelsTab],
		["AuthTab", authTab],
		["DshProviderCards", dshCards],
	]) {
		assert.ok(source.includes('t("config.providerOrderHint")') || source.includes('t("config.dsh.providerOrderHint")'), `${label} 缺少排序说明`);
		assert.ok(source.includes('t("config.providerOrderReset")'), `${label} 缺少恢复默认顺序入口`);
	}
	// 重置按钮只在真的排过序时出现（默认状态下不该有可点的无效按钮）
	assert.ok(modelsTab.includes("(props.providerOrder?.length ?? 0) > 0 && props.onResetProviders"));
	assert.ok(authTab.includes("(props.providerOrder?.length ?? 0) > 0 && props.onResetProviders"));
	assert.ok(dshCards.includes("(props.providerOrder?.length ?? 0) > 0 && props.onResetProviders"));
	// 重置 = 写空数组，落到 SettingsStore 的默认（配置原始顺序）
	assert.ok(configModal.includes("api.settings.update({ providerOrder: [] })"));
	assert.ok(configModal.includes("api.settings.update({ dshProviderOrder: [] })"));
	// DSH 页要透传 scope 与重置回调，否则卡片上的排序入口会静默失效
	assert.ok(dshTab.includes("providerOrderScope={props.providerOrderScope}"));
	assert.ok(dshTab.includes("onResetProviders={props.onResetProviders}"));
});

test("契约完整性：上移/下移按钮已移除，排序收敛为拖拽 + 手柄方向键 + FLIP 落位动画", () => {
	const read = (path) => readFileSync(path, "utf8");
	const hook = read("src/renderer/src/hooks/useProviderReorder.ts");
	const modelsTab = read("src/renderer/src/config/ModelsTab.tsx");
	const authTab = read("src/renderer/src/config/AuthTab.tsx");
	const dshCards = read("src/renderer/src/config/DshProviderCards.tsx");

	// 三个页面都不再渲染上移/下移按钮（按钮回归 = 视觉噪音回归，别再加回来）
	for (const [label, source] of [
		["ModelsTab", modelsTab],
		["AuthTab", authTab],
		["DshProviderCards", dshCards],
	]) {
		assert.ok(!source.includes("config.moveProviderUp") && !source.includes("config.moveProviderDown"), `${label} 不应再渲染上移/下移按钮`);
		assert.ok(!source.includes("providerReorder.canMove") && !source.includes("providerReorder.moveBy"), `${label} 不应再引用按钮专用的 canMove/moveBy`);
	}
	// 键盘可达性：手柄聚焦后 ↑/↓ 以可见邻居为锚点移动（纯键盘用户没有按钮也能排序）
	assert.ok(hook.includes("moveProviderByStep("), "hook 缺少键盘重排（↑/↓ 以可见邻居为锚点）");
	assert.ok(hook.includes("onKeyDown:"), "gripProps 缺少键盘接线");
	// FLIP 落位动画：重排后卡片从旧位置滑到新位置而不是瞬间跳变，且跟随系统「减少动态效果」
	assert.ok(hook.includes("rectsBeforeReorder") && hook.includes(".animate("), "hook 缺少 FLIP 位移动画");
	assert.ok(hook.includes("prefers-reduced-motion"), "动画必须跟随系统「减少动态效果」设置");
	// 拖拽影像：克隆卡头当拖拽影像（原生影像只是十几像素的手柄图标）
	assert.ok(hook.includes("setDragImage"), "hook 缺少拖拽影像增强");
});
