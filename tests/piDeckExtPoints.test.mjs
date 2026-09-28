/**
 * `pi-deck-ext-points`（扩展点面板，PiDeck 内置扩展）的单元测试。
 *
 * 加载方式：`createTsSandbox` 按**源文件目录**解析无扩展名相对 import
 *（AGENTS.md 硬性：加载生产 TS 模块一律走 loadTsCommonJs / createTsSandbox，
 * 不自己写解析钩子 —— 手写 require 桥会以 tests/ 为基准解析，生产代码一新增
 * 本地依赖就整片 MODULE_NOT_FOUND）。
 *
 * 覆盖两条主线：
 * 1. **运行时推导**（清单层）：从 pi 的 `.d.ts` 抽 ui 方法与事件（含泛型方法与易漏事件）；
 *    GUI 落点与桥的 `GUI_SLOT_METHODS` 同源（15 个，含 config.page）；读不到 `.d.ts`
 *    时**降级**为只列 GUI 落点，而不是崩；草稿：勾选顺序 = 编号顺序、已下线的点跳过。
 * 2. **落点优先级**（入口层）：内置化后的核心行为 —— 有 `setConfigPage` 走整页且
 *    **不碰** `setSettingsSection`；只有 `setSettingsSection` 时走退化路径；
 *    两者都没有时既不抛错也不推贡献；`/ext-points` 命令在任何情况下都注册；
 *    会话结束时撤回贡献并清掉重试 timer（生命周期配对）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const EXT_DIR = "resources/extensions/";

// 与生产同源：GUI 落点表就是桥的 spec 模块，测试直接读它（不复制粘贴一份 15 元素数组）。
const loadSpec = createTsSandbox();
const { GUI_SLOT_METHODS } = loadSpec(`${EXT_DIR}pi-deck-gui-bridge-gui-spec.ts`);

const extendLoad = createTsSandbox();
// 清单层与面板层的 `__test__` 在这里（入口只做挂载与命令注册，不转出内部函数）
const catalogMod = extendLoad(`${EXT_DIR}pi-deck-ext-points-catalog.ts`);
const panelMod = extendLoad(`${EXT_DIR}pi-deck-ext-points-panel.ts`);
const { parseUiPoints, parseEvents, enumerateGuiSlotMethods, buildGuiPoints, loadCatalog } = catalogMod.__test__;
const { buildDraft } = panelMod.__test__;

/** 一份最小但形状正确的 .d.ts 片段（照 pi 的真实写法）。 */
const FAKE_DTS = `
export interface ExtensionUIContext {
    select(title: string, options: string[]): Promise<string | undefined>;
    setStatus(key: string, text: string | undefined): void;
    custom<T>(factory: (tui: TUI) => Component, options?: { overlay?: boolean }): Promise<T>;
    setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
    readonly theme: Theme;
}

export interface ExtensionAPI {
    on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
    on(event: "tool_call", handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
    on(event: "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
}
`;

/** 桥 spec 表里的全部落点方法（桥 v1.3 = 15 个）。 */
const ALL_SLOT_METHODS = Object.keys(GUI_SLOT_METHODS);

/**
 * 数组等值断言。
 *
 * 生产模块经 vm 沙箱加载，它返回的数组原型与主 realm 不同 ——
 * `deepStrictEqual` 会以「结构相同但不同引用」失败（仓库既有测试的同一处坑，见
 * `tests/builtInExtensions.test.mjs` 的 `sameArgs`）。比字符串即可，且意图更清楚。
 */
function sameList(actual, expected) {
	assert.equal(JSON.stringify([...actual]), JSON.stringify(expected));
}

