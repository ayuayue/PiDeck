import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// vm 沙箱里的对象/数组原型与宿主不同，deepStrictEqual 会因原型不一致失败。
const plain = (value) => JSON.parse(JSON.stringify(value));

const PRIMARY = { id: 2919297941, label: "DELL U2720Q", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const SECONDARY = { id: 3094298054, label: "副屏", bounds: { x: -1560, y: 0, width: 1560, height: 1040 }, scaleFactor: 2 };

function loadDisplay(displays) {
	return loadTsCommonJs("src/main/cua/CuaDisplay.ts", {
		stubs: {
			electron: {
				screen: {
					getAllDisplays: () => displays,
					getPrimaryDisplay: () => displays.find((display) => display.id === PRIMARY.id) ?? displays[0],
				},
			},
		},
	});
}

test("toScreenRect converts DIP to physical pixels, keeping negative origins", () => {
	const mod = loadTsCommonJs("src/main/cua/CuaDisplay.ts");
	// 本机副屏：DIP (-1560,0) @200% → 物理 (-3120,0)，与 GetSystemMetrics 的虚拟桌面原点一致。
	assert.deepStrictEqual(plain(mod.toScreenRect(SECONDARY.bounds, 2)), { x: -3120, y: 0, width: 3120, height: 2080 });
	assert.deepStrictEqual(plain(mod.toScreenRect(PRIMARY.bounds, 1)), { x: 0, y: 0, width: 1920, height: 1080 });
});

test("toScreenRect rounds edges so adjacent displays still tile the desktop", () => {
	const mod = loadTsCommonJs("src/main/cua/CuaDisplay.ts");
	// 125% 缩放：1501 * 1.25 = 1876.25；宽度必须由取整后的右边界反推，避免 1px 缝。
	const left = mod.toScreenRect({ x: -1501, y: 0, width: 1501, height: 1000 }, 1.25);
	const right = mod.toScreenRect({ x: 0, y: 0, width: 1501, height: 1000 }, 1.25);
	assert.strictEqual(left.x + left.width, right.x);
	assert.strictEqual(left.height, right.height);
});

test("toScreenRect falls back to scale 1 for degenerate scale factors", () => {
	const mod = loadTsCommonJs("src/main/cua/CuaDisplay.ts");
	const bounds = { x: 0, y: 0, width: 800, height: 600 };
	assert.deepStrictEqual(plain(mod.toScreenRect(bounds, 0)), { x: 0, y: 0, width: 800, height: 600 });
	assert.deepStrictEqual(plain(mod.toScreenRect(bounds, Number.NaN)), { x: 0, y: 0, width: 800, height: 600 });
});

test("toCuaDisplays stringifies ids and flags the primary display", () => {
	const mod = loadTsCommonJs("src/main/cua/CuaDisplay.ts");
	const displays = plain(mod.toCuaDisplays([PRIMARY, SECONDARY], PRIMARY.id));

	assert.deepStrictEqual(displays, [
		{
			displayId: "2919297941",
			label: "DELL U2720Q",
			isPrimary: true,
			scaleFactor: 1,
			bounds: { x: 0, y: 0, width: 1920, height: 1080 },
		},
		{
			displayId: "3094298054",
			label: "副屏",
			isPrimary: false,
			scaleFactor: 2,
			bounds: { x: -3120, y: 0, width: 3120, height: 2080 },
		},
	]);
});

test("listCuaDisplays puts the primary display first even when Electron orders it second", () => {
	const mod = loadDisplay([SECONDARY, PRIMARY]);
	const displays = plain(mod.listCuaDisplays());

	assert.deepStrictEqual(
		displays.map((display) => display.displayId),
		["2919297941", "3094298054"],
	);
	assert.strictEqual(displays[0].isPrimary, true);
});

test("isPrimarySelector accepts unset, primary and main only", () => {
	const mod = loadTsCommonJs("src/main/cua/CuaDisplay.ts");
	for (const value of [undefined, "", "primary", "PRIMARY", " main "]) {
		assert.strictEqual(mod.isPrimarySelector(value), true, `${String(value)} should mean primary`);
	}
	for (const value of ["secondary", "3094298054", "screen:0:0"]) {
		assert.strictEqual(mod.isPrimarySelector(value), false, `${value} is not primary`);
	}
});
