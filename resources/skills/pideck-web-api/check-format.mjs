// 判据：SKILL.md 的 Markdown 结构。三件事各一条断言。
// 为什么要有：加粗漏一个会把后面整段吃掉，表格少一列会错位，
// 这两种在 PR review 里被指出过（PR 552 的 review 意见）。
// 行内代码里的星号不算加粗：先剥掉反引号包住的内容再数，否则教人「漏一个 **」的正文会被误判。
// 会红的四种：某行加粗没闭合、代码块没配对、表格某行列数与表头不符、文件读不到。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const P = process.argv[2] || path.join(here, "SKILL.md");
if (!fs.existsSync(P)) { console.log("FAIL 找不到 " + P); process.exit(1); }
const lines = fs.readFileSync(P, "utf8").split(/\r?\n/);
const TICK = String.fromCharCode(96);
const INLINE_CODE = new RegExp(TICK + "[^" + TICK + "]*" + TICK, "g");

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
  if (inFence) return;
  const visible = line.replace(INLINE_CODE, "");
  if ((visible.match(/\*\*/g) || []).length % 2 === 1) { console.log("  行 " + (i + 1) + " 加粗没闭合: " + line.slice(0, 60)); bad++; }
});

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

console.log(bad ? "FAIL " + bad + " 处结构问题" : "PASS 加粗成对、代码块配对、表格列数一致");
process.exit(bad ? 1 : 0);