import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 渲染层虚拟化的两个新件（2026-10）的行为测试。
 *
 * 为什么这个文件必须存在：`virtual-stack.tsx` 与 `structureReuse.ts` 的源码注释里写着
 * 「契约（三件事，测试钉住）」「不变量（测试钉住）」，而审计实验（2026-10）用
 * `grep -rl "reuseStructure\|sameTurnProcessNode\|VirtualStack" tests/` 拿到 0 命中——
 * 也就是那句话当时是**事实错误**：没有任何测试读过这两个文件。
 *
 * 这里补上能真跑的那一半：
 * - `structureReuse` 与 `fileChanges` 的文本缓存是纯逻辑、零运行时依赖，直接加载真跑；
 * - `virtual-stack.tsx` 依赖 React 运行时，node 单测只能对「纯导出与源码契约」做断言，
 *   行为面（测量、overscan、滚动回收）由 e2e/timeline-virtualization.spec.ts 覆盖——
 *   本文件不假装覆盖了那里。
 */

/**
 * 直接复用仓库共享的 TS→CommonJS 加载器，不再自己写一份 vm 沙箱。
 *
 * 曾经是手写 `vm.runInNewContext` + `require: (id) => stubs[id] ?? {}`：这个桩把
 * `structureReuse.ts` 的相对 import（`../../../lib/renderReuse`）静默吞成 `{}`，
 * re-export 出来的 `reuseStructure` / `sameReferenceList` 全是 undefined，于是 5 条
 * 纯函数测试报 `TypeError: not a function`——红光落在测试文件上，产品代码无恙，
 * 「针对性测试红」因此被误归因到产品侧。共享加载器已经解决了同一组问题（相对路径解析、
 * 项目根相对导入、vm 独立 realm 的 Error 身份、构建期 define 常量），复用它是唯一正解。
 */
const loadTs = loadTsCommonJs;

/** 抽出某次调用的参数文本（按括号配平）。源码契约断言用它，正则写不死缩进与换行。 */
function callArguments(source, callee, occurrence = 0) {
	const needle = callee + "(";
	let from = -1;
	for (let seen = 0; seen <= occurrence; seen += 1) {
		from = source.indexOf(needle, from + 1);
		if (from < 0) return null;
	}
	let depth = 0;
	for (let index = from + callee.length; index < source.length; index += 1) {
		const char = source[index];
		if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return source.slice(from + callee.length + 1, index);
		}
	}
	return null;
}

const STRUCTURE = "src/renderer/src/components/session/timeline/structureReuse.ts";
const FILE_CHANGES = "src/shared/fileChanges.ts";
const VIRTUAL_STACK = "src/renderer/src/components/ui-shadcn/virtual-stack.tsx";

/* ── reuseStructure ── */

test("reuseStructure 全命中时返回 previous 数组本身", () => {
	const { reuseStructure } = loadTs(STRUCTURE);
	const a = { id: "a", text: "1" };
	const b = { id: "b", text: "2" };
	const previous = [a, b];
	const next = [
		{ id: "a", text: "1" },
		{ id: "b", text: "2" },
	];
	const same = (x, y) => x.id === y.id && x.text === y.text;

	const out = reuseStructure(previous, next, same);

	assert.equal(out, previous, "全部命中且长度相同必须返回旧数组本身（下游 useMemo 的命中前提）");
	assert.equal(out[0], a);
	assert.equal(out[1], b);
});

test("reuseStructure 长度不同时返回新数组，但同下标命中项仍复用", () => {
	const { reuseStructure } = loadTs(STRUCTURE);
	const a = { id: "a", text: "1" };
	const b = { id: "b", text: "2" };
	const previous = [a, b];
	const next = [
		{ id: "a", text: "1" },
		{ id: "b", text: "2" },
		{ id: "c", text: "3" },
	];
	const same = (x, y) => x.id === y.id && x.text === y.text;

	const out = reuseStructure(previous, next, same);

	assert.notEqual(out, previous, "长度变了数组不能复用（长度是下游切片的依据）");
	assert.equal(out.length, 3, "返回长度必须等于 next");
	assert.equal(out[0], a, "同下标命中项换回旧引用");
	assert.equal(out[1], b);
	assert.equal(out[2].id, "c", "新增项取新对象");
});

