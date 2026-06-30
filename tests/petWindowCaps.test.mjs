import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadModule(mockProcess = {}) {
	const source = readFileSync("src/main/pet/PetWindow.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
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
						commandLine: {
							getSwitchValue: () => "",
						},
						getPath: () => "/tmp/pi-desktop-test",
					},
					BrowserWindow: class {},
					screen: {
						getDisplayMatching: () => ({
							workArea: { x: 0, y: 0, width: 1920, height: 1080 },
						}),
					},
				};
			}
			if (id === "@electron-toolkit/utils") return { is: { dev: true } };
			if (id === "../preloadPath") {
				return { preparePreloadPath: async (sourcePath) => sourcePath };
			}
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "PetWindow.ts",
	});
	return sandbox.exports;
}

test("treats X11 ozone on Linux Wayland as freely positionable", () => {
	const { detectPetWindowCaps } = loadModule({
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
		},
		argv: ["electron", ".", "--ozone-platform=x11"],
	});

	assert.deepEqual(JSON.parse(JSON.stringify(detectPetWindowCaps())), {
		transparent: true,
		clickThrough: true,
		freePosition: true,
	});
});

test("keeps the Wayland fallback when Electron uses native Wayland", () => {
	const { detectPetWindowCaps } = loadModule({
		platform: "linux",
		env: {
			XDG_SESSION_TYPE: "wayland",
			WAYLAND_DISPLAY: "wayland-0",
			DISPLAY: ":0",
		},
		argv: ["electron", ".", "--ozone-platform=wayland"],
	});

	assert.deepEqual(JSON.parse(JSON.stringify(detectPetWindowCaps())), {
		transparent: false,
		clickThrough: true,
		freePosition: false,
	});
});
