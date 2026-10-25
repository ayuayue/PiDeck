#!/usr/bin/env node
"use strict";

/**
 * Linux 原生模块 GLIBC 基线工具（rebuild / report / verify / scan / smoke）。
 *
 * 为什么需要它：
 *   Electron 主程序自身只要求 GLIBC_2.17/2.18/2.25，而 CI 在 ubuntu-24.04(-arm)
 *   （glibc 2.39）上 `npm ci` 现编的 node-pty 会记录 GLIBC_2.34 —— openpty/forkpty
 *   自 glibc 2.34 起从 libutil.so.1 并入 libc.so.6，符号版本随之升到 2.34。于是
 *   在统信 UOS 20 / 麒麟 V10（glibc 2.28）上 pty.node 无法 dlopen，而 node-pty 的
 *   loader 会把真实错误覆盖成 "Cannot find module './prebuilds/linux-arm64//pty.node'"
 *   （它遍历候选路径时只保留最后一次错误），看起来像「打包漏了原生模块」。
 *   修法：在 Debian 10（glibc 2.28）容器里重编 node-pty，把需求压回 2.28 基线。
 *
 * 为什么是 CJS：
 *   scripts/after-pack-cleanup.js 在打包期 require 本模块的纯函数做门禁，保持同一
 *   模块系统避免 ESM/CJS 互操作。
 *
 * 用法：
 *   node scripts/linux-native-baseline.js rebuild [--root <dir>] [--platform <p>] [--image <img>]
 *   node scripts/linux-native-baseline.js report  <file.node...>
 *   node scripts/linux-native-baseline.js verify  [--ceiling 2.28] [--glibcxx-ceiling 3.4.25] <file.node...>
 *   node scripts/linux-native-baseline.js scan    [--root <dir>] [--fail]
 *   node scripts/linux-native-baseline.js verify-node-pty [--root <dir>] [--platform <p>]
 *   node scripts/linux-native-baseline.js smoke   --module-dir <node-pty 目录>
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/** Debian 10 / 统信 UOS 20 / 麒麟 V10 的 glibc。 */
const GLIBC_CEILING_DEFAULT = "2.28";
/** Debian 10 自带 GCC 8.3 的 libstdc++ 最高 GLIBCXX 版本。 */
const GLIBCXX_CEILING_DEFAULT = "3.4.25";
/** 编译基线镜像：Debian 10 = glibc 2.28。 */
const BASELINE_IMAGE = "node:18-buster-slim";
/** 镜像自带 npm 的 bundled node-gyp（镜像里没有 node-gyp 可执行文件）。 */
const CONTAINER_GYP = "/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js";
/** 宿主工作目录在容器内的挂载点。 */
const CONTAINER_ROOT = "/w";
/** 遍历时跳过的目录：既不是包目录也不含 .node，纯为控制扫描时间。 */
const WALK_PRUNE = new Set([".git", ".bin", ".cache", ".github", "coverage", "docs", "man", "example", "examples", "__tests__"]);

/** 本模块所在仓库根目录：用于拦住「在本机 node_modules 里写非本机平台原生模块」的误操作。 */
const SCRIPT_REPO_ROOT = path.resolve(__dirname, "..");

/** 逐段比较 "2.28" / "3.4.25" 形态的版本号；缺失段按 0 处理。 */
function compareVersions(a, b) {
	const left = String(a)
		.split(".")
		.map((part) => Number.parseInt(part, 10) || 0);
	const right = String(b)
		.split(".")
		.map((part) => Number.parseInt(part, 10) || 0);
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const l = left[index] ?? 0;
		const r = right[index] ?? 0;
		if (l !== r) return l < r ? -1 : 1;
	}
	return 0;
}

/** 升序去重排序版本号列表。 */
function sortVersions(versions) {
	return [...new Set(versions)].sort(compareVersions);
}

/**
 * 从 `objdump -T` 输出里提取引用的 GLIBC / GLIBCXX 符号版本。
 * 注意 GLIBCXX_ 前缀不会被 GLIBC_ 规则误吞（GLIBC 之后是 X 而不是下划线）。
 */
