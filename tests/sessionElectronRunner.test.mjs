import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Electron fixture evidence excludes volatile Chromium cache trees", () => {
	const source = readFileSync("scripts/run-session-fixture-electron.mjs", "utf8");
	assert.match(source, /const FINAL_USER_DATA_EVIDENCE = \[/);
	assert.match(source, /"session-catalog\.json"/);
	assert.match(source, /"logs"/);
	assert.match(source, /await copyFinalUserDataEvidence\(userData, join\(runDir, "final-user-data"\)\)/);
	assert.doesNotMatch(source, /copyWithRetry\(userData, join\(runDir, "final-user-data"\)\)/);
});

test("Electron fixture closes the CDP browser before forcing the dev process tree", () => {
	const source = readFileSync("scripts/run-session-fixture-electron.mjs", "utf8");
	assert.match(source, /async function closeElectronGracefully\(cdp\)/);
	assert.match(source, /await cdp\.command\("Browser\.close"\)/);
	assert.match(source, /await closeElectronGracefully\(cdp\);[\s\S]*?await waitForChildExit\(child, 2_000\);[\s\S]*?await stopChildTree\(child\);/);
});

test("Electron fixture rejects pending CDP commands when Browser.close drops the socket", () => {
	const source = readFileSync("scripts/run-session-fixture-electron.mjs", "utf8");
	assert.match(source, /const rejectPending = \(cause\) => \{/);
	assert.match(source, /socket\.on\("close", \(\) => rejectPending\(new Error\("CDP connection closed"\)\)\)/);
	assert.match(source, /socket\.on\("error", \(error\) => rejectPending\(error\)\)/);
});

test("Electron fixture records dialog geometry for stable visual-parity diagnostics", () => {
	const source = readFileSync("scripts/run-session-fixture-electron.mjs", "utf8");
	assert.match(source, /modalLayouts: \["\.settings-modal", "\.config-modal"\]/);
	assert.match(source, /const rect = element\.getBoundingClientRect\(\)/);
	assert.match(source, /display: style\.display/);
	assert.match(source, /visibility: style\.visibility/);
	assert.match(source, /opacity: style\.opacity/);
});

test("Electron fixture waits for delayed session-first controls before parity clicks", () => {
	const source = readFileSync("scripts/run-session-fixture-electron.mjs", "utf8");
	assert.match(source, /async function clickMountedElement\(cdp, selector, timeoutMs = 15_000\)/);
	assert.match(source, /await sleep\(150\)/);
	assert.match(source, /await clickMountedElement\(cdp, clickSelector\)/);
	assert.doesNotMatch(source, /const matched = await evaluate\(cdp/);
});

test("Electron fixture can validate the production build without a Vite dev server", () => {
	const source = readFileSync("scripts/run-session-fixture-electron.mjs", "utf8");
	assert.match(source, /const useBuiltApp = process\.argv\.includes\("--built"\)/);
	assert.match(source, /function builtElectronExecutable\(root\)/);
	assert.match(source, /join\(repoRoot, "out", "main", "index\.js"\)/);
	assert.match(source, /function builtLaunchEnvironment\(\)/);
	assert.match(source, /delete env\.ELECTRON_RENDERER_URL/);
});
