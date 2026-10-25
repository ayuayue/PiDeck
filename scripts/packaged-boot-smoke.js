#!/usr/bin/env node
"use strict";

/**
 * 打包产物「能不能起来」冒烟（Linux deb / AppImage / tar.gz）。
 *
 * 为什么要它：Linux/macOS 发版后最常见的用户回报是「装了打不开」，而这类失败在
 * `electron-builder` 打包成功、CI 全绿的情况下依然会发生——原因几乎都落在四层：
 *   1. 资源缺失：extraResources / asarUnpack 漏项，主进程 require 时 MODULE_NOT_FOUND；
 *   2. 动态链接：目标机缺 .so（libnss3/libgtk 之类）或 .node 需要的 glibc 符号版本高于目标机；
 *   3. 进程起不来：sandbox helper 权限、$HOME/userData 路径、GPU 初始化；
 *   4. 起来了但白屏：preload 注入失败、渲染层入口资源路径错。
 * 源码级测试（tests/*.test.mjs）与 `npm run build` 都覆盖不到这些，因为它们只发生在
 * 「安装后的真实目录布局 + 真实动态链接环境」里。本脚本用打包产物本身当被测对象。
 *
 * 边界（不要指望它验的东西）：托盘/窗口装饰/Wayland/真实 GPU —— 容器与 xvfb 里跑不出来。
 * 它的判定上界是「Chromium 起来且渲染层挂载了 DOM」，对应上面四层里能被机械检出的部分。
 *
 * 用法（必须在 Linux 里跑：WSLg 或容器）：
 *   node scripts/packaged-boot-smoke.js --artifact release/PiDeck_1.0.0_amd64.deb
 *   xvfb-run -a node scripts/packaged-boot-smoke.js --artifact release/ --format AppImage --keep
 *   node scripts/packaged-boot-smoke.js --artifact <pkg> --no-boot    # 只跑静态检查，无需显示
 * 选项：
 *   --artifact <path>   产物文件或所在目录（目录时按 --format/最新时间挑）
 *   --format <deb|appimage|targz>  目录入参时限定类型
 *   --executable <name> 解压后的主程序名，默认取 package.json build.linux.executableName
 *   --out <dir>         解压目录，默认 <tmp>/pideck-boot-smoke
 *   --home <dir>        伪造 HOME，默认 <out>/home（绝不写真实用户配置）
 *   --port <n>          CDP 端口，默认 9333
 *   --boot-timeout-ms   等待 CDP page 的超时，默认 90000
 *   --mount-timeout-ms  等待渲染层挂载 DOM 的超时，默认 45000
 *   --no-boot           跳过启动阶段
 *   --no-baseline       跳过 glibc 基线门禁（委托 linux-native-baseline.js scan）
 *   --keep              保留解压目录与日志便于事后手查
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { readElfMachine } = require("./linux-native-baseline.js");

const REPO_ROOT = path.resolve(__dirname, "..");
/** 递归找 .node / 可执行文件时的上限，防止在巨大 node_modules 里失控。 */
const WALK_LIMIT = 20_000;
const NATIVE_SCAN_LIMIT = 400;
/** stderr 里出现这些片段基本可以直接定性为启动失败，不需要再猜。 */
const FATAL_PATTERNS = [/error while loading shared libraries/i, /libc\.so\.6: version `GLIBC_/i, /undefined symbol:/i, /Cannot find module/i, /MODULE_NOT_FOUND/i, /ENOENT.*resources/i, /SIGSEGV|SIGABRT|Segmentation fault/i, /Aborted/i, /Missing X server|\$DISPLAY/i];

function parseArgs(argv) {
	const values = new Map();
	const positional = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token.startsWith("--")) {
			const name = token.slice(2);
			if (["no-boot", "keep", "no-baseline"].includes(name)) values.set(name, "true");
			else values.set(name, argv[index + 1] ?? "");
			if (!["no-boot", "keep", "no-baseline"].includes(name)) index += 1;
		} else {
			positional.push(token);
		}
	}
	return { values, positional };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (label) => console.log(`\n==> ${label}`);
const ok = (message) => console.log(`  OK   ${message}`);
const bad = (message) => console.log(`  FAIL ${message}`);
/** 打印失败项：真出问题时要一眼看完，不被同一类缺失刷满屏（总数仍计入结论）。 */
function printProblems(problems, cap = 15) {
	for (const problem of problems.slice(0, cap)) bad(problem);
	if (problems.length > cap) bad(`…另有 ${problems.length - cap} 项同类问题（见退出码与总数）`);
}

/** 目录入参时挑选产物：按 --format 过滤，再按 mtime 取最新。 */
function resolveArtifact(artifactArg, format) {
	const stat = fs.statSync(artifactArg, { throwIfNoEntry: false });
	if (!stat) throw new Error(`产物不存在: ${artifactArg}`);
	if (stat.isFile()) return artifactArg;
	const byExt = { deb: [".deb"], appimage: [".AppImage"], targz: [".tar.gz", ".tgz"] };
	const wanted = format ? byExt[format] : [".deb", ".AppImage", ".tar.gz", ".tgz"];
	const candidates = fs
		.readdirSync(artifactArg)
		.filter((name) => wanted.some((ext) => name.endsWith(ext)))
		.map((name) => ({ file: path.join(artifactArg, name), mtime: fs.statSync(path.join(artifactArg, name)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	if (candidates.length === 0) throw new Error(`目录里没有可识别的产物 (${wanted.join(", ")}): ${artifactArg}`);
	return candidates[0].file;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
	if (result.error) return { code: -1, stdout: "", stderr: String(result.error.message) };
	return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** 解包产物。deb 走 dpkg-deb（保留权限位，含 chrome-sandbox 的 SUID），缺失时退回 ar+tar。 */
function unpack(artifact, dest) {
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(dest, { recursive: true });
	const name = path.basename(artifact).toLowerCase();
	if (name.endsWith(".deb")) {
		if (run("dpkg-deb", ["-x", artifact, dest]).code === 0) return dest;
		const work = path.join(dest, "_ar");
		fs.mkdirSync(work, { recursive: true });
		if (run("ar", ["x", path.resolve(artifact)], { cwd: work }).code !== 0) throw new Error("deb 解包失败：dpkg-deb 与 ar 都不可用");
		const data = fs.readdirSync(work).find((entry) => entry.startsWith("data.tar"));
		if (!data) throw new Error("deb 里找不到 data.tar.*");
		if (run("tar", ["-xf", path.join(work, data), "-C", dest]).code !== 0) throw new Error("deb data 归档解包失败");
		fs.rmSync(work, { recursive: true, force: true });
		return dest;
	}
	if (name.endsWith(".appimage")) {
		fs.chmodSync(artifact, 0o755);
		if (run(artifact, ["--appimage-extract"], { cwd: dest }).code !== 0) throw new Error("AppImage --appimage-extract 失败（跨架构？需 unsquashfs 兜底）");
		const root = path.join(dest, "squashfs-root");
		if (!fs.existsSync(root)) throw new Error("AppImage 解包后没有 squashfs-root");
		return root;
	}
	if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
		if (run("tar", ["-xzf", artifact, "-C", dest]).code !== 0) throw new Error("tar.gz 解包失败");
		return dest;
	}
	throw new Error(`不认识的产物类型: ${name}`);
}

function walk(root, predicate, { limit = WALK_LIMIT, prune = new Set(["home", "_ar"]) } = {}) {
	const found = [];
	const stack = [root];
	let visited = 0;
	while (stack.length > 0 && visited < limit) {
		const dir = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		visited += 1;
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!prune.has(entry.name)) stack.push(full);
				continue;
			}
			if (predicate(entry.name, full)) found.push(full);
			if (found.length >= NATIVE_SCAN_LIMIT) return found;
		}
	}
	return found;
}

/** 主程序：Electron 的可执行文件是 ELF，用魔数排除同名脚本/软链。 */
function locateExecutable(root, executableName) {
	const candidates = walk(root, (name) => name === executableName || name.toLowerCase() === "pideck");
	for (const candidate of candidates) {
		const handle = fs.openSync(candidate, "r");
		const head = Buffer.alloc(4);
		fs.readSync(handle, head, 0, 4, 0);
		fs.closeSync(handle);
		if (head.readUInt8(0) === 0x7f && head.readUInt8(1) === 0x45) return { bin: candidate, appRoot: path.dirname(candidate) };
	}
	throw new Error(`解压目录里找不到 ELF 主程序 (${executableName})：${root}`);
}

/**
 * 动态链接检查。
 *
 * 算失败的只有两类：`X => not found`（目标机缺库）和 `version GLIBC_x not found`
 * （正是统信/麒麟上 dlopen 失败那一类）。
 * 三条刻意的收口，否则误报会淹没真问题：
 * - 不加 `-r`：napi/uv/gtk/glib 前缀的符号由宿主在 dlopen 时提供，不在 ELF 的
 *   DT_NEEDED 里，`ldd -r` 对主程序和每个原生模块都会刷出上千行假 undefined symbol；
 * - 跳过非本机 ELF 架构：asarUnpack 会把 koffi/node-pty 的 darwin、win、arm64 预编译
 *   产物一起打进包，它们在 x64 Linux 上永远链接不上，但根本不会被加载；
 * - 容忍 musl 加载器缺失：musl 变体原生模块同理。
 */
/**
 * 单行 ldd 输出的归类（纯函数，tests/packagedBootSmoke.test.mjs 锁判定边界）。
 * 返回 null 表示这行不构成问题——绝大多数 ldd 输出走这条路。
 */
function classifyLddLine(line) {
	const missing = line.match(/^\s*(\S+)\s*=>\s*not found/);
	if (missing) return /musl/i.test(missing[1]) ? null : { kind: "missing", lib: missing[1] };
	// 符号版本需求高于目标机：统信 UOS 20 / 麒麟 V10（glibc 2.28）上的典型死法
	if (/\bversion [`'"]?(GLIBC|GLIBCXX|CXXABI|GLIBC_PRIVATE)[\w.]+[`'"]? not found/.test(line)) return { kind: "version", line: line.trim() };
	return null;
}

