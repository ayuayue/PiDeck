#!/usr/bin/env node
/**
 * 社区 PR 首筛门禁（确定性部分）。规则来源：docs/pr-merge-gate.md。
 *
 *   node scripts/prGate.mjs --pr 123        # 走 gh 读 PR 元数据与 diff
 *   node scripts/prGate.mjs --pr 123 --json # 机器可读
 *
 * 退出码：0 = 通过或需人工；1 = 命中红线（block）。只读，不修改仓库。
 * 只在 GitHub 有网时可用；离线审查直接调用导出的 evaluatePull()。
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const LIMITS = {
	noteLines: 400,
	noteFiles: 20,
	manualLines: 1500,
	manualFiles: 60,
	blockLines: 5000,
	blockFiles: 300,
	/** 同一作者同文件连开 PR 的窗口（小时）与阈值，供人工复核用。 */
	burstHours: 48,
	burstPrs: 3,
};

const TEST_PATH = /(^|\/)(tests?|e2e)\//;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const DOCS_PATH = /\.(md|mdx|txt)$/;
const COPY_FILE = /rendererCopy\.[a-z]{2}(-[A-Z]{2})?\.ts$/;
const STYLE_FILE = /\.(css|scss|less)$/;

/** 命中即拒绝的补丁模式（只看新增行）。 */
const SECURITY_PATCH_RULES = [
	{ code: "R1_ELECTRON_ISOLATION_OFF", re: /\b(?:webSecurity\s*:\s*false|contextIsolation\s*:\s*false|nodeIntegration\s*:\s*true|sandbox\s*:\s*false)\b/ },
	{ code: "R3_ALLOW_SAME_ORIGIN", re: /\bsandbox\s*=\s*["'][^"']*allow-same-origin/ },
];

/** 密钥字面量：测试里常见「假 token」fixture，测试文件只提醒、源码算红线。 */
const SECRET_LITERAL = /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;

/** 需要人工看的补丁模式（不直接拒绝，但必须有人确认）。 */
const MANUAL_PATCH_RULES = [
	{ code: "R4_DYNAMIC_EXEC", re: /(?:^|[^.\w])(?:eval\s*\(|new\s+Function\s*\()/ },
	{ code: "R4_SHELL_INTERPOLATION", re: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*`[^`]*\$\{/ },
	{ code: "R4_SHELL_TRUE", re: /\bshell\s*:\s*true\b/ },
];

const isTestPath = (path) => TEST_PATH.test(path) || TEST_FILE.test(path);
const isDocPath = (path) => DOCS_PATH.test(path) || path.startsWith("docs/");
const isStylePath = (path) => STYLE_FILE.test(path);

function addedLines(patch) {
	if (!patch) return [];
	return patch
		.split("\n")
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
		.map((line) => line.slice(1));
}

function removedLines(patch) {
	if (!patch) return [];
	return patch
		.split("\n")
		.filter((line) => line.startsWith("-") && !line.startsWith("---"))
		.map((line) => line.slice(1));
}

/** 按文件切分 diff，规则需要知道改动落在 tests/ 还是 src/。 */
function splitPatch(patch) {
	const sections = new Map();
	let path = "";
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
			path = match ? match[2] : "";
			if (!sections.has(path)) sections.set(path, { added: [], removed: [] });
			continue;
		}
		const section = sections.get(path);
		if (!section) continue;
		if (line.startsWith("+") && !line.startsWith("+++")) section.added.push(line.slice(1));
		else if (line.startsWith("-") && !line.startsWith("---")) section.removed.push(line.slice(1));
	}
	return sections;
}

/**
 * 对一个 PR 做确定性首筛。
 * @param {object} pull `{ number, title, author, additions, deletions, changedFiles, files, patch }`
 *   files: `[{ path, additions, deletions }]`；patch: 统一 diff 文本（可空）。
 * @returns {{ verdict: "allow"|"manual"|"block", reasons: Array<{code:string,level:string,detail:string}>, facts: object }}
 */
export function evaluatePull(pull) {
	const files = Array.isArray(pull.files) ? pull.files : [];
	const totalLines = (pull.additions ?? 0) + (pull.deletions ?? 0);
	const changedFiles = pull.changedFiles ?? files.length;
	const patch = pull.patch ?? "";
	const added = addedLines(patch);
	const removed = removedLines(patch);
	const sections = splitPatch(patch);
	// 没有 diff 头的补丁（离线调用）退化成全局行，按「任意文件」处理。
	const collect = (pathFilter, key) => (sections.size === 0 ? (key === "added" ? added : removed) : [...sections].filter(([file]) => pathFilter(file)).flatMap(([, section]) => section[key]));
	const reasons = [];
	const push = (level, code, detail) => reasons.push({ code, level, detail });

	// —— 尺寸 ——
	if (totalLines > LIMITS.blockLines || changedFiles > LIMITS.blockFiles) {
		push("block", "SIZE_BLOCK", `${totalLines} 行 / ${changedFiles} 文件，超过拒绝阈值（${LIMITS.blockLines} 行 / ${LIMITS.blockFiles} 文件），要求拆片`);
	} else if (totalLines > LIMITS.manualLines || changedFiles > LIMITS.manualFiles) {
		push("manual", "SIZE_LARGE", `${totalLines} 行 / ${changedFiles} 文件，禁止自动合并，需人工 + 该域 e2e`);
	} else if (totalLines > LIMITS.noteLines || changedFiles > LIMITS.noteFiles) {
		push("note", "SIZE_NOTE", `${totalLines} 行 / ${changedFiles} 文件，PR 描述需含复现步骤与测试证据`);
	}

	// —— 安全红线（只看新增行）——
	for (const rule of SECURITY_PATCH_RULES) {
		const hit = added.find((line) => rule.re.test(line));
		if (hit) push("block", rule.code, `新增行命中：${hit.trim().slice(0, 160)}`);
	}
	for (const rule of MANUAL_PATCH_RULES) {
		const hit = added.find((line) => rule.re.test(line));
		if (hit) push("manual", rule.code, `新增行需人工确认：${hit.trim().slice(0, 160)}`);
	}
	const secretHits = sections.size === 0 ? added.filter((line) => SECRET_LITERAL.test(line)).map((line) => ({ path: "", line })) : [...sections].flatMap(([file, section]) => section.added.filter((line) => SECRET_LITERAL.test(line)).map((line) => ({ path: file, line })));
	const leakedInSource = secretHits.filter((hit) => !isTestPath(hit.path));
	if (leakedInSource.length > 0) {
		push("block", "R5_SECRET_LITERAL", `新增行命中：${leakedInSource[0].line.trim().slice(0, 160)}`);
	} else if (secretHits.length > 0) {
		push("manual", "R5_SECRET_IN_TEST", `测试文件新增疑似密钥字面量 ${secretHits.length} 处，确认是 fixture`);
	}

	// —— 依赖与安装脚本（只看 package.json 的 hunk）——
	const pkg = sections.get("package.json") ?? {};
	if ((pkg.added ?? []).some((line) => /^\s*"(?:pre|post)?install"\s*:/.test(line))) {
		push("manual", "R2_INSTALL_SCRIPT", "package.json 新增 install 类脚本");
	}
	const META_KEYS = /^(?:name|version|description|main|module|types|type|private|license|author|homepage|repository|engines|packageManager|productName|appId)$/;
	const depChanges = (pkg.added ?? [])
		.map((line) => /^\s*"([^"]+)"\s*:\s*"[\^~]?[0-9]/.exec(line))
		.filter((match) => match && !META_KEYS.test(match[1]))
		.map((match) => match[1]);
	if (depChanges.length > 0) {
		push("manual", "R2_DEPENDENCY_CHANGE", `package.json 依赖变更：${[...new Set(depChanges)].slice(0, 8).join(", ")}`);
	}

	// —— 证据 ——
	const sourceFiles = files.filter((file) => !isTestPath(file.path) && !isDocPath(file.path) && !isStylePath(file.path) && !COPY_FILE.test(file.path));
	const testFiles = files.filter((file) => isTestPath(file.path));
	const srcLines = sourceFiles.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);
	if (sourceFiles.length > 0 && testFiles.length === 0 && srcLines > 0) {
		push("manual", "NO_TEST_EVIDENCE", `改了 ${sourceFiles.length} 个源码文件但零测试变更`);
	}
	// 排除 `RE.test(`、`obj.it(` 这类方法调用：只看独立的 test/it/describe 声明。
	const removedTests = collect(isTestPath, "removed").filter((line) => /(?:^|[^\w.$])(?:test|it|describe)\s*\(/.test(line));
	if (removedTests.length > 0) {
		const names = removedTests
			.map((line) => /(?:^|[^\w.$])(?:test|it|describe)\s*\(\s*["'`]([^"'`]{0,60})/.exec(line)?.[1])
			.filter(Boolean)
			.slice(0, 3);
		push("manual", "TEST_DELETED", `删除了 ${removedTests.length} 处测试用例${names.length > 0 ? `：${names.join("；")}` : ""}，需确认功能确实移除`);
	}
	const newSourceOnly = collect(isTestPath, "added").filter((line) => /readFileSync\(\s*(?:["'`]src\/|new URL\(\s*["'`]\.\.\/src\/)/.test(line));
	if (newSourceOnly.length > 0) {
		push("manual", "SOURCE_ONLY_TEST", "新增只读源码的断言，check:test-shape 会拒绝");
	}
	const zhCn = files.some((file) => file.path.endsWith("rendererCopy.zh-CN.ts"));
	const zhTw = files.some((file) => file.path.endsWith("rendererCopy.zh-TW.ts"));
	if (zhCn && !zhTw) {
		push("manual", "I18N_NOT_REGENERATED", "改了 zh-CN 词典但未带 zh-TW 生成物，需跑 node scripts/genZhTwCopy.mjs");
	}

	const facts = {
		number: pull.number ?? null,
		author: pull.author ?? null,
		totalLines,
		changedFiles,
		sourceFiles: sourceFiles.length,
		testFiles: testFiles.length,
		docsOnly: files.length > 0 && files.every((file) => isDocPath(file.path)),
	};
	const order = { block: 0, manual: 1, note: 2 };
	reasons.sort((a, b) => order[a.level] - order[b.level]);
	const verdict = reasons.some((reason) => reason.level === "block") ? "block" : reasons.some((reason) => reason.level === "manual") ? "manual" : "allow";
	return { verdict, reasons, facts };
}

function fetchPull(number) {
	const meta = JSON.parse(
		execFileSync("gh", ["pr", "view", String(number), "--json", "number,title,author,additions,deletions,changedFiles,files"], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		}),
	);
	const patch = execFileSync("gh", ["pr", "diff", String(number), "--patch"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	return {
		number: meta.number,
		title: meta.title,
		author: meta.author?.login ?? null,
		additions: meta.additions,
		deletions: meta.deletions,
		changedFiles: meta.changedFiles,
		files: meta.files ?? [],
		patch,
	};
}

function render(result, pull) {
	const lines = [];
	lines.push(`PR #${result.facts.number ?? "?"}${pull?.title ? ` · ${pull.title}` : ""}`);
	lines.push(`作者 ${result.facts.author ?? "?"} · ${result.facts.totalLines} 行 · ${result.facts.changedFiles} 文件 · 源码 ${result.facts.sourceFiles} / 测试 ${result.facts.testFiles}`);
	lines.push(`判定：${result.verdict.toUpperCase()}`);
	for (const reason of result.reasons) lines.push(`- [${reason.level}] ${reason.code}：${reason.detail}`);
	if (result.verdict === "block") lines.push("下一步：拒绝合并，在回复里列出上面的阻塞项，不输出合并标记。");
	else if (result.verdict === "manual") lines.push("下一步：人工确认上面每一项后再决定；无法确认就不给合并标记。");
	else lines.push("下一步：仍需按 docs/pr-merge-gate.md 人工看语义，脚本只覆盖可判定部分。");
	return lines.join("\n");
}

async function main(argv) {
	const json = argv.includes("--json");
	const index = argv.indexOf("--pr");
	const number = index >= 0 ? argv[index + 1] : null;
	if (!number) {
		console.error("用法：node scripts/prGate.mjs --pr <编号> [--json]");
		process.exit(2);
	}
	const pull = fetchPull(number);
	const result = evaluatePull(pull);
	console.log(json ? JSON.stringify({ pull: { number: pull.number, title: pull.title, author: pull.author }, ...result }, null, 2) : render(result, pull));
	process.exit(result.verdict === "block" ? 1 : 0);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	await main(process.argv.slice(2));
}
