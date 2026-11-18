// 判据：SKILL.md 第 7 节的动作表与端点表，逐条对得上源码 WebApiRoutes.ts。
// 用法：node check-doc.mjs [SKILL.md]  —— 不给参数就校验同目录那份。
// 为什么要有它：这两张表是照着源码抄的，抄漏抄多都没人看得见。
// 会红的五种：文档漏动作、文档多动作、7.1/7.2 表整段被删（空集一律判红）、
//   7.2 的某条端点在源码里没有完整路由（不是只查前缀）、7.2 的方法列与源码不一致。
// 口径上限：源码里路由若由模板串拼接构造，切不出整条时会漏，routes.size 的下限守卫让它报红而不是静默变绿。
// 参数：--src=路径 指定源码根（src 或 src/main 都行），前后都要带等号：写成 `--src 路径`（空格分隔）
//   时路径会被当成 SKILL.md 位置参数，报出来的错是「找不到源码 .../src/main/...」，看不出是参数形式问题。
// 参数：--update-routes 重写路由台账 check-doc-routes.json（改了源码路由之后跑一次）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 必须先跑：变异 compareActions 时第一行就要红，不能让统计行先打印。
// 自检坏样本：7.1 的漏与多两个方向都必须非空。把 compareActions 改成恒空，这里立刻退出。
{
  const onlySrc = compareActions(["x", "y"], ["x"]);
  const onlyDoc = compareActions(["x"], ["x", "z"]);
  if (onlySrc.missing.length !== 1 || onlySrc.missing[0] !== "y") { console.log("FAIL 自检坏样本：源码里多一个动作没被判出来"); process.exit(1); }
  if (onlyDoc.extra.length !== 1 || onlyDoc.extra[0] !== "z") { console.log("FAIL 自检坏样本：文档里多一个动作没被判出来"); process.exit(1); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
// 收到 --selftest 必须报错退出：这条判据没有自检，静默照常跑会让读者以为「自检跑过了」。
// 2026-11-16 实测：改之前 node check-doc.mjs --selftest 返回 0 且打印正常判据结果。
if (process.argv.includes("--selftest")) {
  console.log("FAIL check-doc 没有自检：它每条判据都要真的路由表，用 --src= 指过去。带 --selftest 的只有 check-paths / check-format / check-fields");
  process.exit(2);
}
const srcArg = process.argv.find((a) => a.startsWith("--src="));
const pick = (base) => fs.existsSync(path.join(base, "web/WebApiRoutes.ts")) ? base : (fs.existsSync(path.join(base, "main/web/WebApiRoutes.ts")) ? path.join(base, "main") : base);
const SRC_BASE = pick(srcArg ? path.resolve(srcArg.slice(6)) : path.resolve(here, "../../../src/main"));
const SKILL = process.argv.slice(2).find((a) => !a.startsWith("--")) || path.join(here, "SKILL.md");
const SRC = path.join(SRC_BASE, "web/WebApiRoutes.ts");
const EXTRA = path.join(SRC_BASE, "web/WebServiceManager.ts");
if (!fs.existsSync(SRC)) { console.log("FAIL 找不到源码 " + SRC + "（用 --src= 指向完整 src 目录）；这是环境缺失，rc=2"); process.exit(2); }
const skill = fs.readFileSync(SKILL, "utf8");
const BS = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);
const TICK = String.fromCharCode(96);
const src = [SRC, EXTRA].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8").split(BS + "/").join("/"));

const m = src[0].match(/runtime\/\(([a-z|-]+)/);
if (!m) { console.log("FAIL 源码里找不到 runtime 路由"); process.exit(1); }
const srcActions = m[1].split("|");
if (srcActions.length < 10) { console.log("FAIL 源码动作数只有 " + srcActions.length); process.exit(1); }

const sec71 = skill.split("### 5.1")[1];
if (!sec71) { console.log("FAIL 文档里没有 5.1 节"); process.exit(1); }
const docActions = [...sec71.matchAll(/^\| \x60([a-z-]+)\x60/gm)].map((x) => x[1]);
if (!docActions.length) { console.log("FAIL 5.1 表格一行都没匹配到"); process.exit(1); }

const { missing, extra } = compareActions(srcActions, docActions);
console.log("源码 " + srcActions.length + " 个，文档 " + docActions.length + " 行");
console.log("漏: " + (missing.join(",") || "无") + "  多: " + (extra.join(",") || "无"));
const okA = !missing.length && !extra.length && srcActions.length === docActions.length;

// 源码里的完整路由集合：组合式 (update|delete|copy) 展开成多条，参数段 ([^/]+) 归一成 :id。
// 只查前缀会让 /api/sessions/<id>（源码里没有这条路由）判绿——2026-11-14 实测的漏。
/** 一条源码里的路由写法 → 归一化后的完整路由列表（组合式 (update|delete|copy) 展开成多条）。 */
function expandRoute(token) {
  const route = token.split("$").join("").split("([^/]+)").join(":id");
  let acc = [""];
  for (const raw of route.split("/").filter(Boolean)) {
    const seg = raw.replace(/^\(/, "").replace(/\)$/, "");
    if (!seg) continue;
    const alts = seg.includes("|") ? seg.split("|").map((s) => s.replace(/^\(|\)$/g, "")) : [seg];
    const next = [];
    for (const a of acc) for (const alt of alts) next.push(a + "/" + alt);
    acc = next;
  }
  return acc;
}
/** 7.1 动作表与源码动作集合的差集。
 *  抽成纯函数只为一个目的：自检能喂假集合，证明「漏」与「多」两个方向都会非空。
 *  2026-11-15 变异实测：把 missing 改成恒空数组之后，文档侧两个变异（删一行动作、加一行假动作）
 *  全都静默变绿——判据坏了，而它自己一句话都不说。
 *  与 guard 的 replayCandidate 是同一个动作：判据逻辑住在顶层，坏样本就喂不进去。 */
function compareActions(srcList, docList) {
  return {
    missing: srcList.filter((x) => !docList.includes(x)),
    extra: docList.filter((x) => !srcList.includes(x)),
  };
}


const routes = new Set();
const routeRe = new RegExp(BS + "/api" + BS + "/[^" + QUOTE + TICK + " ,;]*", "g");
for (const m2 of src.join("\n").matchAll(routeRe)) for (const r of expandRoute(m2[0])) routes.add(r);
if (routes.size < 20) { console.log("FAIL 源码里只切出 " + routes.size + " 条完整路由，判据自己坏了"); process.exit(1); }
const docNorm = (p) => p.replace(/\/$/, "").replace(/<[^>]+>/g, ":id");
for (const [p, want] of [["/api/sessions/<id>/delete", true], ["/api/sessions/<id>", false], ["/api/sessions/<id>/deleteXXX", false]]) {
  if (routes.has(docNorm(p)) !== want) { console.log("FAIL 自检坏样本 " + p + "：完整路由存在性判定与预期不符"); process.exit(1); }
}

const sec72 = skill.split("### 5.2")[1];
if (!sec72) { console.log("FAIL 文档里没有 5.2 节"); process.exit(1); }
const srcLineSets = src.map((s) => s.split(/\r?\n/));
/** 每条归一化路由出现在哪个源码文件的哪一行（fileIndex:lineIndex）。
 *  两个源码文件都要扫：/api/health 与 /api/events 只在 WebServiceManager.ts 里注册，
 *  只扫 WebApiRoutes.ts 会让这两条端点定位不到方法，于是写错方法也判绿（2026-11-15 实测）。 */
const routeLines = new Map();
for (let fi = 0; fi < srcLineSets.length; fi++) {
  const ls = srcLineSets[fi];
  for (let li = 0; li < ls.length; li++) {
    for (const m3 of ls[li].matchAll(routeRe)) {
      for (const r of expandRoute(m3[0])) {
        if (!routeLines.has(r)) routeLines.set(r, []);
        routeLines.get(r).push(fi + ":" + li);
      }
    }
  }
}
/** 源码里这条端点注册过哪些 HTTP 方法。
 *  同一端点可能注册两种方法：export-html 既是记录层动作组的 POST，也是单独的 GET，
 *  所以收集全部，不取第一个。返回空数组表示「源码里定不到位」，调用方要当红处理。 */
function methodsInSource(ep) {
  const out = [];
  for (const ref of routeLines.get(docNorm(ep)) || []) {
    const [fi, li] = ref.split(":").map(Number);
    const ls = srcLineSets[fi];
    for (let k = li; k < Math.min(li + 4, ls.length); k++) {
      const mm = ls[k].match(/request\.method === "(GET|POST)"/);
      if (mm) { if (!out.includes(mm[1])) out.push(mm[1]); break; }
    }
  }
  return out;
}
/** 方法列与源码不符时返回源码里的方法列表，相符返回 null。
 *  抽成函数只为一个目的：自检坏样本能直接喂错方法，证明这条判据会红。
 *  2026-11-16 变异实验：删掉这段比对，check-doc 照样 PASS——此前它没有坏样本。 */
function methodMismatch(ep, docMethod) {
  const real = methodsInSource(ep);
  return real.length && !real.includes(docMethod) ? real : null;
}

let bad = 0;
// ── 路由台账：源码里有哪些完整路由，基线存成文件 ─────────────
// 为什么不是「源码路由 ⊆ 文档」：2026-11-16 实测这条口径不成立。文档用模板写路径
// （/api/sessions/<id>/runtime/<action>、/api/sessions/<目标>/prompt），还有 $PIDECK_SESSION_ID 这种
// shell 变量写法，自动比对会红 25 条，其中至少 5 条是假红（/api/sessions/:id/messages 文档里确实有）。
// 所以这里只判一件事：源码里少了一条曾经存在过的路由。文档侧仍有 7.1 动作表与 7.2 端点表各自的正向比对。
// 台账是生成物，别手改：node check-doc.mjs --update-routes
const LEDGER = path.join(here, "check-doc-routes.json");
// 残缺串不进台账：routeRe 在 `pathname === "/api"` 这类边界上会截出 "/api"，通配会截出 "/api/*"。
// 它们不是路由，进了台账就变成「源码里少了这条就红」的假基线。
const skipped = [];
const routeList = [...routes].filter((r) => {
  const segs = r.split("/").filter(Boolean);
  const bad = /[\u4e00-\u9fa5（）「」，。]/.test(r) || segs.length < 2 || segs[1] === "*";
  if (bad) skipped.push(r);
  return !bad;
}).sort();
if (process.argv.includes("--update-routes")) {
  if (skipped.length) console.log("跳过 " + skipped.length + " 条残缺串：" + skipped.join(" | "));
  fs.writeFileSync(LEDGER, JSON.stringify({ updated: "2026-11-16", routes: routeList }, null, 2) + "\n");
  console.log("已写 " + LEDGER + "（" + routeList.length + " 条）");
  process.exit(0);
}
if (!fs.existsSync(LEDGER)) { console.log("FAIL 路由台账 " + LEDGER + " 不存在，先跑 node check-doc.mjs --update-routes"); process.exit(1); }
const ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8")).routes;
for (const r of ledger) if (!routeList.includes(r)) { console.log("  源码里少了路由 " + r + "（台账基线里有；删路由要连台账一起改，并在提交信息里说清为什么）"); bad++; }
for (const r of routeList) if (!ledger.includes(r)) console.log("  源码新增路由 " + r + "（跑 --update-routes 更新台账）");
console.log("路由台账 " + ledger.length + " 条，源码现在 " + routeList.length + " 条");
// 自检坏样本：方法比对必须能红。删掉比对或让它恒返回 null，这里立刻退出。
const MM_PROBE = "/api/sessions/<id>/copy";
if (!methodMismatch(MM_PROBE, "GET")) { console.log("FAIL 自检坏样本：方法列写错没被判出来（" + MM_PROBE + "）"); process.exit(1); }
if (methodMismatch(MM_PROBE, "POST")) { console.log("FAIL 自检正样本：正确方法被误判（" + MM_PROBE + "）"); process.exit(1); }
// 2026-11-15 交叉审查抓到的漏：父路径端点（/api/sessions）此前因末段匹配过宽，
// 把它下面所有子孙路由的方法都收了进来，写错方法也判绿。下面两条锁住它。
const PREFIX_PROBE = "/api/sessions";
if (!methodMismatch(PREFIX_PROBE, "GET")) { console.log("FAIL 自检坏样本：父路径端点写错方法没被判出来（" + PREFIX_PROBE + " 写 GET，源码只有 POST）"); process.exit(1); }
if (methodMismatch(PREFIX_PROBE, "POST")) { console.log("FAIL 自检正样本：父路径端点的正确方法被误判（" + PREFIX_PROBE + "）"); process.exit(1); }
// 只被 WebServiceManager.ts 注册的端点也要能定位到方法，这条锁住「只扫第一个源码文件」。
if (JSON.stringify(methodsInSource("/api/events")) !== JSON.stringify(["GET"])) {
  console.log("FAIL 自检坏样本：/api/events 的方法定不到（应只在 WebServiceManager.ts 里是 GET）");
  process.exit(1);
}

// 7.2 表格必须有多少行。写死是必要的：没有基数就抓不到「文档少了一条端点」——
// 2026-11-15 实测，删掉 export-html 那一行后判据照样 PASS。增删端点时同步改这个数。
const EXPECTED_72_ROWS = 8;
let checked = 0;
for (const line of sec72.split(/\r?\n/)) {
  const mt = line.match(/^\| \x60(\/api[^\x60]*)\x60 \| ([A-Za-z]+) \|/);
  if (!mt) continue;
  const ep = mt[1];
  const docMethod = mt[2];
  checked++;
  if (!routes.has(docNorm(ep))) { console.log("  源码里没有完整路由 " + ep); bad++; continue; }
  if (docMethod !== "GET" && docMethod !== "POST") { console.log("  " + ep + " 的方法列写了 " + docMethod + "，不是 GET/POST"); bad++; continue; }
  const real = methodsInSource(ep);
  if (!real.length) { console.log("  " + ep + " 在源码里定不到方法（判据自己漏了路由）"); bad++; continue; }
  if (!real.includes(docMethod)) { console.log("  " + ep + " 文档写 " + docMethod + "，源码是 " + real.join("/")); bad++; }
}
// 标题里写死的数字必须与表格行数一致。加表格的人常常忘了改标题——
// 2026-11-18 实测：正文写着「运行时 21 个，记录层 8 个」，把 21 改成 22 四条判据全绿，
// 因为它只是散文里的一个数字，而表格行数才是真值。这条把两处锁在一起。
const sec5 = skill.split(/\n## 5 /)[1] || "";
const mRuntime = sec5.match(/运行时 ([0-9]+) 个/);
const mLedger = sec5.match(/记录层 ([0-9]+) 个/);
if (!mRuntime || !mLedger) { console.log("FAIL §5 标题里找不到「运行时 N 个，记录层 N 个」"); process.exit(1); }
if (Number(mRuntime[1]) !== docActions.length) { console.log("FAIL §5 标题说运行时 " + mRuntime[1] + " 个，5.1 表格是 " + docActions.length + " 行"); process.exit(1); }
if (Number(mLedger[1]) !== checked) { console.log("FAIL §5 标题说记录层 " + mLedger[1] + " 个，5.2 表格是 " + checked + " 行"); process.exit(1); }

if (checked !== EXPECTED_72_ROWS) { console.log("FAIL 5.2 表格 " + checked + " 行，基线是 " + EXPECTED_72_ROWS); process.exit(1); }

console.log("5.2 端点 " + checked + " 条（路径 + 方法都比对），" + (bad ? bad + " 处与源码不符" : "全部对得上"));
// 7.1 的「额外 body 字段」列：源码 switch 里读到的 body.X 与文档必须一一对应。
// 少写一个字段，读者就会漏传，服务端拿 undefined 当空值——静默做错事。
const swStart = src[0].indexOf("switch (action)");
const swEnd = swStart + 8000; // switch 体约 80 行；用固定窗口比找闭合括号稳（里面有多个 return true）
const swBody = swStart >= 0 ? src[0].slice(swStart, swEnd) : "";
const bodyFields = new Set([...swBody.matchAll(/body\.([a-zA-Z]+)/g)].map((x) => x[1]));
if (bodyFields.size < 8) { console.log("FAIL 源码 switch 里只切出 " + bodyFields.size + " 个 body 字段，判据自己坏了"); process.exit(1); }
const docRowFields = sec71.split(/\r?\n/).filter((l) => /^\| \x60[a-z-]+\x60 \|/.test(l)).map((l) => l.split("|")[2]).join(" ");
// 可选字段在文档里写成 `prompt?`，问号在反引号里面，所以这里要允许一个问号。
  const docFields = new Set([...docRowFields.matchAll(/\x60([a-zA-Z]+)\??\x60/g)].map((x) => x[1]));
if (!docFields.size) { console.log("FAIL 5.1 的字段列一行都没匹配到"); process.exit(1); }
for (const f of bodyFields) if (!docFields.has(f)) { console.log("  5.1 漏了字段 " + f + "（源码读过 body." + f + "）"); bad++; }
for (const f of docFields) if (!bodyFields.has(f)) { console.log("  5.1 多写了字段 " + f + "（源码 switch 里没读）"); bad++; }

console.log(okA && !bad ? "PASS" : "FAIL");
process.exit(okA && !bad ? 0 : 1);