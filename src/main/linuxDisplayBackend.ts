import { app } from "electron";

type DisplayBackendInput = {
	platform?: NodeJS.Platform | "linux";
	env?: NodeJS.ProcessEnv;
	argv?: string[];
	/**
	 * 桌面宠物是否启用（启动时快照）。宠物依赖 X11 的绝对窗口定位，
	 * 是应用 XWayland 兼容层的唯一理由；未启用时不得强制 XWayland（#108）。
	 */
	petEnabled?: boolean;
};

type CommandLineSwitch = {
	name: string;
	value?: string;
};

const BACKEND_ENV = "PIDECK_LINUX_DISPLAY_BACKEND";
const DISABLE_GPU_ENV = "PIDECK_LINUX_DISABLE_GPU";

function normalizeBackend(value: string | undefined) {
	return value?.trim().toLowerCase();
}

function hasArg(argv: string[], name: string) {
	return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function shouldDisableGpuForXWayland(env: NodeJS.ProcessEnv) {
	return normalizeBackend(env[DISABLE_GPU_ENV]) !== "0";
}

/**
 * Ubuntu/GNOME defaults to Wayland, but Electron 38 cannot freely position
 * BrowserWindow instances there. The desktop pet depends on absolute window
 * coordinates for initial placement, dragging and patrol, so prefer XWayland
 * when the session exposes a DISPLAY server.
 *
 * 见 #108：Electron 38 在 GNOME/Wayland 上强制 XWayland 会导致主窗口不可见，
 * 而兼容层的唯一收益是宠物的自由定位，因此默认不再无条件应用：
 * `PIDECK_LINUX_DISPLAY_BACKEND=wayland` 强制原生 Wayland；`=x11` 强制 XWayland；
 * 未设置时仅当桌面宠物已启用（petEnabled）才应用，未启用宠物的用户走原生
 * Wayland，宠物按 PetWindowCaps 探测结果降级为圆角小窗。
 */
export function getLinuxDisplayBackendSwitches(input: DisplayBackendInput = {}): CommandLineSwitch[] {
	const platform = input.platform ?? process.platform;
	const env = input.env ?? process.env;
	const argv = input.argv ?? process.argv;
	if (platform !== "linux") return [];

	const requestedBackend = normalizeBackend(env[BACKEND_ENV]);
	if (requestedBackend === "wayland") return [];
	if (hasArg(argv, "--ozone-platform") || hasArg(argv, "--ozone-platform-hint")) {
		return [];
	}

	// 默认仅宠物启用时才强制 XWayland；显式 =x11 视为无条件开启。
	if (requestedBackend !== "x11" && input.petEnabled !== true) return [];

	const isWaylandSession = normalizeBackend(env.XDG_SESSION_TYPE) === "wayland" || Boolean(env.WAYLAND_DISPLAY);
	const hasXWaylandDisplay = Boolean(env.DISPLAY);
	if (!isWaylandSession || !hasXWaylandDisplay) return [];

	const switches = [{ name: "ozone-platform", value: "x11" }];
	if (!hasArg(argv, "--log-level")) {
		switches.push({ name: "log-level", value: "3" });
	}
	return switches;
}

export function applyLinuxDisplayBackendWorkaround(petEnabled?: boolean) {
	const switches = getLinuxDisplayBackendSwitches({ petEnabled });
	if (switches.some((item) => item.name === "ozone-platform" && item.value === "x11") && shouldDisableGpuForXWayland(process.env)) {
		app.disableHardwareAcceleration();
	}
	for (const item of switches) {
		if (item.value === undefined) app.commandLine.appendSwitch(item.name);
		else app.commandLine.appendSwitch(item.name, item.value);
	}
}

export function isUsingLinuxXWaylandWorkaround(petEnabled?: boolean) {
	return getLinuxDisplayBackendSwitches({ petEnabled }).some((item) => item.name === "ozone-platform" && item.value === "x11");
}
