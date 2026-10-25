// @ts-check
/**
 * Electron 二进制体检脚本的回归测试。
 *
 * 背景：`npm run dev` 曾因为 node_modules/electron/dist/electron.exe 被写坏而以退出码 127
 * 「静默结束」，日志里看不出根因（详见 scripts/electronBinaryProbe.js 顶部说明）。本测试锁住
 * 几个关键判据：二进制起不来时**不能**被当成健康、失败信息必须给出修复命令、修复流程必须按
 * 「先删标记 → 再解压 → 最后复检」的顺序执行。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const probeModule = require("../scripts/electronBinaryProbe.js");
const { PROBE_TOKEN, createProbeInvocation, evaluateProbe, formatProbeFailure, probeElectronBinary, resolveElectronBinaryPath } = probeModule;
const checkModule = await import(pathToFileURL(join(projectRoot, "scripts", "check-electron.mjs")).href);
const devModule = require("../scripts/dev.js");

test("createProbeInvocation 用 ELECTRON_RUN_AS_NODE 启动同一份二进制且不改动调用方 env", () => {
	const env = { PATH: "/usr/bin" };
	const invocation = createProbeInvocation({ binaryPath: "/app/electron", env });
	assert.equal(invocation.command, "/app/electron");
	assert.equal(invocation.args[0], "-e");
	assert.equal(invocation.env.ELECTRON_RUN_AS_NODE, "1");
	assert.equal(invocation.env.PATH, "/usr/bin");
	// env 必须是副本：直接改调用方对象会污染真实进程环境（dev 启动路径就在用 process.env）。
	assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
});

test("evaluateProbe 只在退出码 0 且拿到 token 时判定健康", () => {
	assert.equal(evaluateProbe({ status: 0, stdout: PROBE_TOKEN, stderr: "" }).ok, true);
	// 实测故障形态：GUI 子系统程序起不来时不输出任何内容，退出码 127。
	const broken = evaluateProbe({ status: 127, stdout: "", stderr: "" });
	assert.equal(broken.ok, false);
	assert.match(broken.detail, /无任何输出/);
	// 有 token 但退出码非 0：说明脚本只跑了一部分，不能算健康。
	assert.equal(evaluateProbe({ status: 1, stdout: PROBE_TOKEN }).ok, false);
});

test("evaluateProbe 区分超时、信号终止与 spawn 失败", () => {
	assert.match(evaluateProbe({ error: { code: "ETIMEDOUT" }, status: null }).detail, /超时/);
	assert.match(evaluateProbe({ signal: "SIGKILL", status: null }).detail, /SIGKILL/);
	assert.match(evaluateProbe({ error: { code: "ENOENT" }, status: null }).detail, /ENOENT/);
});

test("resolveElectronBinaryPath 拒绝非字符串返回值并在缺包时给出可读原因", () => {
	assert.deepEqual(resolveElectronBinaryPath({ requireFn: () => "/x/electron.exe" }), { ok: true, binaryPath: "/x/electron.exe" });
	// 在 Electron 进程内 require("electron") 返回 API 对象，此时不能把对象当路径用。
	const insideElectron = resolveElectronBinaryPath({ requireFn: () => ({ app: {} }) });
	assert.equal(insideElectron.ok, false);
	assert.match(insideElectron.detail, /未返回路径/);
	const missing = resolveElectronBinaryPath({
		requireFn: () => {
			throw new Error("Cannot find module 'electron'");
		},
	});
	assert.equal(missing.ok, false);
	assert.match(missing.detail, /npm install/);
});

test("probeElectronBinary 把探活环境传给子进程并带上超时", () => {
	const calls = [];
	const spawn = (command, args, options) => {
		calls.push({ command, args, options });
		return { status: 0, stdout: PROBE_TOKEN, stderr: "" };
	};
	const result = probeElectronBinary({ requireFn: () => "/x/electron.exe", env: { PATH: "/bin" }, timeoutMs: 1234, spawn });
	assert.equal(result.ok, true);
	assert.equal(result.binaryPath, "/x/electron.exe");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, "/x/electron.exe");
	assert.equal(calls[0].options.timeout, 1234);
	assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
});

test("formatProbeFailure 同时给出结论、路径与一键修复命令（纯文本，无 ANSI）", () => {
	const lines = formatProbeFailure({ binaryPath: "/x/electron.exe", detail: "退出码 127" });
	const text = lines.join("\n");
	assert.match(text, /\/x\/electron\.exe/);
	assert.match(text, /退出码 127/);
	assert.match(text, /npm run check:electron -- --repair/);
	assert.ok(!text.includes("\u001b["), "输出不应带 ANSI 颜色，否则写进日志会串码");
});

test("dev 启动前自检：健康时不打扰，损坏时打印修复指引且不抛错", () => {
	const warnings = [];
	const healthy = devModule.checkElectronBinaryBeforeDev({ probe: () => ({ ok: true }), warn: (line) => warnings.push(line) });
	assert.equal(healthy.ok, true);
	assert.deepEqual(warnings, []);

	const broken = devModule.checkElectronBinaryBeforeDev({ probe: () => ({ ok: false, binaryPath: null, detail: "无法创建子进程：ENOENT" }), warn: (line) => warnings.push(line) });
	assert.equal(broken.ok, false);
	assert.ok(warnings.some((line) => line.includes("npm run check:electron -- --repair")));
});

test("resetElectronArtifacts 只删 dist 与 path.txt，占用导致失败时返回可读原因", () => {
	const removed = [];
	const ok = checkModule.resetElectronArtifacts({ electronDir: "/nm/electron", fs: { rmSync: (target, options) => removed.push([target, options]) } });
	assert.equal(ok.ok, true);
	assert.deepEqual(
		removed.map(([target]) => target),
		[join("/nm/electron", "dist"), join("/nm/electron", "path.txt")],
	);
	// install.js 见到这两个标记存在就会跳过解压，所以必须是 recursive + force 的真删。
	assert.deepEqual(removed[0][1], { recursive: true, force: true });

	const busy = checkModule.resetElectronArtifacts({
		electronDir: "/nm/electron",
		fs: {
			rmSync: () => {
				throw new Error("EBUSY: resource busy or locked");
			},
		},
	});
	assert.equal(busy.ok, false);
	assert.match(busy.detail, /Electron 进程占用/);
	assert.match(busy.detail, /EBUSY/);
});

test("repairElectronBinary 按「删标记 → 解压 → 复检」顺序执行，并透传失败原因", async () => {
	const steps = [];
	const fs = {
		rmSync: (target) => steps.push(`rm:${target}`),
		existsSync: () => true,
	};
	const spawn = () => {
		steps.push("install");
		return { status: 0 };
	};
	const repaired = await checkModule.repairElectronBinary({
		electronDir: "/nm/electron",
		fs,
		spawn,
		probe: () => {
			steps.push("probe");
			return { ok: true, binaryPath: "/nm/electron/dist/electron" };
		},
		// install.js 成功就不该碰兜底路径（它要读真实缓存，测试里必须能证明没被调用）。
		extractFallback: () => {
			steps.push("fallback");
			return { ok: false, detail: "不应被调用" };
		},
	});
	assert.equal(repaired.ok, true);
	assert.equal(repaired.strategy, "installer");
	// 期望值用 join 拼，避免 Windows 反斜杠路径让断言只在 POSIX 上通过。
	assert.deepEqual(steps, [`rm:${join("/nm/electron", "dist")}`, `rm:${join("/nm/electron", "path.txt")}`, "install", "probe"]);

	// install.js 起不来时改走本地缓存兜底；两条都失败才算失败，且不做复检（复检会给出误导性结论）。
	const failedSteps = [];
	const installFailure = await checkModule.repairElectronBinary({
		electronDir: "/nm/electron",
		fs: { rmSync: () => {}, existsSync: () => true },
		spawn: () => {
			failedSteps.push("install");
			return { status: 1 };
		},
		probe: () => {
			failedSteps.push("probe");
			return { ok: true };
		},
		extractFallback: () => {
			failedSteps.push("fallback");
			return { ok: false, detail: "本地缓存里没有 electron-v1-win32-x64.zip" };
		},
	});
	assert.equal(installFailure.ok, false);
	assert.match(installFailure.detail, /install\.js 退出码 1/);
	// 两段原因都要留下：只报 install.js 的失败会让人以为「重跑一次就好」。
	assert.match(installFailure.detail, /本地缓存兜底也失败/);
	assert.match(installFailure.detail, /没有 electron-v1-win32-x64\.zip/);
	assert.deepEqual(failedSteps, ["install", "fallback"]);
});

test("repairElectronBinary 在 install.js 联网失败时靠本地缓存 zip 还原（strategy=cache-zip）", async () => {
	const steps = [];
	const repaired = await checkModule.repairElectronBinary({
		electronDir: "/nm/electron",
		fs: { rmSync: () => {}, existsSync: () => true },
		spawn: () => {
			steps.push("install");
			return { status: 1 };
		},
		extractFallback: () => {
			steps.push("fallback");
			return { ok: true, zipPath: "/cache/<hash>/electron-v1-win32-x64.zip" };
		},
		probe: () => {
			steps.push("probe");
			return { ok: true, binaryPath: "/nm/electron/dist/electron.exe" };
		},
		log: () => {},
	});
	assert.equal(repaired.ok, true);
	assert.equal(repaired.strategy, "cache-zip");
	assert.equal(repaired.binaryPath, "/nm/electron/dist/electron.exe");
	// 兜底之后必须仍然复检：解压成功不等于二进制能起来。
	assert.deepEqual(steps, ["install", "fallback", "probe"]);
});

test("readElectronVersion 容错：缺文件或坏 JSON 都返回 null", () => {
	assert.equal(checkModule.readElectronVersion({ electronDir: "/nm/electron", fs: { existsSync: () => false, readFileSync: () => "" } }), null);
	assert.equal(checkModule.readElectronVersion({ electronDir: "/nm/electron", fs: { existsSync: () => true, readFileSync: () => "{not json" } }), null);
	assert.equal(checkModule.readElectronVersion({ electronDir: "/nm/electron", fs: { existsSync: () => true, readFileSync: () => JSON.stringify({ version: "43.4.0" }) } }), "43.4.0");
});

test("runCli：健康退出 0；损坏时退出 1 并提示修复；带 --repair 时修复后复检通过才算成功", async () => {
	const logs = [];
	const warns = [];
	const healthy = await checkModule.runCli({ argv: [], probe: () => ({ ok: true, binaryPath: "/x/electron" }), log: (line) => logs.push(line), warn: (line) => warns.push(line) });
	assert.equal(healthy, 0);
	assert.ok(logs.some((line) => line.startsWith("✓ Electron")));

	const broken = await checkModule.runCli({ argv: [], probe: () => ({ ok: false, binaryPath: "/x/electron", detail: "退出码 127" }), log: (line) => logs.push(line), warn: (line) => warns.push(line) });
	assert.equal(broken, 1);
	assert.ok(warns.some((line) => line.includes("npm run check:electron -- --repair")));

	// 修复请求：第一次探活失败 → 走 repair（注入口，绝不能碰真实 node_modules）→ 复检成功。
	const verdicts = [
		{ ok: false, binaryPath: "/x/electron", detail: "退出码 127" },
		{ ok: true, binaryPath: "/x/electron" },
	];
	let probeCalls = 0;
	const repairCalls = [];
	const exitCode = await checkModule.runCli({
		argv: ["--repair"],
		projectRoot,
		probe: () => verdicts[Math.min(probeCalls++, verdicts.length - 1)],
		repair: ({ electronDir }) => {
			repairCalls.push(electronDir);
			// 走兜底路径时 CLI 要额外点明「install.js 联网失败」这层根因。
			return { ok: true, strategy: "cache-zip" };
		},
		log: (line) => logs.push(line),
		warn: () => {},
	});
	assert.equal(exitCode, 0);
	assert.equal(probeCalls, 2);
	assert.deepEqual(repairCalls, [join(projectRoot, "node_modules", "electron")]);
	assert.ok(logs.some((line) => line.includes("本地缓存 zip")));

	// 修复成功但复检仍不通过：必须退出非 0，不能因为「修复跑完了」就报成功。
	const stillBroken = await checkModule.runCli({
		argv: ["--repair"],
		projectRoot,
		probe: () => ({ ok: false, binaryPath: "/x/electron", detail: "仍然无法启动" }),
		repair: () => ({ ok: true }),
		log: () => {},
		warn: () => {},
	});
	assert.equal(stillBroken, 1);
});

test("真实二进制端到端：体检脚本在装有 Electron 的开发机上退出码为 0", (t) => {
	const binaryMarker = join(projectRoot, "node_modules", "electron", "path.txt");
	if (!existsSync(binaryMarker)) {
		t.skip("未安装 Electron 二进制（如 ELECTRON_SKIP_BINARY_DOWNLOAD），跳过端到端体检");
		return;
	}
	const result = spawnSync(process.execPath, [join(projectRoot, "scripts", "check-electron.mjs")], { encoding: "utf8", windowsHide: true, timeout: 60000 });
	assert.equal(result.status, 0, `check-electron 应报告健康：${result.stdout}${result.stderr}`);
	assert.match(result.stdout, /✓ Electron/);
});
