import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const representations = [
	["icon_16x16.png", 16],
	["icon_16x16@2x.png", 32],
	["icon_32x32.png", 32],
	["icon_32x32@2x.png", 64],
	["icon_128x128.png", 128],
	["icon_128x128@2x.png", 256],
	["icon_256x256.png", 256],
	["icon_256x256@2x.png", 512],
	["icon_512x512.png", 512],
	["icon_512x512@2x.png", 1024],
];

// Reading the embedded PNGs directly misses ICNS decoding failures in Spotlight.
// Use the same native decoder as macOS and compare every standard representation
// with its source PNG, composited on black to ignore RGB in transparent pixels.
test("macOS decodes every packaging icon representation without corrupting pixels", { skip: process.platform !== "darwin" }, async (t) => {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pideck-icns-"));
	t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
	const iconset = path.join(temporary, "decoded.iconset");
	execFileSync("/usr/bin/iconutil", ["--convert", "iconset", "--output", iconset, path.join(root, "build", "icon.icns")], { timeout: 30_000 });

	for (const [name, size] of representations) {
		await t.test(name, async () => {
			const decoded = sharp(path.join(iconset, name));
			const metadata = await decoded.metadata();
			assert.equal(metadata.width, size);
			assert.equal(metadata.height, size);
			const source = sharp(path.join(root, "build", "icons", `${size}x${size}.png`));
			const actualAlpha = await decoded.clone().extractChannel("alpha").raw().toBuffer();
			const expectedAlpha = await source.clone().extractChannel("alpha").raw().toBuffer();
			assert.deepEqual(actualAlpha, expectedAlpha, `${name}: native decoding must preserve transparency`);
			const actual = await decoded.flatten({ background: "#000000" }).raw().toBuffer();
			const expected = await source.flatten({ background: "#000000" }).raw().toBuffer();
			assert.equal(actual.length, expected.length);
			let maxDifference = 0;
			for (let i = 0; i < actual.length; i += 1) {
				maxDifference = Math.max(maxDifference, Math.abs(actual[i] - expected[i]));
			}
			assert.ok(maxDifference <= 2, `${name}: native ICNS decoding changed a channel by ${maxDifference}/255 (allowed: 2 for alpha rounding)`);
		});
	}
});
