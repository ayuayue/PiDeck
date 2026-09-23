/**
 * `pi-deck-ext-points`（扩展点面板）的单元测试。
 *
 * 加载方式：Node 原生 TS 类型擦除直接 import 源文件 —— 与桥的测试一致，
 * 也顺带证明这个扩展同样是**零构建**的。
 *
 * 覆盖重点是**运行时推导**这条设计主线：
 * - 从 pi 的 `.d.ts` 抽 ui 方法与事件（含泛型方法与易漏的事件）
 * - 从桥的 spec 模块取 GUI 落点（同源，不漂）
 * - 读不到 .d.ts 时**降级**为只列 GUI 落点，而不是崩
 * - 草稿：勾选顺序 = 编号顺序；已下线的点跳过而不是渲染成 undefined
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// 生产代码用仓库约定的无扩展名相对 import（jiti 可解析，Node ESM 不可）
import "./helpers/tsResolveHook.mjs";

const mod = await import("../resources/extensions/pi-deck-ext-points.ts");
const { parseUiPoints, parseEvents, buildGuiPoints, buildDraft } = mod.__test__;

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
		assert.deepEqual(
			events.map((e) => e.label),
			["session_shutdown", "session_start", "tool_call"],
		);
		assert.equal(events[0].signature, 'pi.on("session_shutdown", handler)');
	});

	it("GUI 落点来自桥的 spec 模块（同源，14 个）", () => {
		const points = buildGuiPoints();
		assert.equal(points.length, 14, `应有 14 个落点，实际 ${points.length}`);
		const labels = points.map((p) => p.label);
		assert.ok(labels.includes("ctx.gui.setToolExtra"));
		assert.ok(labels.includes("ctx.gui.setSidebarPanel"));
		// 落点名要能对上（草稿里 agent 要用它）
		const toolExtra = points.find((p) => p.label === "ctx.gui.setToolExtra");
		assert.match(toolExtra.signature, /落点 "tool\.extra"/);
		// GUI 落点全部是 wired —— 桥自己的落点当然生效
		assert.ok(points.every((p) => p.status === "wired"));
	});

	it("每个 GUI 落点都有一句话说明（策展表不许漏）", () => {
		for (const point of buildGuiPoints()) {
			assert.ok(point.note, `落点 ${point.label} 缺说明`);
		}
	});
});

describe("pi-deck-ext-points: 草稿生成", () => {
	const catalog = { points: [...parseUiPoints(FAKE_DTS), ...parseEvents(FAKE_DTS), ...buildGuiPoints()], piVersion: "0.87.1", typesPath: "/x" };

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

	it("草稿带约束提示与参考文档", () => {
		const draft = buildDraft(["ui:setStatus"], new Map(), "", catalog);
		assert.match(draft, /约束提示：这些只是我的初步构想/);
		assert.match(draft, /## 参考文档/);
		assert.match(draft, /docs\/gui-extension-bridge\.md/);
	});
});

describe("pi-deck-ext-points: 降级", () => {
	it("loadCatalog 至少返回 14 个 GUI 落点，且不抛错", () => {
		// 当前测试环境里 pi 可能装也可能没装 —— 两种都要能跑
		const result = mod.__test__.loadCatalog();
		assert.ok(Array.isArray(result.points), "points 必须是数组");
		assert.ok(result.points.length >= 14, `至少有 14 个 GUI 落点，实际 ${result.points.length}`);
		// 无论哪条路径，GUI 落点都必须在（它不依赖 .d.ts）
		assert.ok(result.points.some((p) => p.group === "gui"));
	});

	it("解析坏输入返回空数组而不是抛错", () => {
		assert.deepEqual(parseUiPoints(""), []);
		assert.deepEqual(parseEvents(""), []);
		assert.deepEqual(parseUiPoints("export interface Other { x: 1 }"), []);
	});
});
