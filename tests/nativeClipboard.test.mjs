/**
 * 主进程剪贴板：Electron 38 禁止 renderer/preload 直连 clipboard。
 * 这里测 data URL 写入结果码、CF_HDROP 解析、IPC 三处同步。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function read(path) {
	return readFileSync(path, "utf8");
}

function compile(path) {
	return ts.transpileModule(read(path), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: path,
	}).outputText;
}

function encodeCfHdrop(paths) {
	const pFiles = 20;
	const header = Buffer.alloc(20);
	header.writeUInt32LE(pFiles, 0);
	header.writeUInt32LE(1, 16);
	const encoded = paths.flatMap((path) => [Buffer.from(path, "utf16le"), Buffer.alloc(2)]);
	return Buffer.concat([header, ...encoded, Buffer.alloc(2)]);
}

function loadNativeClipboard({ clipboard, nativeImage, platform = "win32" }) {
	const cache = new Map();
	function load(path) {
		if (cache.has(path)) return cache.get(path);
		const module = { exports: {} };
		cache.set(path, module.exports);
		vm.runInNewContext(
			compile(path),
			{
				module,
				exports: module.exports,
				Buffer,
				process: { platform },
				require: (id) => {
					if (id === "electron") return { clipboard, nativeImage };
					if (id === "../../shared/clipboardImage") return load("src/shared/clipboardImage.ts");
					if (id === "./clipboardFilePaths") return load("src/main/clipboard/clipboardFilePaths.ts");
					throw new Error(`unexpected require ${id}`);
				},
			},
			{ filename: path },
		);
		cache.set(path, module.exports);
		return module.exports;
	}
	return load("src/main/clipboard/nativeClipboard.ts");
}

describe("writeClipboardImageDataUrl", () => {
	test("rejects empty, invalid, oversized, and empty native images", () => {
		const native = loadNativeClipboard({
			clipboard: {
				writeImage() {},
				readImage: () => ({ isEmpty: () => true }),
			},
			nativeImage: {
				createFromBuffer: () => ({ isEmpty: () => true }),
			},
		});
		assert.equal(native.writeClipboardImageDataUrl("").reason, "empty-payload");
		assert.equal(native.writeClipboardImageDataUrl("data:text/plain;base64,abc").reason, "invalid-data-url");
		assert.equal(native.writeClipboardImageDataUrl(`data:image/png;base64,${"a".repeat(native.CLIPBOARD_IMAGE_MAX_CHARS)}`).reason, "payload-too-large");
		assert.equal(native.writeClipboardImageDataUrl("data:image/png;base64,abc").reason, "empty-native-image");
	});

	test("writes bitmap and confirms by reading it back", () => {
		let written = false;
		const native = loadNativeClipboard({
			clipboard: {
				writeImage() {
					written = true;
				},
				readImage: () => ({ isEmpty: () => !written }),
			},
			nativeImage: {
				createFromBuffer: () => ({ isEmpty: () => false }),
			},
		});
		const result = native.writeClipboardImageDataUrl("data:image/png;base64,abc");
		assert.equal(result.ok, true);
	});
});

describe("readClipboardFilePaths", () => {
	test("parses Windows CF_HDROP buffers", () => {
		const native = loadNativeClipboard({
			clipboard: {
				readBuffer: (format) => (format === "CF_HDROP" ? encodeCfHdrop(["C:\\tmp\\a.png"]) : Buffer.alloc(0)),
				has: () => false,
			},
			nativeImage: {},
		});
		const paths = native.readClipboardFilePaths();
		assert.equal(paths.length, 1);
		assert.equal(paths[0], "C:\\tmp\\a.png");
	});
});

test("clipboard IPC is registered in main, preload, and shared channels", () => {
	const channels = read("src/shared/ipc.ts");
	const ipc = read("src/main/ipc/clipboardIpc.ts");
	const preload = read("src/preload/index.ts");
	const mainIndex = read("src/main/index.ts");
	const keys = [...channels.matchAll(/^\t(clipboard\w+):\s*"clipboard:/gm)].map((m) => m[1]);
	assert.ok(keys.length >= 5, `expected clipboard:* channels, got ${keys.length}`);
	assert.deepEqual(
		keys.filter((key) => !ipc.includes(`ipcChannels.${key}`)),
		[],
	);
	assert.match(mainIndex, /registerClipboardIpc\(\{ appLogger \}\)/);
	assert.match(preload, /clipboardWriteImage/);
	assert.match(preload, /clipboardReadFilePaths/);
	assert.doesNotMatch(preload, /clipboard\.readBuffer/);
	assert.doesNotMatch(preload, /clipboard\.has\(/);
});
