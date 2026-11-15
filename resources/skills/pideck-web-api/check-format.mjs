// 判据：SKILL.md 的 Markdown 结构。六条断言，逐条可红。
// 为什么要有：加粗漏一个会把后面整段吃掉，表格少一列会错位，
// 这两种在 PR review 里被指出过（PR 552 的 review 意见）。
// 行内代码里的星号不算加粗：先剥掉反引号包住的内容再数，否则教人「漏一个星号」的正文会被误判。
// 会红的六种：某行加粗没闭合、代码块没配对、表格某行列数与表头不符、标题前缺空行、文件读不到，
//   以及代码块里把 $ 变量写成反引号包裹（bash 会当命令替换执行，读者抄了就拿到 command not found）。
//
// 用法：
//   node check-format.mjs               校验同目录的 SKILL.md
//   node check-format.mjs <文件>        校验指定文件
//   node check-format.mjs --selftest    只验判据自己，不读任何文件（装了 PiDeck 的机器上也能跑）
//
// 为什么单独有 --selftest：这条判据要读的 SKILL.md 只在源码克隆里，装了 PiDeck 的机器上
// 只有技能副本。没有这个开关，「判据自己还对不对」在那些机器上没法验证，
// 而看不出来的判据坏了和判据不存在是同一件事。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
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
    if (isFence(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    if (!/^#{1,6} /.test(lines[i])) continue;
    if (i > 0 && lines[i - 1].trim() !== "") out.push(i + 1);
  }
  return out;
}

/** 全部结构判据作用在一份 lines 上，返回问题列表。
 *  抽成纯函数只为一个目的：--selftest 能在内存里喂坏样本，证明每条判据都会红，
 *  而不是只证明脚本能跑完。 */
function scan(lines) {
  const out = [];
  let inFence = false;
  let tableCols = 0;
  lines.forEach((line, i) => {
    if (isFence(line)) { inFence = !inFence; tableCols = 0; return; }
    if (/^\s*\|/.test(line)) {
      const n = line.split("|").length - 2;
      if (tableCols === 0) tableCols = n;
      else if (n !== tableCols) out.push({ line: i + 1, msg: "表格 " + n + " 列，表头 " + tableCols + " 列", sample: line });
      return;
    }
    tableCols = 0;
    if (inFence && new RegExp(TICK + "[$]").test(line)) { out.push({ line: i + 1, msg: "代码块里 $ 变量被反引号包住，bash 会当命令执行", sample: line }); return; }
    if (inFence) return;
    const visible = line.replace(INLINE_CODE, "");
    if ((visible.match(/\*\*/g) || []).length % 2 === 1) out.push({ line: i + 1, msg: "加粗没闭合", sample: line });
  });
  for (const n of headingWithoutBlank(lines)) out.push({ line: n, msg: "标题前缺空行", sample: "" });
  const fences = lines.filter(isFence).length;
  if (fences % 2) out.push({ line: 0, msg: "代码块围栏一共 " + fences + " 个，没配对", sample: "" });
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
  ];
  let bad = 0;
  for (const [name, lines, want, expect] of cases) {
    const hits = scan(lines).filter((x) => x.msg.includes(want));
    if (hits.length !== expect) { bad++; console.log("FAIL 自检「" + name + "」：" + hits.length + " 处，预期 " + expect); }
  }
  const clean = ["# 标题", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", F + "bash", "echo hi", F, "", "**加粗**成对。"];
  const noisy = scan(clean);
  if (noisy.length) { bad++; console.log("FAIL 自检正样本被误判：" + JSON.stringify(noisy)); }
  if (structure([]).total >= 8) { bad++; console.log("FAIL 自检：空文件的结构量没被判成不足"); }
  console.log(bad ? "selftest FAIL：" + bad + " 条" : "selftest PASS：" + (cases.length + 2) + " 条");
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes("--selftest")) selftest();

const P = process.argv[2] || path.join(here, "SKILL.md");
if (!fs.existsSync(P)) { console.log("FAIL 找不到 " + P + "（参数是待检查的 markdown 路径；不传就查同目录 SKILL.md；--selftest 只验判据自己）"); process.exit(2); }
const lines = fs.readFileSync(P, "utf8").split(/\r?\n/);

const problems = scan(lines);
for (const p of problems) console.log("  行 " + p.line + " " + p.msg + (p.sample ? ": " + p.sample.slice(0, 60) : ""));

// 空对空不算通过：零字节或只剩一句话的文件里没有可查的结构，上面几条会全绿。
// 2026-11-15 实测：printf '' > x.md 与只写两行的文件都 PASS——这正是「判据恒真绿」的形状。
const st = structure(lines);
if (st.total < 8) {
  console.log("FAIL 这个文件里只有 " + st.fences + " 个围栏、" + st.tableRows + " 行表格、" + st.boldPairs + " 对加粗，没有可查的结构（拿错文件了？）");
  process.exit(1);
}
process.exit(problems.length ? 1 : 0);
