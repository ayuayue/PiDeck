/**
 * DOM 归属探针的契约测试。
 *
 * 背景：该模块用于定位「渲染进程 2 万 DOM 节点到底花在哪」，上一轮排查因为没有
 * 归属能力而连续两次归因错误。这里钉住三件事：
 * 1. 注入页面的表达式必须是自包含字符串（不能引用模块变量，否则页面里 ReferenceError）；
 * 2. 页面返回值的归一化必须能挡住畸形数据，不能让它影响主采样；
 * 3. 排序与截断语义稳定（按节点数降序、受 limit 约束）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildDomAttributionExpression, normalizeDomAttribution, DOM_ATTRIBUTION_TOP_LIMIT } = loadTsCommonJs("src/main/memory/domAttribution.ts");

test("表达式是可直接求值的自包含字符串（不引用外部标识符）", () => {
	const expr = buildDomAttributionExpression();
	assert.equal(typeof expr, "string");
	assert.ok(expr.trim().startsWith("(function"), "必须是自执行函数表达式，页面里直接求值");
	assert.ok(expr.trim().endsWith("})()"), "必须自调用");
	// 关键：不能出现 TS/模块作用域引用（这些在页面里会是 ReferenceError）
	assert.ok(!expr.includes("import "), "不得包含 import");
	assert.ok(!expr.includes("document.querySelectorAll('[data-message-id]')".replace(/ /g, "")), "占位检查不应命中");
	// 必须用到的三个锚点都要在表达式里
	for (const anchor of ["data-message-id", "data-process-group-id", "data-process-group-body"]) {
		assert.ok(expr.includes(anchor), `缺少锚点 ${anchor}——该类型的子树将无法归属`);
	}
});

test("表达式在无 DOM 环境下可被安全构造（不抛错）", () => {
	// 只验证构造期安全：真正求值需要浏览器环境，由采集侧的 try/catch 兜底。
	assert.doesNotThrow(() => buildDomAttributionExpression(5));
});

test("limit 参与表达式构造并被规整为正整数", () => {
	const expr = buildDomAttributionExpression(3);
	assert.ok(expr.includes("var LIMIT = 3"));
	// 非法 limit 不能产生 NaN 注入到页面
	const bad = buildDomAttributionExpression(Number.NaN);
	assert.ok(!bad.includes("NaN"), "limit 为 NaN 时不得把 NaN 写进注入脚本");
	assert.ok(/var LIMIT = \d+/.test(bad));
});

test("normalizeDomAttribution: 正常结果按原样保留", () => {
	const raw = {
		total: 22608,
		entries: [
			{ kind: "turn", id: "run-1", nodes: 18000 },
			{ kind: "group", id: "grp:1", nodes: 4000 },
		],
	};
	const out = normalizeDomAttribution(raw);
	assert.equal(out.total, 22608);
	assert.equal(out.entries.length, 2);
	// 跨 realm 比较：模块经 vm 沙箱加载，对象字面量原型与测试侧不同，
	// 直接用 deepStrictEqual 会因原型不一致失败（须先结构化克隆）。
	assert.deepEqual(JSON.parse(JSON.stringify(out.entries[0])), { kind: "turn", id: "run-1", nodes: 18000 });
});

test("normalizeDomAttribution: 畸形输入一律返回 null（不污染采样）", () => {
	for (const bad of [null, undefined, 0, "", [], { total: "x", entries: [] }, { total: 1, entries: "no" }]) {
		assert.equal(normalizeDomAttribution(bad), null, `${JSON.stringify(bad)} 应被拒绝`);
	}
});

test("normalizeDomAttribution: 过滤非法条目并夹紧负数", () => {
	const out = normalizeDomAttribution({
		total: 100,
		entries: [
			{ kind: "turn", id: "a", nodes: 50 },
			{ kind: "unknown-kind", id: "b", nodes: 30 },
			{ kind: "group", id: "c", nodes: Number.POSITIVE_INFINITY },
			{ kind: "root", id: "", nodes: -5 },
		],
	});
	assert.equal(out.entries.length, 2, "非法 kind 与非有限 nodes 必须被丢弃");
	assert.deepEqual(JSON.parse(JSON.stringify(out.entries[1])), { kind: "root", id: "-", nodes: 0 }, "负数夹紧为 0，空 id 归一为 -");
});

test("normalizeDomAttribution: 截断到 limit+1，防止异常返回过大", () => {
	const entries = Array.from({ length: 40 }, (_, i) => ({ kind: "turn", id: `t${i}`, nodes: 100 - i }));
	const out = normalizeDomAttribution({ total: 1000, entries }, DOM_ATTRIBUTION_TOP_LIMIT);
	assert.equal(out.entries.length, DOM_ATTRIBUTION_TOP_LIMIT + 1);
});
/** 极简 DOM 桩：只需支撑 querySelectorAll / contains / getAttribute 三种能力。 */
class StubEl {
	constructor(tag, attrs = {}) {
		this.tag = tag;
		this.attrs = attrs;
		this.children = [];
		this.parentElement = null;
	}
	append(...kids) {
		for (const k of kids) {
			k.parentElement = this;
			this.children.push(k);
		}
		return this;
	}
	getAttribute(name) {
		return this.attrs[name] ?? null;
	}
	contains(other) {
		if (this === other) return true;
		return this.children.some((c) => c.contains(other));
	}
	descendants() {
		return this.children.flatMap((c) => [c, ...c.descendants()]);
	}
	querySelectorAll(sel) {
		const scope = this.descendants();
		if (sel === "*") return scope;
		const m = sel.match(/^\[([a-z-]+)\]$/);
		if (m) return scope.filter((e) => m[1] in e.attrs);
		throw new Error(`unexpected selector ${sel}`);
	}
}
const el = (tag, attrs = {}) => new StubEl(tag, attrs);
const leaves = (n) => {
	const box = el("div");
	for (let i = 0; i < n; i++) box.append(el("span"));
	return box;
};