function parseRequiredVersions(objdumpText) {
	const glibc = [];
	const glibcxx = [];
	for (const match of String(objdumpText).matchAll(/GLIBCXX_([0-9][0-9.]*)/g)) glibcxx.push(match[1]);
	for (const match of String(objdumpText).matchAll(/GLIBC_([0-9][0-9.]*)/g)) glibc.push(match[1]);
	return { glibc: sortVersions(glibc), glibcxx: sortVersions(glibcxx) };
}

/** 判定一组需求是否落在基线上；offenders 为超限项（形如 "GLIBC_2.34"）。 */
function evaluateBaseline(versions, options = {}) {
	const glibcCeiling = options.glibcCeiling ?? GLIBC_CEILING_DEFAULT;
	const glibcxxCeiling = options.glibcxxCeiling ?? GLIBCXX_CEILING_DEFAULT;
	const offenders = [...(versions.glibc ?? []).filter((version) => compareVersions(version, glibcCeiling) > 0).map((version) => `GLIBC_${version}`), ...(versions.glibcxx ?? []).filter((version) => compareVersions(version, glibcxxCeiling) > 0).map((version) => `GLIBCXX_${version}`)];
	return { ok: offenders.length === 0, offenders, glibcCeiling, glibcxxCeiling };
}

/** 读取当前进程运行时的 glibc 版本（仅 Linux 有值），用于打印可比对的证据。 */
function runtimeGlibcVersion() {
	try {
		return process.report?.getReport?.().header?.glibcVersionRuntime ?? null;
	} catch {
		return null;
	}
}

/** ELF e_machine → 统一架构名；比 objdump -f 的 architecture 行可靠（mingw binutils 对 aarch64 会打印 UNKNOWN!）。 */
const ELF_MACHINES = { 3: "x86", 40: "arm", 62: "x64", 183: "arm64", 243: "riscv64" };

/** 直接读 ELF 头部 e_machine，避免依赖 objdump 对目标架构的识别能力。 */
function readElfMachine(file) {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const header = Buffer.alloc(20);
			fs.readSync(fd, header, 0, 20, 0);
			if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) return null;
			return ELF_MACHINES[header.readUInt16LE(18)] ?? `machine-${header.readUInt16LE(18)}`;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return null;
	}
}

/**
 * 对单个原生模块执行 objdump -f / -T，返回架构与版本需求。
 * 非 ELF（node-pty 包内同时带 darwin/win32 预编译产物）标记 skipped，不参与基线判定。
 * 全静态 ELF 没有动态版本需求（objdump -T 报 "not a dynamic object"），同样视为满足基线。
 */
