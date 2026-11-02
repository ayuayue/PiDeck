import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { EXEMPT_CATEGORIES, loadBaseline, runCheck, scan } from "./scrollContainerGuard.mjs";

/**
 * 滚动容器虚拟化守卫。
 *
 * 守的是「每一个有滑动的东西都复用虚拟化」这条要求不会随时间悄悄失效：
 * 新增一个长列表滚动窗时，要么接 <VirtualStack>，要么写明 scroll-ok: <类别> 的理由，
 * 要么就是缺陷。存量登记在 baseline 里等后续批次处理——基线是台账，不是免罪金牌，
 * 处理掉一个就把它的指纹从基线删掉。数量不写在这里：它每天都会变，node
 * tests/scrollContainerGuard.mjs 现算（--list 只列还没判的）。
 */
test("新增滚动容器必须被显式判定（接 VirtualStack 或写 scroll-ok）", () => {
	const baseline = loadBaseline();
	const undecided = scan().filter((item) => !item.hasVirtualStack && !item.exemptCategory && !baseline.has(item.fingerprint));
	assert.deepEqual(
		undecided.map((item) => item.file + ":" + item.line + "  " + item.text),
		[],
		"这些滚动窗既没接 <VirtualStack>，也没有 scroll-ok 判定，也不在基线里",
	);
});

test("扫描器本身要有产出（防止正则写坏导致永远 0 命中）", () => {
	const items = scan();
	assert.ok(items.length > 100, "扫描到的滚动容器数异常少（" + items.length + "），正则可能已被改坏");
	assert.ok(
		items.some((item) => item.hasVirtualStack),
		"没扫到任何已虚拟化的文件，<VirtualStack> 判定可能已失效",
	);
});

/**
 * 以下三条是判据自己的反例样本：合格样本与触发样本都自己造，不借环境当前状态。
 * 判据在 2026-10 换过一次，原因是旧判据（「同文件 ±80 行内出现过 <VirtualStack>」）
 * 对两种真缺陷都给绿：接了但没接线（虚拟器拿不到 scrollElement）、以及压根没接却
 * 挨得近。下面第一条就是这个缺陷的最小复现。
 */
