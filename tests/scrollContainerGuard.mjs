#!/usr/bin/env node
/**
 * 滚动容器虚拟化守卫（基线模式）。
 *
 * 为什么需要：要求是「每一个有滑动的东西都复用虚拟化」。这句话无法靠人记——一百多个
 * 滚动容器，谁记得哪个接了、哪个没接、哪个有理由不接？只写在注释里，下一个人新增
 * 长列表滚动窗时不会有人发现。
 *
 * 判据（见 virtual-stack.tsx）：能不能虚拟化看的不是行高方差，而是（a）有没有自己的
 * 滚动视口、（b）能不能测准行高。本脚本只查一件事：**新增**的滚动窗有没有被显式判定过。
 *
 * 四种状态（互斥，相加恒等于总数）：
 *   1. 已虚拟化 —— 容器带着一个 ref，且同一个 ref 名作为 scrollRef 传给了 <VirtualStack>；
 *   2. 已豁免   —— 容器行向上 14 行内有 scroll-ok: <类别> 标记；
 *   3. 基线存量 —— 已登记进基线，等后续批次处理；
 *   4. 未判定   —— 缺陷（exit 1）。
 *
 * 用法：
 *   node tests/scrollContainerGuard.mjs            检查（有新增未判定项就 exit 1）
 *   node tests/scrollContainerGuard.mjs --list     打印所有未判定的新增项
 *   node tests/scrollContainerGuard.mjs --seed     重新生成基线（只应在上一次全量判定后运行）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, "tests/scrollContainerGuard.baseline.json");
/** 只看「有滚动条」的容器；overflow-hidden 之类不算窗口。 */
const CONTAINER_RE = /overflow-(?:y-)?(?:auto|scroll)/;
/**
 * 豁免类别白名单。**必须与 docs/virtualization-audit.md 的表格一致**，也与下面
 * 「修法二选一」那句文案一致——三处任一处漏改，都会催生一个「守卫认、文档没写、
 * 下一个人不敢删」的类别。类别写错（不在白名单）等于没写，容器照样落进未判定。
 */
const EXEMPT_CATEGORIES = new Set(["bounded", "transient", "nested", "flip", "probe", "text"]);
/** 豁免标记。捕获值必须再过白名单，否则 scroll-ok: 随便什么词都能离开未判定。 */
const EXEMPT_RE = /scroll-ok:\s*([a-z-]+)/;
const LOOKBACK = 14;
/** ref 可能写在容器开标签的上一行（多行属性），向上找几行，但不跨过标签边界。 */
const REF_LOOKBACK = 6;
/** <VirtualStack> 出现。 */
const VIRTUALIZED_RE = /<VirtualStack\b/;
/**
 * 容器上的 ref 名（{@code ref={listRef}}）与传给 <VirtualStack> 的 scrollRef 名（{@code scrollRef={listRef}}）。
 *
 * 为什么必须按「接线」判定，而不是「同文件 ±80 行内出现过 VirtualStack」（2026-10 修）：
 * 旧判据只问「挨得近不近」，于是两种真缺陷都能过关——
 * 1) 接了但接坏：容器没有 ref，VirtualStack 收不到 scrollElement，视口恒 0、一行不渲染；
 * 2) 压根没接：同一组件里另一处 <VirtualStack> 只隔几十行，就把这个纯 pre 也算成已虚拟化，
 *    于是它既不进基线、也不报未判定，永久逃出判定面。
 * 判据改成「同一个 ref 名既挂在容器上、又作为 scrollRef 传给了栈」，两种缺陷都会落进未判定。
 */
const CONTAINER_REF_RE = /(?:^|\s)ref=\{([\w.]+)\}/;
const SCROLL_REF_RE = /scrollRef=\{([\w.]+)\}/;
/**
 * 第三种接线形状：容器元素**自己就是**虚拟化组件（diff 视图的
 * `<Virtualizer className="... overflow-auto">`）。这类没有外部 scrollRef 可对——容器与
 * 虚拟化是同一个节点，接没接线看标签名就够。漏掉它会让「已经虚拟化的 diff 视图」被当成
 * 未判定，逼人去写一条假豁免。
 */
const SELF_VIRTUALIZED_RE = /^<(?:Virtualizer|VirtualStack|VirtualList|VirtualTimeline)\b/;
/** 通用件自身：它自己的自建滚动窗不是接入点（没有「该不该虚拟化」这个问题），扫进来只会多一个假未判定。 */
const SELF_FILE_SUFFIX = "components/ui-shadcn/virtual-stack.tsx";

const SKIP_DIRS = new Set(["node_modules", "dist", "release", "out", ".git"]);

function walk(dir, out) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(join(dir, entry.name), out);
		} else if (/\.(tsx|ts)$/.test(entry.name)) {
			out.push(join(dir, entry.name));
		}
	}
	return out;
}

