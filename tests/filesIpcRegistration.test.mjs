import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const filesIpc = readFileSync("src/main/ipc/filesIpc.ts", "utf8");
const filesSystemIpc = readFileSync("src/main/ipc/filesSystemIpc.ts", "utf8");
const localFileBackend = readFileSync("src/main/files/LocalProjectFileBackend.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");

/**
 * 回归（30b6954b）：新增 files:copy/files:move 时误删了 filesShowInFolder
 * handler，渲染层右键「在文件夹中显示」报 No handler registered。
 * 这里校验 shared/ipc.ts 中每个 files:* 通道都在 filesIpc.ts 注册了 handler，
 * 任何通道漏注册（或反向误删）都会让本测试先红。
 */
test("every files:* channel in shared/ipc.ts has a handler registered in filesIpc.ts", () => {
	// 从 ipc.ts 提取 files* 常量名（filesList / filesOpen / ...）
	const channelKeys = [...ipc.matchAll(/^\t(files\w+):\s*"files:/gm)].map((m) => m[1]);
	assert.ok(channelKeys.length >= 10, `expected files:* channels, got ${channelKeys.length}`);

	const registeredFilesIpc = `${filesIpc}\n${filesSystemIpc}`;
	const missing = channelKeys.filter((key) => !registeredFilesIpc.includes(`ipcChannels.${key}`));
	assert.deepEqual(missing, [], "filesIpc.ts must register a handler for every files:* channel");
});

test("project-scoped reads route through registered local backend boundaries", () => {
	assert.match(filesIpc, /const resolveProjectReadBoundary = async/);
	assert.match(filesIpc, /projectStore\.get\(rawScope\.projectId\)/);
	assert.match(filesIpc, /createProjectFileReadBoundary\(toWindowsPath\(project\.path\)\)/);
	assert.match(filesIpc, /resolveProjectFileReadPath\(boundary, hostPath\)/);
	assert.match(filesIpc, /new LocalProjectFileBackend\(/);
	assert.match(filesIpc, /new ProjectFileBackendRouter\(/);
	assert.match(filesIpc, /projectFileBackendRouter\.forProject\(input\.projectId\)\.readContent\(input, limit\)/);
	assert.match(localFileBackend, /resolveProjectFileReadPath\(boundary, localPath\)/);
	assert.match(localFileBackend, /await readFile\(path, "utf8"\)/);
	assert.match(localFileBackend, /await writeFile\(path, content, "utf8"\)/);
	assert.match(filesIpc, /const readablePath = await resolveReadablePath\(input, boundary\)/);
	assert.match(filesIpc, /const writablePath = await resolveReadablePath\(input, boundary\)/);
	assert.match(filesIpc, /await writeFile\(writablePath, content, "utf8"\)/);
	assert.match(preload, /scope\?: ProjectFileAccessScope/);
	assert.match(preload, /filesOpen, path, scope/);
	assert.match(preload, /filesShowInFolder, path, scope/);
	assert.match(preload, /filesReadContent, path, maxBytes, scope/);
	assert.match(preload, /filesPathsExist, paths, scope/);
	assert.match(preload, /filesReadBase64, path, maxBytes, scope/);
	assert.match(preload, /filesWriteContent, path, content, scope/);
});

test("project-scoped open/show operations resolve the registered project boundary", () => {
	const openBlock = filesIpc.match(/ipcMain\.handle\(ipcChannels\.filesOpen,[\s\S]*?\n\t\}\);/);
	const showBlock = filesIpc.match(/ipcMain\.handle\(ipcChannels\.filesShowInFolder,[\s\S]*?\n\t\}\);/);
	assert.ok(openBlock, "filesOpen handler should be discoverable");
	assert.ok(showBlock, "filesShowInFolder handler should be discoverable");
	for (const block of [openBlock[0], showBlock[0]]) {
		assert.match(block, /parseFilePathInput\(path\)/);
		assert.match(block, /projectFileBackendRouter\.forProject\(input\.projectId\)/);
		assert.match(block, /resolveProjectReadBoundary\(scope\)/);
		assert.match(block, /resolveReadablePath\(input, boundary\)/);
	}
	assert.match(openBlock[0], /shell\.openPath\(readablePath\)/);
	assert.match(showBlock[0], /shell\.showItemInFolder\(readablePath\)/);
});

test("files:list routes targets to backend and maps missing roots consistently", () => {
	const block = filesIpc.match(/ipcMain\.handle\(\s*ipcChannels\.filesList,[\s\S]*?\n[\t ]*\}?\s*\);/);
	assert.ok(block, "filesList handler should be discoverable");
	assert.match(block[0], /target = parseProjectFileTarget\(projectOrTarget\)/);
	assert.match(block[0], /const backend = projectFileBackendRouter\.forProject\(projectId\)/);
	assert.match(block[0], /if \(target\) return backend\.list\(target, maxDepth\)/);
	assert.match(block[0], /resolveProjectFileReadPath\(boundary, toWindowsPath\(legacyDirectory\)\)/);
	assert.match(block[0], /return backend\.list\(\{ projectId, relativePath \}, maxDepth\)/);
	assert.match(localFileBackend, /if \(isMissingPath\(error\)\) throw new Error\("PROJECT_DIRECTORY_MISSING"\)/);
	assert.match(preload, /list: \(project: string \| ProjectFileTarget/);
});
