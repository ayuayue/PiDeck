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
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 2026-11-18：技能正文按任务拆到 references/ 下。路径与判据同处更新，
// 少改一处就会出现「判据跑的还是旧文件、全绿但没检查新内容」。
const SKILL_DIR = "resources/skills/pideck";
const CHECK_DIR = "scripts/skills/pideck";
const SKILL_MD = SKILL_DIR + "/SKILL.md";
const REFERENCES_DIR = SKILL_DIR + "/references";

/** 列出参与判据的 markdown（SKILL.md + references/ 下全部），排序保证输出稳定。 */
function listMarkdown() {
	const result = [];
	const walk = (dir) => {
		for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const rel = `${dir}/${entry.name}`;
			if (entry.isDirectory()) walk(rel);
			else if (entry.name.endsWith(".md")) result.push(rel);
		}
	};
	walk(REFERENCES_DIR);
	return [SKILL_MD, ...result];
}

// 自检用假步，不碰任何判据：聚合器的不变量只有「每条都跑、红的都点名、绿的记下来」，
// 假步就能证。让十几条真判据各跑一遍只是把 CI 从 1 秒拖到 2 秒，证的东西一样。
const FAKE_STEPS = [
	["假步 绿", ["-e", "process.exit(0)"]],
	["假步 红甲", ["-e", "process.exit(1)"]],
	["假步 红乙", ["-e", "process.exit(1)"]],
];

const SELFTEST = process.argv.includes("--selftest");

let tempDir = null;
let mdFiles = [];
let webApiFiles = [];
let STEPS = FAKE_STEPS;
if (!SELFTEST) {
	mdFiles = listMarkdown();
	// paths / fields 只对 web-api 参考有意义：其余参考写的是外部供应商端点与示例路径，
	// 对 PiDeck 源码天然「零命中」，拼进来会把两条判据变成恒红。
	webApiFiles = mdFiles.filter((file) => file.startsWith(REFERENCES_DIR + "/web-api/"));
	// paths / fields 都要求「全文里至少有 N 条路径 / 标识符」，单份短文档过不了这条下限。
	// 拼成一份临时聚合文件跑一次，既保留逐词/逐段口径，又不用为每份文件复制源码扫描。
	tempDir = mkdtempSync(path.join(os.tmpdir(), "pideck-skills-checks-"));
	const combined = path.join(tempDir, "web-api.md");
	const webApiText = webApiFiles
		.map(
			(file) => `

<!-- ${file} -->

${readFileSync(path.join(ROOT, file), "utf8")}`,
		)
		.join("");
	writeFileSync(combined, webApiText, "utf8");
	// 拆分后正文分散在多份文件里，节号引用必须能指向别的文件。汇总全部标题号传给 check-format；
	// 不传时它只认同文件标题（拆文件前的口径），跨文件引用会假红。
	const sections = [...new Set([...webApiText.matchAll(/^##+\s+([0-9]+(?:\.[0-9]+)?)/gm)].map((match) => match[1]))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	const sectionsArg = "--sections=" + sections.join(",");
	STEPS = [
		["判据自检 fields", [CHECK_DIR + "/check-fields.mjs", "--selftest"]],
		["判据自检 format", [CHECK_DIR + "/check-format.mjs", "--selftest"]],
		["判据自检 paths", [CHECK_DIR + "/check-paths.mjs", "--selftest"]],
		["判据自检 self-contained", [CHECK_DIR + "/check-self-contained.mjs", "--selftest"]],
		["判据自检 round-robin", [CHECK_DIR + "/check-round-robin.mjs", "--selftest"]],
		["正文标识符对源码 fields", [CHECK_DIR + "/check-fields.mjs", combined]],
		["动作表与端点表对源码 doc", [CHECK_DIR + "/check-doc.mjs"]],
		["API 路径逐段对源码 paths", [CHECK_DIR + "/check-paths.mjs", combined]],
		// 格式判据按文件跑：报错行号落在哪一份里一眼可见，汇总文件只会给一个拼接后的行号。
		...mdFiles.map((file) => ["正文结构 format " + path.relative(SKILL_DIR, file), [CHECK_DIR + "/check-format.mjs", file, sectionsArg]]),
		// 清单哈希前要归一化行尾：Windows 工作树是 CRLF、CI 检出是 LF，不归一就会在两边得出不同结论
		// （2026-11-15 让 Dev Guard 第 7 步红了三次）。这条自检喂 LF/CRLF 两串比哈希，变异 normalizeEol 会红。
		["清单行尾归一自检", ["scripts/generate-content-manifests.mjs", "--selftest"]],
		// 2026-11-15 评审指出：这个脚本写了 --selftest 但没人跑，等于自检也只写在纸上。
		["版本判据自检", ["scripts/check-version-not-lower.mjs", "--selftest"]],
	];
}

const TIMEOUT_MS = 120000;

const failed = [];
try {
	for (const [name, args] of STEPS) {
		const started = Date.now();
		// timeout 是必须的：某个 check 读目录时挂住，没有上界就永久阻塞 CI，
		// 而 CI 卡住比红更难判断（红至少有名有姓）。
		const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: TIMEOUT_MS });
		const ms = Date.now() - started;
		const ok = r.status === 0;
		const how = r.status === null ? (r.signal ? "被信号 " + r.signal + " 终止" : "超时 " + TIMEOUT_MS + "ms") : "rc=" + r.status;
		if (!ok) failed.push(name);
		console.log((ok ? "OK   " : "FAIL ") + name.padEnd(34) + " " + how + "  " + ms + "ms");
		// 红的那条把输出带出来，绿的不带——否则十几条的输出糊在一起，没人读。
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
} finally {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
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
console.log("test:skills: " + STEPS.length + " 条全绿（覆盖 " + mdFiles.length + " 份 md；paths/fields 覆盖 " + webApiFiles.length + " 份 web-api 参考）");