test("reuseStructure 中间有项不命中时返回新数组但复用命中项", () => {
	const { reuseStructure } = loadTs(STRUCTURE);
	const a = { id: "a", text: "1" };
	const b = { id: "b", text: "2" };
	const c = { id: "c", text: "3" };
	const previous = [a, b, c];
	const next = [
		{ id: "a", text: "1" },
		{ id: "b", text: "CHANGED" },
		{ id: "c", text: "3" },
	];
	const same = (x, y) => x.id === y.id && x.text === y.text;

	const out = reuseStructure(previous, next, same);

	assert.notEqual(out, previous);
	assert.equal(out[0], a, "未变项复用");
	assert.notEqual(out[1], b, "变化项必须取新对象");
	assert.equal(out[1].text, "CHANGED");
	assert.equal(out[2], c, "未变项复用");
});

test("reuseStructure 无 previous 时直接返回 next", () => {
	const { reuseStructure } = loadTs(STRUCTURE);
	const next = [{ id: "a" }];
	const out = reuseStructure(undefined, next, () => true);
	assert.equal(out, next);
});

/* ── 同一性判据 ── */

test("sameReferenceList 逐项引用比较", () => {
	const { sameReferenceList } = loadTs(STRUCTURE);
	const a = {};
	const b = {};
	assert.equal(sameReferenceList([a, b], [a, b]), true);
	assert.equal(sameReferenceList([a], [a, b]), false, "长度不同必须为 false");
	assert.equal(sameReferenceList([a, b], [a, {}]), false, "同内容不同引用为 false（本层只认引用）");
	assert.equal(sameReferenceList(undefined, []), false);
	assert.equal(sameReferenceList(undefined, undefined), true);
});

test("sameTurnProcessEntry 逐 kind 分支", () => {
	const { sameTurnProcessEntry } = loadTs(STRUCTURE);
	const group = {};
	const message = {};
	const messages = [];

	assert.equal(sameTurnProcessEntry({ kind: "thinking-entry", id: "t", group }, { kind: "thinking-entry", id: "t", group }), true);
	assert.equal(sameTurnProcessEntry({ kind: "thinking-entry", id: "t", group }, { kind: "thinking-entry", id: "t", group: {} }), false, "思考组换了对象必须为 false");
	assert.equal(sameTurnProcessEntry({ kind: "tool-entry", id: "x", group }, { kind: "tool-entry", id: "x", group }), true);
	assert.equal(sameTurnProcessEntry({ kind: "retry-entry", id: "r", message }, { kind: "retry-entry", id: "r", message }), true);
	assert.equal(sameTurnProcessEntry({ kind: "retry-entry", id: "r", message }, { kind: "retry-entry", id: "r", message: {} }), false, "同 id 不同消息必须为 false");
	assert.equal(sameTurnProcessEntry({ kind: "extension-entry", id: "e", messages }, { kind: "extension-entry", id: "e", messages }), true);
	assert.equal(sameTurnProcessEntry({ kind: "tool-entry", id: "x", group }, { kind: "thinking-entry", id: "x", group }), false, "kind 不同必须为 false");
	assert.equal(sameTurnProcessEntry({ kind: "tool-entry", id: "x", group }, { kind: "tool-entry", id: "y", group }), false, "id 不同必须为 false");
});

test("sameTurnDisplayItem 区分 process-entry 与 interim/final 回答", () => {
	const { sameTurnDisplayItem } = loadTs(STRUCTURE);
	const group = {};
	const message = {};

	const a = { kind: "process-entry", id: "p", entry: { kind: "tool-entry", id: "x", group } };
	const b = { kind: "process-entry", id: "p", entry: { kind: "tool-entry", id: "x", group } };
	assert.equal(sameTurnDisplayItem(a, b), true, "process-entry 交给 sameTurnProcessEntry");

	assert.equal(sameTurnDisplayItem({ kind: "interim-answer", id: "i", message }, { kind: "interim-answer", id: "i", message }), true);
	assert.equal(sameTurnDisplayItem({ kind: "final-answer", id: "f", message }, { kind: "final-answer", id: "f", message }), true);
	assert.equal(sameTurnDisplayItem({ kind: "interim-answer", id: "i", message }, { kind: "final-answer", id: "i", message }), false, "interim 与 final 不能互认");
	assert.equal(sameTurnDisplayItem({ kind: "final-answer", id: "f", message }, { kind: "final-answer", id: "f", message: {} }), false);
});

