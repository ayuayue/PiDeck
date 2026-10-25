#!/usr/bin/env node
/**
 * release preflight——发版前门禁，一条命令并行跑完全部自动化检查并收集结果。
 *
 *   npm run preflight                              # 默认泳道：typecheck + 单测 + 格式 + 发布一致性
 *   npm run preflight -- --e2e                     # 追加 Playwright E2E（慢，含 build:fast 完整构建）
 *   npm run preflight -- --skip unit-tests         # 日常快速通道（跳过最慢的单测泳道）
 *   npm run preflight -- --only release            # 只跑指定泳道（逗号分隔可多个）
 *   npm run preflight -- --test-concurrency 8      # 单测并发（默认 4，与 npm test 一致）
 *   npm run preflight -- --list                    # 列出泳道
 *
 * 设计：
 * - 泳道（lane）之间并行、泳道内步骤顺序执行；全部跑完才汇总（不首错即停），
 *   一次看到所有问题——发版检查的价值在全景而不是流水线。
 * - 失败输出只打印尾部（tsc/node --test 的错误都在末尾），完整 JSON 报告落盘
 *   release-preflight 目录（release 前缀已在 .gitignore，不会污染工作区）。
 * - 子进程一律数组参数 + error 监听（AGENTS 安全约束）；超时杀整棵进程树
 *   （Windows taskkill /T，POSIX 独立进程组 SIGKILL），Ctrl+C 同样清理，不留孤儿。
 * - 各检查与 docs/release-process.md 的人工项一一对应：机器能判的都在这里，
 *   人工保留项（README 描述准确性、安装包 smoke）见文档。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN = 60_000;
/** 每个步骤的输出环形上限：只留尾部，防大输出（单测/tsc）撑爆内存与 JSON 报告。 */
const OUTPUT_CAP = 256 * 1024;

/** 解析 CLI 参数。非法输入直接抛错（main 转成退出码 2），导出供单测。 */
export function parsePreflightArgs(argv) {
	const args = { only: new Set(), skip: new Set(), e2e: false, list: false, testConcurrency: 4 };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--e2e") args.e2e = true;
		else if (flag === "--list") args.list = true;
		else if (flag === "--only" || flag === "--skip") {
			const ids = (argv[++i] ?? "")
				.split(",")
				.map((id) => id.trim())
				.filter(Boolean);
			if (!ids.length) throw new Error(`${flag} 需要逗号分隔的泳道 id`);
			for (const id of ids) (flag === "--only" ? args.only : args.skip).add(id);
		} else if (flag === "--test-concurrency") {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value < 1) throw new Error("--test-concurrency 需要正整数");
			args.testConcurrency = value;
		} else {
			throw new Error(`未知参数：${flag}（可用：--e2e --list --only <ids> --skip <ids> --test-concurrency <n>）`);
		}
	}
	return args;
}

function scriptStep(label, scriptPath, args = []) {
	return { label, file: process.execPath, args: [scriptPath, ...args] };
}

/** 发布一致性泳道：repo 里所有 --check 型脚本 + 本目录新增的 check-release-consistency。 */
function releaseSteps() {
	const steps = [
		scriptStep("版本/CHANGELOG/README 一致性", join(ROOT, "scripts/check-release-consistency.mjs")),
		scriptStep("workflow choices 下拉已同步", join(ROOT, "scripts/sync-workflow-choices.js"), ["--check"]),
		scriptStep("README 亮点区块已同步", join(ROOT, "scripts/sync-release-notes.js"), ["--check"]),
		scriptStep("pi-ai 模型目录清单", join(ROOT, "scripts/generate-pi-ai-catalog.mjs"), ["--check"]),
		scriptStep("内置扩展清单", join(ROOT, "scripts/generate-extensions-manifest.mjs"), ["--check"]),
		scriptStep("提示词库清单", join(ROOT, "scripts/generate-content-manifests.mjs"), ["--domain", "prompts", "--check"]),
		scriptStep("技能库清单", join(ROOT, "scripts/generate-content-manifests.mjs"), ["--domain", "skills", "--check"]),
		scriptStep("公告 json 与 md 同步", join(ROOT, "scripts/build-announcements.js"), ["--check"]),
		scriptStep("提示词库可检索性", join(ROOT, "scripts/check-xueprompts.mjs")),
		scriptStep("DSH wire payload 形状", join(ROOT, "scripts/check-dsh-wire-payloads.mjs")),
		scriptStep("Electron 二进制体检", join(ROOT, "scripts/check-electron.mjs")),
	];
	// DSH runtime 归档由 runtime:pack 产出、npm run build 会重打包：产物在就校验，
	// 不在就跳过并说明原因（preflight 常在构建前跑，不能拿缺失当失败）。
	const tgz = join(ROOT, "dist-runtime", `dsh-runtime-${process.platform}-${process.arch}.tgz`);
	steps.push(existsSync(tgz) ? scriptStep("DSH runtime 归档完整性", join(ROOT, "scripts/check-dsh-asar.mjs")) : { label: "DSH runtime 归档完整性", skipReason: `未找到 ${relative(ROOT, tgz)}——先跑 npm run runtime:pack 再校验` });
	return steps;
}