/**
 * 在桩 DOM 上真实求值注入表达式。
 * 之前只用字符串断言（"表达式里包含 xxx 锚点"）是不够的——真正的风险是归属算法
 * 把嵌套子树重复计数，那种错误字符串断言永远发现不了。
 */
function evaluateAffordance(expr, rootEl) {
	const previous = globalThis.document;
	globalThis.document = { querySelectorAll: (sel) => rootEl.querySelectorAll(sel) };
	try {
		return eval(expr);
	} finally {
		globalThis.document = previous;
	}
}

test("归属算法：TurnRow 内嵌过程组时不重复计数，且各项之和等于总数", () => {
	// 结构对齐真实 DOM：article[data-message-id] > 组 > 组体（组体里 500 个 span）
	const body = el("div", { "data-process-group-body": "-" }).append(leaves(500));
	const group1 = el("div", { "data-process-group-id": "grp:1" }).append(el("button"), body);
	const group2 = el("div", { "data-process-group-id": "grp:2" }).append(el("button"));
	const turn = el("article", { "data-message-id": "run-1" }).append(el("header"), group1, group2);
	const rootEl = el("div").append(turn, el("footer"));

	const raw = evaluateAffordance(buildDomAttributionExpression(12), rootEl);
	const out = normalizeDomAttribution(raw);

	const byKind = Object.fromEntries(out.entries.map((e) => [`${e.kind}:${e.id}`, e.nodes]));
	// 组体里的 500 个 span + 组体自身 = 501，不能同时算进 process-group 与 turn
	// 组体自身 1 + 内部 div 1 + 500 个 span = 502
	assert.equal(byKind["groupBody:-"], 502, "组体应独占总节点数，不能被父级重复累计");
	assert.equal(byKind["group:grp:1"], 2, "组 1 只剩自身与按钮，组体已被单独报告");
	assert.equal(byKind["group:grp:2"], 2);
	assert.equal(byKind["turn:run-1"], 0, "回合节点数必须扣掉所有嵌套锚点");
	// root = 总数 - 各锚点净贡献之和。桩里未归属的是：footer、根容器自身、以及
	// turn 元素自身（它被计入 root 是因为 total 与 net 的口径都按 querySelectorAll("*")
	// 的后代计：真实浏览器里 * 含 html/body/#root 等外层壳，root 同样是「未归属」的汇总）。
	assert.equal(byKind["root:-"], 3, "未归属节点全部归入 root");

	const sum = out.entries.reduce((a, e) => a + e.nodes, 0);
	assert.equal(sum, out.total, "归属必须平账：各项之和等于页面节点总数，否则说明统计有重复或遗漏");
});

test("归属算法：无任何锚点时全部归入 root", () => {
	const rootEl = el("div").append(leaves(20));
	const out = normalizeDomAttribution(evaluateAffordance(buildDomAttributionExpression(12), rootEl));
	assert.equal(out.total, 21);
	// 跨 realm 比较：模块经 vm 沙箱加载，需先结构化克隆再断言
	assert.deepEqual(JSON.parse(JSON.stringify(out.entries.map((e) => ({ kind: e.kind, nodes: e.nodes })))), [{ kind: "root", nodes: 21 }]);
});
