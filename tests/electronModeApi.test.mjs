import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const mainSource = readFileSync("src/main/index.ts", "utf8");
const petWindowSource = readFileSync("src/main/pet/PetWindow.ts", "utf8");
const preloadPathSource = readFileSync("src/main/preloadPath.ts", "utf8");
const preloadSource = readFileSync("src/preload/index.ts", "utf8");
const ipcSource = readFileSync("src/shared/ipc.ts", "utf8");

test("Electron renderer does not fall back to preview browser API when preload is missing", () => {
	assert.match(appSource, /isElectronRuntime/);
	assert.match(appSource, /missingElectronPreload/);
	assert.match(appSource, /app\.preloadMissing/);
	assert.match(appSource, /function createUnavailableDesktopApi\(/);
	assert.match(appSource, /missingElectronPreload\s*\?\s*createUnavailableDesktopApi\(\)/);
	assert.doesNotMatch(
		appSource,
		/window\.piDesktop\s*\?\?\s*\(isLanWeb\s*\?\s*createBrowserApi\(\)\s*:\s*createPreviewApi\(\)\)/,
	);
	assert.doesNotMatch(
		appSource,
		/missingElectronPreload\s*\|\|\s*!isLanWeb\s*\?\s*createPreviewApi\(\)/,
	);
});

test("packaged main and pet windows never load the dev server URL", () => {
	assert.match(mainSource, /function shouldUseDevRendererUrl\(/);
	assert.match(mainSource, /is\.dev/);
	assert.match(mainSource, /!app\.isPackaged/);
	assert.match(mainSource, /mainWindow\.loadURL\(devRendererUrl\)/);
	assert.doesNotMatch(
		mainSource,
		/is\.dev\s*&&\s*process\.env\.ELECTRON_RENDERER_URL[\s\S]*mainWindow\.loadURL/,
	);
	assert.match(petWindowSource, /shouldUseDevRendererUrl\(/);
	assert.match(petWindowSource, /!app\.isPackaged/);
});

test("main window logs configured preload file and preload reports initialization", () => {
	assert.match(mainSource, /async function prepareMainPreloadPath\(/);
	assert.match(preloadPathSource, /export async function preparePreloadPath\(/);
	assert.match(preloadPathSource, /app\.getPath\("userData"\)/);
	assert.match(preloadPathSource, /copyFile\(sourcePath, targetPath\)/);
	assert.match(mainSource, /Main window preload configured/);
	assert.match(mainSource, /existsSync\(mainPreloadPath\)/);
	assert.match(mainSource, /Main window preload failed/);
	assert.match(mainSource, /webContents\.on\("preload-error"/);
	assert.match(petWindowSource, /preparePreloadPath\(sourcePreloadPath, "pet-preload\.js"\)/);
	assert.match(mainSource, /ipcMain\.on\(ipcChannels\.preloadReady/);
	assert.match(mainSource, /ipcMain\.on\(ipcChannels\.preloadError/);
	assert.match(preloadSource, /ipcChannels\.preloadReady/);
	assert.match(preloadSource, /ipcChannels\.preloadError/);
	assert.match(preloadSource, /contextBridge\.exposeInMainWorld\("piDesktop", api\)/);
	assert.match(ipcSource, /preloadReady:\s*"preload:ready"/);
	assert.match(ipcSource, /preloadError:\s*"preload:error"/);
});
