// 判据：离开本文件的文字（消息、签核、PR 正文、注入面）是不是自包含。
// 为什么要有：子非鱼——你不知道对方知不知道。它可能没读过这个技能、读到旧版、刚重启、
// 上下文被压缩过。写「见第 N 节」的人以为对方手上有全文，对方手上没有。
// 这条只对外部文件生效：SKILL.md 内部的节号跳转是合法的，读者手里有全文。
//
// 会红的四种：
//   1) 节号引用：「见第 6 节」「按 5.6 办」「格式见 7.1」
//   2) 前情指代：「上文」「前述」「上一条」「刚才那段」「如前所述」
//   3) 技能指代：「按技能办」「照技能里的做」
//   4) 空对空：文件不到 40 个非空字符（这种文件没传达任何东西，判它自包含是恒真绿）
//
// 用法：
//   node check-self-contained.mjs <文件...>   扫给定的外部文件
//   node check-self-contained.mjs --selftest  只验判据自己，不读任何文件
// 退出码：0 干净 / 1 有命中 / 2 用法错或文件读不到
import fs from "node:fs";

const RULES = [
  { name: "节号引用", re: /(?:见|按|照|参考|格式见|详见)\s*第?\s*\d+(?:\.\d+)?\s*节|(?:见|按|照)\s*\d+\.\d+/g },
  { name: "前情指代", re: /(?:上文|前述|上一条|上一轮|刚才那|如前所述|前面说)/g },
  { name: "技能指代", re: /(?:按|照)技能(?:办|里的|里的做|做)/g },
];

/** 扫一段文字，返回命中 [{line, rule, sample}]。
 *  行内代码与围栏代码内的内容先剥掉：消息里贴命令是自包含的表现，不是引用前情。
 *  2026-11-18 实测：第一版没剥，把「node check-format.mjs   # 见第 7 节」这类
 *  命令注释里的节号误报，于是真正的节号引用反而被淹没。 */
export function scanText(text) {
  const hits = [];
  let fence = false;
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    line = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    for (const r of RULES) {
      r.re.lastIndex = 0;
      const m = r.re.exec(line);
      if (m) hits.push({ line: i + 1, rule: r.name, sample: line.trim() });
    }
  }
  return hits;
}

const NONEMPTY_MIN = 40;
const charCount = (s) => String(s || "").replace(/\s/g, "").length;

function selftest() {
  let bad = 0;
  const cases = [
    ["节号引用", "改完了，复核请见第 6 节。", 1],
    ["小数节号", "格式见 5.6。", 1],
    ["按节号办", "按 9.2 办。", 1],
    ["前情指代", "上文那段我核过了。", 1],
    ["上一条", "上一条说的三件都成立。", 1],
    ["技能指代", "照技能里的做。", 1],
    ["代码块内不算", "命令：\n\n```bash\nnode x.mjs   # 见第 7 节\n```\n\n以上。", 0],
    ["自包含正样本", "对象 C:/Users/oi/a.md，md5 4ff58933，跑 node x.mjs 得 rc=0。", 0],
  ];
  for (const [name, text, expect] of cases) {
    const n = scanText(text).length;
    if (n !== expect) { bad++; console.log("FAIL 自检「" + name + "」：" + n + " 处，预期 " + expect); }
  }
  const thin = "太短了。";
  if (charCount(thin) >= NONEMPTY_MIN) { bad++; console.log("FAIL 自检：空对空样本没被判成内容不足"); }
  const ok = "对象 C:/x.md，md5 4ff58933，跑 node check.mjs 得 rc=0，跑完脏 0 行，这条消息本身带齐了路径、判据与期望返回。";
  if (charCount(ok) < NONEMPTY_MIN) { bad++; console.log("FAIL 自检：充足样本被误判成内容不足"); }
  console.log(bad ? "selftest FAIL：" + bad + " 条" : "selftest PASS：" + (cases.length + 2) + " 条");
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes("--selftest")) selftest();

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.log("用法：node check-self-contained.mjs <文件...> | --selftest");
  console.log("这条判据扫的是离开本文件的文字（消息、签核、PR 正文），不扫 SKILL.md 自身。");
  process.exit(2);
}

let total = 0;
for (const f of files) {
  if (!fs.existsSync(f)) { console.log("FAIL 读不到 " + f); process.exit(2); }
  const text = fs.readFileSync(f, "utf8");
  if (charCount(text) < NONEMPTY_MIN) {
    total++; console.log("FAIL " + f + " 只有 " + charCount(text) + " 个非空字符，没传达任何东西（判它自包含是恒真绿）"); continue;
  }
  const hits = scanText(text);
  for (const h of hits) { total++; console.log("  行 " + h.line + " " + h.rule + "：" + h.sample.slice(0, 60)); }
  if (!hits.length) console.log("check-self-contained: " + f + " 命中 0 条");
}
process.exit(total ? 1 : 0);
