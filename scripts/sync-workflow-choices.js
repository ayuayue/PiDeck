#!/usr/bin/env node

/**
 * scripts/sync-workflow-choices.js
 *
 * 发版时自动更新 workflow_dispatch 里「tag 下拉（type: choice）」的选项列表。
 *
 * 为什么需要它：
 *   GitHub 的 choice 选项只能是 workflow 文件里写死的静态列表 —— 无法用表达式动态读取
 *   仓库里的 tag/Release。手输改成下拉之后，代价是「每发一版都要把新 tag 加进列表」，
 *   忘了加的结果是：最新版不在下拉里，用户只能去填 tag_custom，等于改造没收益。
 *   所以把这件事交给脚本，列为发版流程的一步（AGENTS.md 发版要求）。
 *
 * 约定：
 *   - 列表首项是哨兵值（默认 auto），保持不动：它承载「跟随 GitHub 最新 Release / 按
 *     package.json 正式发版」的旧语义，不是一个具体版本号。
 *   - 具体版本按 CHANGELOG 的版本顺序（新→旧）排列，保留前 keep 个，更旧的版本一律走
 *     tag_custom 手输（这也是各 workflow 里 tag_custom 输入存在的意义）。
 *   - 幂等：重复执行不产生 diff；发版版本已经在列表里时也不产生 diff。
 *
 * 用法：
 *   node scripts/sync-workflow-choices.js                 # 预览（不写文件）
 *   node scripts/sync-workflow-choices.js --apply         # 应用
 *   node scripts/sync-workflow-choices.js --keep 8        # 自定义保留数量（默认 10）
 *   node scripts/sync-workflow-choices.js --check         # CI/发版校验：有差异则退出码 1
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// 需要维护 tag 下拉列表的 workflow 与其中的 choice 输入名。
// 用「文件 + 输入名」显式列举，而不是全目录扫描：
// 有些 workflow 的 tag 输入是 required 且没有哨兵值（如 release-linux-manual.yml），
// 自动识别容易误伤，显式列表更可控，新增文件时手加一行即可。
const TARGETS = [
	{ file: ".github/workflows/release.yml", input: "tag" },
	{ file: ".github/workflows/publish-dsh-runtime.yml", input: "tag" },
	{ file: ".github/workflows/publish-dsh-runner-node.yml", input: "tag" },
	{ file: ".github/workflows/release-linux-manual.yml", input: "tag" },
	{ file: ".github/workflows/sync-atomgit.yml", input: "tags" },
];

const DEFAULT_KEEP = 10;

/**
 * 从 CHANGELOG 文本解析版本号列表（新→旧）。
 * 拆成纯函数便于单元测试（版本前缀、beta 过滤、顺序、去重都在这里）。
 */
