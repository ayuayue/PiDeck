// 判据：SKILL.md 第 7 节的动作表与端点表，逐条对得上源码 WebApiRoutes.ts。
// 用法：node check-doc.mjs [SKILL.md]  —— 不给参数就校验同目录那份。
// 为什么要有它：这两张表是照着源码抄的，抄漏抄多都没人看得见。
// 会红的五种：文档漏动作、文档多动作、7.1/7.2 表整段被删（空集一律判红）、
//   7.2 的某条端点在源码里没有完整路由（不是只查前缀）、7.2 的方法列与源码不一致。
// 口径上限：源码里路由若由模板串拼接构造，切不出整条时会漏，routes.size 的下限守卫让它报红而不是静默变绿。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = process.argv[2] || path.join(here, "SKILL.md");
const SRC = path.resolve(here, "../../../src/main/web/WebApiRoutes.ts");
const EXTRA = path.resolve(here, "../../../src/main/web/WebServiceManager.ts");
if (!fs.existsSync(SRC)) { console.log("FAIL 找不到源码 " + SRC); process.exit(1); }
const skill = fs.readFileSync(SKILL, "utf8");
const BS = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);
const TICK = String.fromCharCode(96);
const src = [SRC, EXTRA].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8").split(BS + "/").join("/"));

const m = src[0].match(/runtime\/\(([a-z|-]+)/);
if (!m) { console.log("FAIL 源码里找不到 runtime 路由"); process.exit(1); }
const srcActions = m[1].split("|");
if (srcActions.length < 10) { console.log("FAIL 源码动作数只有 " + srcActions.length); process.exit(1); }

const sec71 = skill.split("### 7.1")[1];
if (!sec71) { console.log("FAIL 文档里没有 7.1 节"); process.exit(1); }
const docActions = [...sec71.matchAll(/^\| \x60([a-z-]+)\x60/gm)].map((x) => x[1]);
if (!docActions.length) { console.log("FAIL 7.1 表格一行都没匹配到"); process.exit(1); }

const missing = srcActions.filter((a) => !docActions.includes(a));
const extra = docActions.filter((a) => !srcActions.includes(a));
console.log("源码 " + srcActions.length + " 个，文档 " + docActions.length + " 行");
console.log("漏: " + (missing.join(",") || "无") + "  多: " + (extra.join(",") || "无"));
const okA = !missing.length && !extra.length && srcActions.length === docActions.length;

// 源码里的完整路由集合：组合式 (update|delete|copy) 展开成多条，参数段 ([^/]+) 归一成 :id。
// 只查前缀会让 /api/sessions/<id>（源码里没有这条路由）判绿——2026-11-14 实测的漏。
const routes = new Set();
const routeRe = new RegExp(BS + "/api" + BS + "/[^" + QUOTE + TICK + " ,;]*", "g");
for (const m2 of src.join("\n").matchAll(routeRe)) {
  const route = m2[0].split("$").join("").split("([^/]+)").join(":id");
  let acc = [""];
  for (const raw of route.split("/").filter(Boolean)) {
    const seg = raw.replace(/^\(/, "").replace(/\)$/, "");
    if (!seg) continue;
    const alts = seg.includes("|") ? seg.split("|").map((s) => s.replace(/^\(|\)$/g, "")) : [seg];
    const next = [];
    for (const a of acc) for (const alt of alts) next.push(a + "/" + alt);
    acc = next;
  }
  for (const r of acc) routes.add(r);
}
if (routes.size < 20) { console.log("FAIL 源码里只切出 " + routes.size + " 条完整路由，判据自己坏了"); process.exit(1); }
const docNorm = (p) => p.replace(/\/$/, "").replace(/<[^>]+>/g, ":id");
for (const [p, want] of [["/api/sessions/<id>/delete", true], ["/api/sessions/<id>", false], ["/api/sessions/<id>/deleteXXX", false]]) {
  if (routes.has(docNorm(p)) !== want) { console.log("FAIL 自检坏样本 " + p + "：完整路由存在性判定与预期不符"); process.exit(1); }
}

const sec72 = skill.split("### 7.2")[1];
if (!sec72) { console.log("FAIL 文档里没有 7.2 节"); process.exit(1); }
const srcLines = src[0].split(/\r?\n/);
/** 源码里这条端点用的是哪个 HTTP 方法：先按整条路径找，再按末段找（组合式路由）。 */
function methodsInSource(ep) {
  // 同一条端点可能注册两种方法：export-html 既是记录层动作组的 POST，也是单独的 GET。
  // 只取第一个匹配会把合法的文档判红（2026-11-14 实测到的假阳性）。
  const tail = ep.split("/").filter(Boolean).pop();
  const out = [];
  let i = srcLines.findIndex((x) => x.includes("/api/sessions") && x.includes(tail));
  while (i >= 0) {
    for (let k = i; k < Math.min(i + 4, srcLines.length); k++) {
      const mm = srcLines[k].match(/request\.method === "(GET|POST)"/);
      if (mm) { if (!out.includes(mm[1])) out.push(mm[1]); break; }
    }
    i = srcLines.findIndex((x, idx) => idx > i && x.includes("/api/sessions") && x.includes(tail));
  }
  return out;
}

let bad = 0;
let checked = 0;
for (const line of sec72.split(/\r?\n/)) {
  const mt = line.match(/^\| \x60(\/api[^\x60]*)\x60 \| (GET|POST) \|/);
  if (!mt) continue;
  const ep = mt[1];
  const docMethod = mt[2];
  checked++;
  if (!routes.has(docNorm(ep))) { console.log("  源码里没有完整路由 " + ep); bad++; continue; }
  const real = methodsInSource(ep);
  if (real.length && !real.includes(docMethod)) { console.log("  " + ep + " 文档写 " + docMethod + "，源码是 " + real.join("/")); bad++; }
}
if (!checked) { console.log("FAIL 7.2 端点一行都没匹配到"); process.exit(1); }

console.log("7.2 端点 " + checked + " 条（路径 + 方法都比对），" + (bad ? bad + " 处与源码不符" : "全部对得上"));
console.log(okA && !bad ? "PASS" : "FAIL");
process.exit(okA && !bad ? 0 : 1);