function inspectLinks(files, currentArch = process.arch) {
	const problems = [];
	const missingLibs = new Map();
	let skipped = 0;
	for (const file of files) {
		const machine = readElfMachine(file);
		if (!machine || machine !== currentArch) {
			skipped += 1;
			continue;
		}
		const { code, stdout, stderr } = run("ldd", [file]);
		const output = stdout + stderr;
		if (code !== 0 && !/not a dynamic executable|statically linked/.test(output)) {
			problems.push(`${file}: ldd 无法解析 (${output.trim().split("\n")[0]})`);
			continue;
		}
		for (const line of output.split("\n")) {
			const finding = classifyLddLine(line);
			if (!finding) continue;
			if (finding.kind === "version") {
				problems.push(`${file}: ${finding.line}`);
				continue;
			}
			const entry = missingLibs.get(finding.lib) ?? { count: 0, samples: [] };
			entry.count += 1;
			if (entry.samples.length < 3) entry.samples.push(path.basename(file));
			missingLibs.set(finding.lib, entry);
		}
	}
	for (const [lib, entry] of missingLibs) {
		problems.push(`缺共享库 ${lib}（${entry.count} 个 ELF 需要：${entry.samples.join(", ")}${entry.count > entry.samples.length ? " …" : ""}）`);
	}
	return { problems, skipped, missingLibs: [...missingLibs.keys()] };
}

