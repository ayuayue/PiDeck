#!/usr/bin/env node
// verify-dtt.mjs —— web-api 这套文档的元理论判据：每条规则必须是依赖类型理论的一个类型。
// 四件缺一不算规则：命题 · 引入（命令 + 期望） · 消去（第二入口） · 反例（具体输入）。
// 为什么要有这条：散文写得像规则、读着对，但没有任何一条能跑出退出码。这类文档改坏了没人知道。
// rc: 0 全齐｜1 有缺口｜2 目录不在
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(here, "..");
const SELF = path.basename(fileURLToPath(import.meta.url));

const PROC_WORDS = ["本轮", "上一轮", "待办", "进行中", "暂未", "刚才", "TODO", "FIXME"];
const WEAK = ["视情况", "按需", "待定", "看情况", "大概"];

function collect(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(full); }
      else if (e.name.endsWith(".md") && e.name !== SELF) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

export function check(files, root) {
  const problems = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    if (/SIGN-OFF/i.test(rel)) continue; // 签字页不是规则文件
    const text = fs.readFileSync(f, "utf8");
    const hasType = /^##+ .*(类型|规则)/m.test(text);
    if (!hasType) { problems.push(rel + "：缺「类型」或「规则」节"); continue; }
    // 两种合法形状：
    //   横排 —— 表头是 | # | 命题 | 引入 | 消去 | 反例 |
    //   竖排 —— 第一列是四件名：| 形成 | … | / | 引入 | … | / | 消去 | … | / | 反例 | … |
    // 2026-11-22 实测：9 份 web-api 用的是竖排（一段规则一张四行小卡），只认横排会误报 7 份。
    // 形状判定只看「形成 / 消去」：`| 反例 | … |` 在正文的「反例 / 后果」表里也出现，
    // 拿它当竖排特征会把横排文档误判成竖排（2026-11-22 实测 connect.md 有两张这样的表）。
    const vertical = ["形成", "引入", "消去"].filter((k) => new RegExp("^\\| " + k + " \\|", "m").test(text)).length;
    if (vertical >= 2) {
      // 竖排分支：四件必须齐、每件非空，反例不能写弱词。
      // 2026-11-22 实测：改之前这里是「四个标题出现 ≥3 次就 continue」，于是删掉整行
      // `| 反例 |`、或把它写成「视情况」，5 份竖排文档仍全绿——判据恒绿等于没写。
      for (const k of ["形成", "引入", "消去", "反例"]) {
        // 一行形如 `| 反例 | 内容 |`：split("|") 后 [1] 是件名，[2] 才是内容。
        const values = (text.match(new RegExp("^\\| " + k + " \\|.*$", "gm")) || []).map((line) => (line.split("|")[2] || "").trim());
        if (values.length === 0) problems.push(rel + "：竖排四件缺「" + k + "」");
        if (values.some((v) => !v)) problems.push(rel + "：「" + k + "」写成了空行");
        if (k === "反例") for (const v of values) for (const w of WEAK) if (v.includes(w)) problems.push(rel + "：反例写成「" + w + "」");
      }
      continue;
    }
    {
    // 横排分支
    const headerLine = text.split("\n").find((l) => /^\|.*引入.*\|/.test(l));
    if (!headerLine) { problems.push(rel + "：规则表缺「引入」列"); continue; }
    if (!/反例/.test(headerLine)) { problems.push(rel + "：规则表缺「反例」列"); continue; }
    if (!/消去/.test(headerLine)) { problems.push(rel + "：规则表缺「消去」列"); continue; }
    const cols = headerLine.split("|").length - 2;
    const rows = text.split("\n").filter((l) => /^\| [A-Z]?[0-9]?[0-9]?[0-9]? ?\|/.test(l) && l.split("|").length - 2 === cols && !/^\| ---/.test(l));
    if (rows.length === 0) { problems.push(rel + "：规则表没有数据行"); continue; }
    for (const row of rows) {
      const cells = row.split("|").slice(1, -1).map((s) => s.trim());
      const id = cells[0];
      const intro = cells[cells.length - 3] || "";
      const counter = cells[cells.length - 1] || "";
      if (!intro) problems.push(rel + " " + id + "：引入列为空");
      if (!counter) problems.push(rel + " " + id + "：反例列为空");
      for (const w of WEAK) if (counter.includes(w)) problems.push(rel + " " + id + "：反例写成「" + w + "」");
    }
    }
    for (const w of PROC_WORDS) if (text.includes(w)) problems.push(rel + "：含过程词「" + w + "」");
    // 点名的仓库内脚本必须存在于盘上
    // 脚本存在性只在仓库副本里查：magpie 分发的副本只有 SKILL.md + references，
    // 没有 scripts/ 与 .git，在那里查等于拿仓内路径问一个不存在的根（2026-11-22 实测 4 条误报）。
    const inRepo = fs.existsSync(path.resolve(root, "..", "..", "..", ".git"));
    const refs = inRepo ? [...text.matchAll(/[`]([w./-]+.(?:mjs|js|sh))[`]/g)].map((m) => m[1]) : [];
    for (const r of new Set(refs)) {
      if (r.startsWith("~") || r.startsWith("/")) continue;
      // 判据脚本住在 scripts/skills/pideck/，文档里通常只写文件名。
      const repoRoot = path.resolve(root, "..", "..", "..");
      const cand = [
        path.join(repoRoot, r),
        path.join(repoRoot, "scripts/skills/pideck", r),
        path.join(root, r),
        path.join(root, "..", "..", "..", r),
      ];
      if (!cand.some((c) => fs.existsSync(c))) problems.push(rel + "：点名的脚本不在盘上 " + r);
    }
  }
  return problems;
}

