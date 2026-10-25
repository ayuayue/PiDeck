import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as tar from "tar";

/**
 * check-dsh-asar 归档闸门的**行为**回归：2026-09 v0.7.5 sidecar 事故中，
 * file: 本地包 dsh-tool-pwsh-persistent 缺 lib/（编译产物被 gitignore），
 * 坏归档却因为 exports 里有 "./package.json"（该文件必然存在）被判成
 * 「入口可解析」而静默通过校验，一路发到用户手里 → host require.resolve 崩。
 *
 * 这里直接造一个最小归档跑真实脚本，断言：
 *  - 只有 src/（缺 lib/index.js）时闸门必须红（exit != 0）；
 *  - 补上 lib/index.js 后闸门必须绿。
 * 只断行为不断实现，改成任何实现都不能再放行坏包。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkScript = join(repoRoot, "scripts", "check-dsh-asar.mjs");

// 与 check-dsh-asar 的 REQUIRED / ENTRY_PACKAGES 基线保持同源：闸门先要求这些包都在。
const REQUIRED = [
	"cordis-plugin-group",
	"dsh-anonymous-user-id",
	"dsh-atomic-write",
	"dsh-bash-local",
	"dsh-ptc-runtime-node",
	"dsh-compaction",
	"dsh-fs",
	"dsh-output-retention",
	"dsh-sandbox",
	"dsh-scope",
	"dsh-session-telemetry",
	"dsh-session-title-llm",
	"dsh-shell",
	"dsh-spill",
	"dsh-subagent-fork-in-process",
	"dsh-subagent-spawn-in-process",
	"dsh-subprocess",
	"dsh-timeout",
	"dsh-workflow",
].map((name) => `@deepseek-ai/${name}`);

const ENTRY_PACKAGES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-app-boot", "@deepseek-ai/dsh-cmdline", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-api-session-controller", "dsh-bill"];

/** 造一个「除目标包外全部合规」的最小 runtime 归档；withLib 控制事故复现与否。
 *  ptyLayout: "nested" = 真实布局（dsh-subprocess-local 下嵌套副本）、"top" = npm 提升到顶层、
 *  "none" = 整个包缺席。 */
