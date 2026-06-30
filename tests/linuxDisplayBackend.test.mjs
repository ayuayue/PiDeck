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
							appendSwitch: (name, value) =>
								appendedSwitches.push({ name, value }),
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
		getDisableHardwareAccelerationCalls: () =>
			disableHardwareAccelerationCalls,
	};
}

test("uses X11 ozone backend on Linux Wayland when XWayland display is available", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();

	assert.deepEqual(
		JSON.parse(JSON.stringify(getLinuxDisplayBackendSwitches({
			platform: "linux",
			env: {
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
				DISPLAY: ":0",
			},
			argv: [],
		}))),
		[
			{ name: "ozone-platform", value: "x11" },
			{ name: "log-level", value: "3" },
		],
	);
});

test("does not force X11 when user opts into native Wayland", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();

	assert.deepEqual(
		JSON.parse(JSON.stringify(getLinuxDisplayBackendSwitches({
			platform: "linux",
			env: {
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
				DISPLAY: ":0",
				PIDECK_LINUX_DISPLAY_BACKEND: "wayland",
			},
			argv: [],
		}))),
		[],
	);
});

test("does not override an explicit ozone platform argument", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();

	assert.deepEqual(
		JSON.parse(JSON.stringify(getLinuxDisplayBackendSwitches({
			platform: "linux",
			env: {
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
				DISPLAY: ":0",
			},
			argv: ["pideck", "--ozone-platform=wayland"],
		}))),
		[],
	);
});

test("does not force X11 outside Linux", () => {
	const { getLinuxDisplayBackendSwitches } = loadModule();

	assert.deepEqual(
		JSON.parse(JSON.stringify(getLinuxDisplayBackendSwitches({
			platform: "darwin",
			env: {
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
				DISPLAY: ":0",
			},
			argv: [],
		}))),
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

	applyLinuxDisplayBackendWorkaround();

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

	applyLinuxDisplayBackendWorkaround();

	assert.deepEqual(appendedSwitches, [
		{ name: "ozone-platform", value: "x11" },
	]);
});

test("disables hardware acceleration when forcing X11 on Linux Wayland", () => {
	const { applyLinuxDisplayBackendWorkaround, getDisableHardwareAccelerationCalls } =
		loadModule({
			platform: "linux",
			env: {
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
				DISPLAY: ":0",
			},
			argv: ["pideck"],
		});

	applyLinuxDisplayBackendWorkaround();

	assert.equal(getDisableHardwareAccelerationCalls(), 1);
});

test("keeps hardware acceleration when Linux GPU disable is opted out", () => {
	const { applyLinuxDisplayBackendWorkaround, getDisableHardwareAccelerationCalls } =
		loadModule({
			platform: "linux",
			env: {
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
				DISPLAY: ":0",
				PIDECK_LINUX_DISABLE_GPU: "0",
			},
			argv: ["pideck"],
		});

	applyLinuxDisplayBackendWorkaround();

	assert.equal(getDisableHardwareAccelerationCalls(), 0);
});
