import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { allocHiddenConsole } = loadTsCommonJs("src/main/dsh/allocHiddenConsole.ts");

function makeFfi({ consoleCp = 0, hwnd = 0, allocResult = 1, lastError = 0, stationOk = true, throwStation = false } = {}) {
	const calls = { load: [], allocConsole: 0, showWindow: [], createStation: 0 };
	let currentHwnd = hwnd;
	const koffi = {
		load(name) {
			calls.load.push(name);
			return {
				func(signature) {
					if (signature.includes("GetConsoleCP")) return () => consoleCp;
					if (signature.includes("GetConsoleWindow")) return () => currentHwnd;
					if (signature.includes("AllocConsole")) {
						return () => {
							calls.allocConsole += 1;
							if (allocResult === 1 && !currentHwnd) currentHwnd = 0xabc;
							return allocResult;
						};
					}
					if (signature.includes("GetLastError")) return () => lastError;
					if (signature.includes("ShowWindow")) {
						return (hWnd, nCmdShow) => {
							calls.showWindow.push([hWnd, nCmdShow]);
							return 1;
						};
					}
					if (signature.includes("CreateWindowStationW") || signature.includes("OpenWindowStationW") || signature.includes("SetProcessWindowStation") || signature.includes("CreateDesktopW") || signature.includes("SetThreadDesktop")) {
						if (throwStation) throw new Error("unexpected station api");
						if (signature.includes("CreateWindowStationW")) calls.createStation += 1;
						return () => (stationOk ? 0xabc : 0);
					}
					throw new Error(`unexpected func signature: ${signature}`);
				},
			};
		},
	};
	return { koffi, calls };
}

test("allocHiddenConsole：非 win32 不分配", () => {
	const { koffi, calls } = makeFfi();
	assert.equal(allocHiddenConsole("linux", koffi), false);
	assert.equal(calls.load.length, 0);
});

test("allocHiddenConsole：已有无窗口控制台时不再 AllocConsole", () => {
	const { koffi, calls } = makeFfi({ consoleCp: 437, hwnd: 0 });
	assert.equal(allocHiddenConsole("win32", koffi), true);
	assert.equal(calls.allocConsole, 0);
	assert.equal(calls.showWindow.length, 0);
});

test("allocHiddenConsole：已有可见控制台时只 Hide，不再分配", () => {
	const { koffi, calls } = makeFfi({ consoleCp: 437, hwnd: 0xdef });
	assert.equal(allocHiddenConsole("win32", koffi), true);
	assert.equal(calls.allocConsole, 0);
	assert.deepEqual(calls.showWindow, [[0xdef, 0]]);
});

test("allocHiddenConsole：无控制台时先切私有窗口站再 AllocConsole（不闪窗）", () => {
	const { koffi, calls } = makeFfi({ consoleCp: 0, hwnd: 0, allocResult: 1, stationOk: true });
	assert.equal(allocHiddenConsole("win32", koffi), true);
	assert.equal(calls.createStation, 1);
	assert.equal(calls.allocConsole, 1);
	assert.equal(calls.showWindow.length, 0, "窗口站成功时不必再赛跑 Hide");
});

test("allocHiddenConsole：建站失败时退回 AllocConsole + SW_HIDE", () => {
	const { koffi, calls } = makeFfi({
		consoleCp: 0,
		hwnd: 0,
		allocResult: 1,
		throwStation: true,
	});
	assert.equal(allocHiddenConsole("win32", koffi), true);
	assert.equal(calls.allocConsole, 1);
	assert.deepEqual(calls.showWindow[0], [0xabc, 0]);
});

test("allocHiddenConsole：AllocConsole 失败且错误码 5 视为已有控制台", () => {
	const { koffi, calls } = makeFfi({
		consoleCp: 0,
		hwnd: 0,
		allocResult: 0,
		lastError: 5,
		stationOk: true,
	});
	assert.equal(allocHiddenConsole("win32", koffi), true);
	assert.equal(calls.allocConsole, 1);
});

test("allocHiddenConsole：AllocConsole 失败且非已附带控制台 → false", () => {
	const { koffi } = makeFfi({
		consoleCp: 0,
		hwnd: 0,
		allocResult: 0,
		lastError: 6,
		stationOk: true,
	});
	assert.equal(allocHiddenConsole("win32", koffi), false);
});
