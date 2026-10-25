import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browser = readFileSync("src/renderer/src/components/app/BrowserPanel.tsx", "utf8");

test("browser consumes expected Chromium navigation aborts at the webview boundary", () => {
	assert.match(browser, /export function isExpectedNavigationAbort/);
	assert.match(browser, /ERR_ABORTED/);
	assert.match(browser, /void wv\.loadURL\(targetUrl\)\.catch/);
	assert.match(browser, /did-fail-load/);
	assert.match(browser, /failure\.errorCode === -3/);
});
