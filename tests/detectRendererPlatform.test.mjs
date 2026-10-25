import assert from "node:assert/strict";
import test from "node:test";
import { detectRendererPlatform } from "../src/renderer/src/lib/detectRendererPlatform.ts";

test("detectRendererPlatform maps Electron user agents without waiting for appInfo", () => {
	assert.equal(detectRendererPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.251 Electron/38.8.0 Safari/537.36"), "darwin");
	assert.equal(detectRendererPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.251 Electron/38.8.0 Safari/537.36"), "win32");
	assert.equal(detectRendererPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.251 Electron/38.8.0 Safari/537.36"), "linux");
});