/** 注释行：注释里提到 overflow-y-auto 是在说明文字里，不是真容器。 */
function isCommentLine(line) {
	const t = line.trim();
	return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") || t.startsWith("{/*");
}

/**
 * 把块注释替换成等长空白（保留换行）后再扫描。
 *
 * 为什么要预处理而不是按行判断「这行是不是注释」：注释块中间那些行（例如
 * 「shrink-0 让行保持固有高度，超出部分交还给 overflow-y-auto 滚动。」这句说明的收尾行）
 * 既不以星号开头也不以双斜杠开头，按行判断必然漏，于是注释被当成一个滚动容器登记进台账。
 */
function stripBlockComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

function scan(options = {}) {
	// root / dir 可注入：测试要拿临时目录造反例样本（「只挨着 VirtualStack 但没接线」必须红），
	// 直接扫实盘的话，反例样本会变成仓库里一个额外的滚动容器。
	const root = options.root ?? ROOT;
	const dir = options.dir ?? join(root, "src/renderer/src");
	const files = walk(dir, []);
	const found = [];
	for (const file of files) {
		const rel = relative(root, file).replace(/\\/g, "/");
		if (rel.endsWith(SELF_FILE_SUFFIX)) continue;
		// 原文行用于找豁免标记（标记本身就是注释，抹掉就找不到了）；
		// 抹注释后的行用于找容器与 ref（注释里写的 overflow-y-auto 不是容器）。
		const rawText = readFileSync(file, "utf8");
		const rawLines = rawText.split("\n");
		const lines = stripBlockComments(rawText).split("\n");
		// 接线判定的另一半：本文件里被传给 <VirtualStack> 的 scrollRef 名集合。
		const scrollRefNames = new Set();
		for (const line of lines) {
			const match = SCROLL_REF_RE.exec(line);
			if (match) scrollRefNames.add(match[1]);
		}
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i];
			if (!CONTAINER_RE.test(line)) continue;
			if (isCommentLine(line)) continue;
			const lineNo = i + 1;
			// 已虚拟化 = 容器自己有 ref，且同一个 ref 名传给了 <VirtualStack> 的 scrollRef。
			//
			// ref 可能写在容器开标签的上一行（多行 JSX 属性），所以向上找几行。两条边界：
			// - **先判「上一行是不是别的元素收尾」再判匹配**。顺序反了的话，「上一行是上一个元素
			//   的完整开标签、ref 就在那一行」这种形状会把别人的 ref 认给本容器（2026-10 实测命中
			//   两处：HoverCardContent 的 ref、Input 的 ref），fail-open。
			// - ref 名以 props. 开头的（透传的可选 ref）**不算**接线：透传无法静态证明调用方一定
			//   给了实 ref。需要透传就在组件内做本地兜底（SessionTrajectoryView 的
			//   scrollRef = props.scrollRef ?? localRef），让容器与虚拟栈指向同一个本地变量。
			let refName;
			for (let back = 0; back <= REF_LOOKBACK && i - back >= 0; back += 1) {
				const candidate = lines[i - back];
				if (back > 0 && /(?:>|\/>)\s*$/.test(candidate.trim())) break;
				const match = CONTAINER_REF_RE.exec(candidate);
				if (match && !match[1].startsWith("props.")) {
					refName = match[1];
					break;
				}
			}
			const hasVirtualStack = SELF_VIRTUALIZED_RE.test(line.trim()) || (refName !== undefined && scrollRefNames.has(refName));
			// 向上找豁免标记。三条边界（与 ref 查找同序，顺序本身是判据）：
			// 1. 先判边界再判匹配 —— 反过来的话，「同一个元素自己的属性里写着 scroll-ok 且该行以 > 收尾」
			//    会先命中标记、再轮不到 break，等于把这个元素的标记白送给它下方的容器（fail-open）。
			// 2. 遇到上一个元素的开标签收尾（> 或 />）就停，不跨元素借标记。
			// 3. 类别必须在白名单内。
			let exemptCategory;
			for (let back = 1; back <= LOOKBACK && i - back >= 0; back += 1) {
				if (/(?:>|\/>)\s*$/.test(rawLines[i - back].trim())) break;
				const hit = EXEMPT_RE.exec(rawLines[i - back]);
				if (hit && EXEMPT_CATEGORIES.has(hit[1])) {
					exemptCategory = hit[1];
					break;
				}
			}
			found.push({ file: rel, line: lineNo, text: line.trim().slice(0, 160), hasVirtualStack, exemptCategory });
		}
	}
	// 同一文件里同一行内容出现多次时加序号，让指纹对行号漂移免疫。
	const seen = new Map();
	for (const item of found) {
		const key = item.file + " :: " + item.text;
		const n = (seen.get(key) ?? 0) + 1;
		seen.set(key, n);
		item.fingerprint = n === 1 ? key : key + " #" + n;
	}
	return found;
}