/**
 * 资源清单：以 package.json 的 build.extraResources 为唯一来源，避免脚本与配置漂移。
 *
 * 「源在本地存在」不等于「该进包」：`dist-runtime/dsh-runtime` 由 `npm run runtime:pack`
 * 生成，发版另有 sidecar 通道（release 资产里的 dsh-runtime-*.tgz），本机跑过一次打包就会
 * 留下这个目录，此时拿旧包来验必然假红。生成前缀在下面显式登记，缺席只记提示。
 * 不查 git：容器镜像常没有 git，WSL 里对宿主仓库又会 dubious ownership，判定不该依赖它。
 */
const GENERATED_RESOURCE_SOURCES = ["dist-runtime/"];

function expectedResourceNames() {
	const build = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).build ?? {};
	const entries = [];
	for (const entry of build.extraResources ?? []) {
		if (typeof entry === "string") entries.push({ to: path.basename(entry), from: entry });
		else if (entry?.to && entry?.from) entries.push({ to: entry.to, from: entry.from });
		else if (entry?.to) entries.push({ to: entry.to, from: entry.to });
	}
	return {
		names: entries.map((entry) => ({ ...entry, required: entry.from.startsWith("node_modules/") || !GENERATED_RESOURCE_SOURCES.some((prefix) => entry.from.startsWith(prefix)) })).filter((entry) => fs.existsSync(path.join(REPO_ROOT, entry.from))),
		expectsNodePtyUnpack: (build.asarUnpack ?? []).some((pattern) => pattern.includes("node-pty")),
		executableName: build.linux?.executableName ?? "pideck",
	};
}

