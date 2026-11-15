#!/usr/bin/env node
// 一次跑完全部内置技能判据，逐条打印退出码，最后汇总。
//
// 为什么不用 && 串联：第一条红之后后面的不执行。一次改动里有两处红，只看到一处，
// 修完再跑又冒出第二处——往返次数等于红的条数，而每一步都要等 CI。
// 这里每条都跑完再汇总，红的按名字列在末尾。
//
// 判据：全绿 rc=0；任一条非 0 → rc=1，末尾点名红的那几条。
// 坏样本：把任意一个 check 脚本改成 process.exit(1)，末尾必须点名它，
//   且其余条目仍出现在输出里（证明没有短路）。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = "resources/skills/pideck-web-api";

// 前三条只验判据自己（不读源码与文档），装了 PiDeck 的机器上也能跑；
// 后四条对真文件，必须在源码克隆根目录跑。
const STEPS = [
	["判据自检 fields", [DIR + "/check-fields.mjs", "--selftest"]],
	["判据自检 format", [DIR + "/check-format.mjs", "--selftest"]],
	["判据自检 paths", [DIR + "/check-paths.mjs", "--selftest"]],
	["正文标识符对源码 fields", [DIR + "/check-fields.mjs", "--src=src/main"]],
	["动作表与端点表对源码 doc", [DIR + "/check-doc.mjs"]],
	["API 路径逐段对源码 paths", [DIR + "/check-paths.mjs"]],
	["正文结构 format", [DIR + "/check-format.mjs"]],
];

const failed = [];
for (const [name, args] of STEPS) {
	const started = Date.now();
	const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
	const ms = Date.now() - started;
	const ok = r.status === 0;
	if (!ok) failed.push(name);
	console.log((ok ? "OK   " : "FAIL ") + name.padEnd(28) + " rc=" + r.status + "  " + ms + "ms");
	// 红的那条把输出带出来，绿的不带——否则七条的输出糊在一起，没人读。
	if (!ok) {
		const out = ((r.stdout || "") + (r.stderr || "")).trim();
		if (out) console.log(out.split(String.fromCharCode(10)).map((l) => "       " + l).join(String.fromCharCode(10)));
	}
}

if (failed.length) {
	console.log("test:skills: " + STEPS.length + " 条，红 " + failed.length + " 条：" + failed.join("、"));
	process.exit(1);
}
console.log("test:skills: " + STEPS.length + " 条全绿");