function describeAddon(file, options = {}) {
	const objdump = options.objdump ?? "objdump";
	const header = spawnSync(objdump, ["-f", file], { encoding: "utf8" });
	if (header.error) throw new Error(`无法执行 ${objdump}: ${header.error.message}`);
	const format = /file format (\S+)/.exec(header.stdout ?? "")?.[1];
	if (!format || !format.startsWith("elf")) return { file, format: format ?? "unknown", arch: "非 ELF", skipped: true, glibc: [], glibcxx: [] };
	const architecture = /architecture: ([^,]+)/.exec(header.stdout ?? "")?.[1]?.trim() ?? "";
	const arch = readElfMachine(file) ?? (architecture.includes("aarch64") ? "arm64" : architecture.includes("x86-64") ? "x64" : architecture || format);
	const symbols = spawnSync(objdump, ["-T", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (symbols.status !== 0) {
		if (/not a dynamic object/i.test(symbols.stderr ?? "")) return { file, format, arch, static: true, glibc: [], glibcxx: [] };
		throw new Error(`${objdump} -T 失败（${symbols.status}）: ${(symbols.stderr ?? "").trim()}`);
	}
	return { file, format, arch, ...parseRequiredVersions(symbols.stdout) };
}

/** 按固定宽度打印一行证据。 */
function formatAddonLine(addon, verdict) {
	const glibc = addon.glibc.length ? addon.glibc.map((v) => `GLIBC_${v}`).join(" ") : "GLIBC_-";
	const glibcxx = addon.glibcxx.length ? addon.glibcxx.map((v) => `GLIBCXX_${v}`).join(" ") : "GLIBCXX_-";
	const mark = verdict.ok ? "OK  " : "FAIL";
	const note = addon.static ? "（静态）" : "";
	return `${mark} ${addon.arch.padEnd(6)} ${glibc} | ${glibcxx} | ${addon.file}${note}${verdict.ok ? "" : `  <= 超限: ${verdict.offenders.join(" ")}`}`;
}

/** 递归收集目录下的原生模块（*.node）。 */
function listNativeAddons(rootDir, options = {}) {
	const prune = options.prune ?? WALK_PRUNE;
	const maxDirs = options.maxDirs ?? 50_000;
	const found = [];
	const stack = [rootDir];
	let visited = 0;
	while (stack.length) {
		if (++visited > maxDirs) return { files: found.sort(), capped: true };
		let entries;
		try {
			entries = fs.readdirSync(stack.pop(), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(entry.parentPath ?? entry.path ?? rootDir, entry.name);
			if (entry.isDirectory()) {
				if (!prune.has(entry.name)) stack.push(full);
			} else if (entry.name.endsWith(".node")) {
				found.push(full);
			}
		}
	}
	return { files: found.sort(), capped: false };
}

/**
 * 找出所有 node-pty 包目录（含 DSH 内嵌副本）。
 * 只走 npm 的 node_modules 布局，不遍历 release/、.tmp-asar/ 等构建产物目录。
 */
function findNodePtyDirs(rootDir) {
	const found = [];
	const scanModules = (modulesDir) => {
		let entries;
		try {
			entries = fs.readdirSync(modulesDir, { withFileTypes: true });
		} catch {
			return;
		}
		const packages = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".cache") continue;
			const full = path.join(modulesDir, entry.name);
			if (!entry.name.startsWith("@")) {
				packages.push(full);
				continue;
			}
			try {
				for (const inner of fs.readdirSync(full, { withFileTypes: true })) if (inner.isDirectory()) packages.push(path.join(full, inner.name));
			} catch {
				/* 作用域目录读不到就跳过 */
			}
		}
		for (const packageDir of packages) {
			if (path.basename(packageDir) === "node-pty") {
				found.push(packageDir);
				continue;
			}
			scanModules(path.join(packageDir, "node_modules"));
		}
	};
	scanModules(path.join(rootDir, "node_modules"));
	return found.sort();
}

/** 该平台是否已有可直接使用的预编译产物（有则不需要现编）。 */
function needsRebuild(nodePtyDir, platform) {
	return !fs.existsSync(path.join(nodePtyDir, "prebuilds", platform, "pty.node"));
}

/** 按 node-pty 自身 loader 的顺序解析实际会被加载的产物路径。 */
function resolveNodePtyArtifact(nodePtyDir, platform) {
	const candidates = [path.join(nodePtyDir, "build", "Release", "pty.node"), path.join(nodePtyDir, "build", "Debug", "pty.node"), path.join(nodePtyDir, "prebuilds", platform, "pty.node")];
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** 宿主路径 → 容器内路径（统一正斜杠）。 */
function toContainerPath(rootDir, target) {
	return `${CONTAINER_ROOT}/${path.relative(rootDir, target).split(path.sep).join("/")}`;
}

/**
 * 生成容器内的重建脚本（纯函数，便于单测）。
 * buster 已 EOL：官方源迁到 archive.debian.org，且 Release 已过期，必须关 Valid-Until 才能 update。
 */
function buildBusterScript(targets, options) {
	const { rootDir, uid, gid } = options;
	const dirs = targets.map((target) => toContainerPath(rootDir, target));
	const lines = [
		"set -euo pipefail",
		"sed -i -e 's|deb.debian.org/debian|archive.debian.org/debian|g' -e 's|security.debian.org/debian-security|archive.debian.org/debian-security|g' -e '/buster-updates/d' /etc/apt/sources.list",
		"apt-get -o Acquire::Check-Valid-Until=false update -qq",
		"apt-get install -y -qq --no-install-recommends python3 make g++ binutils",
		`echo "==> 基线镜像 $(node -p process.version) / glibc $(ldd --version | head -1 | awk '{print $NF}')"`,
	];
	for (const dir of dirs) {
		lines.push(`echo "==> 重建 ${dir}"`);
		lines.push(`( cd ${dir} && node ${CONTAINER_GYP} rebuild --jobs=max )`);
		// 容器以 root 写入，宿主 runner 用户之后要能读/清理，故改回调用方身份；
		// 宿主 uid 为 0（root 或非 Linux 宿主）时不需要也无法 chown。
		if (uid !== 0 || gid !== 0) lines.push(`chown -R ${uid}:${gid} ${dir}/build`);
	}
	return `${lines.join("\n")}\n`;
}

/** 在 Debian 10 容器里重建需要现编的 node-pty 副本。 */
function rebuild(options = {}) {
	const rootDir = path.resolve(options.root ?? process.cwd());
	const platform = options.platform ?? `${process.platform}-${process.arch}`;
	const image = options.image ?? BASELINE_IMAGE;
	const targets = findNodePtyDirs(rootDir).filter((dir) => needsRebuild(dir, platform));
	if (!targets.length) {
		console.log(`==> 所有 node-pty 副本在 ${platform} 上都有预编译产物，无需重建`);
		return 0;
	}
	for (const target of targets) console.log(`==> 需要重建: ${path.relative(rootDir, target)}`);
	// 风险点就在写入：在非 Linux 宿主上给本仓库现编会拿 Linux .so 覆盖本机 pty.node，
	// 而 node-pty 的 loader 优先选 build/Release，本机终端随后就会加载失败。
	if (process.platform !== "linux") {
		const insideOwnRepo = targets.filter((target) => !path.relative(SCRIPT_REPO_ROOT, target).startsWith(".."));
		if (insideOwnRepo.length) {
			console.error(`==> 拒绝在非 Linux 宿主上把 ${platform} 产物写进本仓库的 node_modules：${insideOwnRepo.map((target) => path.relative(SCRIPT_REPO_ROOT, target)).join(", ")}`);
			console.error("==> 请在 Linux（或 CI）上执行重建，否则本机终端会因加载错架构的原生模块而失效");
			return 1;
		}
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const gid = typeof process.getgid === "function" ? process.getgid() : 0;
	const mount = `${rootDir.split(path.sep).join("/")}:${CONTAINER_ROOT}`;
	const result = spawnSync("docker", ["run", "--rm", "-v", mount, "-w", CONTAINER_ROOT, image, "bash", "-lc", buildBusterScript(targets, { rootDir, uid, gid })], { stdio: "inherit" });
	if (result.error) {
		console.error(`==> 无法执行 docker: ${result.error.message}`);
		return 1;
	}
	return result.status ?? 1;
}

/** 真实加载并 spawn 一个 PTY：验证产物不仅能解析，而且能跑。 */
function smoke(options = {}) {
	const moduleDir = path.resolve(options.moduleDir ?? "");
	if (!moduleDir || !fs.existsSync(moduleDir)) {
		console.error("==> 需要 --module-dir 指向 node-pty 目录");
		return 1;
	}
	const glibc = runtimeGlibcVersion();
	console.log(`==> node ${process.version} / ${process.arch} / glibc ${glibc ?? "非 Linux"}`);
	console.log(`==> 加载 ${moduleDir}`);
	let pty;
	try {
		pty = require(moduleDir);
	} catch (error) {
		console.error(`==> 加载失败: ${error?.message ?? error}`);
		return 1;
	}
	const addon = resolveNodePtyArtifact(moduleDir, `linux-${process.arch}`);
	console.log(`==> 产物 ${addon ? path.relative(moduleDir, addon) : "（未找到 build/Release、build/Debug、prebuilds 候选）"}`);
	const child = pty.spawn("/bin/sh", ["-c", "echo PTY_SMOKE_OK; exit 0"], { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: { ...process.env, TERM: "xterm-256color" } });
	let output = "";
	let finished = false;
	const timer = setTimeout(() => {
		if (finished) return;
		finished = true;
		console.error("==> 超时：20s 内没有收到 PTY 退出事件");
		try {
			child.kill();
		} catch {
			/* 已经退出 */
		}
		process.exit(1);
	}, 20_000);
	child.onData((data) => {
		output += data;
	});
	child.onExit(({ exitCode }) => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		const ok = output.includes("PTY_SMOKE_OK") && exitCode === 0;
		console.log(`==> 输出 ${JSON.stringify(output.trim())} / exitCode ${exitCode}`);
		console.log(ok ? "==> PTY 冒烟通过" : "==> PTY 冒烟失败");
		process.exit(ok ? 0 : 1);
	});
	return 0;
}

/** 对一批文件跑证据表；failOnOffender=true 时超限即非零退出。 */
function reportFiles(files, options = {}) {
	let failed = 0;
	let checked = 0;
	let skipped = 0;
	for (const file of files) {
		try {
			const addon = describeAddon(file, options);
			if (addon.skipped) {
				skipped += 1;
				continue;
			}
			checked += 1;
			const verdict = evaluateBaseline(addon, options);
			if (!verdict.ok) failed += 1;
			console.log(formatAddonLine(addon, verdict));
		} catch (error) {
			failed += 1;
			console.log(`FAIL 无法检查 ${file}: ${error?.message ?? error}`);
		}
	}
	const suffix = skipped > 0 ? `（另有 ${skipped} 个非 ELF 产物跳过）` : "";
	if (failed > 0) {
		console.log(`==> ${failed}/${checked} 个 ELF 原生模块超过基线（glibc ${options.glibcCeiling ?? GLIBC_CEILING_DEFAULT} / GLIBCXX ${options.glibcxxCeiling ?? GLIBCXX_CEILING_DEFAULT}）${suffix}`);
		return options.failOnOffender ? 1 : 0;
	}
	console.log(`==> ${checked} 个 ELF 原生模块满足基线${suffix}`);
	return 0;
}

/** 解析形如 --key value 的参数。 */
function parseArgs(argv) {
	const values = new Map();
	const positional = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token.startsWith("--")) {
			const key = token.slice(2);
			if (key === "fail") {
				values.set(key, "true");
				continue;
			}
			values.set(key, argv[index + 1]);
			index += 1;
		} else {
			positional.push(token);
		}
	}
	return { values, positional };
}

