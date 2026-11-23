#!/usr/bin/env node
// check-rules.mjs —— 判据脚本自己的规则也要能被判。
// 问题：check-doc / check-paths / check-fields 各自用散文注释解释「我在判什么」，机器读不出来。
// 于是「这个判据还在判它该判的东西吗」只能靠人看；判据坏了和判据不存在，后果相同。
// 做法：规则写成数据（rules.mjs），四件齐——命题 · 引入（命令 + 期望）· 消去（第二入口）· 反例。
// rc: 0 全齐｜1 有缺口｜2 规则文件缺失
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "./rules.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIELDS = ["claim", "intro", "second", "counter"];

export function checkRules(rules, dir) {
	const problems = [];
	const ids = new Set();
	for (const r of rules) {
		if (!r.id) {
			problems.push("有一条规则没有 id");
			continue;
		}
		if (ids.has(r.id)) problems.push(r.id + "：id 重复");
		ids.add(r.id);
		for (const f of FIELDS) if (!r[f] || !String(r[f]).trim()) problems.push(r.id + "：缺 " + f);
		if (r.script && !fs.existsSync(path.join(dir, r.script))) problems.push(r.id + "：点名的脚本不在盘上 " + r.script);
	}
	// 每个判据脚本都要至少一条规则：否则那个脚本的规则仍然只活在散文里。
	const scripts = new Set(rules.map((r) => r.script).filter(Boolean));
	for (const f of fs.readdirSync(dir).filter((f) => /^check-.*\.mjs$/.test(f) && f !== "check-rules.mjs")) {
		if (!scripts.has(f)) problems.push(f + "：没有登记任何规则");
	}
	return problems;
}

if (process.argv.includes("--selftest")) {
	const cases = [
		["缺 claim", [{ id: "X1", intro: "i", second: "s", counter: "c" }], 1],
		["缺 intro", [{ id: "X1", claim: "p", second: "s", counter: "c" }], 1],
		["缺 second", [{ id: "X1", claim: "p", intro: "i", counter: "c" }], 1],
		["缺 counter", [{ id: "X1", claim: "p", intro: "i", second: "s" }], 1],
		[
			"id 重复",
			[
				{ id: "X1", claim: "p", intro: "i", second: "s", counter: "c" },
				{ id: "X1", claim: "p", intro: "i", second: "s", counter: "c" },
			],
			1,
		],
	];
	let bad = 0;
	for (const [name, rules, want] of cases) {
		const got = checkRules(rules, here).some((p) => !p.includes("没有登记任何规则")) ? 1 : 0;
		const ok = got === want;
		if (!ok) bad++;
		console.log((ok ? "PASS" : "FAIL") + "  " + name + "：得 " + got + "，期望 " + want);
	}
	console.log(bad === 0 ? "selftest: 五个坏样本都对" : "selftest: " + bad + " 条不符");
	process.exit(bad === 0 ? 0 : 1);
}

const problems = checkRules(RULES, here);
for (const p of problems) console.log("红  " + p);
const scripts = new Set(RULES.map((r) => r.script));
console.log("check-rules: " + RULES.length + " 条规则，覆盖 " + scripts.size + " 个判据脚本，缺口 " + problems.length + " 个");
process.exit(problems.length === 0 ? 0 : 1);