function inspectResources(appRoot, { names, expectsNodePtyUnpack }) {
	const problems = [];
	const notes = [];
	const resources = path.join(appRoot, "resources");
	if (!fs.existsSync(path.join(resources, "app.asar"))) problems.push("缺 resources/app.asar");
	for (const entry of names) {
		if (fs.existsSync(path.join(resources, entry.to))) continue;
		if (entry.required) problems.push(`缺 extraResources: resources/${entry.to}（源 ${entry.from} 应随包分发）`);
		else notes.push(`resources/${entry.to} 不在包里（源 ${entry.from} 是生成目录，按 sidecar 单独分发时属正常）`);
	}
	const unpackedRoot = path.join(resources, "app.asar.unpacked");
	if (expectsNodePtyUnpack) {
		const pty = walk(unpackedRoot, (name) => name === "pty.node");
		if (pty.length === 0) problems.push("app.asar.unpacked 里没有 pty.node（asarUnpack 漏了？）");
	}
	const sandboxHelper = path.join(appRoot, "chrome-sandbox");
	if (fs.existsSync(sandboxHelper)) {
		const mode = fs.statSync(sandboxHelper).mode & 0o7777;
		notes.push(mode === 0o4755 ? "chrome-sandbox SUID 正常" : `chrome-sandbox 权限 ${mode.toString(8)}（非 4755，真实安装需 dpkg 修正）`);
	} else {
		notes.push("没找到 chrome-sandbox（打包时已删？需 --no-sandbox 才能起）");
	}
	return { problems, notes };
}

async function waitForCdpPage(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			const page = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl && !entry.url?.startsWith("devtools://"));
			if (page) return page;
		} catch {
			// Chromium 还没监听 CDP
		}
		await sleep(250);
	}
	return null;
}

/**
 * 连 CDP。
 *
 * 用 addEventListener 而不是 `.on()`：本脚本要能在没装 `ws` 的环境里跑（容器只挂了
 * 产物，不保证有仓库 node_modules），而 Node 的全局 WebSocket 是 undici 实现，只有
 * EventTarget 接口。scripts/run-session-fixture-electron.mjs 里的 `socket.on` 靠的是
 * devDependency `ws`，照抄到容器里就是 `socket.on is not a function`。
 */
