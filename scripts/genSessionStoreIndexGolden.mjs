#!/usr/bin/env node
/**
 * 生成 session-store 条目表 parity 基准（Wave 2）。
 *
 * 用法：node scripts/genSessionStoreIndexGolden.mjs [--bin <session-store 可执行文件>]
 *
 * 流程：构建（或复用 --bin）native/session-store 的二进制 → 对
 * tests/fixtures/sessionStoreIndexParity.jsonl 发一次 get-index → 把表写到
 * tests/fixtures/sessionStoreIndexParity.golden.json。
 *
 * 基准是「Go 侧真实输出」：tests/sessionStoreIndexParity.test.mjs 用它证明 Go 的表与 TS 的
 * parseIndexLine 语义等价；native/session-store/parity_test.go 用它证明 Go 自身没漂移。
 * 改动任何一侧的解析语义后都要重跑本脚本（golden 与 TS 语义不符时测试会红）。
 *
 * golden 里的 path 换成仓库相对路径、mtimeMs 归零：这两项与机器无关，避免每次生成都产生噪音 diff
 * （Go 侧 parity_test.go 比较前做同样的归一化）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GO_DIR = join(REPO_ROOT, "native", "session-store");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "sessionStoreIndexParity.jsonl");
const GOLDEN = join(REPO_ROOT, "tests", "fixtures", "sessionStoreIndexParity.golden.json");
const REQUEST_TIMEOUT_MS = 60_000;

function fail(message) {
	process.stderr.write(`✖ ${message}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const options = { bin: null };
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--bin") options.bin = argv[index + 1] ?? null;
	}
	return options;
}

/** 构建 sidecar（本机平台，CGO 关闭）：与 scripts/build-session-store.mjs 的口径一致。 */
function buildBinary(outputPath) {
	if (!existsSync(join(GO_DIR, "go.mod"))) fail(`找不到 Go 模块：${GO_DIR}`);
	const result = spawnSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", outputPath, "."], {
		cwd: GO_DIR,
		env: { ...process.env, CGO_ENABLED: "0" },
		stdio: "inherit",
	});
	if (result.status !== 0) fail("go build 失败（需要本机 Go 1.26 或 GOTOOLCHAIN=auto 自动拉取）");
}

/** 跑一次 get-index：边写请求边等响应（NDJSON，按 id 配对）。 */
function requestIndexTable(binaryPath, statePath, fixturePath) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(binaryPath, [statePath], { stdio: ["pipe", "pipe", "pipe"] });
		let buffer = "";
		let ready = false;
		const timer = setTimeout(() => {
			child.kill();
			rejectPromise(new Error(`get-index 超时（${REQUEST_TIMEOUT_MS}ms 未收到响应）`));
		}, REQUEST_TIMEOUT_MS);
		const finish = (error, table) => {
			clearTimeout(timer);
			// Windows：子进程退出前文件仍被占用（rm 会 EPERM），等 close 再结算。
			child.once("close", () => {
				if (error) rejectPromise(error);
				else resolvePromise(table);
			});
			child.kill();
		};
		child.on("error", (error) => finish(error));
		child.stderr.on("data", (chunk) => process.stderr.write(chunk));
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const record = JSON.parse(line);
				if (record.type === "ready" && !ready) {
					ready = true;
					child.stdin.write(`${JSON.stringify({ cmd: "get-index", id: 1, roots: [], path: fixturePath })}\n`);
					continue;
				}
				if (record.type === "response" && record.id === 1) {
					if (!record.ok) finish(new Error(`get-index 失败：${record.error ?? "unknown"}`));
					else finish(null, record.result);
				}
			}
		});
	});
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!existsSync(FIXTURE)) fail(`找不到 fixture：${FIXTURE}`);
	const workDir = mkdtempSync(join(tmpdir(), "pideck-session-store-golden-"));
	try {
		const binaryPath = options.bin ?? join(workDir, process.platform === "win32" ? "session-store.exe" : "session-store");
		if (!options.bin) buildBinary(binaryPath);
		const table = await requestIndexTable(binaryPath, join(workDir, "state.bin"), FIXTURE);
		if (!table || !Array.isArray(table.entries) || table.entries.length === 0) fail("get-index 没有返回条目");
		table.path = relative(REPO_ROOT, FIXTURE).replace(/\\/g, "/");
		table.mtimeMs = 0;
		writeFileSync(GOLDEN, `${JSON.stringify(table, null, 2)}\n`, "utf8");
		process.stdout.write(`✔ ${relative(REPO_ROOT, GOLDEN).replace(/\\/g, "/")}：${table.entries.length} 条条目，${table.oversizedLines} 条超长行，endsWithNewline=${table.endsWithNewline}\n`);
	} finally {
		try {
			rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch (error) {
			process.stderr.write(`⚠ 临时目录未清理（不影响 golden）：${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
}

await main();
