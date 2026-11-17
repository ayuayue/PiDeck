#!/usr/bin/env node
// 协作署名判据：谁发现谁改，换手复核。
//
// 为什么需要它（2026-11-17 一整天）：两个会话连续五轮都写「修改者：对端（待你改）」，
// 每一轮都说不出「对方机器无写权限」或「文件只在我这盘上」——同机、有写权限、能提交。
// 还有一次是复核者列完缺陷写「等它修改」：缺陷是它找的，活却回到对方手上。
// 两种写法是同一件事的事前版与事后版，都靠自述，都不可观测。所以判据只看签核上写的字段。
//
// 判两条（都机器可查）：
//   1. 发现者 == 修改者。谁指得出缺陷，谁就落盘改，中间不经转述。
//   2. 修改者 != 复核者。同一个人既改又核，等于这一轮没有复核。
// 不判「连续两轮同一个修改者」：如果一直是甲先看出问题，甲就该一直改——
// 要防的从来不是同一个人连续改，是同一个人既改又核。
//
// 口径上限：只看每份签核前 1200 字符（署名行在第一屏）；解析不到的字段按缺算，按红算。

import fs from "node:fs";
import path from "node:path";

const RE_ROUND = /^\s*\**轮次\**\s*[:：]\s*R?(\d+)/m;
const RE_DISCOVER = /^\s*\**发现者\**\s*[:：]\s*([^\n]+)/m;
const RE_MOD = /^\s*\**修改者\**\s*[:：]\s*([^\n]+)/m;
const RE_REV = /^\s*\**复核者\**\s*[:：]\s*([^\n]+)/m;
const RE_PROPOSER = /^\s*\**提出者\**\s*[:：]\s*([^\n]+)/m;
// 一轮的时间轴：开头只审（审查段），结束只改（已改段）。审查段必须在已改段之前。
const RE_REVIEW = /^\s*\**审查\**\s*[:：]\s*([^\n]+)/m;
// 交付行：改完发给对方的时刻或回执标识。缺它说明「改完没交对方」——
// 2026-11-17 实测：改完 PR 结构、写了签核、也在 PR 里评论了，但没发消息，对方不知道有这回事。
// PR 评论与签核文件都不算交付，对方不会去翻。
const RE_DELIVER = /^\s*\**交付\**\s*[:：]\s*([^\n]+)/m;
// 「已改 / 未改」：能改就当场改完，不许推给对方。未改必须带一种可核的原因。
const RE_DONE = /^\s*\**已改\**\s*[:：]\s*([^\n]+)/m;
const RE_LEFT = /^\s*\**未改\**\s*[:：]\s*([^\n]+)/m;
const LEFT_OK = /(无写权限|无凭据|文件不在本机)/;

// 推责说法：说出来就是没做到。六条都是同一个形状——把一件事说成别人的，然后自己不做了。
const PUSH_WORDS = ["等你改", "按规则归你", "本轮由你改", "不越位", "你发现你改", "留给你", "下一轮再说", "单开一轮", "我记着"];

