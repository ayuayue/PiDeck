// @ts-check
/**
 * Electron 二进制探活：确认 node_modules 里的 electron 真的能被启动。
 *
 * 背景（2026-09-21 实测）：一次安装把 node_modules/electron/dist/electron.exe 写坏了，
 * 文件大小与缓存 zip 内完全一致（225,533,440 字节）但内容不同。表现是 `npm run dev`
 * 打印完 electron-vite 的构建日志 + "start electron app..." 之后就结束，退出码 127 ——
 * 子进程创建失败，跟业务代码无关，光看日志根本看不出来。
 *
 * 判定手段：用 `ELECTRON_RUN_AS_NODE=1` 让同一个二进制退化成 node 运行时跑一段极短脚本。
 * 能跑通 ⇒ 文件可执行且加载完整；跑不通 ⇒ 二进制损坏/被截断，或被安全软件拦住了启动。
 *
 * 为什么不用 `electron.exe --version`：Windows 上 electron.exe 是 GUI 子系统程序，不往
 * 管道打印，成功也是空输出（exit 0），失败也是空输出（exit 127），两者无法区分。
 *
 * 本模块是 CommonJS：scripts/dev.js（CJS）与 scripts/check-electron.mjs（ESM，经默认导入）
 * 共用同一份判定逻辑，避免两处各写一遍探活。
 */
const { spawnSync } = require("node:child_process");

/** 探活脚本：只在成功路径输出 token，避免 Electron 自身的告警混进判定。 */
const PROBE_SNIPPET = "process.stdout.write('pideck-electron-probe-ok')";
const PROBE_TOKEN = "pideck-electron-probe-ok";
/** 冷启动（磁盘慢/被杀软扫描）时 Electron 首次加载可能接近 10s，给足余量再判超时。 */
const DEFAULT_PROBE_TIMEOUT_MS = 20000;

/**
 * 解析 Electron 可执行文件路径。
 * 普通 Node 进程下 `require("electron")` 返回字符串路径；在 Electron 内部则返回 API 对象，
 * 那种情况说明调用方环境不对，直接判定不可用而不是把对象当路径用。
 * ELECTRON_OVERRIDE_DIST_PATH 由 electron 包自身处理，这里不重复实现。
 */
function resolveElectronBinaryPath({ requireFn = require } = {}) {
	try {
		const resolved = requireFn("electron");
		if (typeof resolved !== "string" || resolved.length === 0) {
			return { ok: false, detail: `require("electron") 未返回路径（得到 ${typeof resolved}），请确认不是在 Electron 进程内调用` };
		}
		return { ok: true, binaryPath: resolved };
	} catch (error) {
		return { ok: false, detail: `找不到 electron 包（先跑 npm install）：${error instanceof Error ? error.message : String(error)}` };
	}
}

/** 生成探活调用参数；env 复制一份，避免污染调用方环境。 */
function createProbeInvocation({ binaryPath, env = process.env }) {
	return {
		command: binaryPath,
		args: ["-e", PROBE_SNIPPET],
		env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
	};
}

/**
 * 判定探活结果。
 * 成功要求「退出码 0」且「看到 token」两个条件同时成立：二进制起不来时进程根本没跑起来，
 * stdout 必然为空，此时退出码可能是 127（无法创建子进程）或别的异常值；反过来只看 token
 * 也不够，防止脚本部分执行后崩溃被当成健康。
 */
function evaluateProbe({ status, stdout, stderr, error, signal } = {}) {
	const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
	const err = typeof stderr === "string" ? stderr : String(stderr ?? "");
	if (out.includes(PROBE_TOKEN) && status === 0) return { ok: true, detail: "探活 token 正常返回" };
	if (error && error.code === "ETIMEDOUT") return { ok: false, detail: `探活超时（>${DEFAULT_PROBE_TIMEOUT_MS}ms）` };
	if (error) return { ok: false, detail: `无法创建子进程：${[error.code, error.message].filter(Boolean).join(" / ")}` };
	if (signal) return { ok: false, detail: `探活进程被 ${signal} 终止` };
	const tail = [err.trim(), out.trim()].filter(Boolean).join(" / ").slice(-400);
	return { ok: false, detail: `退出码 ${status ?? "未知"}${tail ? `：${tail}` : "（无任何输出，典型于二进制无法加载）"}` };
}

/** 完整探活：解析路径 + 跑一次子进程 + 判定，返回结论与细节供调用方打印。 */
function probeElectronBinary({ requireFn = require, env = process.env, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, spawn = spawnSync } = {}) {
	const resolved = resolveElectronBinaryPath({ requireFn });
	if (!resolved.ok) return { ok: false, binaryPath: null, detail: resolved.detail };
	const invocation = createProbeInvocation({ binaryPath: resolved.binaryPath, env });
	const result = spawn(invocation.command, invocation.args, {
		env: invocation.env,
		encoding: "utf8",
		timeout: timeoutMs,
		windowsHide: true,
	});
	return { ...evaluateProbe(result), binaryPath: resolved.binaryPath };
}

/** 失败时给人看的说明（纯文本，无 ANSI 颜色，方便同时用于终端与日志）。 */
function formatProbeFailure({ binaryPath, detail } = {}) {
	return [
		"[electron] ✗ Electron 二进制无法启动，npm run dev 会以「打印完构建日志就结束」（退出码 127）的形式失败",
		`[electron]   二进制：${binaryPath ?? "(未解析到路径)"}`,
		`[electron]   探活结果：${detail ?? "未知"}`,
		"[electron]   原因通常是文件被写坏/截断，或被安全软件拦住了启动；与项目代码无关。",
		"[electron]   一键修复：npm run check:electron -- --repair",
	];
}

module.exports = {
	PROBE_SNIPPET,
	PROBE_TOKEN,
	DEFAULT_PROBE_TIMEOUT_MS,
	createProbeInvocation,
	evaluateProbe,
	formatProbeFailure,
	probeElectronBinary,
	resolveElectronBinaryPath,
};
