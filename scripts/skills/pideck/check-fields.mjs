// 判据：文档里反引号包住的标识符，都得在源码 src/main 的 .ts 里整词出现过。
// 用法：node check-fields.mjs [文档路径] [--src=<完整源码 src 目录>]
//      node check-fields.mjs --selftest  只跑好坏两个样本，不读真源码。
//      拆分后的多份参考请传聚合文件（scripts/run-skills-checks.mjs 会拼）。
// 为什么要有它：文档里的字段名是手抄源码的，抄错一个字母，读者照着写就取不到值，
//   而渲染出来看不出差别（sessions 与 session 长得一样）。另外两个脚本只核对路由与路径，不看字段名。
// 会红的三种：文档里出现源码没有的标识符；源码目录读不到；读到的 .ts 少于 100 个。
//   第三种是防「克隆不完整时静默变绿」——另外两个脚本只读 2 个文件，这里要全量。
// 口径上限：它分不出「本项目源码字段名」与「外部系统的命令名、字段名」。md5sum、curl、mergeStateStatus 源码里永远没有，文档里给它们加反引号就会判红（2026-11-17 实测三次：md5sum、dupFields、mergeStateStatus）。
//   写法上避开：命令名与外部 API 字段名不加反引号，只给需要与源码对得上的标识符加。这条约定是判据能用的前提，不是可选项。
// 口径上限：整词包含判断，源码里用拼串构造的字段名会误红——实测过：源码写 "total" + "Bytes"、文档写 totalBytes 时判红，那不是文档错。
//   整串不中再判最后一段（文档 body.target.sessionId 对源码 body.target?.sessionId）。
//   所以 foo.bar.sessionId 这种路径前缀写错抓不到，只有字段名本体写错才红。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SELFTEST = process.argv.includes("--selftest");
const srcArg = process.argv.find((a) => a.startsWith("--src="));
const skillArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const SKILL = skillArg || path.resolve(here, "../../..", "resources/skills/pideck/references/web-api/actions.md");
const SRC = srcArg ? srcArg.slice(6) : path.resolve(here, "../../../src/main");
const TICK = String.fromCharCode(96);

function collect(dir) {
	let blob = "",
		files = 0;
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".ts")) {
				blob += fs.readFileSync(p, "utf8");
				files += 1;
			}
		}
	};
	walk(dir);
	return { blob, files };
}

function check(skillPath, blob) {
	const doc = fs.readFileSync(skillPath, "utf8");
	const re = new RegExp(TICK + "([A-Za-z][A-Za-z0-9_.]{2,40})" + TICK, "g");
	const words = new Set();
	let m;
	while ((m = re.exec(doc))) {
		const w = m[1];
		if (w.includes("/") || w.includes(":") || w.endsWith(".mjs") || w.endsWith(".ts")) continue;
		words.add(w);
	}
	const hit = (w) => blob.includes(w) || (w.includes(".") && blob.includes(w.split(".").pop()));
	const miss = [...words].filter((w) => !hit(w));
	return { total: words.size, miss };
}

if (SELFTEST) {
	const dir = path.join(here, "..", "..", "..", "node_modules", ".cache-check-fields");
	fs.mkdirSync(dir, { recursive: true });
	const sample = path.join(dir, "sample.md");
	const body = "坏样本：" + TICK + "totallyFakeFieldName" + TICK + " 与 " + TICK + "sessions" + TICK + " 与 " + TICK + "body.target.sessionId" + TICK + "。";
	let ok1 = false,
		ok2 = false;
	try {
		fs.writeFileSync(sample, body, "utf8");
		const r1 = check(sample, "const sessions = 1; const sessionId = 2;");
		ok1 = r1.miss.length === 1 && r1.miss[0] === "totallyFakeFieldName";
		console.log("坏样本：应红 1 个，实得 " + r1.miss.length + " 个（" + r1.miss.join(",") + "）→ " + (ok1 ? "PASS" : "FAIL"));
	} finally {
		fs.rmSync(sample, { force: true });
	}
	try {
		fs.writeFileSync(sample, body, "utf8");
		const r2 = check(sample, "const sessions = 1; const sessionId = 2; const totallyFakeFieldName = 3;");
		ok2 = r2.miss.length === 0;
		console.log("好样本：应绿，实得 " + r2.miss.length + " 个零命中 → " + (ok2 ? "PASS" : "FAIL"));
	} finally {
		fs.rmSync(sample, { force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
	process.exit(ok1 && ok2 ? 0 : 1);
}

if (!fs.existsSync(SRC)) {
	console.log("FAIL 找不到源码目录 " + SRC + "（克隆不完整时用 --src= 指向完整 src）；这是环境缺失，rc=2");
	process.exit(2);
}
// 两条边界，方向相反：少于 100 = 克隆不完整（下面这条），多到离谱 = 目录里进了生成文件。
// 上限不是性能优化——2026-11-15 实测 1027 个 .ts 跑 0.32 秒，一万个才会开始拖；
// 它挡的是「目录结构悄悄变了没人说」。同仓 injection-map-fix.mjs（MAX_DEPTH/MAX_ENTRIES）
// 与 check-contradiction.mjs（MAX_FILES）都有上限，就这一处漏了。
const MAX_FILES = 5000;
const { blob, files } = collect(SRC);
if (files > MAX_FILES) {
	console.log("FAIL 扫到 " + files + " 个 .ts，超过上限 " + MAX_FILES + "：源码目录里是不是进了生成文件？确认后把上限调大");
	process.exit(1);
}
if (files < 100) {
	console.log("FAIL 只读到 " + files + " 个 .ts，源码目录不完整 " + SRC + "（用 --src= 指向完整 src）；这是环境缺失，rc=2");
	process.exit(2);
}
const { total, miss } = check(SKILL, blob);
if (miss.length) {
	console.log("FAIL " + SKILL + "：反引号标识符 " + total + " 个，源码里零命中 " + miss.length + " 个");
	for (const w of miss) console.log("  源码里找不到：" + w);
	process.exit(1);
}
console.log("PASS " + SKILL + "：反引号标识符 " + total + " 个，全部在源码里出现（" + files + " 个 .ts）");
