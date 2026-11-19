// 判据：文档的 Markdown 结构。七条断言，逐条可红。
// 为什么要有：加粗漏一个会把后面整段吃掉，表格少一列会错位，
// 这两种在 PR review 里被指出过（PR 552 的 review 意见）。
// 行内代码里的星号不算加粗：先剥掉反引号包住的内容再数，否则教人「漏一个星号」的正文会被误判。
// 会红的七种：某行加粗没闭合、代码块没配对、表格某行列数与表头不符、标题前缺空行、文件读不到、
//   代码块里把 $ 变量写成反引号包裹（bash 会当命令替换执行），以及正文引用的节号在文档里找不到。
//
// 用法：
//   node check-format.mjs                       校验 resources/skills/pideck/SKILL.md
//   node check-format.mjs <文件> [--sections=…] 校验指定文件；拆分后请对每份 md 各跑一次
//   node check-format.mjs --selftest            只验判据自己，不读任何文件（装了 PiDeck 的机器上也能跑）
//
// --sections=0,0.4,1,2,… 给出整套文档的节号索引：节号引用可以指向别的文件。
// 不传时只认同文件标题（拆文件前的口径）。
//
// 为什么单独有 --selftest：这条判据要读的 SKILL.md 只在源码克隆里，装了 PiDeck 的机器上
// 只有技能副本。没有这个开关，「判据自己还对不对」在那些机器上没法验证，
// 而看不出来的判据坏了和判据不存在是同一件事。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 结构量下限：只说「空文件/拿错文件」，不是内容质量分。
// 2026-11-18 技能正文拆成多份短参考后，最短的 boundaries.md 只有 7 对加粗、没有表格与围栏；
// 按旧的 8 会把它判成「拿错文件」。4 仍然能拉住空文件（0）与只剩两行的文件（≤2）。
const MIN_STRUCTURE = 4;
const TICK = String.fromCharCode(96);
const FENCE = TICK + TICK + TICK;
const INLINE_CODE = new RegExp(TICK + "[^" + TICK + "]*" + TICK, "g");
// 三个连着的反引号用 \x60 写，免得源文件里出现围栏字面量、把编辑器的高亮弄乱。
const isFence = (x) => /^\s*\x60\x60\x60/.test(x);

/** 标题前必须有空行，否则 markdown 会把标题并进上一段。
 *  代码块内的行先剥掉：2026-11-15 实测，第一版没剥，把 bash 块里的「# 取端口和令牌」
 *  当成标题误报，于是真正缺空行的两处反而没被查。 */
