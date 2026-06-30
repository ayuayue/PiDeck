import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionsTabSource = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
const browserApiSource = readFileSync("src/renderer/src/browserApi.ts", "utf8");

test("extensions settings tab does not read preload API at module load", () => {
	assert.doesNotMatch(extensionsTabSource, /const\s+api[\s\S]*window\.piDesktop!?\.[a-zA-Z]/);
	assert.match(extensionsTabSource, /function getExtensionsApi\(/);
});

test("browser API validates web state before replacing renderer lists", () => {
	assert.match(browserApiSource, /function isWebState\(/);
	assert.match(browserApiSource, /Array\.isArray\(.*\.projects\)/);
	assert.match(browserApiSource, /Array\.isArray\(.*\.agents\)/);
	assert.match(browserApiSource, /Invalid web service state payload/);
});
