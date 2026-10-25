/**
 * 「复制为图片」回归：Electron 里 navigator.clipboard.write(ClipboardItem)
 * 常因失焦/权限直接抛错，用户只看到「复制失败」，主进程无 log。
 * 图片写入必须优先走 preload writeImage；截图 blob 为空不得假装成功。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import ts from "typescript";
import vm from "node:vm";

function read(path) {
	return readFileSync(path, "utf8");
}

function transpile(path) {
	return ts.transpileModule(read(path), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: path,
	}).outputText;
}

function loadClipboardImageParser() {
	const module = { exports: {} };
	vm.runInNewContext(transpile("src/shared/clipboardImage.ts"), { module, exports: module.exports }, { filename: "clipboardImage.ts" });
	return module.exports;
}

function loadClipboardUtils(options = {}) {
	const written = [];
	const nativeWriteImage =
		options.writeImage ??
		((dataUrl) => {
			written.push(dataUrl);
			return true;
		});
	const clipboardWrite =
		options.clipboardWrite ??
		(async () => {
			throw new Error("ClipboardItem write should not run when native writeImage works");
		});
	const logs = [];
	const module = { exports: {} };
	class BlobStub {
		constructor(parts = [], options = {}) {
			this.parts = parts;
			this.type = options.type || "";
		}
		async arrayBuffer() {
			return new TextEncoder().encode(String(this.parts[0] ?? "")).buffer;
		}
	}
	vm.runInNewContext(
		transpile("src/renderer/src/utils/clipboard.ts"),
		{
			module,
			exports: module.exports,
			require: () => ({}),
			console,
			Blob: BlobStub,
			ClipboardItem: class ClipboardItem {
				constructor(items) {
					this.items = items;
				}
			},
			Uint8Array,
			btoa: (value) => Buffer.from(value, "binary").toString("base64"),
			atob: (value) => Buffer.from(value, "base64").toString("binary"),
			window: {
				piDesktop: {
					clipboard: { writeImage: nativeWriteImage },
					app: {
						rendererLog: async (level, scope, message, detail) => {
							logs.push({ level, scope, message, detail });
						},
					},
				},
			},
			navigator: {
				clipboard: {
					write: clipboardWrite,
					writeText: async () => undefined,
				},
			},
		},
		{ filename: "clipboard.ts" },
	);
	return { ...module.exports, written, logs, BlobStub };
}

describe("parseClipboardImageDataUrl", () => {
	test("accepts standard png data URLs and MIME parameters", () => {
		const { parseClipboardImageDataUrl } = loadClipboardImageParser();
		const png = parseClipboardImageDataUrl("data:image/png;base64,abc");
		assert.equal(png?.mimeType, "image/png");
		assert.equal(png?.base64, "abc");
		const jpeg = parseClipboardImageDataUrl("data:image/jpeg;charset=utf-8;base64,Zm9v");
		assert.equal(jpeg?.mimeType, "image/jpeg");
		assert.equal(jpeg?.base64, "Zm9v");
		assert.equal(parseClipboardImageDataUrl("data:text/plain;base64,abc"), null);
		assert.equal(parseClipboardImageDataUrl("not-a-data-url"), null);
	});
});

describe("writeClipboardImage", () => {
	test("prefers native writeImage and skips ClipboardItem", async () => {
		let clipboardItemCalls = 0;
		const { writeClipboardImage, written } = loadClipboardUtils({
			clipboardWrite: async () => {
				clipboardItemCalls += 1;
			},
		});
		const ok = await writeClipboardImage("data:image/png;base64,abc");
		assert.equal(ok, true);
		assert.deepEqual(written, ["data:image/png;base64,abc"]);
		assert.equal(clipboardItemCalls, 0);
	});

	test("awaits Promise-returning native writeImage", async () => {
		let clipboardItemCalls = 0;
		const { writeClipboardImage, written } = loadClipboardUtils({
			writeImage: async (dataUrl) => {
				await Promise.resolve();
				written.push(dataUrl);
				return true;
			},
			clipboardWrite: async () => {
				clipboardItemCalls += 1;
			},
		});
		const ok = await writeClipboardImage("data:image/png;base64,abc");
		assert.equal(ok, true);
		assert.deepEqual(written, ["data:image/png;base64,abc"]);
		assert.equal(clipboardItemCalls, 0);
	});

	test("encodes a Blob then writes via native clipboard", async () => {
		const { writeClipboardImage, written, BlobStub } = loadClipboardUtils();
		const ok = await writeClipboardImage(new BlobStub(["blob"], { type: "image/png" }));
		assert.equal(ok, true);
		assert.equal(written.length, 1);
		assert.match(written[0], /^data:image\/png;base64,/);
	});

	test("logs and returns false when native write fails and ClipboardItem is blocked", async () => {
		const { writeClipboardImage, logs } = loadClipboardUtils({
			writeImage: () => false,
			clipboardWrite: async () => {
				throw new Error("Document is not focused.");
			},
		});
		const ok = await writeClipboardImage("data:image/png;base64,abc");
		assert.equal(ok, false);
		assert.equal(
			logs.some((entry) => entry.scope === "clipboard"),
			true,
		);
	});
});

test("copy-as-image paths use writeClipboardImage instead of ClipboardItem", () => {
	const surface = read("src/renderer/src/components/session/SurfaceComponents.tsx");
	const timeline = read("src/renderer/src/components/session/SessionMessageTimeline.tsx");
	const finalAnswer = read("src/renderer/src/components/session/turn/FinalAnswer.tsx");

	assert.match(surface, /writeClipboardImage/);
	assert.match(surface, /if \(!blob\) throw/);
	assert.doesNotMatch(surface, /navigator\.clipboard\.write\(\[new ClipboardItem/);

	assert.match(timeline, /writeClipboardImage/);
	assert.doesNotMatch(timeline, /navigator\.clipboard\.write\(\[\s*new ClipboardItem/);

	assert.match(finalAnswer, /writeClipboardImage/);
	assert.doesNotMatch(finalAnswer, /if \(!imageDataUrl \|\| !navigator\.clipboard\?\.write\) return/);
});

test("copy-as-image clone hides via .multi-select-image-export, not off-viewport offsets", () => {
	// html-to-image 会把 clone 的 computed style 复制进 SVG foreignObject 再渲染。
	// 若用 left:-100000px / position:fixed 隐藏 clone，内容会整体渲染到 viewBox 外 → 截图空白。
	// 必须复用 .multi-select-image-export（absolute + left/top 归零 + z-index:-1），与多选分享一致。
	const surface = read("src/renderer/src/components/session/SurfaceComponents.tsx");

	// 根因守卫：单条「复制为图片」的 clone 不得再用负偏移或 fixed 定位隐藏
	assert.doesNotMatch(surface, /style\.left\s*=\s*"-100000px"/);
	assert.doesNotMatch(surface, /style\.position\s*=\s*"fixed"/);
	// 正向：copyElementAsPng 复用多选分享的隐藏类
	assert.match(surface, /classList\.add\("multi-select-image-export"\)/);
});

test("native clipboard image write lives in main and preload only invokes IPC", () => {
	const preload = read("src/preload/index.ts");
	const native = read("src/main/clipboard/nativeClipboard.ts");
	const ipc = read("src/main/ipc/clipboardIpc.ts");
	const channels = read("src/shared/ipc.ts");

	assert.match(channels, /clipboardWriteImage: "clipboard:write-image"/);
	assert.match(ipc, /ipcMain\.handle\(ipcChannels\.clipboardWriteImage/);
	assert.match(native, /parseClipboardImageDataUrl/);
	assert.match(native, /nativeImage\.createFromBuffer/);
	assert.match(preload, /ipcRenderer\.invoke\(ipcChannels\.clipboardWriteImage/);
	assert.match(preload, /import \{ contextBridge, ipcRenderer, webUtils \} from "electron"/);
	assert.doesNotMatch(preload, /nativeImage\.createFromBuffer/);
	assert.doesNotMatch(preload, /clipboard\.readBuffer/);
});
