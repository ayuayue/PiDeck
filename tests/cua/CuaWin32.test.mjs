import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const CuaWin32 = loadTsCommonJs("src/main/cua/CuaWin32.ts");

test("normalizeAbsoluteCoordinate maps primary screen corners", () => {
	const sw = 2560;
	const sh = 1440;

	assert.deepStrictEqual(JSON.parse(JSON.stringify(CuaWin32.normalizeAbsoluteCoordinate(0, 0, sw, sh))), { x: 0, y: 0 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(CuaWin32.normalizeAbsoluteCoordinate(sw - 1, sh - 1, sw, sh))), { x: 65535, y: 65535 });

	const center = CuaWin32.normalizeAbsoluteCoordinate(1280, 720, sw, sh);
	assert.strictEqual(center.x, Math.round((1280 * 65535) / (sw - 1)));
	assert.strictEqual(center.y, Math.round((720 * 65535) / (sh - 1)));
});

test("normalizeAbsoluteCoordinate clamps out-of-bounds coordinates", () => {
	assert.deepStrictEqual(JSON.parse(JSON.stringify(CuaWin32.normalizeAbsoluteCoordinate(-100, -100, 1920, 1080))), { x: 0, y: 0 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(CuaWin32.normalizeAbsoluteCoordinate(9999, 9999, 1920, 1080))), { x: 65535, y: 65535 });
});

test("normalizeAbsoluteCoordinate maps virtual desktop origin (multi-monitor)", () => {
	// Virtual desktop spanning two monitors: origin (-2560, 0), size 5120x1440.
	// Primary-only normalization (the pre-fix behavior) would clamp the left
	// monitor to the left edge; with origin it must land on the far left = 0.
	const originX = -2560;
	const originY = 0;
	const w = 5120;
	const h = 1440;
	assert.deepStrictEqual(JSON.parse(JSON.stringify(CuaWin32.normalizeAbsoluteCoordinate(-2560, 0, w, h, originX, originY))), { x: 0, y: 0 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(CuaWin32.normalizeAbsoluteCoordinate(2559, 1439, w, h, originX, originY))), { x: 65535, y: 65535 });
	// Point on the left monitor center: quarter across the virtual desktop.
	const quarter = CuaWin32.normalizeAbsoluteCoordinate(-1280, 720, w, h, originX, originY);
	assert.strictEqual(quarter.x, Math.round((1280 * 65535) / (w - 1)));
});

test("buildUnicodeInputs splits astral-plane characters into surrogate pairs", () => {
	const bmp = CuaWin32.buildUnicodeInputs("A");
	assert.strictEqual(bmp.length, 2, "BMP char = down + up");
	assert.strictEqual(bmp[0].ki_wScan, 65);
	assert.strictEqual(bmp[0].ki_dwFlags, 0x0004);
	assert.strictEqual(bmp[1].ki_dwFlags, 0x0004 | 0x0002);

	// U+1F600 (😀): high 0xD83D, low 0xDE00 — raw code point would truncate wScan.
	const astral = CuaWin32.buildUnicodeInputs("\u{1F600}");
	assert.strictEqual(astral.length, 4, "astral char = surrogate pair * (down + up)");
	assert.strictEqual(astral[0].ki_wScan, 0xd83d);
	assert.strictEqual(astral[1].ki_wScan, 0xd83d);
	assert.strictEqual(astral[2].ki_wScan, 0xde00);
	assert.strictEqual(astral[3].ki_wScan, 0xde00);
	assert.strictEqual(astral[0].ki_dwFlags, 0x0004);
	assert.strictEqual(astral[1].ki_dwFlags, 0x0004 | 0x0002);
	assert.strictEqual(astral[2].ki_dwFlags, 0x0004);
	assert.strictEqual(astral[3].ki_dwFlags, 0x0004 | 0x0002);

	const mixed = CuaWin32.buildUnicodeInputs("A\u{1F600}中");
	assert.strictEqual(mixed.length, 2 + 4 + 2);
});

test("normalizeAbsoluteCoordinate rejects invalid dimensions", () => {
	assert.throws(() => CuaWin32.normalizeAbsoluteCoordinate(0, 0, 0, 1080), /Invalid screen dimensions/);
	assert.throws(() => CuaWin32.normalizeAbsoluteCoordinate(0, 0, 1920, 0), /Invalid screen dimensions/);
});

test("buildMouseInput produces absolute move flags", () => {
	const input = CuaWin32.buildMouseInput(1000, 2000, 0x8001);
	assert.strictEqual(input.type, 0);
	assert.strictEqual(input.mi_dx, 1000);
	assert.strictEqual(input.mi_dy, 2000);
	assert.strictEqual(input.mi_dwFlags, 0x8001);
	assert.strictEqual(input.ki_wVk, 0);
});

test("buildKeyboardInput produces unicode down input", () => {
	const input = CuaWin32.buildKeyboardInput(0, 65, 0x0004);
	assert.strictEqual(input.type, 1);
	assert.strictEqual(input.ki_wScan, 65);
	assert.strictEqual(input.ki_dwFlags, 0x0004);
	assert.strictEqual(input.mi_dx, 0);
});

/**
 * 与真实 koffi 同契约的替身：`LibraryHandle` 的方法是原生方法，receiver 必须是
 * 句柄对象本身（`proxy.func()` 抛 `TypeError: Illegal invocation`）。
 * 上面那组用例走真实 koffi，只有 Windows 才会命中这条路径；这里固定
 * `platform=win32` 让任意平台都能复现同一契约。
 */