function parseVersions(changelogText) {
	const versions = [];
	for (const line of changelogText.split(/\r?\n/)) {
		// 保留 v 前缀：workflow 里填的必须是真实 tag 名（git tag 是 vX.Y.Z），
		// 只认 vX.Y.Z 与 X.Y.Z 两种写法，统一归一成带 v 的形式。
		const m = line.match(/^##\s+(v?)(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(.*)$/);
		if (!m) continue;
		// 只收正式版：beta/pre-release 不作为下拉的常规选项（要同步它们用 tag_custom）
		if (m[3]) continue;
		// 行尾只允许发布日期（`- 2026-09-26` 与 `(2026-09-17)` 两种历史写法）；
		// `## vX.Y.Z (Unreleased)` 还没发布，同样不能进下拉（发版后才补日期）。
		const tail = m[4].trim();
		if (tail && !/^(?:-\s*\d{4}-\d{2}-\d{2}|\(\s*\d{4}-\d{2}-\d{2}\s*\))$/.test(tail)) continue;
		const version = `v${m[2]}`;
		if (!versions.includes(version)) versions.push(version);
	}
	if (!versions.length) throw new Error("CHANGELOG 里没解析到任何正式版本号");
	return versions;
}

/**
 * CHANGELOG 是版本的唯一事实来源：发版要求里「加版本号与日期」是必做项，
 * Release 列表则可能夹带 beta/sidecar 等不适合放进下拉的 tag。
 */
function readVersionsFromChangelog() {
	const file = path.join(ROOT, "CHANGELOG.md");
	if (!fs.existsSync(file)) throw new Error(`找不到 ${file}`);
	return parseVersions(fs.readFileSync(file, "utf8"));
}

/** 在指定 workflow 文本里定位输入块的行范围（从 `      <input>:` 到下一个同级键）。 */
function locateInputBlock(lines, inputName) {
	const start = lines.findIndex((line) => line === `      ${inputName}:`);
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		// 同级输入（6 空格缩进的键）即下一个输入块的开始
		if (/^ {6}\S/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return { start, end };
}

/** 替换输入块里的 options 列表：保留首项（哨兵值），后面按 versions 顺序重排。 */
function rewriteOptions(lines, block, versions, keep) {
	const { start, end } = block;
	const optionsIdx = lines.findIndex((line, i) => i > start && i < end && line.trim() === "options:");
	if (optionsIdx === -1) return { changed: false, reason: "该输入不是 choice（没有 options 列表）" };

	let optionsEnd = end;
	for (let i = optionsIdx + 1; i < end; i++) {
		if (!/^\s{10}- /.test(lines[i])) {
			optionsEnd = i;
			break;
		}
	}
	const current = lines.slice(optionsIdx + 1, optionsEnd).map((line) => line.trim().replace(/^- /, ""));
	if (!current.length) return { changed: false, reason: "options 列表为空" };

	// 首项是哨兵值（auto / latest 之类非版本号），原样保留在最前
	const sentinel = /^v?\d+\.\d+\.\d+$/.test(current[0]) ? null : current[0];
	const desired = [...(sentinel ? [sentinel] : []), ...versions.slice(0, keep)];
	if (current.join("\n") === desired.join("\n")) return { changed: false, reason: "已是最新" };

	const indent = "          "; // options 项的缩进（与文件现有风格一致）
	const next = [...lines.slice(0, optionsIdx + 1), ...desired.map((v) => `${indent}- ${v}`), ...lines.slice(optionsEnd)];
	return { changed: true, lines: next, before: current, after: desired };
}

function main() {
	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const check = args.includes("--check");
	const keepArg = args.indexOf("--keep");
	const keep = keepArg !== -1 ? Number(args[keepArg + 1]) : DEFAULT_KEEP;
	if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep 需要一个正整数");

	const versions = readVersionsFromChangelog();
	console.log(`CHANGELOG 正式版本（新→旧）：${versions.slice(0, keep + 2).join(", ")}${versions.length > keep + 2 ? ", …" : ""}`);
	console.log(`保留前 ${keep} 个作为下拉选项${apply ? "（应用模式）" : check ? "（校验模式）" : "（预览模式，不写文件）"}\n`);

	let changed = 0;
	for (const target of TARGETS) {
		const file = path.join(ROOT, target.file);
		if (!fs.existsSync(file)) {
			console.log(`⚠️  ${target.file} 不存在，跳过`);
			continue;
		}
		const original = fs.readFileSync(file, "utf8");
		const eol = original.includes("\r\n") ? "\r\n" : "\n";
		const lines = original.split(/\r?\n/);
		const block = locateInputBlock(lines, target.input);
		if (!block) {
			console.log(`⚠️  ${target.file} 里找不到输入 \`${target.input}\`，跳过`);
			continue;
		}
		const result = rewriteOptions(lines, block, versions, keep);
		if (!result.changed) {
			console.log(`✅ ${target.file} (${target.input}) ${result.reason}`);
			continue;
		}
		changed++;
		console.log(`✏️  ${target.file} (${target.input})`);
		console.log(`     before: ${result.before.join(", ")}`);
		console.log(`     after : ${result.after.join(", ")}`);
		if (apply) fs.writeFileSync(file, result.lines.join(eol), "utf8");
	}

	console.log("");
	if (check && changed) {
		console.error(`❌ ${changed} 个 workflow 的 tag 下拉列表未同步，请运行：node scripts/sync-workflow-choices.js --apply`);
		process.exit(1);
	}
	if (changed && !apply) console.log(`ℹ️  预览模式：以上 ${changed} 处未写入，加 --apply 应用。`);
	else if (changed) console.log(`✅ 已更新 ${changed} 个 workflow。`);
	else console.log("✅ 全部 workflow 的 tag 下拉列表已是最新。");
}

// 直接执行才跑 main；被测试 import 时只导出纯函数，不产生副作用。
if (require.main === module) main();

// 供 tests/syncWorkflowChoices.test.mjs 直接断言纯函数（版本解析 / options 重写），
// 避免测试只能靠「跑一遍脚本再看文件」的间接方式，也方便后续接钩子。
module.exports = { parseVersions, rewriteOptions, locateInputBlock, TARGETS, DEFAULT_KEEP };
