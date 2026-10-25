import assert from "node:assert/strict";
import { test } from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 自定义 logo 图片读取（设置页选图 → 内联 data URL）的边界：
 * 主进程按 CUSTOM_LOGO_DATA_URL_MAX_LENGTH 丢弃超长值，若这里不缩图/不报错，
 * 用户选完图会「什么都没发生」且没有任何提示——所以阶梯缩图与超限报错都要有用例兜住。
 */
const MODULE = "src/renderer/src/utils/brandLogoImage.ts";
const DATA_URL_MAX = 1_500_000;

/** 造一份可控 DOM 替身：FileReader / Image / canvas 全部同步回调，不依赖真实浏览器 API。 */
function loadModule({ naturalWidth = 1024, naturalHeight = 1024, encodeResults = [] } = {}) {
	const calls = { images: 0, canvases: [] };
	let encodeIndex = 0;
	class FakeFileReader {
		readAsDataURL(file) {
			this.result = file.__dataUrl;
			this.onload?.();
		}
	}
	class FakeImage {
		set src(_value) {
			calls.images += 1;
			this.naturalWidth = naturalWidth;
			this.naturalHeight = naturalHeight;
			this.onload?.();
		}
	}
	const document = {
		createElement: (tag) => {
			assert.equal(tag, "canvas");
			const canvas = {
				width: 0,
				height: 0,
				getContext: () => ({ drawImage: () => undefined }),
				toDataURL: () => {
					calls.canvases.push({ width: canvas.width, height: canvas.height });
					const value = encodeResults[Math.min(encodeIndex, encodeResults.length - 1)];
					encodeIndex += 1;
					return value ?? "data:image/png;base64,OK";
				},
			};
			return canvas;
		},
	};
	const load = createTsSandbox({ globals: { FileReader: FakeFileReader, Image: FakeImage, document } });
	return { mod: load(MODULE), calls };
}

const file = (over) => ({ size: 10, type: "image/png", __dataUrl: "data:image/png;base64,SRC", ...over });

test("computeLogoScale 等比缩到最长边以内，无需缩放或尺寸非法时返回 null", () => {
	const { mod } = loadModule();
	assert.equal(mod.computeLogoScale(512, 512), null, "最长边已在限内不重编码");
	assert.equal(mod.computeLogoScale(200, 100), null);
	assert.deepEqual({ ...mod.computeLogoScale(1024, 1024) }, { width: 512, height: 512 });
	assert.deepEqual({ ...mod.computeLogoScale(2048, 512) }, { width: 512, height: 128 });
	assert.deepEqual({ ...mod.computeLogoScale(1, 3000) }, { width: 1, height: 512 }, "极窄图短边至少留 1px");
	assert.deepEqual({ ...mod.computeLogoScale(1000, 500, 256) }, { width: 256, height: 128 }, "maxEdge 可覆盖");
	for (const [w, h] of [
		[0, 10],
		[10, 0],
		[-1, 10],
		[Number.NaN, 10],
		[Number.POSITIVE_INFINITY, 10],
	]) {
		assert.equal(mod.computeLogoScale(w, h), null, `尺寸非法（${w}×${h}）交给调用方按原图处理`);
	}
});

test("readLogoImageFile：SVG 原样返回，不做光栅化", async () => {
	const { mod, calls } = loadModule();
	const url = await mod.readLogoImageFile(file({ type: "image/svg+xml", __dataUrl: "data:image/svg+xml;base64,SVG" }));
	assert.equal(url, "data:image/svg+xml;base64,SVG");
	assert.equal(calls.images, 0, "矢量图不进 Image 解码");
	assert.equal(calls.canvases.length, 0);
});

test("readLogoImageFile：源文件超上限直接拒绝（不先读进内存）", async () => {
	const { mod, calls } = loadModule();
	await assert.rejects(() => mod.readLogoImageFile(file({ size: 12 * 1024 * 1024 + 1 })), /too large/);
	assert.equal(calls.images, 0);
});

test("readLogoImageFile：位图按最长边阶梯缩图，第一档够小就停", async () => {
	const { mod, calls } = loadModule({ naturalWidth: 2048, naturalHeight: 1024, encodeResults: ["data:image/png;base64,SMALL"] });
	const url = await mod.readLogoImageFile(file({ type: "image/png" }));
	assert.equal(url, "data:image/png;base64,SMALL");
	assert.deepEqual(calls.canvases, [{ width: 512, height: 256 }], "512 档够小就不再降档");
});

test("readLogoImageFile：每档仍超上限时继续降档，走完还超则报错（不静默存主进程会丢弃的图）", async () => {
	const tooBig = `data:image/png;base64,${"A".repeat(DATA_URL_MAX)}`;
	const { mod, calls } = loadModule({ naturalWidth: 2048, naturalHeight: 2048, encodeResults: [tooBig, tooBig, "data:image/png;base64,OK"] });
	const url = await mod.readLogoImageFile(file());
	assert.equal(url, "data:image/png;base64,OK");
	assert.deepEqual(calls.canvases, [
		{ width: 512, height: 512 },
		{ width: 256, height: 256 },
		{ width: 128, height: 128 },
	]);

	const { mod: stillTooBig } = loadModule({ encodeResults: [tooBig] });
	await assert.rejects(() => stillTooBig.readLogoImageFile(file()), /still too large/);
});
