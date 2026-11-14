// 判据：SKILL.md 里出现的每个 /api/... 路径，其每一段都要在源码的路由里出现过。
// 为什么要有：文档里一个错端点，读者 curl 一次拿到 apiNotFound，就以为服务坏了。
// 口径（有界）：按「段」比对，不按整条路由比对。源码把多条路由写成组合式
//   （/api/sessions/([^/]+)/(update|delete|copy|export-html)），整条比对会误判「不存在」。
//   本脚本抓「段写错、拼错」，抓不到「段都对但顺序错」。整条路由的精确比对由
//   check-doc.mjs 负责，两份一起跑才算全。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = process.argv[2] || path.join(here, "SKILL.md");
const root = path.resolve(here, "../../..");
const srcFiles = ["src/main/web/WebApiRoutes.ts", "src/main/web/WebServiceManager.ts"]
  .map((p) => path.join(root, p))
  .filter((p) => fs.existsSync(p));
if (!srcFiles.length) { console.log("FAIL 找不到源码"); process.exit(1); }
const BS = String.fromCharCode(92);
const src = srcFiles.map((p) => fs.readFileSync(p, "utf8")).join("\n").split(BS + "/").join("/");

const srcSegs = new Set();
const QUOTE = String.fromCharCode(34);
const TICK = String.fromCharCode(96);
const routeRe = new RegExp(BS + "/api" + BS + "/[^" + QUOTE + TICK + " ,;]*", "g");
for (const m of src.matchAll(routeRe)) {
  const route = m[0]
    .replace(/\$/, "")
    .replace(/\^/g, "")
    .replace(/\(\[\^\/\]\+\)/g, ":id"); // 这一段的斜杠不参与分段
  for (const raw of route.split("/").filter(Boolean)) {
    const seg = raw.replace(/^\(/, "").replace(/\)$/, "");
    if (seg.includes("|")) for (const alt of seg.split("|")) srcSegs.add(alt.replace(/^\(|\)$/g, ""));
    else srcSegs.add(seg);
  }
}
if (srcSegs.size < 20) { console.log("FAIL 源码里只切出 " + srcSegs.size + " 个段，判据自己坏了"); process.exit(1); }

const skill = fs.readFileSync(SKILL, "utf8");
const found = [...skill.matchAll(/\/api\/[A-Za-z0-9_\/<>.$\u4e00-\u9fa5-]*/g)].map((m) => m[0].replace(/[.,;:)]+$/, ""));
const uniq = [...new Set(found)].sort();
if (uniq.length < 10) { console.log("FAIL 只抽到 " + uniq.length + " 条路径"); process.exit(1); }

for (const c of ["sessions", "runtimes", "state"]) {
  if (!srcSegs.has(c)) { console.log("FAIL 控制组段 " + c + " 在源码段集合里不存在"); process.exit(1); }
}

let bad = 0;
for (const p of uniq) {
  const segs = p.replace(/\/$/, "").split("/").filter(Boolean).slice(1);
  for (const s of segs) {
    if (/^<|^\$/.test(s)) continue;
    if (!srcSegs.has(s)) { console.log("  " + p + " 里的段「" + s + "」源码里没有"); bad++; }
  }
}
console.log("文档里 " + uniq.length + " 条 /api 路径，" + (bad ? bad + " 处段对不上" : "每一段都在源码里"));
console.log(bad ? "FAIL" : "PASS");
process.exit(bad ? 1 : 0);