function loadBaseline(baselinePath) {
	const path = baselinePath ?? BASELINE_PATH;
	if (!existsSync(path)) return new Set();
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	return new Set(parsed.entries ?? []);
}

/**
 * 把每个容器归入唯一一档。四个数相加恒等于总数——用减法算「基线存量」会把
 * 「既接了虚拟栈又写了豁免标记」这类重复计数悄悄掩掉。
 */
function classify(items, baseline) {
	// 四档必须互斥且穷尽：所有条目都必须落进其中一档。任何「落不进来」的形态
	const groups = { virtualized: [], exempt: [], baselined: [], undecided: [] };
	for (const item of items) {
		if (item.hasVirtualStack) groups.virtualized.push(item);
		else if (item.exemptCategory) groups.exempt.push(item);
		else if (baseline.has(item.fingerprint)) groups.baselined.push(item);
		else groups.undecided.push(item);
	}
	return groups;
}

function main() {
	const args = process.argv.slice(2);
	return runCheck({ args });
}

/**
 * 纯函数版的 CLI：扫描 → 分档 → 打印 → 返回退出码。
 *
 * 为什么把它从 main 里拆出来：main 直接读 process.argv / process.cwd()，
 * 于是「未判定时必须 exit 1」「四档必须互斥且穷尽」这两条判据在测试里根本跑不到 ——
 * 把 classify 的兜底档篡改成「全进基线」，全量测试照样全绿、CLI 照样打印「未判定 0」。
 * 闸门永远 PASS 而判据自己不会说话。现在测试可以对临时目录造反例，直接断言返回值。
 */
function runCheck(options = {}) {
	const args = options.args ?? [];
	const items = scan(options);
	if (args.includes("--seed")) {
		// 只收「还没判定过」的项：已虚拟化和已豁免的不进基线。
		// 否则把某处的 <VirtualStack> 拆掉也不会变红——基线会替它兜底。
		const entries = items
			.filter((item) => !item.hasVirtualStack && !item.exemptCategory)
			.map((item) => item.fingerprint)
			.sort();
		// 写入前先分类一次：漏进未知档的条目在这里就会被发现（见 classify 的 other 档）。
		writeFileSync(options.baselinePath ?? BASELINE_PATH, JSON.stringify({ count: entries.length, entries }, null, "\t") + "\n", "utf8");
		console.log("基线已写入 " + (options.baselinePath ?? relative(ROOT, BASELINE_PATH)) + "：" + entries.length + " 个待判定的滚动容器");
		return 0;
	}

	const baseline = loadBaseline(options.baselinePath);
	const groups = classify(items, baseline);

	if (args.includes("--list")) {
		for (const item of groups.undecided) console.log(item.file + ":" + item.line + "  " + item.text);
		console.log("未判定 " + groups.undecided.length + " / 共 " + items.length);
		return 0;
	}

	console.log("滚动容器 " + items.length + " 个：已虚拟化 " + groups.virtualized.length + " · 已豁免 " + groups.exempt.length + " · 基线存量 " + groups.baselined.length + " · 未判定 " + groups.undecided.length);
	// 自检：四档必须互斥且穷尽，否则上面的数字不可信
	const sum = groups.virtualized.length + groups.exempt.length + groups.baselined.length + groups.undecided.length;
	if (sum !== items.length) {
		console.error("\n分类不完整：" + sum + " ≠ " + items.length + "，统计逻辑有问题");
		return 1;
	}

	if (groups.undecided.length > 0) {
		console.error("\n以下滚动窗既没接 <VirtualStack>，也没有 scroll-ok 判定，也不在基线里：");
		for (const item of groups.undecided) console.error("  " + item.file + ":" + item.line + "  " + item.text);
		console.error("\n修法二选一：接 <VirtualStack>（容器带 ref，同一个 ref 名作为 scrollRef 传给它），或在滚动窗上方写 scroll-ok: <类别>（" + [...EXEMPT_CATEGORIES].join("/") + "）说明理由。");
		return 1;
	}
	return 0;
}

// 可被 tests/scrollContainerGuard.test.mjs 直接 import 复用（测试与实现共用同一份扫描逻辑，
// 不另写副本——副本迟早与实现漂移，那时测试会变成假绿）。
export { scan, loadBaseline, classify, runCheck, EXEMPT_CATEGORIES };

// 只有被当作 CLI 直接执行时才跑 main；被 import 时不跑（省掉 process.exit）。
const invokedDirectly = process.argv[1] ? process.argv[1].includes("scrollContainerGuard.mjs") : false;
if (invokedDirectly) process.exit(main());
