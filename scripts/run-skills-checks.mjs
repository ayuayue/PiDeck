#!/usr/bin/env node
// 一次跑完全部内置技能判据，逐条打印退出码，最后汇总。
//
// 为什么不用 && 串联：第一条红之后后面的不执行。一次改动里有两处红，只看到一处，
// 修完再跑又冒出第二处——往返次数等于红的条数，而每一步都要等 CI。
// 这里每条都跑完再汇总，红的按名字列在末尾。
//
// 判据：全绿 rc=0；任一条非 0 → rc=1，末尾点名红的那几条。
// 坏样本（两条，各自证明一件事）：
//   一、--selftest：三条假步（一绿两红）走同一套聚合逻辑，必须点名那两条红的、且三条都
//       出现在输出里。证的是聚合器自己——它会不会短路、红条数算不算对。
//   二、人工造坏：把任意一个 check 脚本改成 process.exit(1)，对应条目与它的输出一起出现，
//       其余条目照常 OK。证的是判据与聚合器之间没有短路。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = "resources/skills/pideck-web-api";

// 前三条只验判据自己（不读源码与文档），装了 PiDeck 的机器上也能跑；
// 后四条对真文件，必须在源码克隆根目录跑。
const REAL_STEPS = [
	["判据自检 fields", [DIR + "/check-fields.mjs", "--selftest"]],
	["判据自检 format", [DIR + "/check-format.mjs", "--selftest"]],
	["判据自检 paths", [DIR + "/check-paths.mjs", "--selftest"]],
	["正文标识符对源码 fields", [DIR + "/check-fields.mjs", "--src=src/main"]],
	["动作表与端点表对源码 doc", [DIR + "/check-doc.mjs"]],
	["API 路径逐段对源码 paths", [DIR + "/check-paths.mjs"]],
	["正文结构 format", [DIR + "/check-format.mjs"]],
	// 清单哈希前要归一化行尾：Windows 工作树是 CRLF、CI 检出是 LF，不归一就会在两边得出不同结论
	// （2026-11-15 让 Dev Guard 第 7 步红了三次）。这条自检喂 LF/CRLF 两串比哈希，变异 normalizeEol 会红。
	["清单行尾归一自检", ["scripts/generate-content-manifests.mjs", "--selftest"]],
];

// 自检用假步，不碰任何判据：聚合器的不变量只有「每条都跑、红的都点名、绿的记下来」，
// 假步就能证。让七个真判据各跑一遍只是把 CI 从 1 秒拖到 2 秒，证的东西一样。
const FAKE_STEPS = [
	["假步 绿", ["-e", "process.exit(0)"]],
	["假步 红甲", ["-e", "process.exit(1)"]],
	["假步 红乙", ["-e", "process.exit(1)"]],
];

const SELFTEST = process.argv.includes("--selftest");
const STEPS = SELFTEST ? FAKE_STEPS : REAL_STEPS;

const TIMEOUT_MS = 120000;

const failed = [];
for (const [name, args] of STEPS) {
	const started = Date.now();
	// timeout 是必须的：某个 check 读目录时挂住，没有上界就永久阻塞 CI，
	// 而 CI 卡住比红更难判断（红至少有名有姓）。
	const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: TIMEOUT_MS });
	const ms = Date.now() - started;
	const ok = r.status === 0;
	const how = r.status === null ? (r.signal ? "被信号 " + r.signal + " 终止" : "超时 " + TIMEOUT_MS + "ms") : "rc=" + r.status;
	if (!ok) failed.push(name);
	console.log((ok ? "OK   " : "FAIL ") + name.padEnd(28) + " " + how + "  " + ms + "ms");
	// 红的那条把输出带出来，绿的不带——否则七条的输出糊在一起，没人读。
	if (!ok) {
		const out = ((r.stdout || "") + (r.stderr || "")).trim();
		if (out)
			console.log(
				out
					.split(String.fromCharCode(10))
					.map((l) => "       " + l)
					.join(String.fromCharCode(10)),
			);
	}
}

if (SELFTEST) {
	const want = ["假步 红甲", "假步 红乙"];
	const ok = failed.length === want.length && want.every((w) => failed.includes(w));
	console.log(ok ? "selftest PASS：3 条假步，1 绿 2 红，红的都点名了，没有短路" : "selftest FAIL：failed=" + JSON.stringify(failed));
	process.exit(ok ? 0 : 1);
}

if (failed.length) {
	console.log("test:skills: " + STEPS.length + " 条，红 " + failed.length + " 条：" + failed.join("、"));
	process.exit(1);
}
console.log("test:skills: " + STEPS.length + " 条全绿");
