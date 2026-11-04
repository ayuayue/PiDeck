#!/usr/bin/env node
/**
 * Build the native remote-sftp executor into resources/remote-sftp/bin/.
 *
 * Target selection mirrors the other Go sidecars: --os/--arch, then
 * REMOTE_SFTP_OS/REMOTE_SFTP_ARCH, then the host. Go failures stay fail-open:
 * SFTP remains an unavailable capability rather than blocking the whole app.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const goSourceDir = path.join(repoRoot, "native", "remote-sftp");
const outputDir = path.join(repoRoot, "resources", "remote-sftp", "bin");

function parseArgs(argv) {
	const target = { os: null, arch: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--os" && argv[i + 1]) target.os = argv[++i];
		else if (argv[i] === "--arch" && argv[i + 1]) target.arch = argv[++i];
	}
	if (process.env.REMOTE_SFTP_OS) target.os ??= process.env.REMOTE_SFTP_OS;
	if (process.env.REMOTE_SFTP_ARCH) target.arch ??= process.env.REMOTE_SFTP_ARCH;
	return target;
}

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

function hostTarget() {
	return {
		os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : process.platform,
		arch: process.arch === "x64" ? "amd64" : process.arch,
	};
}

function warn(message) {
	console.warn(`[build:remote-sftp] ${message}`);
}

function main() {
	const requested = parseArgs(process.argv.slice(2));
	const host = hostTarget();
	const goos = normalizeTarget(requested.os) || host.os;
	const goarch = normalizeTarget(requested.arch) || host.arch;

	if (!existsSync(path.join(goSourceDir, "go.mod"))) {
		warn("native/remote-sftp 源码缺失，跳过（SFTP 能力不可用）");
		return;
	}
	const probe = spawnSync("go", ["version"], { encoding: "utf8", shell: false });
	if (probe.error || probe.status !== 0) {
		warn("未找到 Go 工具链（go version 失败），跳过构建。安装 Go ≥1.26 后重跑 npm run build:remote-sftp。");
		return;
	}

	mkdirSync(outputDir, { recursive: true });
	const binaryName = goos === "windows" ? "remote-sftp.exe" : "remote-sftp";
	const outputPath = path.join(outputDir, binaryName);
	const build = spawnSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", outputPath, "."], {
		cwd: goSourceDir,
		stdio: ["ignore", "inherit", "inherit"],
		env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
		shell: false,
	});
	if (build.error || build.status !== 0) {
		warn(`go build 失败（${goos}/${goarch}），SFTP 能力不可用`);
		if (build.error) warn(build.error.message);
		process.exitCode = 0;
		return;
	}
	const sizeMiB = (statSync(outputPath).size / (1024 * 1024)).toFixed(1);
	console.log(`[build:remote-sftp] ${goos}/${goarch} → ${path.relative(repoRoot, outputPath)} (${sizeMiB} MiB)`);
}

main();
