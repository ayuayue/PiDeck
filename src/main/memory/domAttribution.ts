/**
 * 渲染层 DOM 归属探针：回答「这 N 万个节点到底花在哪个子树」。
 *
 * 为什么需要（2026-10 内存排查）：MemoryMonitor 只记录 document.querySelectorAll('*').length，
 * 只能看到总量。实测某次 5 秒内 DOM 从 1517 涨到 22608、渲染进程 RSS 峰值 1369MB，
 * 但总量无法区分「一个巨长代码块」/「大量过程组」/「某个卡片子树」——
 * 排查因此卡在猜测上，连续两轮归因都错了。
 *
 * 设计约束：
 * - 表达式必须在页面里自包含（executeJavaScript 注入的是字符串，不能引用模块变量）；
 * - 用渲染层已有的稳定锚点分组：时间线回合 data-message-id、过程组 data-process-group-id、
 *   过程组体 data-process-group-body；无锚点的节点归入 root；
 * - 只统计「直属锚点」下的节点数，不重复累计嵌套锚点（避免同一子树被算两次）；
 * - 结果按节点数降序取前 N，写盘走独立 JSONL，不动既有 CSV 列契约。
 *
 * 纯函数部分（分组/截断）抽出来便于单测；页面内联表达式由 buildDomAttributionExpression 产出。
 */

/** 单轮采样里最多保留多少个高占用子树（防止一次采样写出巨大文件）。 */
export const DOM_ATTRIBUTION_TOP_LIMIT = 12;

/** 一个被统计的子树。kind 对应它来自哪个锚点类型。 */
export type DomAttributionEntry = {
	/** 锚点类型：turn = 时间线回合；group = 过程组；groupBody = 过程组体；root = 未归属 */
	kind: "turn" | "group" | "groupBody" | "root";
	/** 锚点标识（data-message-id / data-process-group-id 的值；root 为 "-"） */
	id: string;
	/** 该子树内节点总数（不含嵌套锚点子树，那些单独成条） */
	nodes: number;
};

/**
 * 在页面内执行的归属统计表达式。
 *
 * 算法：先收集所有锚点元素（按 turn < group < groupBody 的优先级），每个锚点节点数 =
 * 该元素 querySelectorAll('*').length + 1，再减去其内部嵌套锚点的同一计数（只减直属后代，
 * 嵌套锚点的贡献由它自己那条报告）。最后补一条 root = 总数 - 所有顶层锚点之和。
 *
 * 为什么要减：TurnRow 里嵌着 ProcessGroupStep，直接相加会把组内节点重复计两次。
 */
export function buildDomAttributionExpression(limit: number = DOM_ATTRIBUTION_TOP_LIMIT): string {
	// limit 必须先收敛成有限正整数：Math.max(1, NaN) 仍是 NaN，直接拼进注入脚本会让
	// 页面侧 sort/slice 行为异常（LIMIT=NaN 时 slice(0,NaN)=空数组，归属结果静默丢失）。
	const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DOM_ATTRIBUTION_TOP_LIMIT;
	// 注意：这是注入页面的字符串，不能用 TS 语法糖；保持 ES5 兼容写法便于在旧 Chromium 上跑。
	return `(function(){
	var LIMIT = ${safeLimit};
	var anchors = [];
	var seen = [];
	function collect(selector, kind, attr){
		var els = document.querySelectorAll(selector);
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (seen.indexOf(el) >= 0) continue;
			seen.push(el);
			anchors.push({ el: el, kind: kind, id: el.getAttribute(attr) || "-" });
		}
	}
	collect('[data-message-id]', 'turn', 'data-message-id');
	collect('[data-process-group-id]', 'group', 'data-process-group-id');
	collect('[data-process-group-body]', 'groupBody', 'data-process-group-body');
	// 预先算每个锚点的原始节点数
	for (var i = 0; i < anchors.length; i++) {
		anchors[i].raw = anchors[i].el.querySelectorAll('*').length + 1;
	}
	// 每个锚点的净节点数 = 原始 - 内部嵌套锚点的原始数（嵌套锚点自己会报告）
	for (var i = 0; i < anchors.length; i++) {
		var a = anchors[i];
		a.net = a.raw;
		for (var j = 0; j < anchors.length; j++) {
			if (i === j) continue;
			if (a.el !== anchors[j].el && a.el.contains(anchors[j].el)) a.net -= anchors[j].raw;
		}
		if (a.net < 0) a.net = 0;
	}
	var total = document.querySelectorAll('*').length;
	// root = 总数 - 所有锚点的「净贡献」，而不是减顶层锚点的 raw：
	// raw 含嵌套锚点子树，用它相减会把嵌套部分重复扣一次（实测差 2 个节点，平账失败）。
	var covered = 0;
	for (var i = 0; i < anchors.length; i++) covered += anchors[i].net;
	anchors.sort(function(x, y){ return y.net - x.net; });
	var top = anchors.slice(0, LIMIT).map(function(a){ return { kind: a.kind, id: a.id, nodes: a.net }; });
	var rootNodes = total - covered;
	if (rootNodes > 0) top.push({ kind: 'root', id: '-', nodes: rootNodes });
	return { total: total, entries: top };
})()`;
}

/**
 * 把页面返回的原始结果整理成稳定结构（纯函数，可单测）。
 * 页面执行失败/结构不符时返回 null——采样侧据此写成空，不能让它影响主采样。
 */
export function normalizeDomAttribution(raw: unknown, limit: number = DOM_ATTRIBUTION_TOP_LIMIT): { total: number; entries: DomAttributionEntry[] } | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as { total?: unknown; entries?: unknown };
	if (typeof value.total !== "number" || !Array.isArray(value.entries)) return null;
	const allowed = new Set(["turn", "group", "groupBody", "root"]);
	const entries: DomAttributionEntry[] = [];
	for (const item of value.entries) {
		if (!item || typeof item !== "object") continue;
		const entry = item as { kind?: unknown; id?: unknown; nodes?: unknown };
		if (typeof entry.kind !== "string" || !allowed.has(entry.kind)) continue;
		if (typeof entry.nodes !== "number" || !Number.isFinite(entry.nodes)) continue;
		entries.push({
			kind: entry.kind as DomAttributionEntry["kind"],
			id: typeof entry.id === "string" && entry.id ? entry.id : "-",
			nodes: Math.max(0, Math.round(entry.nodes)),
		});
	}
	// 二次截断：页面侧已按 LIMIT 截过，这里兜底防止异常返回过大
	return { total: Math.max(0, Math.round(value.total)), entries: entries.slice(0, limit + 1) };
}
