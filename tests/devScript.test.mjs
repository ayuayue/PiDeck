import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
	createDevEnvironment,
	getElectronViteInvocation,
	withDefaultElectronArgs,
} = require("../scripts/dev.js");

test("disables Electron sandbox for Linux dev runs by default", () => {
	const env = createDevEnvironment({
		platform: "linux",
		env: { PATH: "/usr/bin" },
	});

	assert.equal(env.ELECTRON_DISABLE_SANDBOX, "1");
	assert.equal(env.PATH, "/usr/bin");
});

test("removes stale electron-vite dev environment from parent shells", () => {
	const env = createDevEnvironment({
		platform: "linux",
		env: {
			ELECTRON_RENDERER_URL: "http://127.0.0.1:5175/",
			ELECTRON_CLI_ARGS: "[\"--ozone-platform=wayland\"]",
			NODE_ENV_ELECTRON_VITE: "development",
			PATH: "/usr/bin",
		},
	});

	assert.equal(Object.hasOwn(env, "ELECTRON_RENDERER_URL"), false);
	assert.equal(Object.hasOwn(env, "ELECTRON_CLI_ARGS"), false);
	assert.equal(Object.hasOwn(env, "NODE_ENV_ELECTRON_VITE"), false);
	assert.equal(env.PATH, "/usr/bin");
});

test("does not override an explicit Electron sandbox setting", () => {
	const env = createDevEnvironment({
		platform: "linux",
		env: { ELECTRON_DISABLE_SANDBOX: "0" },
	});

	assert.equal(env.ELECTRON_DISABLE_SANDBOX, "0");
});

test("allows Linux developers to keep the sandbox enabled", () => {
	const env = createDevEnvironment({
		platform: "linux",
		env: { PIDECK_DEV_ENABLE_SANDBOX: "1" },
	});

	assert.equal(Object.hasOwn(env, "ELECTRON_DISABLE_SANDBOX"), false);
});

test("does not disable Electron sandbox outside Linux", () => {
	const env = createDevEnvironment({
		platform: "darwin",
		env: {},
	});

	assert.equal(Object.hasOwn(env, "ELECTRON_DISABLE_SANDBOX"), false);
});

test("runs electron-vite dev and forwards extra arguments", () => {
	const invocation = getElectronViteInvocation({
		nodeExecPath: "/usr/bin/node",
		electronViteBinPath: "/repo/node_modules/electron-vite/bin/electron-vite.js",
		args: ["--debug", "main", "--", "--trace-warnings"],
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
		},
	});

	assert.equal(invocation.command, "/usr/bin/node");
	assert.deepEqual(invocation.args, [
		"/repo/node_modules/electron-vite/bin/electron-vite.js",
		"dev",
		"--debug",
		"main",
		"--",
		"--trace-warnings",
		"--ozone-platform=x11",
		"--log-level=3",
	]);
});

test("does not override an explicit Chromium log level", () => {
	const invocation = getElectronViteInvocation({
		nodeExecPath: "/usr/bin/node",
		electronViteBinPath: "/repo/node_modules/electron-vite/bin/electron-vite.js",
		args: ["--", "--log-level=1"],
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
		},
	});

	assert.deepEqual(invocation.args, [
		"/repo/node_modules/electron-vite/bin/electron-vite.js",
		"dev",
		"--",
		"--log-level=1",
		"--ozone-platform=x11",
	]);
});

test("adds startup X11 ozone argument on Linux Wayland", () => {
	assert.deepEqual(
		withDefaultElectronArgs(["--debug"], {
			platform: "linux",
			env: {
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
				DISPLAY: ":0",
			},
		}),
		["--debug", "--", "--ozone-platform=x11", "--log-level=3"],
	);
});

test("does not override an explicit startup ozone argument", () => {
	assert.deepEqual(
		withDefaultElectronArgs(["--", "--ozone-platform=wayland"], {
			platform: "linux",
			env: {
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
				DISPLAY: ":0",
			},
		}),
		["--", "--ozone-platform=wayland", "--log-level=3"],
	);
});

test("does not add startup X11 ozone argument outside Linux", () => {
	assert.deepEqual(
		withDefaultElectronArgs([], {
			platform: "darwin",
			env: {
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
				DISPLAY: ":0",
			},
			}),
			["--", "--log-level=3"],
		);
	});
