// 判据：SKILL.md 的 Markdown 结构。六条断言，逐条可红。
// 为什么要有：加粗漏一个会把后面整段吃掉，表格少一列会错位，
// 这两种在 PR review 里被指出过（PR 552 的 review 意见）。
// 行内代码里的星号不算加粗：先剥掉反引号包住的内容再数，否则教人「漏一个 **」的正文会被误判。
// 会红的六种：某行加粗没闭合、代码块没配对、表格某行列数与表头不符、标题前缺空行、文件读不到，
//   以及代码块里把 $ 变量写成反引号包裹（bash 会当命令替换执行，读者抄了就拿到 command not found）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const P = process.argv[2] || path.join(here, "SKILL.md");
if (!fs.existsSync(P)) { console.log("FAIL 找不到 " + P); process.exit(1); }
const lines = fs.readFileSync(P, "utf8").split(/\r?\n/);
const TICK = String.fromCharCode(96);
const INLINE_CODE = new RegExp(TICK + "[^" + TICK + "]*" + TICK, "g");

/** 标题前必须有空行，否则 markdown 会把标题并进上一段。
 *  代码块内的行先剥掉：2026-11-15 实测，第一版没剥，把 bash 块里的「# 取端口和令牌」
 *  当成标题误报，于是真正缺空行的两处反而没被查。 */
function headingWithoutBlank(lines) {
  const out = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    if (!/^#{1,6} /.test(lines[i])) continue;
    if (i > 0 && lines[i - 1].trim() !== "") out.push(i + 1);
  }
  return out;
}
// 自检：一条坏样本、一条正样本、一条代码块里的 # 行，三个都要对，否则判据自己坏了。
if (headingWithoutBlank(["正文", "## 标题"]).length !== 1) { console.log("FAIL 自检坏样本：标题前缺空行没被判出来"); process.exit(1); }
if (headingWithoutBlank(["正文", "", "## 标题"]).length !== 0) { console.log("FAIL 自检正样本：标题前有空行被误判"); process.exit(1); }
if (headingWithoutBlank(["```", "# 注释行", "```", "正文"]).length !== 0) { console.log("FAIL 自检：代码块内的 # 行被当成标题"); process.exit(1); }

let bad = 0;
let inFence = false;
let tableCols = 0;
lines.forEach((line, i) => {
  if (/^\s*```/.test(line)) { inFence = !inFence; tableCols = 0; return; }
  if (/^\s*\|/.test(line)) {
    const n = line.split("|").length - 2;
    if (tableCols === 0) tableCols = n;
    else if (n !== tableCols) { console.log("  行 " + (i + 1) + " 表格 " + n + " 列，表头 " + tableCols + " 列"); bad++; }
    return;
  }
  tableCols = 0;
  if (inFence && /`[$]/.test(line)) { console.log("  行 " + (i + 1) + " 代码块里 $ 变量被反引号包住，bash 会当命令执行: " + line.slice(0, 60)); bad++; return; }
  if (inFence) return;
  const visible = line.replace(INLINE_CODE, "");
  if ((visible.match(/\*\*/g) || []).length % 2 === 1) { console.log("  行 " + (i + 1) + " 加粗没闭合: " + line.slice(0, 60)); bad++; }
});

for (const n of headingWithoutBlank(lines)) { console.log("  行 " + n + " 标题前缺空行"); bad++; }

const fences = lines.filter((x) => /^\s*```/.test(x)).length;
if (fences % 2) { console.log("  代码块 ``` 一共 " + fences + " 个，没配对"); bad++; }

// 空对空不算通过：零字节或只剩一句话的文件里没有可查的结构，上面三条会全绿。
// 2026-11-15 实测：printf '' > x.md 与只写两行的文件都 PASS——这正是「判据恒真绿」的形状。
const tableRows = lines.filter((x) => /^\s*\|/.test(x)).length;
const boldPairs = lines.reduce((n, x) => n + (x.replace(INLINE_CODE, "").match(/\*\*/g) || []).length, 0) / 2;
if (fences + tableRows + boldPairs < 8) {
  console.log("FAIL 这个文件里只有 " + fences + " 个围栏、" + tableRows + " 行表格、" + boldPairs + " 对加粗，没有可查的结构（拿错文件了？）");
  bad++;
}

console.log(bad ? "FAIL " + bad + " 处结构问题" : "PASS 加粗成对、代码块配对、表格列数一致、标题前有空行、代码块引号正常、文件可读");
process.exit(bad ? 1 : 0);