const clean = (s) => String(s || "").replace(/\*\*/g, "").trim().split(/[\s（(]/)[0];

// 同一事实只允许出现一处。2026-11-17 实测：一份签核里两行「未改」，签核那行写「无」、
// 正文末尾那段写「没动」——改字段时只替换了签核那行，另一处没动，两条真值当场分叉。
// 前 1200 字符读不到正文末尾，所以这条必须扫全文，不能只看 head。
const COUNT_FIELDS = ["已改", "未改", "交付", "发现者", "修改者", "复核者", "提出者"];
export function dupFields(text) {
  // 跳过围栏代码块：正文里引用「未改: ...」这种示例会被数成真字段（R16 实测误报）。
  let fence = false;
  const all = String(text || "").split("\n").map((l) => {
    if (/^\s*```/.test(l)) { fence = !fence; return ""; }
    return fence ? "" : l;
  }).join("\n");
  const dup = [];
  for (const k of COUNT_FIELDS) {
    const n = (all.match(new RegExp("^\\s*\\**" + k + "\\**\\s*[:：]", "gm")) || []).length;
    if (n > 1) dup.push(k + " ×" + n);
  }
  return dup;
}
export function parseOne(text) {
  const head = String(text || "").slice(0, 1200);
  const r = RE_ROUND.exec(head);
  if (!r) return null;
  const pickRaw = (re) => { const m = re.exec(head); return m ? m[1].trim() : null; };
  const pos = (re) => { const m = re.exec(head); return m ? head.indexOf(m[0]) : -1; };
  const pick = (re) => { const m = re.exec(head); return m ? clean(m[1]) : null; };
  return {
    raw: head,
    round: Number(r[1]),
    proposer: pick(RE_PROPOSER),
    discoverer: pick(RE_DISCOVER),
    modifier: pick(RE_MOD),
    // 原始文本留着：「待你改」在 clean 之后会被截掉，判据读不到就是漏判。
    modifierRaw: pickRaw(RE_MOD),
    review: pickRaw(RE_REVIEW), done: pickRaw(RE_DONE), left: pickRaw(RE_LEFT),
    posReview: pos(RE_REVIEW), posDone: pos(RE_DONE),
    reviewer: pick(RE_REV),
    delivered: pickRaw(RE_DELIVER),
    dup: dupFields(text),
  };
}

// 历史基线：2026-11-17 之前（含）的签核里，R1–R4 全是发现者 pr合作2、修改者 pr合作1 ——
// 四轮都没做到「谁发现谁改」。这个事实留着当基线，判据照打但不拦；
// 名单外的新违反才红。与 distill / manifest 的基线同一形态：恒红的判据进 gate 等于没有判据。
export const HISTORY_BAD = ["R1", "R2", "R3", "R4"];

export function check(entries) {
  const maxRound = entries.reduce((m, x) => Math.max(m, x.round), 0);
  const bad = [];
  for (const e of entries.slice().sort((a, b) => a.round - b.round)) {
    const tag = "R" + e.round + (e.file ? " " + e.file : "");
    if (e.dup && e.dup.length) bad.push(tag + " 同一字段出现多次（" + e.dup.join("、") + "）：同一事实两个来源，迟早分叉");
    if (!e.discoverer) bad.push(tag + " 缺「发现者」");
    if (!e.modifier) bad.push(tag + " 缺「修改者」");
    if (!e.reviewer) bad.push(tag + " 缺「复核者」");
    if (/待你改|待改|等它改|请对方改/.test(String(e.modifierRaw || e.modifier || ""))) {
      bad.push(tag + " 修改者写着「待你改 / 等它改」：这一轮没有落盘");
    }
    if (e.discoverer && e.modifier && e.discoverer !== e.modifier) {
      bad.push(tag + " 发现者（" + e.discoverer + "）与修改者（" + e.modifier + "）不是同一个会话：改动被转述了一遍");
    }
    if (e.modifier && e.reviewer && e.modifier === e.reviewer) {
      bad.push(tag + " 修改者与复核者是同一个会话：这一轮没有复核");
    }
        // 交付只判最近一轮：R1–R6 那几轮改完确实没发消息（R6 被用户点出来），已成事实，判进历史。
    // 从 R7 起缺交付就红。
    if (e.round === maxRound && !e.delivered) bad.push(tag + " 缺「交付」行：改完没交对方（PR 评论与签核文件都不算交付）");
    if (e.round === maxRound) {
      if (!e.done) bad.push(tag + " 缺「已改」行：本轮真改了什么");
      if (!e.left) bad.push(tag + " 缺「未改」行（没有就写 未改: 无）");
      else if (!/^无$/.test(String(e.left).trim()) && !LEFT_OK.test(String(e.left))) {
        bad.push(tag + " 「未改」的原因只能是 无写权限 / 无凭据 / 文件不在本机，写的是：" + String(e.left).slice(0, 40));
      }
      const hit = PUSH_WORDS.find((w) => String(e.done || "").includes(w) || String(e.left || "").includes(w));
      if (hit) bad.push(tag + " 出现推责说法「" + hit + "」：能改就改，不许推给对方");
    }
  }
  // 历史违反与新闻题分开：历史照打不拦，新的才让 rc=1。
  const isHistory = (b) => HISTORY_BAD.some((h) => b.startsWith(h + " "));
  return { bad: bad.filter((b) => !isHistory(b)), history: bad.filter(isHistory) };
}

function scanDir(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const p = path.join(dir, f);
    let t;
    try { t = fs.readFileSync(p, "utf8"); } catch { continue; }
    const one = parseOne(t);
    if (one) out.push({ ...one, file: f });
  }
  return out;
}

function selftest() {
  const doc = (o) => [
    "# 签核",
    "轮次: R" + o.r,
    "提出者: 用户",
    "发现者: " + o.d,
    "修改者: " + o.m,
    "复核者: " + o.v,
    "交付: 2026-11-17T14:00",
    "已改: 本轮改的东西",
    "未改: 无",
  ].join("\n");
  const cases = [
    { name: "好样本：甲发现甲改乙核", doc: doc({ r: 9, d: "甲", m: "甲", v: "乙" }), want: 0 },
    { name: "坏样本：签核齐全但没有「交付」行（改完没交对方）", doc: "# 签核\n轮次: R9\n提出者: 用户\n发现者: 甲\n修改者: 甲\n复核者: 乙\n已改: x\n未改: 无", want: 1 },
    { name: "坏样本：未改的原因不在白名单（中性说法，不踩推责词）", doc: "# 签核\n轮次: R9\n提出者: 用户\n发现者: 甲\n修改者: 甲\n复核者: 乙\n交付: 14:00\n已改: x\n未改: sync:verify｜原因: 等排期", want: 1 },
    { name: "坏样本：未改写推责词「下一轮再说」——同时踩白名单，共 2 条", doc: "# 签核\n轮次: R9\n提出者: 用户\n发现者: 甲\n修改者: 甲\n复核者: 乙\n交付: 14:00\n已改: x\n未改: sync:verify｜原因: 下一轮再说", want: 2 },
    { name: "坏样本：已改行写「我记着，不越位」", doc: "# 签核\n轮次: R9\n提出者: 用户\n发现者: 甲\n修改者: 甲\n复核者: 乙\n交付: 14:00\n已改: 我记着，不越位\n未改: 无", want: 1 },
    { name: "坏样本：发现者与修改者不是同一人", doc: doc({ r: 9, d: "甲", m: "乙", v: "丙" }), want: 1 },
    { name: "坏样本：修改者与复核者同一人", doc: doc({ r: 9, d: "甲", m: "甲", v: "甲" }), want: 1 },
    { name: "坏样本：修改者写「待你改」", doc: doc({ r: 9, d: "甲", m: "乙（待你改）", v: "甲" }), want: 2 },
    { name: "坏样本：修改者写「等它改」", doc: doc({ r: 9, d: "甲", m: "等它改", v: "乙" }), want: 2 },
    { name: "坏样本：缺发现者（同时缺交付/已改/未改，共四处）", doc: "# 签核\n轮次: R1\n修改者: 甲\n复核者: 乙", want: 4 },
    { name: "好样本：两轮各自谁发现谁改（同一人连改不算错）",
      docs: [doc({ r: 9, d: "甲", m: "甲", v: "乙" }), doc({ r: 8, d: "甲", m: "甲", v: "乙" })], want: 0 },
    { name: "好样本：换边后乙发现乙改甲核",
      docs: [doc({ r: 9, d: "甲", m: "甲", v: "乙" }), doc({ r: 2, d: "乙", m: "乙", v: "甲" })], want: 0 },
    // 坏样本：正文末尾又写一段「未改」，与签核那行冲突（判据只读前 1200 字符，看不见它）。
    { name: "坏样本：两行「未改」——签核写「无」，正文末尾写「没动」", doc: "# 签核\n轮次: R9\n提出者: 用户\n发现者: 甲\n修改者: 甲\n复核者: 乙\n交付: 14:00\n已改: x\n未改: 无\n\n## 已改 / 未改\n\n未改: 那份文件没动", want: 1 },
    { name: "坏样本：两行「已改」——同一事实写了两次", doc: "# 签核\n轮次: R9\n提出者: 用户\n发现者: 甲\n修改者: 甲\n复核者: 乙\n交付: 14:00\n已改: x\n未改: 无\n\n已改: x 再写一遍", want: 1 },
    { name: "解析层：没有轮次的文件不被当成签核", doc: "# 随便一份文件\n修改者: 甲", want: 0, skip: true },
  ];
  let pass = 0, fail = 0;
  for (const c of cases) {
    const entries = c.skip ? (parseOne(c.doc) ? [{ ...parseOne(c.doc), file: "f" }] : []) : (c.docs || [c.doc]).map((t, i) => ({ ...parseOne(t), file: "f" + i }));
    void 0;
    const got = check(entries).bad.length + check(entries).history.length;
    if (got === c.want) { pass++; console.log("PASS " + c.name); }
    else { fail++; console.log("FAIL " + c.name + "：期望 " + c.want + " 条问题，实得 " + got); }
  }
  console.log("\n自检通过 " + pass + " 条");
  return fail === 0 ? 0 : 1;
}

const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (process.argv.includes("--selftest")) process.exit(selftest());

const dir = arg || process.cwd();
if (!fs.existsSync(dir)) { console.log("目录不存在：" + dir); process.exit(2); }
// 传单文件进来时 readdirSync 会抛 ENOTDIR（未捕获），把用法错伪装成崩溃。
// 用法错是 rc=2，判据红是 rc=1，两个码分开：混成崩溃就分不清机器坏还是代码坏。
if (!fs.statSync(dir).isDirectory()) {
  console.log("用法：node check-round-robin.mjs <目录> | --selftest（它扫目录下所有 .md，不接单文件）");
  process.exit(2);
}
const entries = scanDir(dir);
if (!entries.length) {
  console.log("check-round-robin: " + dir + " 下没有带「轮次」的签核，跳过（口径：只管写了轮次的文件）");
  process.exit(0);
}
const { bad, history } = check(entries);
for (const h of history) console.log("历史 " + h + "（基线内，不拦）");
if (!bad.length) {
  console.log("check-round-robin: " + entries.length + " 份签核，" + entries.map((e) => "R" + e.round).join("/") + " 全部成立（发现者=修改者，修改者≠复核者）");
  process.exit(0);
}
for (const b of bad) console.log("红 " + b);
console.log("check-round-robin: " + bad.length + " 条问题");
process.exit(1);