test("sameTurnProcessNode 组节点只认成员引用，组头计数由 members 推导", () => {
	const { sameTurnProcessNode } = loadTs(STRUCTURE);
	const m1 = {};
	const m2 = {};

	assert.equal(sameTurnProcessNode({ kind: "group", id: "g", members: [m1, m2] }, { kind: "group", id: "g", members: [m1, m2] }), true);
	assert.equal(sameTurnProcessNode({ kind: "group", id: "g", members: [m1] }, { kind: "group", id: "g", members: [m1, m2] }), false, "成员数变了必须为 false");
	assert.equal(sameTurnProcessNode({ kind: "group", id: "g", members: [m1, m2] }, { kind: "group", id: "g", members: [m1, {}] }), false);

	const message = {};
	assert.equal(sameTurnProcessNode({ kind: "interim", id: "i", message }, { kind: "interim", id: "i", message }), true);
	assert.equal(sameTurnProcessNode({ kind: "entry", id: "e", entry: m1 }, { kind: "entry", id: "e", entry: m1 }), true);
	assert.equal(sameTurnProcessNode({ kind: "entry", id: "e", entry: m1 }, { kind: "entry", id: "e", entry: m2 }), false);
});

/* ── 文本变换缓存 ── */

test("createTextTransformCache 同一输入二次调用不再执行 transform", () => {
	const { createTextTransformCache } = loadTs(FILE_CHANGES);
	let calls = 0;
	const transform = createTextTransformCache((text) => {
		calls += 1;
		return text.toUpperCase();
	});

	assert.equal(transform("abc"), "ABC");
	assert.equal(calls, 1);
	assert.equal(transform("abc"), "ABC");
	assert.equal(calls, 1, "同一输入必须命中缓存（流式期间同一段正文每 50ms 被清 6 遍，这才是收益来源）");
	assert.equal(transform("xyz"), "XYZ");
	assert.equal(calls, 2, "不同输入各自计算");
});

test("createTextTransformCache 语义与原 transform 逐字相同", () => {
	const { createTextTransformCache } = loadTs(FILE_CHANGES);
	const raw = (text) => text.split("").reverse().join("");
	const cached = createTextTransformCache(raw);
	for (const sample of ["", "a", "hello", "中文内容", "混合 mixed 123", "\n\t  "]) {
		assert.equal(cached(sample), raw(sample), `输入 ${JSON.stringify(sample)} 的结果必须与未缓存时一致`);
	}
});

test("createTextTransformCache 超长输入不缓存但结果仍正确", () => {
	const { createTextTransformCache } = loadTs(FILE_CHANGES);
	let calls = 0;
	const transform = createTextTransformCache(
		(text) => {
			calls += 1;
			return `len=${text.length}`;
		},
		256,
		8,
	);

	const long = "x".repeat(20);
	assert.equal(transform(long), "len=20");
	assert.equal(transform(long), "len=20");
	assert.equal(calls, 2, "超过 maxInput 的输入不缓存（避免长正文把缓存撑爆）");

	const short = "abc";
	assert.equal(transform(short), "len=3");
	assert.equal(transform(short), "len=3");
	assert.equal(calls, 3, "短输入仍然命中缓存");
});

test("createTextTransformCache 条目到上限时清空整表且结果仍正确", () => {
	const { createTextTransformCache } = loadTs(FILE_CHANGES);
	let calls = 0;
	const transform = createTextTransformCache((text) => {
		calls += 1;
		return `#${text}`;
	}, 2);

	assert.equal(transform("a"), "#a");
	assert.equal(transform("b"), "#b");
	assert.equal(transform("c"), "#c");
	assert.equal(calls, 3, "第三条触发整表清空");
	assert.equal(transform("a"), "#a");
	assert.equal(calls, 4, "清空后旧条目需重算，但结果必须仍然正确");
});

