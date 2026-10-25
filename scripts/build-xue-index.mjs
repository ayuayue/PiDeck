#!/usr/bin/env node
/**
 * 构建 Go 侧 xue-index 二进制（提示词库检索 sidecar）到 resources/xue-index/bin/。
 *
 * 目标平台来源（优先级）：--os/--arch 参数 > XUE_INDEX_OS/XUE_INDEX_ARCH 环境变量（CI 传入）> 宿主平台。
 * fail-open 是硬约定：Go 工具链缺失或构建失败时只告警、exit 0——CI 与 npm run build 不因此红灯，
 * 应用运行时探测不到二进制会自动回退现有 sql.js 路径（见 src/main/prompts/XueIndexService.ts）。
 *
 * 产物目录被 .gitignore 忽略（只留 .gitkeep），electron-builder 经 extraResources
 * 把 bin/ 打进安装包（package.json → build.extraResources "resources/xue-index/bin" → "xue-index"）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const goSourceDir = path.join(repoRoot, "native", "xue-index");
const outputDir = path.join(repoRoot, "resources", "xue-index", "bin");

function parseArgs(argv) {
	const target = { os: null, arch: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--os" && argv[i + 1]) target.os = argv[++i];
		else if (argv[i] === "--arch" && argv[i + 1]) target.arch = argv[++i];
	}
	if (process.env.XUE_INDEX_OS) target.os ??= process.env.XUE_INDEX_OS;
	if (process.env.XUE_INDEX_ARCH) target.arch ??= process.env.XUE_INDEX_ARCH;
	return target;
}

/** 外部输入规范化到 Go 形态：win32→windows、darwin/macos→darwin、x64→amd64、ia32→386 */
function normalizeTarget(raw) {
	const value = String(raw || "")
		.trim()
		.toLowerCase();
	if (["win32", "windows"].includes(value)) return "windows";
	if (["darwin", "macos", "mac"].includes(value)) return "darwin";
	if (value === "x64" || value === "amd64") return "amd64";
	if (value === "ia32" || value === "386") return "386";
	return value;
}

/** process.platform → Go GOOS；process.arch → Go GOARCH */
function hostTarget() {
	return {
		os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : process.platform,
		arch: process.arch === "x64" ? "amd64" : process.arch,
	};
}

function warn(message) {
	console.warn(`[build:xue-index] ${message}`);
}

function main() {
	const requested = parseArgs(process.argv.slice(2));
	const host = hostTarget();
	const goos = normalizeTarget(requested.os) || host.os;
	const goarch = normalizeTarget(requested.arch) || host.arch;

	// 原生目录不存在（浅克隆/裁剪过的源码树）时静默跳过
	if (!existsSync(path.join(goSourceDir, "go.mod"))) {
		warn(`native/xue-index 源码缺失，跳过（应用运行时回退 sql.js 路径）`);
		return;
	}

	const probe = spawnSync("go", ["version"], { encoding: "utf8", shell: false });
	if (probe.error || probe.status !== 0) {
		warn(`未找到 Go 工具链（go version 失败），跳过构建。安装 Go ≥1.24 后重跑 npm run build:xue-index。`);
		return;
	}

	mkdirSync(outputDir, { recursive: true });
	const binaryName = goos === "windows" ? "xue-index.exe" : "xue-index";
	const outputPath = path.join(outputDir, binaryName);

	const build = spawnSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", outputPath, "."], {
		cwd: goSourceDir,
		stdio: ["ignore", "inherit", "inherit"],
		// 纯 Go 依赖（modernc.org/sqlite），CGO 关死保证交叉编译与运行环境解耦
		env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
		shell: false,
	});
	if (build.error || build.status !== 0) {
		warn(`go build 失败（${goos}/${goarch}），应用运行时回退 sql.js 路径`);
		if (build.error) warn(build.error.message);
		process.exitCode = 0;
		return;
	}
	const sizeMiB = (statSync(outputPath).size / (1024 * 1024)).toFixed(1);
	console.log(`[build:xue-index] ${goos}/${goarch} → ${path.relative(repoRoot, outputPath)} (${sizeMiB} MiB)`);
}

main();
