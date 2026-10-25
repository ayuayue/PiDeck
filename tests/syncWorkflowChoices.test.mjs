import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 纯规则模块：脚本用 CommonJS 写的（.js），测试用 createRequire 取它的纯函数，
// 只做文本/数据结构转换，不碰网络，可直接断言。
// 覆盖点集中在三类易错处：版本解析（前缀/beta/去重）、哨兵值保留、自动链调用方式。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts/sync-workflow-choices.js");
const { parseVersions, rewriteOptions } = createRequire(import.meta.url)("../scripts/sync-workflow-choices.js");

const TARGET_FILES = [".github/workflows/release.yml", ".github/workflows/publish-dsh-runtime.yml", ".github/workflows/publish-dsh-runner-node.yml", ".github/workflows/release-linux-manual.yml", ".github/workflows/sync-atomgit.yml"];

/** 取出某个 workflow 里指定输入的 options 列表（按文件顺序）。 */
function readOptions(file, inputName) {
	const text = readFileSync(join(repoRoot, file), "utf8");
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => line === `      ${inputName}:`);
	assert.notEqual(start, -1, `${file} 里应有输入 ${inputName}`);
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^ {6}\S/.test(lines[i])) {
			end = i;
			break;
		}
	}
	const optionsIdx = lines.findIndex((line, i) => i > start && i < end && line.trim() === "options:");
	assert.notEqual(optionsIdx, -1, `${file}#${inputName} 应是 choice（有 options）`);
	const result = [];
	for (let i = optionsIdx + 1; i < end; i++) {
		const m = lines[i].match(/^\s{10}- (.*)$/);
		if (!m) break;
		result.push(m[1]);
	}
	return result;
}

test("sync-workflow-choices: 仓库当前的下拉列表与 CHANGELOG 一致（--check 必须通过）", () => {
	// 发版清单依赖这个断言：CI 里跑 --check 时，列表漂了就会红。
	const out = execFileSync(process.execPath, [script, "--check"], { cwd: repoRoot, encoding: "utf8" });
	assert.match(out, /已是最新|已更新/, `--check 应报告状态，实际输出：${out}`);
});

test("sync-workflow-choices: 所有 tag 下拉都保留 v 前缀（workflow 里必须写真实 tag 名）", () => {
	for (const file of TARGET_FILES) {
		const input = file.endsWith("sync-atomgit.yml") ? "tags" : "tag";
		const options = readOptions(file, input);
		const versionLike = options.slice(1); // 首项是哨兵值
		assert.ok(versionLike.length > 0, `${file} 下拉里应至少有版本项`);
		for (const option of versionLike) {
			assert.match(option, /^v\d+\.\d+\.\d+$/, `${file} 选项 ${option} 必须是带 v 前缀的真实 tag（曾因正则吃掉 v 而写错）`);
		}
		// 新→旧排序：MAJOR.MINOR.PATCH 单调不增
		const nums = versionLike.map((v) => v.slice(1).split(".").map(Number));
		for (let i = 1; i < nums.length; i++) {
			const [pa, pb] = [nums[i - 1], nums[i]];
			const cmp = pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
			assert.ok(cmp > 0, `${file} 版本顺序应为新→旧，${versionLike[i - 1]} 后面不该是 ${versionLike[i]}`);
		}
	}
});

test("sync-workflow-choices: 允许 latest 语义的 workflow 首项是哨兵值 auto，且不是 auto 的输入必须 required", () => {
	// 哨兵值是「留空 = latest / 按 package.json 发版」这条旧语义的唯一载体，不能被脚本顶掉。
	// 例外：release-linux-manual.yml 的 tag 是 required 且语义就是具体版本，没有 auto。
	const sentinelFiles = [".github/workflows/release.yml", ".github/workflows/publish-dsh-runtime.yml", ".github/workflows/publish-dsh-runner-node.yml", ".github/workflows/sync-atomgit.yml"];
	for (const file of sentinelFiles) {
		const input = file.endsWith("sync-atomgit.yml") ? "tags" : "tag";
		assert.equal(readOptions(file, input)[0], "auto", `${file} 下拉首项必须是哨兵值 auto`);
	}
	const manual = readOptions(".github/workflows/release-linux-manual.yml", "tag")[0];
	assert.match(manual, /^v\d+\.\d+\.\d+$/, "release-linux-manual 是补发入口，首项必须是具体 tag");

	// choice 输入不接受空字符串选项，因此凡是带 auto 的 workflow 都必须有还原逻辑；
	// 同时每个 tag 输入都应配一个 tag_custom 兜底入口（列表外的旧版本）。
	for (const file of TARGET_FILES) {
		const text = readFileSync(join(repoRoot, file), "utf8");
		const input = file.endsWith("sync-atomgit.yml") ? "tags" : "tag";
		assert.match(text, new RegExp(`^      ${input}_custom:`, "m"), `${file} 缺少 ${input}_custom 兜底输入`);
		if (sentinelFiles.includes(file)) {
			assert.match(text, new RegExp(`\\$INPUT_TAG|\\bTAGS=|INPUT_TAG|TAGS=`), `${file} 应有哨兵值还原逻辑`);
			assert.match(text, new RegExp(`${input}_custom != ''`), `${file} 应让 ${input}_custom 覆盖下拉选择`);
		}
	}
});