test("stripAnsi 行为与未加缓存时一致", () => {
	const { stripAnsi } = loadTs(FILE_CHANGES);
	// 构造项：ESC [ 0 m 包住正文
	const ESC = String.fromCharCode(27);
	assert.equal(stripAnsi(`${ESC}[0mhello${ESC}[0m`), "hello");
	assert.equal(stripAnsi("plain"), "plain");
	assert.equal(stripAnsi(""), "");
	assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m and ${ESC}[1mbold${ESC}[0m`), "red and bold");
});

/* ── virtual-stack 的纯导出与源码契约 ── */

test("VirtualStack 的短列表门槛是 16 行", () => {
	const exports = loadTs(VIRTUAL_STACK, {
		stubs: {
			react: { useCallback: () => {}, useMemo: () => {} },
			"react/jsx-runtime": { jsx: () => {}, jsxs: () => {}, Fragment: Symbol("Fragment") },
			"@tanstack/react-virtual": { useVirtualizer: () => ({}) },
		},
	});
	assert.equal(exports.VIRTUAL_STACK_MIN_ROWS, 16, "门槛变更会影响 7 处接入点的 DOM 形态，必须显式改这条测试");
});

test("VirtualStack 虚拟化行带 data-index（virtual-core 靠它定位）", () => {
	const source = readFileSync(VIRTUAL_STACK, "utf8");
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	assert.match(code, /data-index=\{virtualItem\.index\}/, "缺 data-index 时 measureElement 找不到行下标，行高全部按估值走");
	assert.match(code, /height:\s*virtualizer\.getTotalSize\(\)/, "内容盒高度必须取 getTotalSize，否则 scrollHeight 与实际内容不符");
	assert.match(code, /transform:\s*`translateY\(/, "行用 translateY 定位（不用 top，避免每帧触发布局）");
});

test("VirtualStack 短列表分支：无 containerProps 时直出 Fragment，有则包一层", () => {
	const source = readFileSync(VIRTUAL_STACK, "utf8");
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	// 没有 containerProps 时必须直出 Fragment：多包一层会改掉接入点的 flex / 子选择器排版。
	// 有 containerProps 时必须包一层——分支树的 role="tree" 就在这里，且在 ≤16 行的常态下
	// 也必须存在，否则 treeitem 失去 tree 祖先（审计缺陷 2）。
	assert.match(code, /return containerProps \? \(\s*<div \{\.\.\.containerRest\} className=\{containerClassName\}>/, "短列表分支必须消费 containerProps（拆出 className 后合并），且无 containerProps 时不多包层");
	assert.match(code, /<>\(?\s*\{plainRows\}\s*\)?<\/>/, "无 containerProps 时直出 Fragment");
	assert.match(code, /<Fragment key=\{getKey\(item, index\)\}>/, "短列表行必须带 key：renderItem 的返回值多数不产 key");
});

test("VirtualStack 在滚动窗 ref 迟到挂载时必须补一次渲染", () => {
	// 回归防线（2026-11 待办条「展开后一片空白、等好久才出来」）：
	// React 先跑子组件 layout effect、后 attach 父 host 元素 ref，所以子组件首次 _willUpdate 读到
	// getScrollElement() === null；virtual-core 见 scrollElement 未变就直接 return（不订阅、不 notify），
	// 没有这次补渲染就永远不会自己恢复。删掉这段时 e2e/todo-strip-many-items.spec.ts 会一直 0 行。
	const source = readFileSync(VIRTUAL_STACK, "utf8");
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	assert.match(code, /const element = scrollRef\.current;/, "必须读 scrollRef.current 做就绪判定");
	assert.match(code, /if \(element && virtualize\) forceRender\(\);/, "拿到滚动窗（且确实虚拟化）后必须强制重渲染一次");
	assert.match(code, /if \(element === attachedScrollElement\.current\) return;/, "必须比对上次元素，否则每次渲染都多触发一次");
});

/* ── 结构复用必须真接线（防死代码回归） ── */

test("structureReuse 必须被生产代码引用（不许是死代码）", () => {
	// 审计抓到过一次：`structureReuse.ts` 写好了、注释写着「缺任何一层，下游 memo 就按新引用
	// 判为变化」，但 src/ 里 0 引用——那层根本没接线，属于文档与实盘不符。
	//
	// 用 fs 递归而不是 `git grep`：新文件在提交前不被 git 跟踪，`grep -l` 会漏掉它自己，
	// 而 uncommitted 状态正是这条判据最该生效的时候。
	const hits = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = `${dir}/${entry.name}`;
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!/\.(ts|tsx)$/.test(entry.name)) continue;
			if (full.endsWith("timeline/structureReuse.ts")) continue; // 排除自身
			if (readFileSync(full, "utf8").includes("structureReuse")) hits.push(full);
		}
	};
	walk("src");
	assert.ok(hits.length >= 1, "structureReuse 至少要被一个生产文件引用（否则是死代码）");
	assert.ok(
		hits.some((file) => file.includes("TurnRow.tsx")),
		`TurnRow 必须接线结构复用（现有引用：${hits.join(", ") || "无"}）`,
	);
});