function createReceiverSensitiveKoffi() {
	const state = { dlls: [], signatures: [], sizeofSpecs: [] };
	const load = (dllName) => {
		state.dlls.push(dllName);
		const lib = {
			dll: dllName,
			func(signature) {
				if (this !== lib) throw new TypeError("Illegal invocation");
				state.signatures.push(signature);
				return () => 0;
			},
		};
		return lib;
	};
	return {
		state,
		load,
		struct: (name) => ({ kind: "struct", name }),
		proto: (name) => ({ kind: "proto", name }),
		sizeof: (spec) => {
			state.sizeofSpecs.push(spec);
			return 40;
		},
		address: () => 0,
	};
}

test("module import binds koffi LibraryHandle methods to the handle", () => {
	// 2026-09-30 打包版启动即崩：顶层 `user32.func(...)` 经 Proxy 调用，this 被顶替
	// 成代理对象 → koffi 抛 Illegal invocation → 主进程入口模块加载失败（弹框把行号
	// 截成 `app.asar:33`，看着像 `require("koffi")` 炸了）。句柄方法必须 bind 回去。
	const koffi = createReceiverSensitiveKoffi();
	const mod = loadTsCommonJs("src/main/cua/CuaWin32.ts", {
		stubs: { "./koffiRuntime": { requireKoffi: () => koffi } },
		globals: { process: { platform: "win32" } },
	});

	assert.ok(koffi.state.dlls.includes("user32.dll"));
	assert.ok(koffi.state.dlls.includes("kernel32.dll"));
	assert.ok(koffi.state.signatures.some((signature) => signature.includes("GetSystemMetrics")));
	assert.ok(koffi.state.signatures.some((signature) => signature.includes("SendInput")));
	// INPUT 不再走 koffi struct（union 不可表达，见 packInputs），没有 sizeof 调用。
	assert.strictEqual(koffi.state.sizeofSpecs.length, 0);

	// 运行期经同一代理的调用同样要能以句柄为 receiver。替身 SendInput 返回 0，
	// sendInputs 不足额即抛——抛的是我们的 Error 而非 Illegal invocation 才证明绑定正常。
	assert.throws(() => mod.sendInputs([mod.buildMouseInput(1, 1, 0)]), /SendInput injected 0\/1/);
});

function createSendInputCapturingKoffi() {
	const state = { sendInputCalls: [] };
	const load = (dllName) => {
		const lib = {
			func(signature) {
				if (this !== lib) throw new TypeError("Illegal invocation");
				if (signature.includes("SendInput")) {
					return (count, buffer, size) => {
						state.sendInputCalls.push({ count, buffer: Buffer.from(buffer), size });
						return count;
					};
				}
				return () => 0;
			},
		};
		return lib;
	};
	return { state, load, struct: (name) => ({ kind: "struct", name }), proto: (name) => ({ kind: "proto", name }), sizeof: () => 40, address: () => 0 };
}

test("sendInputs packs INPUT records as 40-byte buffers (SendInput layout regression)", () => {
	// 修复前 INPUT 用 koffi struct 堆叠 mi/ki/hi 字段，sizeof ≈ 64 ≠ 40，
	// SendInput 恒 ERROR_INVALID_PARAMETER 返回 0（实机注入全静默失效）。
	const koffi = createSendInputCapturingKoffi();
	const mod = loadTsCommonJs("src/main/cua/CuaWin32.ts", {
		stubs: { "./koffiRuntime": { requireKoffi: () => koffi } },
		globals: { process: { platform: "win32" } },
	});

	// 鼠标记录
	mod.sendInputs([mod.buildMouseInput(1000, 2000, 0x8001)]);
	const mouseCall = koffi.state.sendInputCalls.at(-1);
	assert.strictEqual(mouseCall.count, 1);
	assert.strictEqual(mouseCall.size, 40, "cbSize must be sizeof(INPUT)=40");
	assert.strictEqual(mouseCall.buffer.length, 40);
	assert.strictEqual(mouseCall.buffer.readUInt32LE(0), 0, "INPUT_MOUSE");
	assert.strictEqual(mouseCall.buffer.readInt32LE(8), 1000, "mi.dx @8");
	assert.strictEqual(mouseCall.buffer.readInt32LE(12), 2000, "mi.dy @12");
	assert.strictEqual(mouseCall.buffer.readUInt32LE(20), 0x8001, "mi.dwFlags @20");

	// 键盘记录
	mod.sendInputs([mod.buildKeyboardInput(0x0d, 0x1c, 0x0004)]);
	const keyCall = koffi.state.sendInputCalls.at(-1);
	assert.strictEqual(keyCall.buffer.length, 40);
	assert.strictEqual(keyCall.buffer.readUInt32LE(0), 1, "INPUT_KEYBOARD");
	assert.strictEqual(keyCall.buffer.readUInt16LE(8), 0x0d, "ki.wVk @8");
	assert.strictEqual(keyCall.buffer.readUInt16LE(10), 0x1c, "ki.wScan @10");
	assert.strictEqual(keyCall.buffer.readUInt32LE(12), 0x0004, "ki.dwFlags @12");

	// 多条记录拼接 + 负滚轮 delta 按 DWORD 写入
	mod.scrollAt(100, 100, -120, 0, 1920, 1080);
	const scrollCall = koffi.state.sendInputCalls.at(-1);
	assert.strictEqual(scrollCall.count, 2, "move + wheel");
	assert.strictEqual(scrollCall.buffer.length, 80);
	assert.strictEqual(scrollCall.buffer.readUInt32LE(40 + 16), 0xffffff88, "wheel delta -120 as DWORD");
	assert.strictEqual(scrollCall.buffer.readUInt32LE(40 + 20) & 0x800, 0x800, "MOUSEEVENTF_WHEEL on second record");
});