async function buildFixture({ withLib, nestedKoffi = false, brokenKoffi = false, ptyLayout = "nested" }) {
	const src = mkdtempSync(join(tmpdir(), "dsh-gate-src-"));
	const writePkg = (name, extra = {}) => {
		const dir = join(src, "node_modules", ...name.split("/"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...extra }));
	};
	for (const name of [...REQUIRED, ...ENTRY_PACKAGES]) writePkg(name);
	// 交叉打包引入的原生资产门禁（406e78de）：目标平台的 sharp/koffi/rg 平台包与
	// node-pty 的 prebuilds/<platform>-<arch>/ 必须在位，最小归档也跟着摆齐。
	const target = `${process.platform}-${process.arch}`;
	for (const name of [`@img/sharp-${target}`, `@koromix/koffi-${target}`, `@vscode/ripgrep-${target}`]) {
		writePkg(name);
	}
	// 闸门钉死的关键文件：koffi 的 src 入口（入口解析看不到的间接 require）
	const koffiRoot = join(src, "node_modules", ...(nestedKoffi ? ["@deepseek-ai", "dsh-shell", "node_modules"] : []), "koffi");
	mkdirSync(join(koffiRoot, "src", "koffi"), { recursive: true });
	writeFileSync(join(koffiRoot, "package.json"), JSON.stringify({ name: "koffi", main: "index.cjs" }));
	writeFileSync(join(koffiRoot, "index.cjs"), 'module.exports = require("./src/koffi/index.cjs");');
	if (!brokenKoffi) writeFileSync(join(koffiRoot, "src", "koffi", "index.cjs"), "module.exports = {};");
	// node-pty 的运行时归谁不固定：pwsh 本地包下线后只剩 dsh-subprocess-local 的
	// 嵌套副本（真实归档布局），旧版可能有 npm 提升的顶层副本。两者都必须放行。
	if (ptyLayout !== "none") {
		const ptyRoot = ptyLayout === "top" ? join(src, "node_modules", "node-pty") : join(src, "node_modules", "@deepseek-ai", "dsh-subprocess-local", "node_modules", "node-pty");
		mkdirSync(ptyRoot, { recursive: true });
		writeFileSync(join(ptyRoot, "package.json"), JSON.stringify({ name: "node-pty", main: "lib/index.js" }));
		mkdirSync(join(ptyRoot, "lib"), { recursive: true });
		writeFileSync(join(ptyRoot, "lib", "index.js"), "module.exports = {};");
		// node-pty 的平台 prebuild 目录（win32 上 conpty.dll 是硬运行时依赖）
		mkdirSync(join(ptyRoot, "prebuilds", target), { recursive: true });
		writeFileSync(join(ptyRoot, "prebuilds", target, "pty.node"), "");
	}

	// 事故包：exports 同时声明 "." → lib/index.js 与 "./package.json"（元数据导出）;
	// 它是 file: 本地包形态的合成夹具（真实包不随仓库存在，也不能进 ENTRY_PACKAGES）。
	const culprit = join(src, "node_modules", "dsh-file-local-pkg");
	mkdirSync(culprit, { recursive: true });
	writeFileSync(
		join(culprit, "package.json"),
		JSON.stringify({
			name: "dsh-file-local-pkg",
			version: "0.1.2",
			main: "lib/index.js",
			exports: { ".": "./lib/index.js", "./package.json": "./package.json" },
		}),
	);
	mkdirSync(join(culprit, "src"), { recursive: true });
	writeFileSync(join(culprit, "src", "index.ts"), "export const x = 1;");
	if (withLib) {
		mkdirSync(join(culprit, "lib"), { recursive: true });
		writeFileSync(join(culprit, "lib", "index.js"), "export const x = 1;");
	}

	writeFileSync(join(src, "manifest.json"), JSON.stringify({ schemaVersion: 1, runtimeVersion: "0.1.5-rc.1", archiveSha256: "" }));

	const archivePath = join(mkdtempSync(join(tmpdir(), "dsh-gate-out-")), "dsh-runtime-fixture.tgz");
	await tar.c(
		{
			gzip: true,
			file: archivePath,
			cwd: src,
			portable: true,
			onWriteEntry: (entry) => {
				entry.path = `dsh-runtime/${entry.path}`;
			},
		},
		["./manifest.json", "./node_modules"],
	);
	return { archivePath, cleanup: () => [src, dirname(archivePath)].forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

test("归档闸门：缺 lib/ 的 file: 本地包不能被 ./package.json 导出放行（2026-09 事故回归）", async () => {
	const { archivePath, cleanup } = await buildFixture({ withLib: false });
	try {
		let status = 0;
		let stderr = "";
		try {
			execFileSync(process.execPath, [checkScript, archivePath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			status = err.status;
			stderr = err.stderr ?? "";
		}
		assert.notEqual(status, 0, "缺 lib/index.js 的归档必须校验失败（旧实现被 ./package.json 骗过）");
		// 归档条目路径前缀随 tar 输入形式变化（./node_modules → dsh-runtime/./…），只钉包名段
		assert.match(stderr, /no resolvable entry: .*dsh-file-local-pkg \(main=lib\/index\.js/);
	} finally {
		cleanup();
	}
});

test("归档闸门：合法嵌套 koffi 不依赖 npm 提升到顶层", async () => {
	const { archivePath, cleanup } = await buildFixture({ withLib: true, nestedKoffi: true });
	try {
		assert.match(execFileSync(process.execPath, [checkScript, archivePath], { encoding: "utf8" }), /OK\s+/);
	} finally {
		cleanup();
	}
});

test("归档闸门：嵌套 koffi 缺少间接 src 入口也必须失败", async () => {
	const { archivePath, cleanup } = await buildFixture({ withLib: true, nestedKoffi: true, brokenKoffi: true });
	try {
		assert.throws(
			() => execFileSync(process.execPath, [checkScript, archivePath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
			(error) => /missing critical file: .*koffi.*src\/koffi\/index\.cjs/.test(error.stderr),
		);
	} finally {
		cleanup();
	}
});

test("归档闸门：node-pty 只在 dsh-subprocess-local 下嵌套也必须放行（不要求 npm 提升）", async () => {
	const { archivePath, cleanup } = await buildFixture({ withLib: true, ptyLayout: "nested" });
	try {
		assert.match(execFileSync(process.execPath, [checkScript, archivePath], { encoding: "utf8" }), /OK\s+/);
	} finally {
		cleanup();
	}
});

test("归档闸门：node-pty 被 npm 提升到顶层也放行（历史归档布局）", async () => {
	const { archivePath, cleanup } = await buildFixture({ withLib: true, ptyLayout: "top" });
	try {
		assert.match(execFileSync(process.execPath, [checkScript, archivePath], { encoding: "utf8" }), /OK\s+/);
	} finally {
		cleanup();
	}
});

test("归档闸门：node-pty 整个缺席必须失败（原生模块依赖不能被静默裁掉）", async () => {
	const { archivePath, cleanup } = await buildFixture({ withLib: true, ptyLayout: "none" });
	try {
		assert.throws(
			() => execFileSync(process.execPath, [checkScript, archivePath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
			(error) => /missing critical package: node-pty/.test(error.stderr),
		);
	} finally {
		cleanup();
	}
});

test("归档闸门：补上 lib/index.js 后同一归档必须放行", async () => {
	const { archivePath, cleanup } = await buildFixture({ withLib: true });
	try {
		const stdout = execFileSync(process.execPath, [checkScript, archivePath], { encoding: "utf8" });
		assert.match(stdout, /OK\s+\d+ baseline \+ \d+ entry packages present/);
	} finally {
		cleanup();
	}
});