test("TurnRow 的两层复用都用对了同一性判据", () => {
	const source = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	// displayItems 层必须用 sameTurnDisplayItem，processNodes 层必须用 sameTurnProcessNode。
	// 用错判据（例如两层都用 id 比较）不会报错，只会静默地复用内容已变的条目。
	//
	// 断言对象从「内联样板」换成「useReusedList 的调用参数」：TurnRow 已把那段样板收进
	// hook（lib/hooks/use-render-reuse.ts），继续找旧写法等于在测一段不存在的代码。
	const displayArgs = callArguments(code, "useReusedList", 0);
	const processArgs = callArguments(code, "useReusedList", 1);
	assert.ok(displayArgs !== null && processArgs !== null, "两层派生都必须走 useReusedList：写回 useMemo 等于丢掉结构复用");
	// 变量名也要钉：只钉「参数里出现哪个判据」的话，把 displayItems 与 processNodes 的
	// 赋值目标互换照样全绿（两处参数文本各自仍然成立）。
	assert.match(code, /const displayItems = useReusedList\(/);
	assert.match(code, /const processNodes = useReusedList\(/);
	assert.match(displayArgs, /buildTurnDisplay\(/, "第一处复用必须是 displayItems 层");
	assert.match(displayArgs, /sameTurnDisplayItem/, "displayItems 层判据");
	assert.doesNotMatch(displayArgs, /sameTurnProcessNode/, "两层判据不得互换");
	assert.match(processArgs, /groupTurnProcess\(displayItems\)/, "第二处复用必须是 processNodes 层");
	assert.match(processArgs, /sameTurnProcessNode/, "processNodes 层判据");
	assert.doesNotMatch(processArgs, /sameTurnDisplayItem/, "两层判据不得互换");
	assert.equal(callArguments(code, "useReusedList", 2), null, "只应有这两处复用点；新增复用点要同时定判据并更新本断言");
});
/**
 * 两条虚拟列表的「列表语义」契约（2026-10 审查后补）。
 *
 * 为什么需要源码级断言：虚拟化后行的父元素不再是 ul/ol，而是 div[data-index]。
 * 装配错的表现是「DOM 合法但屏幕阅读器不再按列表播报」，没有报错、没有视觉差异，
 * 只有读 DOM 才发现。仓库里这两处（子代理条 / 轨迹视图）恰好是两种正确写法的样本：
 * 短列表用真标签 ul>li（ol>li），虚拟分支用 role=list / listitem 补语义。
 * e2e 只覆盖了子代理条的短列表（1 行），虚拟路径（>16 行）没有任何自动化，这里补上静态那一半。
 */
test("子代理条：两条路径各用合法标签，虚拟路径的 role 挂在栈的内容盒上", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionSubagentsStrip.tsx", "utf8");
	// 容器标签与行标签由同一个布尔量导出，不会分叉成「容器 div、行 li」。
	assert.match(source, /const ListTag: "ul" \| "div" = virtualizeRows \? "div" : "ul";/);
	assert.match(source, /const ItemTag: "li" \| "div" = virtualizeRows \? "div" : "li";/);
	// 虚拟行是 div[data-index] 的子节点：role=list 必须在栈的内容盒上（containerProps），
	// 挂在栈外面的容器上等于跨了一层，与轨迹视图的写法不一致。
	assert.match(source, /containerProps=\{\{ role: "list" \}\}/);
	assert.match(source, /rowProps=\{\(\) => \(\{ role: "listitem" \}\)\}/);
	// 短列表不许再套一层 li：行组件根节点就是 li，再包一层是非法的 li > li。
	assert.match(source, /rows\.map\(\(row\) => renderRow\(row, "li"\)\)/);
	assert.doesNotMatch(source, /<li key=\{row\.id\}>/, "外层 li 已被移除（行组件自带 li）");
	assert.match(source, /const RowTag = as \?\? "li";/);
});

test("轨迹视图：短列表保留基线两层结构，虚拟分支压平但补 role", () => {
	const source = readFileSync("src/renderer/src/components/session/trajectory/SessionTrajectoryView.tsx", "utf8");
	// 短列表必须与接入虚拟化前逐字节一致：**两层** ul —— 外层 divide-y /50 分隔轮，
	// 内层 divide-y /40 分隔记录行。
	// 这条被维护者打回过两次：一次写成 ol，一次把两层拍平成一层（记录行分隔线从内层 /40
	// 变成外层 /50）。所以断言必须同时钉两层与两个颜色档 —— 只钉外层 ul 的话，拍平照样绿。
	assert.match(source, /<ul className="divide-y divide-border\/50">\s*\{\[\.\.\.byTurn\.entries\(\)\]\.map/);
	assert.match(source, /<ul className="divide-y divide-border\/40">/);
	assert.match(source, /<li key=\{`turn:\$\{turnIndex\}`\}>/);
	// 虚拟路径只吃一维数组，压平是必要代价；行分隔线取记录行那一档 /40。
	assert.match(source, /rowClassName="border-b border-border\/40"/);
	assert.match(source, /containerProps=\{\{ role: "list" \}\}/);
	assert.match(source, /rowProps=\{\(\) => \(\{ role: "listitem" \}\)\}/);
});
