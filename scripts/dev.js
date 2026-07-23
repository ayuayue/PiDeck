// @ts-check
/**
 * Electron 在部分 Linux 开发环境中会因 node_modules/electron/dist/chrome-sandbox
 * 不是 root:4755 而直接退出。开发态默认关闭 Electron sandbox，避免每次启动前都
 * 需要手动 sudo chown/chmod；正式打包不经过此脚本。
 */
const path = require("node:path");
const { spawn } = require("node:child_process");

const ELECTRON_VITE_BIN = path.join(__dirname, "..", "node_modules", "electron-vite", "bin", "electron-vite.js");
const STALE_ELECTRON_VITE_ENV_KEYS = [
	"ELECTRON_RENDERER_URL",
	"ELECTRON_CLI_ARGS",
	"ELECTRON_EXEC_PATH",
	"ELECTRON_MAJOR_VER",
	"NODE_ENV_ELECTRON_VITE",
	"VITE_DEV_SERVER_URL",
];

function createDevEnvironment({ platform = process.platform, env = process.env } = {}) {
	const nextEnv = { ...env };
	for (const key of STALE_ELECTRON_VITE_ENV_KEYS) {
		delete nextEnv[key];
	}
	if (
		platform === "linux" &&
		nextEnv.PIDECK_DEV_ENABLE_SANDBOX !== "1" &&
		nextEnv.ELECTRON_DISABLE_SANDBOX == null
	) {
		nextEnv.ELECTRON_DISABLE_SANDBOX = "1";
	}
	return nextEnv;
}

function isLinuxWaylandWithXDisplay({ platform = process.platform, env = process.env } = {}) {
	if (platform !== "linux") return false;
	if (String(env.PIDECK_LINUX_DISPLAY_BACKEND ?? "").trim().toLowerCase() === "wayland") {
		return false;
	}
	const isWaylandSession =
		String(env.XDG_SESSION_TYPE ?? "").trim().toLowerCase() === "wayland" ||
		Boolean(env.WAYLAND_DISPLAY);
	return isWaylandSession && Boolean(env.DISPLAY);
}

function hasElectronArg(electronArgs, name) {
	return electronArgs.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function withDefaultElectronArgs(args, input = {}) {
	const nextArgs = [...args];
	const separatorIndex = nextArgs.indexOf("--");
	const electronArgs =
		separatorIndex === -1 ? [] : nextArgs.slice(separatorIndex + 1);
	if (separatorIndex === -1) {
		nextArgs.push("--");
	}
	if (
		isLinuxWaylandWithXDisplay(input) &&
		!hasElectronArg(electronArgs, "--ozone-platform") &&
		!hasElectronArg(electronArgs, "--ozone-platform-hint")
	) {
		nextArgs.push("--ozone-platform=x11");
	}
	if (!hasElectronArg(electronArgs, "--log-level")) {
		nextArgs.push("--log-level=3");
	}
	return nextArgs;
}

function getElectronViteInvocation({
	nodeExecPath = process.execPath,
	electronViteBinPath = ELECTRON_VITE_BIN,
	args = process.argv.slice(2),
	platform = process.platform,
	env = process.env,
} = {}) {
	return {
		command: nodeExecPath,
		args: [
			electronViteBinPath,
			"dev",
			...withDefaultElectronArgs(args, { platform, env }),
		],
	};
}

function runDev() {
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
	createDevEnvironment,
	getElectronViteInvocation,
	isLinuxWaylandWithXDisplay,
	runDev,
	withDefaultElectronArgs,
};