/** 泳道表。导出供单测断言（步骤脚本存在性、参数、e2e 开关）。 */
export function buildLanes({ testConcurrency, e2e }) {
	const lanes = [
		{
			id: "typecheck",
			label: "TypeScript 类型检查",
			timeoutMs: 10 * MIN,
			steps: [scriptStep("tsc --noEmit", join(ROOT, "node_modules/typescript/bin/tsc"), ["--noEmit"])],
		},
		{
			id: "unit-tests",
			label: `单元测试（--test-concurrency=${testConcurrency}）`,
			// 多 agent 并行开发时机器可能同时胞多个测试进程，全量套件会显著变慢；
			// 实测空闲机 ~4min，抢资源时 >20min，这里放宽到 30min 减少误杀。
			timeoutMs: 30 * MIN,
			steps: [
				{
					label: "node --test tests/**",
					file: process.execPath,
					args: ["--test", `--test-concurrency=${testConcurrency}`, "tests/*.test.mjs", "tests/cua/*.test.mjs"],
				},
			],
		},
		{
			id: "format",
			label: "biome 格式检查",
			timeoutMs: 5 * MIN,
			steps: [scriptStep("biome format（check 模式）", join(ROOT, "node_modules/@biomejs/biome/bin/biome"), ["format", "src", "tests", "scripts", "e2e"])],
		},
		{ id: "release", label: "发布一致性", timeoutMs: 10 * MIN, steps: releaseSteps() },
	];
	if (e2e) {
		// test:e2e 是 npm 复合脚本（build:fast && playwright test），不值得拆步骤复刻；
		// Windows 上 .cmd 直 spawn 会 EINVAL（Node 安全补丁），走 cmd.exe /c 数组参数，不进 shell 拼接。
		const win32 = process.platform === "win32";
		lanes.push({
			id: "e2e",
			label: "Playwright E2E（build:fast + e2e）",
			timeoutMs: 30 * MIN,
			steps: [{ label: "npm run test:e2e", file: win32 ? "cmd.exe" : "npm", args: win32 ? ["/d", "/c", "npm", "run", "test:e2e"] : ["run", "test:e2e"] }],
		});
	}
	return lanes;
}

/** 泳道选择：--only 优先，--skip 在其上过滤；未知 id 立即报错，避免静默跑错范围。 */
export function selectLanes(lanes, { only, skip }) {
	const known = new Set(lanes.map((lane) => lane.id));
	for (const id of [...only, ...skip]) {
		if (!known.has(id)) throw new Error(`未知泳道 id：${id}（可用：${[...known].join(", ")}）`);
	}
	return lanes.filter((lane) => (only.size === 0 ? true : only.has(lane.id))).filter((lane) => !skip.has(lane.id));
}

const activeChildren = new Set();

/** 杀整棵子进程树：Windows taskkill /T /F；POSIX 杀进程组（spawn 时 detached 建组）。 */
function killTree(child) {
	if (!child.pid) {
		child.kill("SIGKILL");
		return;
	}
	if (process.platform === "win32") {
		const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		tk.on("error", () => child.kill("SIGKILL"));
	} else {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}
}

function runStep(step, timeoutMs) {
	return new Promise((resolve) => {
		if (step.skipReason) {
			resolve({ label: step.label, skipped: true, skipReason: step.skipReason, durationMs: 0 });
			return;
		}
		const started = Date.now();
		const chunks = [];
		let buffered = 0;
		const child = spawn(step.file, step.args, {
			cwd: ROOT,
			stdio: ["ignore", "pipe", "pipe"],
			// POSIX 上放独立进程组：超时/中断能整组收割 node --test 自己再起的子进程
			detached: process.platform !== "win32",
		});
		activeChildren.add(child);
		let timedOut = false;
		const onChunk = (buf) => {
			chunks.push(buf);
			buffered += buf.length;
			// 环形上限：丢最老的块，只保尾部（错误摘要在末尾，头部是进度噪音）
			while (buffered > OUTPUT_CAP && chunks.length > 1) {
				buffered -= chunks.shift().length;
			}
		};
		child.stdout.on("data", onChunk);
		child.stderr.on("data", onChunk);
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, timeoutMs);
		const finish = (exitCode) => {
			clearTimeout(timer);
			activeChildren.delete(child);
			resolve({
				label: step.label,
				command: `${step.file} ${step.args.join(" ")}`,
				exitCode,
				timedOut,
				durationMs: Date.now() - started,
				output: chunks.join(""),
			});
		};
		// spawn 失败（文件不存在等）也走 finish 收集，绝不裸 error 崩主进程
		child.on("error", (error) => {
			chunks.push(Buffer.from(`\n[preflight] 进程启动失败：${error.message}\n`));
			finish(-1);
		});
		child.on("close", (exitCode) => finish(exitCode));
	});
}

