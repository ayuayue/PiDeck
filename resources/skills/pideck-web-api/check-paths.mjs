// 判据：SKILL.md 里出现的每个 /api/... 路径，其每一段都要在源码的路由里出现过。
// 为什么要有：文档里一个错端点，读者 curl 一次拿到 apiNotFound，就以为服务坏了。
// 口径（有界）：按「段」比对，不按整条路由比对。源码把多条路由写成组合式
//   （/api/sessions/([^/]+)/(update|delete|copy|export-html)），整条比对会误判「不存在」。
//   本脚本抓「段写错、拼错」，抓不到「段都对但顺序错」。整条路由的精确比对由
//   check-doc.mjs 负责，两份一起跑才算全。
//
// 用法：
//   node check-paths.mjs            校验同目录的 SKILL.md
//   node check-paths.mjs <文件>
//   node check-paths.mjs --selftest 只验判据自己，不读源码、不读文档（装了 PiDeck 的机器上也能跑）
//
// 为什么单独有 --selftest：真检查要读源码路由，只有源码克隆里才有。装了 PiDeck 的机器上
// 只有技能副本，那里「判据自己还对不对」没法验证——判据坏了和判据不存在，后果相同。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BS = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);
const TICK = String.fromCharCode(96);

/** 一条文档路径里，哪些段在源码段集合里找不到。占位符段（<id> / $VAR）跳过。
 *  集合从参数进来，不从闭包拿：自检要用假集合，读源码的路径只走一次。 */
function missingSegs(p, segs) {
  const out = [];
  for (const s of p.replace(/\/$/, "").split("/").filter(Boolean).slice(1)) {
    if (/^<|^\$|^:/.test(s)) continue;
    if (!segs.has(s)) out.push(s);
  }
  return out;
}

/** 源码里有几种路由写法，组合式的段要拆开进集合，否则 (update|delete) 整条会被当成一段。
 *  抽成函数是为了自检能喂一段组合式源码，证明拆段真的发生。 */
function segsFromSource(src) {
  const segs = new Set();
  const routeRe = new RegExp(BS + "/api" + BS + "/[^" + QUOTE + TICK + " ,;]*", "g");
  for (const m of src.matchAll(routeRe)) {
    const route = m[0]
      .replace(/\$/, "")
      .replace(/\^/g, "")
      .replace(/\(\[\^\/\]\+\)/g, ":id"); // 这一段的斜杠不参与分段
    // :id 是占位符，不进字面量集合：它对应文档里的 <id>，而 <id> 在 missingSegs 里已经跳过。
    for (const raw of route.split("/").filter(Boolean)) {
      const seg = raw.replace(/^\(/, "").replace(/\)$/, "");
      if (seg === ":id" || seg === "$") continue;
      if (seg.includes("|")) for (const alt of seg.split("|")) segs.add(alt.replace(/^\(|\)$/g, ""));
      else segs.add(seg);
    }
  }
  return segs;
}

/** 本机绝对路径不能写进技能：技能发给别人用，别人的机器上没有这个目录。
 *  三种写法都要认——C:\Users、C:/Users、/c/Users。只认第一种时，
 *  用 Git Bash 写法贴进去的路径会静默通过（读者复制到自己的 shell 里就是错的）。 */
function foreignPaths(text) {
  const out = [];
  for (const re of [/[A-Za-z]:[\\/]Users/g, /[\\/]c[\\/]Users/g]) {
    for (const m of text.matchAll(re)) out.push(m[0]);
  }
  return out;
}