function main(argv) {
	const [command, ...rest] = argv;
	const { values, positional } = parseArgs(rest);
	const options = {
		glibcCeiling: values.get("ceiling") ?? GLIBC_CEILING_DEFAULT,
		glibcxxCeiling: values.get("glibcxx-ceiling") ?? GLIBCXX_CEILING_DEFAULT,
	};
	const root = path.resolve(values.get("root") ?? process.cwd());
	switch (command) {
		case "rebuild":
			return rebuild({ root, platform: values.get("platform"), image: values.get("image") });
		case "report":
			return reportFiles(positional, options);
		case "verify":
			return reportFiles(positional, { ...options, failOnOffender: true });
		case "scan": {
			const { files, capped } = listNativeAddons(root);
			if (capped) console.log(`==> 警告：目录遍历达到上限，${root} 下的原生模块清单可能不完整`);
			return reportFiles(files, { ...options, failOnOffender: values.get("fail") === "true" });
		}
		case "verify-node-pty": {
			const platform = values.get("platform") ?? `linux-${process.arch}`;
			const dirs = findNodePtyDirs(root);
			const artifacts = dirs.map((dir) => resolveNodePtyArtifact(dir, platform)).filter(Boolean);
			if (artifacts.length !== dirs.length) {
				console.log(`==> ${dirs.length} 个 node-pty 副本中只有 ${artifacts.length} 个能找到 ${platform} 产物`);
				return 1;
			}
			return reportFiles(artifacts, { ...options, failOnOffender: true });
		}
		case "smoke":
			return smoke({ moduleDir: values.get("module-dir") });
		default:
			console.error("用法: linux-native-baseline.js <rebuild|report|verify|scan|verify-node-pty|smoke> [选项]");
			return 2;
	}
}

if (require.main === module) {
	process.exitCode = main(process.argv.slice(2));
}

module.exports = {
	BASELINE_IMAGE,
	CONTAINER_GYP,
	CONTAINER_ROOT,
	GLIBCXX_CEILING_DEFAULT,
	GLIBC_CEILING_DEFAULT,
	buildBusterScript,
	compareVersions,
	describeAddon,
	evaluateBaseline,
	findNodePtyDirs,
	formatAddonLine,
	listNativeAddons,
	main,
	needsRebuild,
	parseRequiredVersions,
	readElfMachine,
	resolveNodePtyArtifact,
	runtimeGlibcVersion,
	smoke,
	sortVersions,
	toContainerPath,
};
