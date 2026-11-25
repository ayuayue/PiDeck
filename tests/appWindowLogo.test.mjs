import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const CLASSIC = "classic.png";
const CLASSIC_WINDOWS = "classic-windows.png";
const PADDED = "pi-tui.png";
const WINDOWS = "pi-tui-windows.png";

/** 隔离 Electron 读图边界，实际执行生产解析器及 LogoStyle 回落逻辑。 */
function createHarness(platform, { customEmpty = false, builtinEmpty = false } = {}) {
	const paths = [];
	const customImage = { isEmpty: () => customEmpty };
	const module = loadTsCommonJs("src/main/appWindowLogo.ts", {
		stubs: {
			electron: {
				app: {},
				nativeImage: {
					createFromPath: (source) => {
						paths.push(source);
						return { source, isEmpty: () => builtinEmpty };
					},
					createFromDataURL: () => customImage,
				},
			},
			"../../build/icon.png?asset": CLASSIC,
			"../../build/icon-classic-windows.png?asset": CLASSIC_WINDOWS,
			"../../build/icon-pi-tui.png?asset": PADDED,
			"../../build/icon-pi-tui-windows.png?asset": WINDOWS,
			"./logging/sharedLogger": { getAppLogger: () => null },
		},
		globals: { process: { platform } },
	});
	return { ...module, paths, customImage };
}

test("Windows 默认与旧设置回落使用无 Dock 留白的白底图标", () => {
	const harness = createHarness("win32");
	for (const style of ["pi-tui", undefined, null, "unknown"]) {
		const entry = harness.resolveLogoImage(style);
		assert.equal(entry.resolved, "pi-tui");
		assert.equal(entry.image.source, WINDOWS);
	}
});

test("macOS 和 Linux 继续使用保留外层留白的图标", () => {
	for (const platform of ["darwin", "linux"]) {
		const harness = createHarness(platform);
		assert.equal(harness.resolveLogoImage("pi-tui").image.source, PADDED);
	}
});

test("两种内置风格均使用对应平台资源，自定义图片保持原样", () => {
	for (const platform of ["win32", "darwin", "linux"]) {
		const harness = createHarness(platform);
		const expectedClassic = platform === "win32" ? CLASSIC_WINDOWS : CLASSIC;
		assert.equal(harness.resolveLogoImage("classic").image.source, expectedClassic);
		const custom = harness.resolveLogoImage("custom", "data:image/png;base64,custom");
		assert.equal(custom.resolved, "custom");
		assert.equal(custom.image, harness.customImage);
		assert.deepEqual(harness.paths, [expectedClassic], "custom image must not be replaced by a platform asset");
	}
});

test("Windows 自定义图片缺失或解码失败时回落到无额外留白的默认图", () => {
	for (const source of [undefined, "", "https://example.com/logo.png", "data:image/png;base64,broken"]) {
		const harness = createHarness("win32", { customEmpty: true });
		const entry = harness.resolveLogoImage("custom", source);
		assert.equal(entry.resolved, "pi-tui");
		assert.equal(entry.image.source, WINDOWS);
	}
});

test("平台图标资源缺失时保持现有图标", () => {
	const harness = createHarness("win32", { builtinEmpty: true });
	assert.equal(harness.resolveLogoImage("pi-tui"), null);
});