async function connectCdp(target) {
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map();
	const drain = (cause) => {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	};
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.error) request.reject(new Error(JSON.stringify(message.error)));
		else request.resolve(message.result);
	});
	socket.addEventListener("close", () => drain(new Error("CDP 连接断开")));
	socket.addEventListener("error", (event) => drain(event?.message ?? "CDP 连接错误"));
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	return {
		async evaluate(expression) {
			const result = await new Promise((resolve, reject) => {
				const id = nextId++;
				pending.set(id, { resolve, reject });
				socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
			});
			if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "evaluate 失败");
			return result.result?.value;
		},
		close: () => socket.close(),
	};
}

/** 启动阶段：伪造 HOME 隔离真实配置，--no-sandbox/--disable-gpu 是无显示环境的必需品。 */
async function boot({ bin, appRoot, home, port, bootTimeoutMs, mountTimeoutMs, logFile }) {
	const problems = [];
	const logs = [];
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(logFile, "");
	const userData = path.join(home, "pideck-smoke-userdata");
	const child = spawn(bin, ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-software-rasterizer", `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
		cwd: appRoot,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
			ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
		},
	});
	const append = (chunk) => {
		logs.push(String(chunk));
		fs.appendFileSync(logFile, String(chunk));
	};
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	let exited = null;
	child.on("exit", (code, signal) => {
		exited = { code, signal };
	});
	child.on("error", (error) => {
		exited = { code: -1, signal: String(error.message) };
	});

	const killTree = (signal) => {
		try {
			process.kill(-child.pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// 已经退了
			}
		}
	};

	try {
		const page = await waitForCdpPage(port, bootTimeoutMs);
		if (!page) {
			problems.push(exited ? `主进程在 CDP 就绪前退出 (code=${exited.code} signal=${exited.signal})` : `等待 CDP 超时 (${bootTimeoutMs}ms)`);
			return { problems, tail: tailOf(logs) };
		}
		const cdp = await connectCdp(page);
		let mounted = null;
		const deadline = Date.now() + mountTimeoutMs;
		while (Date.now() < deadline) {
			try {
				mounted = await cdp.evaluate(`(() => ({ href: location.href, title: document.title, rootChildren: document.getElementById('root')?.childElementCount ?? document.body.childElementCount, bodyText: document.body.innerText.slice(0, 120) }))()`);
			} catch {
				mounted = null;
			}
			if (mounted && mounted.rootChildren > 0) break;
			await sleep(300);
		}
		cdp.close();
		if (!mounted || mounted.rootChildren <= 0) {
			problems.push(`渲染层未挂载 DOM (href=${mounted?.href ?? "未知"}, title=${mounted?.title ?? ""})`);
		} else {
			ok(`渲染层已挂载: ${mounted.href} · rootChildren=${mounted.rootChildren} · 「${mounted.bodyText.replace(/\s+/g, " ").trim().slice(0, 60)}」`);
		}
		if (exited) problems.push(`主进程提前退出 (code=${exited.code} signal=${exited.signal})`);
		for (const line of tailOf(logs).split("\n")) {
			if (FATAL_PATTERNS.some((pattern) => pattern.test(line))) problems.push(`日志致命行: ${line.trim()}`);
		}
		return { problems, tail: tailOf(logs) };
	} finally {
		killTree("SIGKILL");
	}
}

function tailOf(chunks, maxLines = 60) {
	return chunks.join("").split("\n").slice(-maxLines).join("\n");
}