function headingWithoutBlank(lines) {
	const out = [];
	let fence = false;
	for (let i = 0; i < lines.length; i++) {
		if (isFence(lines[i])) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		if (!/^#{1,6} /.test(lines[i])) continue;
		if (i > 0 && lines[i - 1].trim() !== "") out.push(i + 1);
	}
	return out;
}

/** 同一小节里，同一个反引号标识符既被当成判据，又被明确排除。
 *  形状来自 2026-11-15 实测：同一节里一边写「送达看回读 total 变大」，一边写「不要用 total」——
 *  两轮两个人先后加的，拼在一起成了两句互相否定的判据。读者按第一句做，把 total 因对方回复
 *  而变大读成「我的消息到了」，于是重发。同一段正文在一个会话里出现 3 次就是这么来的。
 *
 *  钉标识符不钉自然语言短语：合法对比（判据是 A，不是 B）里两个标识符各占一头，同一个不会
 *  两头都占；而这次撞车的是 total 一个词被赋了两个互斥角色。
 *  含「改前 / 上一版 / 旧版 / 日期」的句子跳过：那里写的正是「以前用 X，现在不用」，是记录不是矛盾。
 *  第一版把「历史」「之前」也放进白名单，于是「数 user 条数，不要用 total，进没进历史」这行
 *  被整行跳过，判据当场失效。白名单只认真正的历史标记。
 *
 *  本机另有一条同语义判据：~/.pi/agent/bin/check-contradiction.mjs（gate 的 check:contradiction 步），
 *  管 canon 文章与七篇技能副本。两条口径相同、作用域不同：那一条跟着本机闸门跑，这一条跟着 CI 跑。
 *  改规则时两处一起改——只改一处，同一份正文会在两个入口得到不同结论。 */
function conflictingRoles(lines) {
	const AFFIRM = /(是判据|作为判据|当判据|送达看|看回读|以此判|按它判)/;
	const NEGATE = /(不是判据|不要用|别用|别拿|不算判据|不能当判据|排除)/;
	// 只认真正的历史标记。「历史」「之前」这类词在正常句子里太常见——第一版写了它们，
	// 于是「数 user 条数，不要用 total，进没进历史」这行因为含「历史」被跳过，判据当场失效。
	const TIME = /(改前|上一版|旧版|20[0-9][0-9]-[0-9][0-9]-[0-9][0-9])/;
	const out = [];
	let section = -1;
	let fence = false;
	const buckets = new Map();
	lines.forEach((line, i) => {
		if (isFence(line)) {
			fence = !fence;
			return;
		}
		if (fence) return;
		if (/^#{1,6} /.test(line)) {
			section = i;
			return;
		}
		if (section < 0) return;
		const ids = line.match(INLINE_CODE);
		if (!ids || TIME.test(line)) return;
		const neg = NEGATE.test(line);
		const aff = !neg && AFFIRM.test(line);
		if (!neg && !aff) return;
		let m = buckets.get(section);
		if (!m) {
			m = new Map();
			buckets.set(section, m);
		}
		for (const raw of ids) {
			const id = raw.slice(1, -1);
			if (!id || /\s/.test(id)) continue;
			const cur = m.get(id) || {};
			if (aff && !cur.aff) cur.aff = i + 1;
			if (neg && !cur.neg) cur.neg = i + 1;
			m.set(id, cur);
		}
	});
	for (const m of buckets.values()) {
		for (const [id, cur] of m) {
			if (cur.aff && cur.neg) {
				out.push({ line: cur.neg, msg: "同一节里 " + TICK + id + TICK + " 既是判据（第 " + cur.aff + " 行）又被排除（第 " + cur.neg + " 行）：两句互相否定，读者按哪句都可能是错的", sample: "" });
			}
		}
	}
	return out;
}

/** 节号引用必须落地：正文写「第 7 节」「见 5.6」时，同文件必须真有那个标题。
 *  2026-11-17 实测：全文压缩时把 ## 5.6 与 ## 7 两个标题当空行一起删了，
 *  正文四处引用（第 7 节 x2、见 5.6、见 7.1、见 9.1）全部落空，
 *  而四个 check（doc / paths / format / fields）全是绿的——它们没有一条判导航。
 *  标题是导航，不是叙述：压行数时它最先被误删，所以要有一条判据专门看着它。 */
function danglingRefs(lines, sections = null) {
	const out = [];
	const heads = new Set();
	for (const line of lines) {
		const m = /^##+\s+([0-9]+(?:\.[0-9]+)?)/.exec(line);
		if (m) heads.add(m[1]);
	}
	const known = sections ?? heads;
	const seen = new Set();
	lines.forEach((line, i) => {
		if (isFence(line)) return;
		const text = line.replace(INLINE_CODE, "");
		for (const m of text.matchAll(/第\s*([0-9]+(?:\.[0-9]+)?)\s*节/g)) seen.add([m[1], i + 1]);
		for (const m of text.matchAll(/见\s*([0-9]+(?:\.[0-9]+)?)(?![0-9])/g)) seen.add([m[1], i + 1]);
	});
	for (const [num, line] of seen) {
		if (!known.has(num)) out.push({ line, msg: "引用第 " + num + " 节，但" + (sections ? "整套文档" : "同文件") + "没有这个标题", sample: "" });
	}
	return out;
}

/** 标题层级必须与编号深度一致：同一个文件里，编号 N.x 的标题要比编号 N 的标题深一级。
 *  2026-11-18 实测：`connect.md` 的 `## 0.4` 与 `message.md` 的 `## 5.5` 都写在 `## 0` / `## 5` 下面，
 *  却用了同级标题——读者会以为 5.5 是与 5 平级的新章节。
 *  本文件没有父节时不判：`collaboration.md` 装着 §5.6 与 §9.1–§9.4，父节在别的文件里，
 *  那种情况下 H2 是对的，改成 H3 才会变成无父的孤儿标题。 */
function headingLevelMismatch(lines) {
	const out = [];
	const heads = [];
	lines.forEach((line, i) => {
		if (isFence(line)) return;
		const m = /^(#{2,4})\s+([0-9]+(?:\.[0-9]+)*)/.exec(line);
		if (m) heads.push({ line: i + 1, lvl: m[1].length, num: m[2] });
	});
	for (const h of heads) {
		const parts = h.num.split(".");
		if (parts.length < 2) continue;
		const parent = heads.find((x) => x.num === parts.slice(0, -1).join("."));
		if (!parent) continue;
		if (h.lvl !== parent.lvl + 1) out.push({ line: h.line, msg: "编号 " + h.num + " 是 " + parent.num + " 的子节，标题用了 H" + h.lvl + "，应为 H" + (parent.lvl + 1), sample: "" });
	}
	return out;
}

/** 全部结构判据作用在一份 lines 上，返回问题列表。
 *  抽成纯函数只为一个目的：--selftest 能在内存里喂坏样本，证明每条判据都会红，
 *  而不是只证明脚本能跑完。 */
function scan(lines, sections = null) {
	const out = [];
	let inFence = false;
	let tableCols = 0;
	lines.forEach((line, i) => {
		if (isFence(line)) {
			inFence = !inFence;
			tableCols = 0;
			return;
		}
		if (/^\s*\|/.test(line)) {
			const n = line.split("|").length - 2;
			if (tableCols === 0) tableCols = n;
			else if (n !== tableCols) out.push({ line: i + 1, msg: "表格 " + n + " 列，表头 " + tableCols + " 列", sample: line });
			return;
		}
		tableCols = 0;
		if (inFence && new RegExp(TICK + "[$]").test(line)) {
			out.push({ line: i + 1, msg: "代码块里 $ 变量被反引号包住，bash 会当命令执行", sample: line });
			return;
		}
		if (inFence) return;
		const visible = line.replace(INLINE_CODE, "");
		if ((visible.match(/\*\*/g) || []).length % 2 === 1) out.push({ line: i + 1, msg: "加粗没闭合", sample: line });
	});
	for (const n of headingWithoutBlank(lines)) out.push({ line: n, msg: "标题前缺空行", sample: "" });
	const fences = lines.filter(isFence).length;
	if (fences % 2) out.push({ line: 0, msg: "代码块围栏一共 " + fences + " 个，没配对", sample: "" });
	out.push(...conflictingRoles(lines));
	out.push(...danglingRefs(lines, sections));
	out.push(...headingLevelMismatch(lines));
	return out;
}

/** 结构量：行数太少（拿错文件、空文件）时上面的判据会全绿，这是「恒真绿」的形状。 */
function structure(lines) {
	const tableRows = lines.filter((x) => /^\s*\|/.test(x)).length;
	const fences = lines.filter(isFence).length;
	const boldPairs = lines.reduce((n, x) => n + (x.replace(INLINE_CODE, "").match(/\*\*/g) || []).length, 0) / 2;
	return { fences, tableRows, boldPairs, total: fences + tableRows + boldPairs };
}

// 自检：每条判据都喂一份坏样本，再喂一份干净样本、一份空文件。
// 2026-11-16：此前只有「标题前缺空行」有坏样本，另外四条（表格列数、加粗未闭合、
// 代码块配对、$ 反引号）从来没被证明会红——把判定删掉，脚本照样 PASS。
function selftest() {
	const F = FENCE;
	const cases = [
		["表格列数与表头不符", ["| a | b |", "| --- | --- |", "| 1 | 2 | 3 |"], "表格", 1],
		["加粗没闭合", ["正文 **没闭合", "下一行"], "加粗", 1],
		["代码块没配对", [F + "bash", "echo hi"], "没配对", 1],
		["代码块里 $ 变量被反引号包住", [F + "bash", "PORT=" + TICK + "$BASE" + TICK, F], "命令执行", 1],
		["标题前缺空行", ["正文", "## 标题"], "空行", 1],
		["代码块里的 # 行不算标题", ["正文", F + "bash", "# 注释", F, "", "## 标题"], "空行", 0],
		["代码块里的 # 前有空格也不算标题", ["正文", F, "  # 缩进注释", F, "", "## 标题"], "空行", 0],
		["同一节里同一个标识符既是判据又被排除", ["## 1 发送", "", "送达看回读 " + TICK + "total" + TICK + " 变大。", "要看某条进没进历史，数 user 条数，不要用 " + TICK + "total" + TICK + "。"], "两句互相否定", 1],
		["合法对比不是矛盾：判据是 A 不是 B", ["## 1 发送", "", "送达判据是 " + TICK + "code" + TICK + "，不是 " + TICK + "total" + TICK + "。"], "两句互相否定", 0],
		["跨小节的同类表述不算矛盾", ["## 1 发送", "", "送达看 " + TICK + "total" + TICK + "。", "", "## 2 边界", "", "不要用 " + TICK + "total" + TICK + " 判断别的事。"], "两句互相否定", 0],
		["节号引用落空：标题被删掉，正文还指着它", ["## 1 甲", "", "见第 2 节。", "", "## 2 乙", "", "见第 3 节。"], "引用第", 1],
		["节号引用落地：标题都在", ["## 1 甲", "", "见第 2 节。", "", "## 2 乙", "", "第 2 节讲过了。"], "引用第", 0],
		["子节用了与父节同级的标题", ["## 5 发消息", "", "## 5.5 等对方干完"], "是 5 的子节", 1],
		["子节层级正确", ["## 5 发消息", "", "### 5.5 等对方干完"], "是 5 的子节", 0],
		["本文件没有父节时不判层级（collaboration.md 的形状）", ["## 9.1 每句话带来源", "", "## 9.2 说人话"], "是 9 的子节", 0],
		["带日期的历史记录不算矛盾", ["## 1 发送", "", "20xx 年改前送达看 " + TICK + "total" + TICK + "。", "不要用 " + TICK + "total" + TICK + "。"], "两句互相否定", 0],
	];
	let bad = 0;
	for (const [name, lines, want, expect] of cases) {
		const hits = scan(lines).filter((x) => x.msg.includes(want));
		if (hits.length !== expect) {
			bad++;
			console.log("FAIL 自检「" + name + "」：" + hits.length + " 处，预期 " + expect);
		}
	}
	const clean = ["# 标题", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", F + "bash", "echo hi", F, "", "**加粗**成对。"];
	const noisy = scan(clean);
	if (noisy.length) {
		bad++;
		console.log("FAIL 自检正样本被误判：" + JSON.stringify(noisy));
	}
	if (structure([]).total >= MIN_STRUCTURE) {
		bad++;
		console.log("FAIL 自检：空文件的结构量没被判成不足");
	}
	const small = ["## 1 边界", "", "**只读** 会话文件，**不要**改 jsonl。", "**停之前** 先问用户，**没有第二个窗口**就别停。"];
	if (structure(small).total < MIN_STRUCTURE) {
		bad++;
		console.log("FAIL 自检：拆出来的短文档被误判成没结构");
	}
	console.log(bad ? "selftest FAIL：" + bad + " 条" : "selftest PASS：" + (cases.length + 3) + " 条");
	process.exit(bad ? 1 : 0);
}

if (process.argv.includes("--selftest")) selftest();

const P = process.argv.slice(2).find((a) => !a.startsWith("--")) || path.resolve(here, "../../..", "resources/skills/pideck/SKILL.md");
if (!fs.existsSync(P)) {
	console.log("FAIL 找不到 " + P + "（参数是待检查的 markdown 路径；不传就查 resources/skills/pideck/SKILL.md；--selftest 只验判据自己）");
	process.exit(2);
}
const sectionsArg = process.argv.find((a) => a.startsWith("--sections="));
const SECTIONS = sectionsArg
	? new Set(
			sectionsArg
				.slice("--sections=".length)
				.split(",")
				.map((x) => x.trim())
				.filter(Boolean),
		)
	: null;
const lines = fs.readFileSync(P, "utf8").split(/\r?\n/);

const problems = scan(lines, SECTIONS);
for (const p of problems) console.log("  行 " + p.line + " " + p.msg + (p.sample ? ": " + p.sample.slice(0, 60) : ""));

// 空对空不算通过：零字节或只剩一句话的文件里没有可查的结构，上面几条会全绿。
// 2026-11-15 实测：printf '' > x.md 与只写两行的文件都 PASS——这正是「判据恒真绿」的形状。
const st = structure(lines);
if (st.total < MIN_STRUCTURE) {
	console.log("FAIL 这个文件里只有 " + st.fences + " 个围栏、" + st.tableRows + " 行表格、" + st.boldPairs + " 对加粗，没有可查的结构（拿错文件了？）");
	process.exit(1);
}
if (!problems.length) console.log("check-format: " + path.basename(P) + " 围栏 " + st.fences + " / 表格行 " + st.tableRows + " / 加粗对 " + st.boldPairs + "，问题 0 条");
process.exit(problems.length ? 1 : 0);