test("sync-workflow-choices: 走 GitHub API 的整数 index 触发时 input 名不能再改（gh CLI 兼容）", () => {
	// 记录一个踩过的坑：gh workflow run 用整数 index 传 input 时依赖输入声明顺序，
	// 顺序变了会导致「1 号输入」的含义变化。这里锁定 sync-atomgit 前 4 个输入的顺序。
	const text = readFileSync(join(repoRoot, ".github/workflows/sync-atomgit.yml"), "utf8");
	const section = text.slice(text.indexOf("workflow_dispatch:"), text.indexOf("permissions:"));
	const order = [...section.matchAll(/^ {6}(\w+):/gm)].map((m) => m[1]);
	assert.deepEqual(order, ["tags", "tags_custom", "force_resync", "push_refs", "refs_only"]);
});

test("sync-workflow-choices: 自动链触发 sync-atomgit 必须用 tags_custom，不能用 choice 的 tags", () => {
	// 最关键的一条不变量：`type: choice` 的输入在 dispatch 时由服务端校验，
	// 值不在静态 options 列表里就直接 422 拒绝（cli/cli#5246）。发版自动化链
	// （post-release-sidecars → gh workflow run sync-atomgit.yml -f tags=...）是无人值守的，
	// 万一发版时忘了跑 sync-workflow-choices.js 把新 tag 插进列表，整条 AtomGit 同步
	// 就会静默断掉。所以自动链必须打无校验的 tags_custom。
	const sidecars = readFileSync(join(repoRoot, ".github/workflows/post-release-sidecars.yml"), "utf8");
	assert.match(sidecars, /gh workflow run sync-atomgit\.yml/, "自动链仍应触发 sync-atomgit");
	assert.match(sidecars, /-f "tags_custom=\$\{TAG\}"/, "自动链必须用 tags_custom=");
	assert.doesNotMatch(sidecars, /-f "tags=\$\{TAG\}"/, "自动链不能用受 options 校验的 tags=");
});

test("sync-workflow-choices: 脚本保留数量足够覆盖 CHANGELOG 里所有正式版本时不应报差异", () => {
	// 幂等性：把 --keep 设成当前列表长度（哨兵值不信版本数），跑两遍 --check 都应为「已是最新」。
	// 这样不依赖具体保留数量（DEFAULT_KEEP 改了也不会误报），只验证「同参数重跑无差异」。
	const listLength = readOptions(".github/workflows/release.yml", "tag").length - 1; // 减去哨兵值
	const run = () =>
		execFileSync(process.execPath, [script, "--check", "--keep", String(listLength)], {
			cwd: repoRoot,
			encoding: "utf8",
		});
	assert.match(run(), /已是最新/, "与当前列表长度一致的 --keep 应报告「已是最新」");
	assert.match(run(), /已是最新/, "重复执行必须幂等（第二次也不应报差异）");
});

test("sync-workflow-choices: parseVersions 保留 v 前缀、滤掉 beta、去重且保持新→旧顺序", () => {
	const changelog = ["# Changelog", "", "## v0.7.6 (2026-09-17)", "", "- 正式版", "", "## v0.7.6-beta", "", "- 预发布：不应进下拉", "", "## v0.7.6", "", "- 重复版本号：去重", "", "## 0.7.5", "", "- 不带 v 前缀也要归一成 v0.7.5", "", "## v0.7.4-rc.1", "", "- 带 rc 的预发布：同样滤掉"].join("\n");
	assert.deepEqual(parseVersions(changelog), ["v0.7.6", "v0.7.5"]);
});

test("sync-workflow-choices: parseVersions 跳过未发布（Unreleased）段", () => {
	const changelog = ["# Changelog", "", "## v0.7.9 (Unreleased)", "", "- 未发布：不应进下拉", "", "## v0.7.8 - 2026-09-26", "", "- 正式版（横杠日期写法）", "", "## v0.7.7 (2026-09-17)", "", "- 正式版（括号日期写法）"].join("\n");
	assert.deepEqual(parseVersions(changelog), ["v0.7.8", "v0.7.7"]);
});

test("sync-workflow-choices: rewriteOptions 保留哨兵值在首位，并把版本按传入顺序排列", () => {
	// 哨兵值（auto）不能出现在版本序列里；反过来，若首项已是版本号则不应误认成哨兵。
	const lines = ["      tag:", "        type: choice", "        default: auto", "        options:", "          - auto", "          - v0.7.6", "      tag_custom:", "        type: string"];
	const block = { start: 0, end: 7 };
	const result = rewriteOptions(lines, block, ["v0.8.0", "v0.7.6", "v0.7.5"], 10);
	assert.equal(result.changed, true);
	assert.deepEqual(result.after, ["auto", "v0.8.0", "v0.7.6", "v0.7.5"]);

	// 首项是版本号（release-linux-manual 的形态）时不得凭空补 auto
	const noSentinel = ["      tag:", "        type: choice", "        options:", "          - v0.7.6", "      tag_custom:"];
	const manual = rewriteOptions(noSentinel, { start: 0, end: 5 }, ["v0.8.0", "v0.7.6"], 10);
	assert.deepEqual(manual.after, ["v0.8.0", "v0.7.6"]);
});