async function main(argv) {
	const { values } = parseArgs(argv);
	if (process.platform !== "linux") {
		console.error(`BOOT_SMOKE_FAIL 本脚本必须在 Linux 里跑（WSLg 或容器）。当前: ${process.platform}`);
		return 2;
	}
	const out = path.resolve(values.get("out") ?? path.join(os.tmpdir(), "pideck-boot-smoke"));
	const artifact = resolveArtifact(path.resolve(values.get("artifact") ?? path.join(REPO_ROOT, "release")), values.get("format"));
	const { names, expectsNodePtyUnpack, executableName } = expectedResourceNames();
	const allProblems = [];

	console.log(`产物: ${artifact}`);
	step("解包");
	const extracted = unpack(artifact, out);
	const { bin, appRoot } = locateExecutable(extracted, values.get("executable") || executableName);
	ok(`主程序 ${path.relative(out, bin)} (${(fs.statSync(bin).size / 1048576).toFixed(1)} MiB)`);

	step("资源完整性");
	const resources = inspectResources(appRoot, { names, expectsNodePtyUnpack });
	for (const note of resources.notes) console.log(`  ..   ${note}`);
	for (const problem of resources.problems) bad(problem);
	allProblems.push(...resources.problems);

	step("动态链接 (ldd)");
	const nativeFiles = [bin, ...walk(appRoot, (name) => name.endsWith(".node")), ...walk(appRoot, (name) => name.endsWith(".so"))].slice(0, NATIVE_SCAN_LIMIT);
	const links = inspectLinks(nativeFiles);
	ok(`本机架构 ELF ${nativeFiles.length - links.skipped} 个（跳过 ${links.skipped} 个非 ${process.arch} 产物）`);
	printProblems(links.problems);
	allProblems.push(...links.problems);

	if (values.get("no-baseline") === "true") {
		step("glibc 基线：已按 --no-baseline 跳过");
	} else if (run("objdump", ["--version"]).code !== 0) {
		console.log("  ..   跳过 glibc 基线：本机没有 objdump（Debian/Ubuntu 装 binutils；busybox 镜像必然没有）");
	} else {
		step("glibc 基线 (linux-native-baseline scan)");
		const baseline = run("node", [path.join(REPO_ROOT, "scripts", "linux-native-baseline.js"), "scan", "--root", appRoot, "--fail"]);
		const summary = (baseline.stdout + baseline.stderr).trim().split("\n").slice(-4).join("\n");
		console.log(
			summary
				.split("\n")
				.map((line) => `  ..   ${line}`)
				.join("\n"),
		);
		if (baseline.code !== 0) allProblems.push("原生模块超出 glibc 2.28 基线（统信/麒麟会 dlopen 失败）");
	}

	if (values.get("no-boot") === "true") {
		console.log(`\n${allProblems.length === 0 ? "BOOT_SMOKE_OK (静态)" : `BOOT_SMOKE_FAIL ${allProblems.length} 项静态问题`}`);
		return allProblems.length === 0 ? 0 : 1;
	}

	step("启动 (需 xvfb 或 WSLg)");
	if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
		console.error("BOOT_SMOKE_FAIL 没有 DISPLAY/WAYLAND_DISPLAY：用 xvfb-run -a 包一层，或在 WSLg 里跑");
		return 2;
	}
	const bootResult = await boot({
		bin,
		appRoot,
		home: path.resolve(values.get("home") ?? path.join(out, "home")),
		port: Number(values.get("port") ?? 9333),
		bootTimeoutMs: Number(values.get("boot-timeout-ms") ?? 90_000),
		mountTimeoutMs: Number(values.get("mount-timeout-ms") ?? 45_000),
		logFile: path.join(out, "electron.log"),
	});
	allProblems.push(...bootResult.problems);
	printProblems(bootResult.problems);
	if (bootResult.problems.length > 0) {
		console.log(`\n---- electron.log 末尾 ----\n${bootResult.tail}`);
	}

	console.log(`\n日志: ${path.join(out, "electron.log")}`);
	if (values.get("keep") !== "true") fs.rmSync(out, { recursive: true, force: true });
	else console.log(`保留目录: ${out}`);
	console.log(allProblems.length === 0 ? "BOOT_SMOKE_OK" : `BOOT_SMOKE_FAIL ${allProblems.length} 项问题`);
	return allProblems.length === 0 ? 0 : 1;
}

if (require.main === module) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error(`BOOT_SMOKE_FAIL ${error?.stack ?? error}`);
			process.exitCode = 1;
		},
	);
}

module.exports = { GENERATED_RESOURCE_SOURCES, classifyLddLine, expectedResourceNames, inspectLinks, inspectResources, locateExecutable, resolveArtifact, unpack };
