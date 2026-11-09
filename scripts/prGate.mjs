#!/usr/bin/env node
/**
 * 社区 PR 首筛门禁（确定性部分）。规则来源：docs/pr-merge-gate.md。
 *
 *   node scripts/prGate.mjs --pr 123        # 走 gh 读 PR 元数据与 diff
 *   node scripts/prGate.mjs --pr 123 --json # 机器可读
 *   node scripts/prGate.mjs --pr 123 --allow-protected  # 维护者本人改门禁/CI 时放行 R6
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
};

/**
 * 门禁自身与 CI 定义：PR 能改这些文件，就等于能改判自己的规则。
 * 维护者确需改动时用 `--allow-protected` 显式放行（见 docs/pr-merge-gate.md §1 R6）。
 */
const PROTECTED_PATHS = [/^scripts\/prGate\.mjs$/, /^tests\/prGate\.test\.mjs$/, /^scripts\/check-[\w-]+\.mjs$/, /^scripts\/testShapeBaseline\.json$/, /^\.github\/workflows\//, /^biome[.\w-]*\.jsonc?$/];

const TEST_PATH = /(^|\/)(tests?|e2e)\//;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const DOCS_PATH = /\.(md|mdx|txt)$/;
const COPY_FILE = /rendererCopy\.[a-z]{2}(-[A-Z]{2})?\.ts$/;
const STYLE_FILE = /\.(css|scss|less)$/;

/**
 * 命中即拒绝的隔离回归（只看新增行）。
 * 极性拆开写、`:` 与 `=` 都覆盖：仓库现有的写法是赋值式（`src/main/index.ts:2671`
 * `webPreferences.nodeIntegration = false`），旧版只认对象字面量 `key: value`，照抄邻居写法的 PR 直接绕过。
 */
const ISOLATION_REGRESSION_RULES = [
	{ code: "R1_ELECTRON_ISOLATION_OFF", re: /\b(?:webSecurity|contextIsolation)\b["']?\s*(?::|=)\s*false\b/ },
	{ code: "R1_ELECTRON_ISOLATION_OFF", re: /\bnodeIntegration(?:InWorker|InSubFrames)?\b["']?\s*(?::|=)\s*true\b/ },
];
/** 主窗口当前就是 `sandbox:false`（`src/main/index.ts:2882`），只能人工确认是否扩大关闭范围，不能一律拒绝。 */
const SANDBOX_OFF = /\bsandbox\b["']?\s*(?::|=)\s*false\b/;
const ALLOW_SAME_ORIGIN = /\bsandbox\s*=\s*["'][^"']*allow-same-origin/;

/** 密钥字面量：测试里常见「假 token」fixture，测试文件只提醒、源码算红线。 */
const SECRET_LITERAL = /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
/** 泛用密钥赋值（`apiKey = "…"`）：真 key 常常不是上面四种形状。 */
const SECRET_ASSIGNMENT = /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i;
const SECRET_PLACEHOLDER = /process\.env|example|placeholder|dummy|redacted|fixture/i;
/** pi 活跃会话文件的直接读写（AGENTS.md 铁律 2）。 */
const JSONL_WRITE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|renameSync|rename|truncateSync|rmSync|unlinkSync|copyFileSync)\s*\(/;
/** 新增的凭据类文件：内容不进 diff，只能按路径拒。 */
const SENSITIVE_FILE = /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|[^/]+\.(?:pem|p12|pfx|key|keystore|jks))$/i;
const E2E_SPEC = /^e2e\/.+\.(?:spec|test)\.ts$/;
/** 基础设施而非产品代码：只改这些不该要求单测证据。 */
const INFRA_FILE = /^\.github\//;
/** 产品代码：改门禁又改这些文件 = 高风险混合 PR（见 R6）。 */
const APP_SOURCE = /^(?:src|resources|native)\//;

/** 需要人工看的补丁模式（不直接拒绝，但必须有人确认）。 */
const MANUAL_PATCH_RULES = [
	{ code: "R4_DYNAMIC_EXEC", re: /(?:^|[^.\w])(?:eval\s*\(|new\s+Function\s*\()/ },
	{ code: "R4_SHELL_INTERPOLATION", re: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*`[^`]*\$\{/ },
	// 真实注入形态通常是「命令在别处拼好」：仓库惯例是 execFile + 参数数组（207 处），
	// exec/execSync 接变量属于例外，需要人看一眼。字面量首参不报。
	{ code: "R4_EXEC_NON_LITERAL", re: /(?:^|[^.\w])(?:exec|execSync)\s*\(\s*[A-Za-z_$(]/ },
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
			if (!sections.has(path)) sections.set(path, { added: [], removed: [], isNew: false });
			continue;
		}
		if (line.startsWith("new file mode ")) {
			const section = sections.get(path);
			if (section) section.isNew = true;
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
 * @param {{ allowProtected?: boolean }} [options] allowProtected: 维护者改门禁自身时显式放行（R6）。
 * @returns {{ verdict: "allow"|"manual"|"block", reasons: Array<{code:string,level:string,detail:string}>, facts: object }}
 */
export function evaluatePull(pull, options = {}) {
	const files = Array.isArray(pull.files) ? pull.files : [];
	const totalLines = (pull.additions ?? 0) + (pull.deletions ?? 0);
	const changedFiles = pull.changedFiles ?? files.length;
	const patch = pull.patch ?? "";
	const added = addedLines(patch);
	const removed = removedLines(patch);
	const sections = splitPatch(patch);
	// 没有 diff 头的补丁（离线调用）退化成全局行，按「任意文件」处理。
	const collect = (pathFilter, key) => (sections.size === 0 ? (key === "added" ? added : removed) : [...sections].filter(([file]) => pathFilter(file)).flatMap(([, section]) => section[key]));
	const addedWithPath = sections.size === 0 ? added.map((line) => ({ path: "", line })) : [...sections].flatMap(([file, section]) => section.added.map((line) => ({ path: file, line })));
	const firstHit = (re) => addedWithPath.find((entry) => re.test(entry.line));
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

	// —— R6 门禁自改 ——
	// 规则与基线都在被审的仓库里：不拦这一条，PR 可以「改产品代码顺便放宽判自己的尺子」。
	// 只改 scripts/CI/docs 的 PR 不拦（一眼可看，且维护者天天发），只留一条 note。
	const touchedPaths = [...new Set([...files.map((file) => file.path), ...sections.keys()])].filter(Boolean);
	const protectedTouched = touchedPaths.filter((path) => PROTECTED_PATHS.some((re) => re.test(path)));
	if (!options.allowProtected && protectedTouched.length > 0) {
		const appSourceTouched = touchedPaths.filter((path) => APP_SOURCE.test(path));
		if (appSourceTouched.length > 0) {
			push("block", "SELF_PROTECTED_PATH", `改了门禁/CI（${protectedTouched.slice(0, 3).join(", ")}）又带产品代码（${appSourceTouched.slice(0, 3).join(", ")}）：只能维护者本人合，确有必要加 --allow-protected`);
		} else {
			push("note", "SELF_PROTECTED_PATH", `只改门禁/CI：${protectedTouched.slice(0, 3).join(", ")}，确认不是放宽判定口径`);
		}
	}

	// —— 安全红线（只看新增行）——
	for (const rule of ISOLATION_REGRESSION_RULES) {
		const hit = firstHit(rule.re);
		if (!hit) continue;
		// 测试里的开关是 fixture / 断言对象，不算红线，但仍要有人看一眼
		const inTest = isTestPath(hit.path);
		push(inTest ? "manual" : "block", rule.code, `${inTest ? "测试文件新增" : "新增行命中"}：${hit.line.trim().slice(0, 160)}`);
	}
	const sandboxOff = firstHit(SANDBOX_OFF);
	if (sandboxOff) push("manual", "R1_SANDBOX_OFF", `新增行关 sandbox：${sandboxOff.line.trim().slice(0, 160)}（主窗口当前就是 sandbox:false，确认不是扩大范围）`);
	const sameOrigin = firstHit(ALLOW_SAME_ORIGIN);
	if (sameOrigin) push("block", "R3_ALLOW_SAME_ORIGIN", `新增行命中：${sameOrigin.line.trim().slice(0, 160)}`);
	for (const rule of MANUAL_PATCH_RULES) {
		const hit = firstHit(rule.re);
		if (hit) push("manual", rule.code, `新增行需人工确认：${hit.line.trim().slice(0, 160)}`);
	}
	const secretHits = addedWithPath.filter((entry) => SECRET_LITERAL.test(entry.line));
	const leakedInSource = secretHits.filter((hit) => !isTestPath(hit.path));
	if (leakedInSource.length > 0) {
		push("block", "R5_SECRET_LITERAL", `新增行命中：${leakedInSource[0].line.trim().slice(0, 160)}`);
	} else if (secretHits.length > 0) {
		push("manual", "R5_SECRET_IN_TEST", `测试文件新增疑似密钥字面量 ${secretHits.length} 处，确认是 fixture`);
	}
	const assignmentHits = addedWithPath.filter((entry) => !isDocPath(entry.path) && SECRET_ASSIGNMENT.test(entry.line) && !SECRET_PLACEHOLDER.test(entry.line));
	if (assignmentHits.length > 0) push("manual", "R5_SECRET_ASSIGNMENT", `疑似把密钥写成字面量：${assignmentHits[0].line.trim().slice(0, 160)}`);
	// 只给「pi 活跃会话文件」提醒：evidence/*.jsonl 这类自建日志不在此列。
	const jsonlWrite = addedWithPath.find((entry) => /^src\/main\//.test(entry.path) && JSONL_WRITE.test(entry.line) && /\.jsonl\b/.test(entry.line) && /session|\.pi[\\/]|piDir|sessionsDir/i.test(entry.line));
	if (jsonlWrite) push("manual", "R5_PI_JSONL_WRITE", `新增 .jsonl 写入：${jsonlWrite.line.trim().slice(0, 160)}（会话文件只走专用写入路径 / context_edit）`);
	const sensitiveFile = [...sections].find(([file, section]) => section.isNew && SENSITIVE_FILE.test(file));
	if (sensitiveFile) push("block", "R5_SENSITIVE_FILE", `新增凭据类文件 ${sensitiveFile[0]}`);

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
	const sourceFiles = files.filter((file) => !isTestPath(file.path) && !isDocPath(file.path) && !isStylePath(file.path) && !COPY_FILE.test(file.path) && !INFRA_FILE.test(file.path));
	const testFiles = files.filter((file) => isTestPath(file.path));
	const srcLines = sourceFiles.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);
	if (sourceFiles.length > 0 && testFiles.length === 0 && srcLines > 0) {
		push("manual", "NO_TEST_EVIDENCE", `改了 ${sourceFiles.length} 个源码文件但零测试变更`);
	}
	// 排除 `RE.test(`、`obj.it(` 这类方法调用：只看独立的 test/it/describe 声明。
	// 「只读源码的测试」口径归 scripts/check-test-shape.mjs（CI 里跑，含运行时加载豁免）：不再在这里重复一份更窄的正则。
	// 计数按「净减少」算：重构时删旧用例+加新用例是正常动作（实测占已合并 PR 的 46%，全按删除报会把门禁淹掉）。
	const TEST_DECL = /(?:^|[^\w.$])(?:test|it|describe)\s*\(/;
	const removedTests = collect(isTestPath, "removed").filter((line) => TEST_DECL.test(line));
	const addedTests = collect(isTestPath, "added").filter((line) => TEST_DECL.test(line));
	if (removedTests.length > addedTests.length) {
		const names = removedTests
			.map((line) => /(?:^|[^\w.$])(?:test|it|describe)\s*\(\s*["'`]([^"'`]{0,60})/.exec(line)?.[1])
			.filter(Boolean)
			.slice(0, 3);
		push("manual", "TEST_DELETED", `用例净减少 ${removedTests.length - addedTests.length} 处（删 ${removedTests.length} / 加 ${addedTests.length}）${names.length > 0 ? `：${names.join("；")}` : ""}，需确认功能确实移除`);
	}
	// 新增 e2e 本身是好事。但 #502 的形态是「不走共享 launcher、自己在 spec 里 launch」——
	// 那种 spec 要自己重定向 USERPROFILE/HOME，漏了就会写真实 profile（合并 12 分钟后回归）。
	const newE2eSpec = [...sections].find(([file, section]) => section.isNew && E2E_SPEC.test(file));
	if (newE2eSpec) {
		const selfLaunch = newE2eSpec[1].added.some((line) => /\b_electron\b/.test(line));
		if (selfLaunch) push("manual", "E2E_SELF_LAUNCH", `新增 e2e 用例 ${newE2eSpec[0]} 自己 launch Electron（未走 e2e/fixtures）：确认 USERPROFILE/HOME 已重定向、不写真实 profile（#502 教训）`);
		else push("note", "E2E_NEW_SPEC", `新增 e2e 用例 ${newE2eSpec[0]}`);
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
	const allowProtected = argv.includes("--allow-protected");
	const index = argv.indexOf("--pr");
	const number = index >= 0 ? argv[index + 1] : null;
	if (!number) {
		console.error("用法：node scripts/prGate.mjs --pr <编号> [--json] [--allow-protected]");
		process.exit(2);
	}
	const pull = fetchPull(number);
	const result = evaluatePull(pull, { allowProtected });
	console.log(json ? JSON.stringify({ pull: { number: pull.number, title: pull.title, author: pull.author }, ...result }, null, 2) : render(result, pull));
	process.exit(result.verdict === "block" ? 1 : 0);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	await main(process.argv.slice(2));
}