if (process.argv.includes("--selftest")) {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "dtt-"));
  const cases = [
    ["缺类型节", "# x\n\n| A | B |\n| --- | --- |\n", 1],
    ["缺引入列", "# x\n\n## 类型\n\n| # | 命题 | 反例 | 消去 |\n| --- | --- | --- | --- |\n| A1 | p | r | s |\n", 1],
    ["反例为空", "# x\n\n## 类型\n\n| # | 命题 | 引入 | 消去 | 反例 |\n| --- | --- | --- | --- | --- |\n| A1 | p | c | s |  |\n", 1],
    ["反例写视情况", "# x\n\n## 类型\n\n| # | 命题 | 引入 | 消去 | 反例 |\n| --- | --- | --- | --- | --- |\n| A1 | p | c | s | 视情况 |\n", 1],
    ["齐了", "# x\n\n## 类型\n\n| # | 命题 | 引入 | 消去 | 反例 |\n| --- | --- | --- | --- | --- |\n| A1 | p | 命令 → 0 | 第二入口 | 具体错法 |\n", 0],
    // 竖排是 9 份 web-api 文档实际用的形状（一段规则一张四行小卡），坏样本必须在它上面跑一遍：
    // 只在横排上验坏样本，竖排分支恒绿也发现不了。
    ["竖排缺反例行", "# x\n\n## 类型\n\n| 件 | 形状 |\n| --- | --- |\n| 形成 | p |\n| 引入 | 命令 → 0 |\n| 消去 | 第二入口 |\n", 1],
    ["竖排反例为空", "# x\n\n## 类型\n\n| 件 | 形状 |\n| --- | --- |\n| 形成 | p |\n| 引入 | 命令 → 0 |\n| 消去 | 第二入口 |\n| 反例 |  |\n", 1],
    ["竖排反例写视情况", "# x\n\n## 类型\n\n| 件 | 形状 |\n| --- | --- |\n| 形成 | p |\n| 引入 | 命令 → 0 |\n| 消去 | 第二入口 |\n| 反例 | 视情况 |\n", 1],
    ["竖排齐了", "# x\n\n## 类型\n\n| 件 | 形状 |\n| --- | --- |\n| 形成 | p |\n| 引入 | 命令 → 0 |\n| 消去 | 第二入口 |\n| 反例 | health 非 200 仍去发消息 |\n", 0],
  ];
  let bad = 0;
  for (const [name, body, want] of cases) {
    const f = path.join(tmp, name + ".md");
    fs.writeFileSync(f, body, "utf8");
    const got = check([f], tmp).length > 0 ? 1 : 0;
    const ok = got === want;
    if (!ok) bad++;
    console.log((ok ? "PASS" : "FAIL") + "  " + name + "：得 " + got + "，期望 " + want);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad === 0 ? "selftest: " + cases.length + " 个样本都对" : "selftest: " + bad + " 条不符");
  process.exit(bad === 0 ? 0 : 1);
}

const files = collect(here); // 只扫 pideck 自己：兄弟技能（mcp-setup 等）有各自的判据
if (files.length === 0) { console.log("缺文档目录 " + SKILL_DIR); process.exit(2); }
const problems = check(files, here); // root 必须是 pideck 目录，传 skills/ 会让脚本路径算到上一层
for (const p of problems) console.log("红  " + p);
console.log("verify-dtt: " + files.length + " 份文档，缺口 " + problems.length + " 个");
process.exit(problems.length === 0 ? 0 : 1);