function scanSample(files) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-guard-"));
	try {
		for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
		return scan({ root: dir, dir });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("反例：只挨着 VirtualStack、没有 ref→scrollRef 接线的滚动窗必须算未判定", () => {
	const items = scanSample({
		"Sample.tsx": ["const NeighbourOnly = () => (", '  <div className="overflow-y-auto">', "    <VirtualStack items={[]} />", "  </div>", ");", "", "const Wired = () => (", '  <div className="h-40 overflow-y-auto" ref={listRef}>', "    <VirtualStack scrollRef={listRef} items={[]} />", "  </div>", ");"].join("\n"),
	});
	assert.equal(items.length, 2, "两个滚动容器都要被扫到");
	assert.equal(items[0].hasVirtualStack, false, "挨着 VirtualStack 但没接线，必须算未判定（旧判据这里给绿）");
	assert.equal(items[1].hasVirtualStack, true, "ref 与 scrollRef 同名的接线必须算已虚拟化");
});

test("反例：注释里提到的 overflow-y-auto 不是滚动容器", () => {
	const items = scanSample({
		"Note.tsx": ["export const Note = () => {", "  /*", "   * 行必须 shrink-0，超出部分交还给 overflow-y-auto 滚动。", "   */", '  return <div className="flex" />;', "};"].join("\n"),
	});
	assert.deepEqual(
		items.map((item) => item.line),
		[],
		"注释块中间那行既不以星号也不以双斜杠开头，按行判断会把它当成容器（旧实现踩过）",
	);
});

test("反例：容器上一行的 ref 也能认（多行 JSX 属性）", () => {
	const items = scanSample({
		"Multiline.tsx": ["const Multiline = () => (", "  <div", "    ref={scrollRef}", '    className="max-h-40 overflow-y-auto"', "  >", "    <VirtualStack scrollRef={scrollRef} items={[]} />", "  </div>", ");"].join("\n"),
	});
	assert.equal(items.length, 1);
	assert.equal(items[0].hasVirtualStack, true, "ref 写在开标签的上一行时也要认出来");
});

test("反例：上一行是别的元素的完整开标签时，不能把它的 ref 认给本容器", () => {
	// 顺序反了就会 fail-open：先匹配 ref 再判「上一行以 > 收尾」，break 永远轮不到。
	const items = scanSample({
		"Neighbour.tsx": ["const Neighbour = () => (", '  <HoverCardContent ref={contentRef} className="p-0">', '    <div className="max-h-48 overflow-y-auto select-text">', "      <VirtualStack scrollRef={contentRef} items={[]} />", "    </div>", "  </HoverCardContent>", ");"].join("\n"),
	});
	assert.equal(items.length, 1);
	assert.equal(items[0].hasVirtualStack, false, "contentRef 是上一个元素的 ref，不是这个 div 的");
});

test("反例：透传的可选 ref（props.x）不算接线", () => {
	// 透传无法静态证明调用方给了实 ref：要在组件内做本地兜底再用。
	const items = scanSample({
		"Passthrough.tsx": ["const Passthrough = (props) => (", '  <div ref={props.scrollRef} className="max-h-40 overflow-y-auto">', "    <VirtualStack scrollRef={props.scrollRef} items={[]} />", "  </div>", ");"].join("\n"),
	});
	assert.equal(items.length, 1);
	assert.equal(items[0].hasVirtualStack, false, "props.x 必须先在组件内兜底成本地变量");
});
test("反例：scroll-ok: 写了不在白名单里的类别，等于没写", () => {
	// 判据靠白名单而不是「任何小写词」：否则 scroll-ok: whatever 就能让容器离开未判定，
	// 而 docs 里的类别表永远不会因为「多了一个没人认识的类别」被暴露。
	const items = scanSample({
		"Bogus.tsx": ["/** scroll-ok: whatever 随便写的类别 */", "const Bogus = () => (", '  <div className="max-h-40 overflow-y-auto" />', ");"].join("\n"),
	});
	assert.equal(items.length, 1);
	assert.equal(items[0].exemptCategory, undefined, "白名单外的类别不得算豁免");
});

test("合格样本：白名单内的类别算豁免", () => {
	const items = scanSample({
		"Good.tsx": ["/** scroll-ok: text 整段 pre，没有行列表 */", "const Good = () => (", '  <pre className="max-h-40 overflow-auto" />', ");"].join("\n"),
	});
	assert.equal(items.length, 1);
	assert.equal(items[0].exemptCategory, "text");
});
test("反例：scroll-ok 写在容器下方，等于没写", () => {
	// 守卫只向上找：写在下面时容器会落进基线兜底，于是「判过了」和「没人判」长得一样。
	// 2026-10 实测命中一处（GitGraph 的提交列表），标记白写了一段时间。
	const items = scanSample({
		"Below.tsx": ["const Below = () => (", '  <div className="max-h-40 overflow-y-auto">', "    {/* scroll-ok: bounded 写在下面 */}", "  </div>", ");"].join("\n"),
	});
	assert.equal(items.length, 1);
	assert.equal(items[0].exemptCategory, undefined, "标记必须写在容器的上一行或更上，写在下方不算");
});
/** 把一段源码写进临时 root，供 runCheck 这类「要看退出码」的用例使用。 */
function runSample(files, extra = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-guard-run-"));
	try {
		for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
		const baselinePath = join(dir, "baseline.json");
		writeFileSync(baselinePath, JSON.stringify({ count: 0, entries: [] }), "utf8");
		return runCheck({ root: dir, dir, baselinePath, ...extra });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("未判定时必须 exit 1、判定了才 exit 0（闸门本身要会说话）", () => {
	// 这条守的是「判据自己会不会坏」：把 classify 的兜底档篡改成「全进基线」，
	// 全量测试照样全绿、CLI 照样打印「未判定 0」——闸门永远 PASS。
	const undecided = runSample({
		"Loose.tsx": ['const Loose = () => <div className="overflow-y-auto" />;'].join("\n"),
	});
	assert.equal(undecided, 1, "有未判定的滚动窗时必须 exit 1");

	const wired = runSample({
		"Wired.tsx": ["const Wired = () => (", '  <div ref={listRef} className="h-40 overflow-y-auto">', "    <VirtualStack scrollRef={listRef} items={[]} />", "  </div>", ");"].join("\n"),
	});
	assert.equal(wired, 0, "全部判定过时必须 exit 0");
});

test("文档里的豁免类别表与代码白名单逐项一致", () => {
	// 「三处同源」原来只做到两处（Set 与报错文案），文档表格靠手抄。
	// 往 Set 里加一个文档没写的类别时，测试必须红。
	const doc = readFileSync("docs/virtualization-audit.md", "utf8");
	const table = doc.slice(doc.indexOf("| 类别 | 含义 |"), doc.indexOf("## 五、守卫"));
	const documented = Array.from(table.matchAll(/^\| `([a-z-]+)` \|/gm)).map((match) => match[1]);
	assert.ok(documented.length >= 5, "类别表没解析出来（表格格式变了就更新本条的正则）");
	assert.deepEqual([...EXEMPT_CATEGORIES].sort(), documented.sort(), "代码白名单与文档表格必须逐项一致");
});
test("反例：上一个元素上的 scroll-ok 不豁免它下方的容器", () => {
	// 标记与 ref 一样要判标签边界：不判的话，写在元素 A 上方的标记会顺带豁免
	// A 下方 13 行内属于另一个元素的滚动窗（fail-open，与旧 ref 判据同族）。
	const items = scanSample({
		"NeighbourMark.tsx": ["const NeighbourMark = () => (", '  <div className="p-2">', "    {/* scroll-ok: bounded 属于上面的 div，不属于下面的 */}", "  </div>,", "  <section>", '    <div className="max-h-40 overflow-y-auto" />', "  </section>", ");"].join("\n"),
	});
	assert.equal(items.length, 1, "只扫到一个滚动容器");
	assert.equal(items[0].exemptCategory, undefined, "标记属于上一个元素，不得豁免这个容器");
});
test("反例：标记写在同一行属性里（该行以 > 收尾）不豁免下方容器", () => {
	// 顺序判据：先判边界再判匹配。反过来的话，同一行既是标记又以 > 收尾时，
	// 会先命中标记、轮不到 break，等于把这个元素的标记白送给它下面的容器。
	const items = scanSample({
		"InlineMark.tsx": ["const InlineMark = () => (", '  <div data-hint="scroll-ok: text">', '    <div className="max-h-40 overflow-y-auto" />', "  </div>", ");"].join("\n"),
	});
	assert.equal(items.length, 1);
	assert.equal(items[0].exemptCategory, undefined, "标记属于外层元素，不得豁免内层容器");
});

/**
 * 反方向用例（PR #471 review 要求）：跳过规则只看「声明行」，
 * 于是「类名抽成变量」曾是一条静默逃跑通道——声明行被跳过，
 * 元素行又没有 overflow 字面量，整个容器从判定面里消失（实测命中 4 处）。
 */
test("反例：类名抽成变量后，元素行也必须被登记（不许静默消失）", () => {
	const items = scanSample({
		"Extracted.tsx": ["const Extracted = () => {", '  const listClass = "m-0 flex max-h-64 flex-col overflow-y-auto";', "  return <ul className={listClass} />;", "};"].join("\n"),
	});
	assert.equal(items.length, 1, "声明行不算容器，但引用它的元素行必须算");
	assert.equal(items[0].hasVirtualStack, false);
	assert.equal(items[0].exemptCategory, undefined, "没接虚拟栈也没写标记 → 落进未判定");
});

test("合格样本：内联后的同一行照样能被豁免标记认下来", () => {
	const items = scanSample({
		"Inlined.tsx": ["const Inlined = () => (", "  <div>", "    {/* scroll-ok: bounded 固定枚举 */}", '    <ul className="m-0 flex max-h-64 flex-col overflow-y-auto" />', "  </div>", ");"].join("\n"),
	});
	assert.equal(items.length, 1);
	assert.equal(items[0].exemptCategory, "bounded");
});

test("反例：只有声明、没有元素引用时不算容器（声明行本身不是滚动窗）", () => {
	const items = scanSample({
		"DeclOnly.tsx": ["const DeclOnly = () => {", '  const listClass = "m-0 max-h-64 overflow-y-auto";', "  return null;", "};"].join("\n"),
	});
	assert.equal(items.length, 0, "没人用的类名常量不该变成滚动容器");
});