/** 普通对象等值断言（同样为了避开跨 realm 的原型差异）。 */
function sameProps(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

describe("pi-deck-ext-points: 运行时推导扩展点", () => {
	it("从 ExtensionUIContext 抽方法（含泛型方法与只读属性）", () => {
		const points = parseUiPoints(FAKE_DTS);
		const labels = points.map((p) => p.label);
		assert.ok(labels.includes("ctx.ui.select"));
		assert.ok(labels.includes("ctx.ui.setStatus"));
		// 泛型方法：早期正则漏了 `<T>`，会整个丢掉 custom
		assert.ok(labels.includes("ctx.ui.custom"), `应含 ctx.ui.custom，实际 ${labels.join(", ")}`);
		// 只读属性也要收
		assert.ok(labels.includes("ctx.ui.theme"), "只读属性应被收进清单");
		// 签名要带上参数，草稿里 agent 靠它猜参数
		const setStatus = points.find((p) => p.label === "ctx.ui.setStatus");
		assert.match(setStatus.signature, /setStatus\(key: string, text: string \| undefined\): void/);
	});

	it("事件扫 on() 签名，不扫接口的 type 字面量", () => {
		const events = parseEvents(FAKE_DTS);
		sameList(
			events.map((e) => e.label),
			["session_shutdown", "session_start", "tool_call"],
		);
		assert.equal(events[0].signature, 'pi.on("session_shutdown", handler)');
	});

	it("GUI 落点与桥的 spec 表同源（15 个，含 config.page）", () => {
		// 桥 v1.3 的白名单：14 个旧落点 + setConfigPage（本次内置化的落点）
		sameList(ALL_SLOT_METHODS, [
			"setSidebarPanel",
			"setSidebarSection",
			"setContentView",
			"setComposerToolbar",
			"setTitlebarAction",
			"setBanner",
			"setToolExtra",
			"setMessageExtra",
			"setThinkingExtra",
			"setDialogAction",
			"setDialogBody",
			"setSettingsSection",
			"setConfigPage",
			"setSessionItemExtra",
			"setContextMenuItem",
		]);

		const { points, unknown } = buildGuiPoints(ALL_SLOT_METHODS);
		assert.equal(points.length, 15, `应有 15 个落点，实际 ${points.length}`);
		sameList(unknown, [], "桥白名单内的落点不该被判为「待登记」");
		const labels = points.map((p) => p.label);
		assert.ok(labels.includes("ctx.gui.setToolExtra"));
		assert.ok(labels.includes("ctx.gui.setSidebarPanel"));
		assert.ok(labels.includes("ctx.gui.setConfigPage"));
		// 落点 id 与桥的契约逐条对齐（渲染层按 slot 字符串聚合，漂了就整片不显示）
		const ids = points.map((p) => p.id);
		for (const slot of Object.values(GUI_SLOT_METHODS)) {
			assert.ok(ids.includes(`gui:${slot}`), `落点 id 应含 gui:${slot}`);
		}
		// 落点名要能对上（草稿里 agent 要用它）
		const toolExtra = points.find((p) => p.label === "ctx.gui.setToolExtra");
		assert.match(toolExtra.signature, /落点 "tool\.extra"/);
		// GUI 落点全部是 wired —— 桥自己的落点当然生效
		assert.ok(points.every((p) => p.status === "wired"));
	});

	it("每个 GUI 落点都有一句话说明（策展表不许漏）", () => {
		for (const point of buildGuiPoints(ALL_SLOT_METHODS).points) {
			assert.ok(point.note, `落点 ${point.label} 缺说明`);
		}
	});

	it("枚举到桥 spec 表外的新落点：照列不漏，标「待登记」", () => {
		const { points, unknown } = buildGuiPoints([...ALL_SLOT_METHODS, "setSomethingNew"]);
		sameList(unknown, ["setSomethingNew"]);
		const extra = points.find((p) => p.label === "ctx.gui.setSomethingNew");
		assert.ok(extra, "未登记的落点也要列出来，不许静默丢弃");
		assert.equal(extra.id, "gui:setSomethingNew", "未登记时落点 id 暂用方法名");
		assert.match(extra.signature, /落点待登记/);
	});

	it("enumerateGuiSlotMethods 只认 setXxx 函数属性", () => {
		const gui = { setBanner: () => {}, setFoo: "not a function", custom: () => {}, theme: {} };
		sameList(enumerateGuiSlotMethods(gui), ["setBanner"]);
		sameList(enumerateGuiSlotMethods(null), []);
		sameList(enumerateGuiSlotMethods(undefined), []);
	});
});

describe("pi-deck-ext-points: 草稿生成", () => {
	const catalog = { points: [...parseUiPoints(FAKE_DTS), ...parseEvents(FAKE_DTS), ...buildGuiPoints(ALL_SLOT_METHODS).points], piVersion: "0.87.1", typesPath: "/x" };

	it("编号顺序 = 勾选顺序，不是列表顺序", () => {
		// 先勾事件（列表里靠后），再勾 ui（列表里靠前）
		const draft = buildDraft(["event:tool_call", "ui:setStatus"], new Map(), "", catalog);
		const i1 = draft.indexOf("1. tool_call");
		const i2 = draft.indexOf("2. ctx.ui.setStatus");
		assert.ok(i1 !== -1 && i2 !== -1, `编号顺序不对：\n${draft}`);
		assert.ok(i1 < i2, "应先出现先勾选的 tool_call");
	});

	it("带上签名与说明（agent 不用猜参数）", () => {
		const draft = buildDraft(["ui:setStatus"], new Map(), "", catalog);
		assert.match(draft, /- 签名：setStatus\(key: string, text: string \| undefined\): void/);
	});

	it("未填用途时给明确占位，不留空让 agent 猜", () => {
		const draft = buildDraft(["ui:setStatus"], new Map(), "", catalog);
		assert.match(draft, /- 主要用来：（未填写，请先问我这块具体想做什么）/);
	});

	it("填了用途就原样带上", () => {
		const draft = buildDraft(["ui:setStatus"], new Map([["ui:setStatus", "在状态栏常驻显示上下文占用"]]), "", catalog);
		assert.match(draft, /- 主要用来：在状态栏常驻显示上下文占用/);
	});

	it("未命名有兜底文案", () => {
		assert.match(buildDraft([], new Map(), "", catalog), /扩展名称和大概功能：（未命名，请先问我）/);
		assert.match(buildDraft([], new Map(), "  ", catalog), /（未命名，请先问我）/, "纯空格也算未命名");
		assert.match(buildDraft([], new Map(), "我的扩展", catalog), /扩展名称和大概功能：我的扩展/);
	});

	it("没勾任何点时给出明确提示，而不是空列表", () => {
		assert.match(buildDraft([], new Map(), "", catalog), /（还没勾选任何扩展点）/);
	});

	it("已下线的扩展点 id 被跳过，而不是渲染成 undefined", () => {
		// 模拟：用户勾了某个点，之后 pi 升级把它删了
		const draft = buildDraft(["ui:setStatus", "ui:thisPointIsGone"], new Map(), "", catalog);
		// 断言要精确：pi 的类型签名里本来就有 "undefined"（如 `text: string | undefined`），
		// 那是合法内容；要抓的是「被跳过的点渲染成编号条目 undefined」。
		assert.equal(/^\s*\d+\. undefined/m.test(draft), false, `不应渲染成 undefined 条目：\n${draft}`);
		assert.match(draft, /1\. ctx\.ui\.setStatus/);
		// 被跳过的点不占编号：后面没有 2.
		assert.equal(draft.includes("2. "), false);
	});

	it("草稿带约束提示与参考文档（含落点白名单源文件）", () => {
		const draft = buildDraft(["ui:setStatus"], new Map(), "", catalog);
		assert.match(draft, /约束提示：这些只是我的初步构想/);
		assert.match(draft, /## 参考文档/);
		assert.match(draft, /pi-deck-gui-bridge-gui-spec\.ts/);
		assert.match(draft, /docs\/gui-extension-bridge\.md/);
	});
});

describe("pi-deck-ext-points: 降级", () => {
	/** 全 15 个落点的替身 gui（真桥挂出来就是这个形状）。 */
	function fullGui() {
		return Object.fromEntries(ALL_SLOT_METHODS.map((method) => [method, () => {}]));
	}

	it("读不到 pi 的 .d.ts 时降级为只列 GUI 落点，且不抛错", () => {
		// 当前测试环境里 pi 可能装也可能没装 —— 两种都要能跑
		const result = loadCatalog(fullGui(), "测试替身");
		assert.ok(Array.isArray(result.points), "points 必须是数组");
		// 无论哪条路径，GUI 落点都必须在（它不依赖 .d.ts）
		assert.ok(result.points.some((p) => p.group === "gui"));
		const guiPoints = result.points.filter((p) => p.group === "gui");
		assert.equal(guiPoints.length, 15, `GUI 落点恒为 15 个，实际 ${guiPoints.length}`);
	});

	it("锚点全落空时 loadCatalog 仍返回 15 个 GUI 落点（typesPath 为 null）", () => {
		// 用替身 fs 模拟「pi 没装」：所有候选路径都不存在、createRequire 也解析不到。
		// 这走的是 loadCatalog 的降级分支 —— 不报错、不影响会话。
		const loadDegraded = createTsSandbox({
			stubs: {
				"node:fs": { existsSync: () => false, readFileSync: () => "" },
				"node:module": {
					createRequire: () => {
						throw new Error("pi 未安装（测试替身）");
					},
				},
				"node:os": { homedir: () => "" },
			},
		});
		const degradedMod = loadDegraded(`${EXT_DIR}pi-deck-ext-points-catalog.ts`);
		const result = degradedMod.__test__.loadCatalog(fullGui(), "降级替身");
		assert.equal(result.typesPath, null);
		assert.equal(result.piVersion, null);
		assert.equal(result.points.length, 15);
		assert.ok(result.points.every((p) => p.group === "gui"));
	});

	it("解析坏输入返回空数组而不是抛错", () => {
		sameList(parseUiPoints(""), []);
		sameList(parseEvents(""), []);
		sameList(parseUiPoints("export interface Other { x: 1 }"), []);
		sameList(parseEvents('export interface Other { on(event: "x"): void }'), []);
	});
});

// ── 落点优先级（本次内置化的核心行为）────────────────────────────

/** 单次落点调用记录。 */
function recorder() {
	const calls = [];
	return {
		calls,
		/** 记一次调用（测试里的落点 setter 就是它）。 */
		push(name, ...args) {
			calls.push({ name, args });
		},
		/** 该 setter 被调用过几次。 */
		count(name) {
			return calls.filter((c) => c.name === name).length;
		},
		/** 第 occurrence 次调用的第 index 个参数。 */
		arg(name, index, occurrence = 0) {
			const hit = calls.filter((c) => c.name === name)[occurrence];
			return hit ? hit.args[index] : undefined;
		},
	};
}

/**
 * 造一个假 pi：收集 registerCommand / on 注册，并把事件 emit 出来。
 *
 * 每次用**全新的 sandbox 实例**加载入口（helper 的缓存按实例隔离，不会命中旧实例），
 * 闭包里的勾选状态因此不会跨用例串味。
 */
function bootExtension() {
	const freshLoad = createTsSandbox();
	const fresh = freshLoad(`${EXT_DIR}pi-deck-ext-points.ts`);
	const commands = new Map();
	const handlers = new Map();
	fresh.default({
		registerCommand: (name, options) => commands.set(name, options),
		on: (event, handler) => handlers.set(event, handler),
	});
	const record = recorder();
	const gui = {};
	return {
		commands,
		record,
		/** 挂上落点 setter（模拟桥挂 gui 的方式：普通对象属性）。 */
		setSlot(name) {
			gui[name] = (...args) => record.push(name, ...args);
			return this;
		},
		/** 触发已注册的事件处理器（ctx.ui.gui 指向同一个 gui 对象）。 */
		emit(event) {
			handlers.get(event)?.(undefined, { ui: { gui } });
			return this;
		},
	};
}

describe("pi-deck-ext-points: 落点优先级（内置化后反转）", () => {
	it("有 setConfigPage → 推 config.page 整页，且不碰 setSettingsSection", () => {
		const app = bootExtension();
		const record = app.record;
		app.setSlot("setConfigPage").setSlot("setSettingsSection");
		app.emit("session_start");

		assert.equal(record.count("setConfigPage"), 1, "应推一次整页贡献");
		assert.equal(record.count("setSettingsSection"), 0, "有整页就不该再推设置卡片（会重复）");
		assert.equal(record.arg("setConfigPage", 0), "ext-points", "落点 key 必须保持 ext-points");
		sameProps(record.arg("setConfigPage", 2), { title: "扩展点", order: 900 });
		// factory 返回的是一棵可渲染的展示树
		const factory = record.arg("setConfigPage", 1);
		assert.equal(typeof factory, "function");
		const node = factory();
		assert.equal(node.kind, "card");
		assert.equal(node.id, "ext-points-section");
		assert.ok(Array.isArray(node.children) && node.children.length > 0);
	});

	it("只有 setSettingsSection（老桥）→ 走退化路径推设置卡片", () => {
		const app = bootExtension();
		const record = app.record;
		app.setSlot("setSettingsSection");
		app.emit("session_start");

		assert.equal(record.count("setSettingsSection"), 1, "没有整页落点时退化为设置卡片");
		assert.equal(record.count("setConfigPage"), 0);
		assert.equal(record.arg("setSettingsSection", 0), "ext-points");
		sameProps(record.arg("setSettingsSection", 2), { title: "扩展点", order: 900 });
	});

	it("两者都没有（纯终端 / 桥被禁用）→ 不抛错、不推任何 GUI 贡献", () => {
		const app = bootExtension();
		app.emit("session_start"); // 不许抛
		assert.deepEqual(app.record.calls, [], "没有落点 setter 时不该调用任何东西");
		// 兜底的 agent_start 路径同样不许抛
		app.emit("agent_start");
		assert.deepEqual(app.record.calls, []);
	});

	it("/ext-points 命令在任何落点情况下都注册", () => {
		for (const slots of [[], ["setSettingsSection"], ["setConfigPage"], ["setConfigPage", "setSettingsSection"]]) {
			const app = bootExtension();
			for (const slot of slots) app.setSlot(slot);
			app.emit("session_start");
			const command = app.commands.get("ext-points");
			assert.ok(command, `落点 ${slots.join("+") || "（无）"} 下也必须注册 /ext-points`);
			assert.equal(typeof command.handler, "function");
		}
	});

	it("session_shutdown 撤回落点贡献（与注册成对），并清掉重试 timer", () => {
		const app = bootExtension();
		const record = app.record;
		app.setSlot("setConfigPage").setSlot("setSettingsSection");
		app.emit("session_start");
		assert.equal(record.count("setConfigPage"), 1);

		app.emit("session_shutdown");
		assert.equal(record.count("setConfigPage"), 2, "shutdown 应再调一次同 key 的 setter");
		assert.equal(record.arg("setConfigPage", 1, 1), undefined, "撤回贡献 = 同 key 传 undefined");
		assert.equal(record.count("setSettingsSection"), 0, "撤回只能撤自己推的那条路径");

		// 再撤一次不该重复调用（activeSlot 已清）
		app.emit("session_shutdown");
		assert.equal(record.count("setConfigPage"), 2);
	});

	it("退化路径下 shutdown 撤的是 setSettingsSection", () => {
		const app = bootExtension();
		const record = app.record;
		app.setSlot("setSettingsSection");
		app.emit("session_start");
		app.emit("session_shutdown");
		assert.equal(record.count("setSettingsSection"), 2);
		assert.equal(record.arg("setSettingsSection", 1, 1), undefined);
	});

	it("session_start 里拿不到 gui（桥后挂）→ 单次重试后仍能挂上，且只推一处", async () => {
		const app = bootExtension();
		const record = app.record;
		// 先 emit：此刻 gui 还是空对象 → 走 setTimeout(0) 重试
		app.emit("session_start");
		sameList(record.calls, [], "同步段桥还没挂，不该推贡献");
		// 桥在同一次 emit 之后挂上（真实时序）
		app.setSlot("setConfigPage");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(record.count("setConfigPage"), 1, "宏任务重试后应挂上");
		assert.equal(record.count("setSettingsSection"), 0);
	});

	it("session_start + agent_start 都拿不到 gui → 只排一次重试，桥挂上后只推一次", async () => {
		const app = bootExtension();
		const record = app.record;
		// 真实时序：pi 先 emit session_start，再有 agent_start；两次都看不到 gui。
		// 没有重试闸门时会排两个 timer → 桥挂上后推两次同 key 贡献。
		app.emit("session_start");
		app.emit("agent_start");
		app.setSlot("setConfigPage");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(record.count("setConfigPage"), 1, `应只推一次，实际 ${record.count("setConfigPage")} 次`);
	});

	it("会话结束后新会话能重新挂上（mounted 复位，不留「已挂」假状态）", () => {
		const app = bootExtension();
		const record = app.record;
		app.setSlot("setConfigPage");
		app.emit("session_start");
		assert.equal(record.count("setConfigPage"), 1);
		app.emit("session_shutdown");
		assert.equal(record.count("setConfigPage"), 2);
		// 新会话：必须重新推一次（否则新会话里挂载态是假的）
		app.emit("session_start");
		assert.equal(record.count("setConfigPage"), 3, "新会话应重新挂载");
		assert.equal(typeof record.arg("setConfigPage", 1, 2), "function", "新会话推的是新的 factory，不是撤回用的 undefined");
	});
});
