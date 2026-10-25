import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule(mockProcess = {}) {
	const source = readFileSync("src/main/linuxDisplayBackend.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const appendedSwitches = [];
	let disableHardwareAccelerationCalls = 0;
	const sandbox = {
		exports: {},
		process: {
			platform: "linux",
			env: {},
			argv: [],
			...mockProcess,
		},
		require: (id) => {
			if (id === "electron") {
				return {
					app: {
						disableHardwareAcceleration: () => {
							disableHardwareAccelerationCalls++;
						},
						commandLine: {
							appendSwitch: (name, value) => appendedSwitches.push({ name, value }),
						},
					},
				};
			}
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "linuxDisplayBackend.ts",
	});
	return {
		...sandbox.exports,
		appendedSwitches,
		getDisableHardwareAccelerationCalls: () => disableHardwareAccelerationCalls,
	};
}

test("uses X11 ozone backend on Linux Wayland when the desktop pet is enabled", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();

	assert.deepEqual(
		JSON.parse(
			JSON.stringify(
				getLinuxDisplayBackendSwitches({
					platform: "linux",
					env: {
						XDG_SESSION_TYPE: "wayland",
						WAYLAND_DISPLAY: "wayland-0",
						DISPLAY: ":0",
					},
					argv: [],
					petEnabled: true,
				}),
			),
		),
		[
			{ name: "ozone-platform", value: "x11" },
			{ name: "log-level", value: "3" },
		],
	);
});

test("does not force X11 by default when the desktop pet is disabled (#108)", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();

	// 未传 petEnabled（默认未启用宠物）时，即使处于 Wayland + XWayland 环境
	// 也不得强制 ozone-platform=x11，否则主窗口在部分 GNOME/Wayland 环境不可见。
	assert.deepEqual(
		JSON.parse(
			JSON.stringify(
				getLinuxDisplayBackendSwitches({
					platform: "linux",
					env: {
						XDG_SESSION_TYPE: "wayland",
						WAYLAND_DISPLAY: "wayland-0",
						DISPLAY: ":0",
					},
					argv: [],
				}),
			),
		),
		[],
	);
	assert.deepEqual(
		JSON.parse(
			JSON.stringify(
				getLinuxDisplayBackendSwitches({
					platform: "linux",
					env: {
						XDG_SESSION_TYPE: "wayland",
						WAYLAND_DISPLAY: "wayland-0",
						DISPLAY: ":0",
					},
					argv: [],
					petEnabled: false,
				}),
			),
		),
		[],
	);
});

test("forces X11 without the pet when the backend is explicitly set to x11", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();

	assert.deepEqual(
		JSON.parse(
			JSON.stringify(
				getLinuxDisplayBackendSwitches({
					platform: "linux",
					env: {
						XDG_SESSION_TYPE: "wayland",
						WAYLAND_DISPLAY: "wayland-0",
						DISPLAY: ":0",
						PIDECK_LINUX_DISPLAY_BACKEND: "x11",
					},
					argv: [],
				}),
			),
		),
		[
			{ name: "ozone-platform", value: "x11" },
			{ name: "log-level", value: "3" },
		],
	);
});

test("does not force X11 when user opts into native Wayland", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();

	assert.deepEqual(
		JSON.parse(
			JSON.stringify(
				getLinuxDisplayBackendSwitches({
					platform: "linux",
					env: {
						XDG_SESSION_TYPE: "wayland",
						WAYLAND_DISPLAY: "wayland-0",
						DISPLAY: ":0",
						PIDECK_LINUX_DISPLAY_BACKEND: "wayland",
					},
					argv: [],
					petEnabled: true,
				}),
			),
		),
		[],
	);
});

test("does not override an explicit ozone platform argument", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();

	assert.deepEqual(
		JSON.parse(
			JSON.stringify(
				getLinuxDisplayBackendSwitches({
					platform: "linux",
					env: {
						XDG_SESSION_TYPE: "wayland",
						WAYLAND_DISPLAY: "wayland-0",
						DISPLAY: ":0",
					},
					argv: ["pideck", "--ozone-platform=wayland"],
					petEnabled: true,
				}),
			),
		),
		[],
	);
});

test("does not force X11 outside Linux", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();

	assert.deepEqual(
		JSON.parse(
			JSON.stringify(
				getLinuxDisplayBackendSwitches({
					platform: "darwin",
					env: {
						XDG_SESSION_TYPE: "wayland",
						WAYLAND_DISPLAY: "wayland-0",
						DISPLAY: ":0",
					},
					argv: [],
					petEnabled: true,
				}),
			),
		),
		[],
	);
});

test("applies the X11 switch to Electron commandLine before app ready", () => {
	const { applyLinuxDisplayBackendWorkaround, appendedSwitches } = loadModule({
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
		},
		argv: ["pideck"],
	});

	applyLinuxDisplayBackendWorkaround(true);

	assert.deepEqual(appendedSwitches, [
		{ name: "ozone-platform", value: "x11" },
		{ name: "log-level", value: "3" },
	]);
});

test("does not override an explicit Chromium log level", () => {
	const { applyLinuxDisplayBackendWorkaround, appendedSwitches } = loadModule({
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
		},
		argv: ["pideck", "--log-level=2"],
	});

	applyLinuxDisplayBackendWorkaround(true);

	assert.deepEqual(appendedSwitches, [{ name: "ozone-platform", value: "x11" }]);
});

test("disables hardware acceleration when forcing X11 on Linux Wayland", () => {
	const { applyLinuxDisplayBackendWorkaround, getDisableHardwareAccelerationCalls } = loadModule({
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
		},
		argv: ["pideck"],
	});

	applyLinuxDisplayBackendWorkaround(true);

	assert.equal(getDisableHardwareAccelerationCalls(), 1);
});

test("keeps hardware acceleration when Linux GPU disable is opted out", () => {
	const { applyLinuxDisplayBackendWorkaround, getDisableHardwareAccelerationCalls } = loadModule({
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
			PIDECK_LINUX_DISABLE_GPU: "0",
		},
		argv: ["pideck"],
	});

	applyLinuxDisplayBackendWorkaround(true);

	assert.equal(getDisableHardwareAccelerationCalls(), 0);
});

test("applies nothing and keeps GPU acceleration when the pet is disabled (#108)", () => {
	const { applyLinuxDisplayBackendWorkaround, appendedSwitches, getDisableHardwareAccelerationCalls } = loadModule({
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
		},
		argv: ["pideck"],
	});

	// 默认（未启用宠物）不得改动任何 Chromium 启动参数。
	applyLinuxDisplayBackendWorkaround();

	assert.deepEqual(appendedSwitches, []);
	assert.equal(getDisableHardwareAccelerationCalls(), 0);
});