/** 只保留输出尾部 N 行（去掉末尾空行）——tsc / node --test 的失败摘要在末尾。 */
export function tail(output, maxLines) {
	const lines = (output ?? "").split(/\r?\n/);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.slice(-maxLines).join("\n");
}

async function runLane(lane) {
	const started = Date.now();
	const steps = [];
	console.log(`▶ ${lane.label}`);
	for (const step of lane.steps) {
		const result = await runStep(step, lane.timeoutMs);
		steps.push(result);
		const mark = result.skipped ? "⏭️ " : result.exitCode === 0 && !result.timedOut ? "✓" : "✗";
		const detail = result.skipped ? `（跳过：${result.skipReason}）` : ` ${(result.durationMs / 1000).toFixed(1)}s`;
		console.log(`  ${mark} ${result.label}${detail}`);
	}
	return { id: lane.id, label: lane.label, durationMs: Date.now() - started, steps };
}

function gitInfo() {
	// 报告附 git 快照（分支/commit/脏文件数）用于事后追溯；git 缺失不阻断
	try {
		const run = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
		const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
		const commit = run(["rev-parse", "--short", "HEAD"]);
		const status = run(["status", "--porcelain"]);
		if (status.status !== 0) return null;
		return {
			branch: branch.stdout.trim(),
			commit: commit.stdout.trim(),
			dirtyFiles: status.stdout.trim() ? status.stdout.trim().split(/\r?\n/).length : 0,
		};
	} catch {
		return null;
	}
}

async function main() {
	let args;
	try {
		args = parsePreflightArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error.message);
		process.exit(2);
		return;
	}
	const allLanes = buildLanes({ testConcurrency: args.testConcurrency, e2e: args.e2e });
	if (args.list) {
		console.log(allLanes.map((lane) => `${lane.id} — ${lane.label}（${lane.steps.length} 步）`).join("\n"));
		return;
	}
	let lanes;
	try {
		lanes = selectLanes(allLanes, args);
	} catch (error) {
		console.error(error.message);
		process.exit(2);
		return;
	}
	if (lanes.length === 0) {
		console.log("没有可跑的泳道");
		return;
	}

	const startedAt = new Date();
	console.log(`release preflight —— ${lanes.map((lane) => lane.id).join(" + ")} 泳道并行执行\n`);
	const laneResults = await Promise.all(lanes.map((lane) => runLane(lane)));

	const stepFailed = (step) => !step.skipped && (step.exitCode !== 0 || step.timedOut);
	const failures = laneResults.flatMap((lane) => lane.steps.filter(stepFailed).map((step) => ({ lane: lane.id, step })));
	const ok = failures.length === 0;

	console.log("\n=== 汇总 ===");
	for (const lane of laneResults) {
		const bad = lane.steps.some(stepFailed);
		console.log(`${bad ? "✗" : "✓"} ${lane.id.padEnd(12)} ${(lane.durationMs / 1000).toFixed(1)}s`);
	}
	for (const { lane, step } of failures) {
		console.log(`\n--- ${lane} / ${step.label} 失败（退出码 ${step.exitCode}${step.timedOut ? "，超时被杀" : ""}）尾部输出 ---`);
		console.log(tail(step.output, 50) || "（无输出）");
	}

	const reportDir = join(ROOT, "release-preflight");
	mkdirSync(reportDir, { recursive: true });
	const report = {
		startedAt: startedAt.toISOString(),
		finishedAt: new Date().toISOString(),
		node: process.version,
		git: gitInfo(),
		ok,
		lanes: laneResults.map((lane) => ({
			id: lane.id,
			durationMs: lane.durationMs,
			steps: lane.steps.map((step) => ({
				label: step.label,
				exitCode: step.exitCode ?? null,
				timedOut: step.timedOut ?? false,
				skipped: step.skipped ?? false,
				skipReason: step.skipReason,
				durationMs: step.durationMs,
				// 报告里存更长的尾部（400 行），控制台只打 50 行
				outputTail: step.skipped ? "" : tail(step.output, 400),
			})),
		})),
	};
	const reportFile = join(reportDir, `report-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
	writeFileSync(reportFile, JSON.stringify(report, null, "\t"));
	writeFileSync(join(reportDir, "latest.json"), JSON.stringify(report, null, "\t"));

	console.log(`\n报告：${relative(ROOT, reportFile)}（另存 latest.json）`);
	console.log(ok ? "✅ 全部通过" : `❌ ${failures.length} 个步骤失败`);
	process.exitCode = ok ? 0 : 1;
}

// Ctrl+C / SIGTERM 时清理全部子树再退出，不留孤儿测试进程
process.on("SIGINT", () => {
	console.log("\n中断，清理子进程…");
	for (const child of [...activeChildren]) killTree(child);
	process.exit(130);
});
process.on("SIGTERM", () => {
	for (const child of [...activeChildren]) killTree(child);
	process.exit(143);
});

// 直接执行时才跑 main；被测试 import 时不产生副作用（不挂信号监听以外的逻辑）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