function selftest() {
  const S = new Set(["sessions", "runtimes", "state", "messages", "update", "delete"]);
  const cases = [
    ["不存在的段", "/api/sessions/notexistsegment", 1],
    ["存在的段", "/api/sessions/runtimes", 0],
    ["占位符段跳过", "/api/sessions/<id>/messages", 0],
    ["$ 变量段跳过", "/api/sessions/$SID/messages", 0],
    [": 占位符段跳过但它后面的段照样查", "/api/sessions/:id/nosuch", 1],
    [": 占位符段 + 正确段", "/api/sessions/:id/messages", 0],
    ["组合式路由的每个分支都在集合里", "/api/sessions/update", 0],
    ["组合式路由的另一个分支也在集合里", "/api/sessions/delete", 0],
  ];
  let bad = 0;
  for (const [name, p, expect] of cases) {
    const n = missingSegs(p, S).length;
    if (n !== expect) { bad++; console.log("FAIL 自检「" + name + "」：" + n + " 段对不上，预期 " + expect + "（" + p + "）"); }
  }
  // 拆段：一段组合式源码要拆出两个分支，漏拆等于所有组合式端点都判「不存在」。
  const segs = segsFromSource('"/api/sessions/([^/]+)/(update|delete)"');
  for (const want of ["update", "delete"]) {
    if (!segs.has(want)) { bad++; console.log("FAIL 自检：组合式路由没拆出「" + want + "」"); }
  }
  if (segs.has(":id")) { bad++; console.log("FAIL 自检：占位符 :id 进了字面量集合，会把文档里的 <id> 判成错段"); }
  // 本机路径的三种写法，以及一条不该校验的对照（~/ 是允许的，它相对 home）。
  const foreignCase = "C:" + BS + "Users" + BS + "a" + BS + "x 与 C:/Users/a/x 与 /c/Users/a/x 与 ~/.agents/skills";
  if (foreignPaths(foreignCase).length !== 3) { bad++; console.log("FAIL 自检：本机路径认了 " + foreignPaths(foreignCase).length + " 处，预期 3"); }
  if (foreignPaths("~/.agents/skills/x").length !== 0) { bad++; console.log("FAIL 自检：~/ 相对路径被误判成本机路径"); }
  console.log(bad ? "selftest FAIL：" + bad + " 条" : "selftest PASS：" + (cases.length + 5) + " 条");
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes("--selftest")) selftest();

const SKILL = process.argv[2] || path.join(here, "SKILL.md");
const SRC = path.resolve(here, "../../../src/main/web/WebApiRoutes.ts");
const srcFiles = [SRC, path.resolve(here, "../../../src/main/web/WebServiceManager.ts")].filter((f) => fs.existsSync(f));
if (!srcFiles.length) { console.log("FAIL 找不到源码（找过 " + SRC + "）。判据自己还对不对，用 --selftest 验"); process.exit(2); }
const src = srcFiles.map((p) => fs.readFileSync(p, "utf8")).join(String.fromCharCode(10)).split(BS + "/").join("/");

const srcSegs = segsFromSource(src);
if (srcSegs.size < 20) { console.log("FAIL 源码里只切出 " + srcSegs.size + " 个段，判据自己坏了"); process.exit(1); }

const skill = fs.readFileSync(SKILL, "utf8");
const found = [...skill.matchAll(/\/api\/[A-Za-z0-9_\/<>.:$\u4e00-\u9fa5-]*/g)].map((m) => m[0].replace(/[.,;:)]+$/, ""));
const uniq = [...new Set(found)].sort();
if (uniq.length < 10) { console.log("FAIL 只抽到 " + uniq.length + " 条路径"); process.exit(1); }

for (const c of ["sessions", "runtimes", "state"]) {
  if (!srcSegs.has(c)) { console.log("FAIL 控制组段 " + c + " 在源码段集合里不存在"); process.exit(1); }
}

let bad = 0;
for (const p of uniq) {
  for (const s of missingSegs(p, srcSegs)) { console.log("  " + p + " 里的段「" + s + "」源码里没有"); bad++; }
}
for (const f of foreignPaths(skill)) { console.log("  文档里写了本机路径: " + f); bad++; }

console.log("文档里 " + uniq.length + " 条 /api 路径，" + (bad ? bad + " 处段对不上" : "每一段都在源码里"));
console.log(bad ? "FAIL" : "PASS");
process.exit(bad ? 1 : 0);
