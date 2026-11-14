// 判据：SKILL.md 第 7 节的动作表与端点表，逐条对得上源码 WebApiRoutes.ts。
// 用法：node check-doc.mjs [SKILL.md]  —— 不给参数就校验同目录那份。
// 为什么要有它：这两张表是照着源码抄的，抄漏抄多都没人看得见。
// 会红的三种情况：文档漏动作、文档多动作、7.1/7.2 表整段被删（空集一律判红，空对空不算通过）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = process.argv[2] || path.join(here, "SKILL.md");
const SRC = path.resolve(here, "../../../src/main/web/WebApiRoutes.ts");
if (!fs.existsSync(SRC)) { console.log("FAIL 找不到源码 " + SRC); process.exit(1); }
const skill = fs.readFileSync(SKILL, "utf8");
const BS = String.fromCharCode(92);
const src = fs.readFileSync(SRC, "utf8").split(BS + "/").join("/");

const m = src.match(/runtime\/\(([a-z|-]+)\)/);
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

const sec72 = skill.split("### 7.2")[1];
if (!sec72) { console.log("FAIL 文档里没有 7.2 节"); process.exit(1); }
const docEps = [...sec72.matchAll(/^\| \x60(\/api[^\x60]*)\x60/gm)].map((x) => x[1]);
if (!docEps.length) { console.log("FAIL 7.2 端点一行都没匹配到"); process.exit(1); }
let bad = 0;
for (const ep of docEps) {
  const base = ep.includes("<id>") ? "/api/sessions/" : ep;
  if (!src.includes(base)) { console.log("  源码里没有 " + ep); bad++; }
}
console.log("7.2 端点 " + docEps.length + " 条，" + (bad ? bad + " 条源码里没有" : "全部在源码里"));
console.log(okA && !bad ? "PASS" : "FAIL");
process.exit(okA && !bad ? 0 : 1);