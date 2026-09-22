// @ts-check
/**
 * Electron 在部分 Linux 开发环境中会因 node_modules/electron/dist/chrome-sandbox
 * 不是 root:4755 而直接退出。开发态默认关闭 Electron sandbox，避免每次启动前都
 * 需要手动 sudo chown/chmod；正式打包不经过此脚本。
 */
const path = require("node:path");
const { spawn } = require("node:child_process");
const { formatProbeFailure, probeElectronBinary } = require("./electronBinaryProbe.js");

const ELECTRON_VITE_BIN = path.join(__dirname, "..", "node_modules", "electron-vite", "bin", "electron-vite.js");
const STALE_ELECTRON_VITE_ENV_KEYS = ["ELECTRON_RENDERER_URL", "ELECTRON_CLI_ARGS", "ELECTRON_EXEC_PATH", "ELECTRON_MAJOR_VER", "NODE_ENV_ELECTRON_VITE", "VITE_DEV_SERVER_URL"];

function createDevEnvironment({ platform = process.platform, env = process.env, nodeExecPath = process.execPath } = {}) {
	const nextEnv = { ...env };
	for (const key of STALE_ELECTRON_VITE_ENV_KEYS) {
		delete nextEnv[key];
	}
	if (platform === "linux" && nextEnv.PIDECK_DEV_ENABLE_SANDBOX !== "1" && nextEnv.ELECTRON_DISABLE_SANDBOX == null) {
		nextEnv.ELECTRON_DISABLE_SANDBOX = "1";
	}
	// Windows DSH 沙箱 runner 的 CUI sidecar：dev 直接用本机 node.exe，不必先下载随包副本。
	if (platform === "win32" && nextEnv.PIDECK_DSH_RUNNER_NODE == null) {
		nextEnv.PIDECK_DSH_RUNNER_NODE = nodeExecPath;
	}
	return nextEnv;
}

function isLinuxWaylandWithXDisplay({ platform = process.platform, env = process.env } = {}) {
	if (platform !== "linux") return false;
	if (
		String(env.PIDECK_LINUX_DISPLAY_BACKEND ?? "")
			.trim()
			.toLowerCase() === "wayland"
	) {
		return false;
	}
	const isWaylandSession =
		String(env.XDG_SESSION_TYPE ?? "")
			.trim()
			.toLowerCase() === "wayland" || Boolean(env.WAYLAND_DISPLAY);
	return isWaylandSession && Boolean(env.DISPLAY);
}

function hasElectronArg(electronArgs, name) {
	return electronArgs.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function withDefaultElectronArgs(args, input = {}) {
	const nextArgs = [...args];
	const separatorIndex = nextArgs.indexOf("--");
	const electronArgs = separatorIndex === -1 ? [] : nextArgs.slice(separatorIndex + 1);
	if (separatorIndex === -1) {
		nextArgs.push("--");
	}
	if (isLinuxWaylandWithXDisplay(input) && !hasElectronArg(electronArgs, "--ozone-platform") && !hasElectronArg(electronArgs, "--ozone-platform-hint")) {
		nextArgs.push("--ozone-platform=x11");
	}
	if (!hasElectronArg(electronArgs, "--log-level")) {
		nextArgs.push("--log-level=3");
	}
	return nextArgs;
}

function getElectronViteInvocation({ nodeExecPath = process.execPath, electronViteBinPath = ELECTRON_VITE_BIN, args = process.argv.slice(2), platform = process.platform, env = process.env } = {}) {
	return {
		command: nodeExecPath,
		args: [electronViteBinPath, "dev", ...withDefaultElectronArgs(args, { platform, env })],
	};
}

/**
 * 开发启动前的 Electron 二进制自检（只告警不阻断）。
 * 二进制写坏时子进程创建失败，dev 的表现是「打印完构建日志 + start electron app... 之后直接
 * 结束」（退出码 127），从日志完全看不出与代码无关；这里提前把结论和修复命令打出来。
 * 之所以不阻断启动：探活要起一个子进程（冷启动可能几秒），不该让自检失败挡掉用户的显式启动，
 * 用户可能正准备用 ELECTRON_OVERRIDE_DIST_PATH 等方式自行处理。
 */
function checkElectronBinaryBeforeDev({ probe = probeElectronBinary, env = process.env, warn = console.warn } = {}) {
	const result = probe({ env });
	if (result.ok) return result;
	for (const line of formatProbeFailure(result)) warn(line);
	return result;
}

function runDev() {
	// 先构建本地 workspace 包（如 dsh-tool-pwsh-persistent 的 lib/），
	// 否则 DSH host 启动时 require.resolve 命中缺失的 lib/index.js 会以 code=1 退出。
	require("node:child_process").execSync("npm run build:packages", {
		cwd: path.join(__dirname, ".."),
		stdio: "inherit",
		shell: true,
	});
	checkElectronBinaryBeforeDev();
	const invocation = getElectronViteInvocation();
	// Windows 下切换到 UTF-8 代码页，使终端能正确显示中文输出
	if (process.platform === "win32") {
		try {
			require("child_process").execSync("chcp 65001", { stdio: "ignore" });
		} catch {
			// 忽略失败，仅影响中文显示
		}
	}
	const child = spawn(invocation.command, invocation.args, {
		stdio: "inherit",
		env: createDevEnvironment(),
	});
	child.on("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 0);
	});
	child.on("error", (error) => {
		console.error("[dev] Failed to start electron-vite:", error);
		process.exit(1);
	});
}

if (require.main === module) {
	runDev();
}

module.exports = {
	checkElectronBinaryBeforeDev,
	createDevEnvironment,
	getElectronViteInvocation,
	isLinuxWaylandWithXDisplay,
	runDev,
	withDefaultElectronArgs,
};
