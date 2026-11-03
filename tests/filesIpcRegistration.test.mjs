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
 *
 * 合并说明：文件系统类通道拆到 filesSystemIpc.ts（dev 结构），远端 feature 的
 * project-relative target 校验仍在 filesIpc.ts —— 两个注册点都要计入。
 */
test("every files:* channel in shared/ipc.ts has a handler registered in filesIpc.ts", () => {
	// 从 ipc.ts 提取 files* 常量名（filesList / filesOpen / ...）
	const channelKeys = [...ipc.matchAll(/^\t(files\w+):\s*"files:/gm)].map((m) => m[1]);
	assert.ok(channelKeys.length >= 10, `expected files:* channels, got ${channelKeys.length}`);

	const registeredFilesIpc = `${filesIpc}\n${filesSystemIpc}`;
	const missing = channelKeys.filter((key) => !registeredFilesIpc.includes(`ipcChannels.${key}`));
	assert.deepEqual(missing, [], "filesIpc.ts / filesSystemIpc.ts must register a handler for every files:* channel");
});

test("project-scoped reads route through registered local backend boundaries", () => {
	assert.match(filesIpc, /const resolveProjectReadBoundary = async/);
	// 读边界经 localProject() 取项目——它内部走 projectStore.get 并额外拒绝 locator 项目
	// （远端项目不得进入本机文件路径）。意图不变：权威根只来自 ProjectStore，renderer 不能自报。
	assert.match(filesIpc, /const localProject = \(projectId: string\)/);
	assert.match(filesIpc, /const project = projectStore\.get\(projectId\);/);
	assert.match(filesIpc, /localProject\(rawScope\.projectId\)/);
	assert.match(filesIpc, /createProjectFileReadBoundary\(toWindowsPath\(project\.path, project\)\)/);
	assert.match(filesIpc, /resolveProjectFileReadPath\(boundary, hostPath\)/);
	// 远端 feature 的 project-relative file contract：本地实现 + 路由必须同时存在。
	assert.match(filesIpc, /new LocalProjectFileBackend\(/);
	assert.match(filesIpc, /new ProjectFileBackendRouter\(/);
	assert.match(filesIpc, /projectFileBackendRouter\.forProject\(input\.projectId\)\.readContent\(input, effectiveMax\)/);
	assert.match(localFileBackend, /resolveProjectFileReadPath\(boundary, localPath\)/);
	assert.match(localFileBackend, /readTextFileGuarded\(path, maxBytes\)/);
	// 写路径走共享守卫（密文拦截 + 原子替换），不得回退到裸 writeFile。
	assert.match(localFileBackend, /await writeTextFileGuarded\(path, content\)/);
	assert.match(filesIpc, /const boundary = await resolveProjectReadBoundary\(scope\)/);
	assert.match(filesIpc, /const readablePath = await resolveReadablePath\(input, boundary\)/);
	assert.match(filesIpc, /const fileStat = await stat\(readablePath\)/);
	assert.match(filesIpc, /const writablePath = await resolveReadablePath\(input, boundary\)/);
	assert.match(filesIpc, /await writeTextFileGuarded\(writablePath, content\)/);
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
	// issue #396：Linux 上 shell.openPath 永不 settle，handler 必须走受保护的统一入口。
	assert.match(openBlock[0], /openSystemPath\s*\(\s*readablePath\s*\)/);
	assert.match(showBlock[0], /shell\.showItemInFolder\(readablePath\)/);
});

test("files:list routes project-relative targets through the backend and validates legacy input", () => {
	const block = filesIpc.match(/ipcMain\.handle\(\s*ipcChannels\.filesList,[\s\S]*?\n[\t ]*\}?\s*\);/);
	assert.ok(block, "filesList handler should be discoverable");
	assert.match(block[0], /target = parseProjectFileTarget\(projectOrTarget\)/);
	assert.match(block[0], /const backend = projectFileBackendRouter\.forProject\(projectId\)/);
	assert.match(block[0], /if \(target\) return await listOrEmpty\(target\)/);
	// legacy directory（字符串 + directory 选项）仍走注册根 realpath 边界，不信任 renderer 自报。
	assert.match(block[0], /resolveProjectFileReadPath\(boundary, toWindowsPath\(legacyDirectory, project\)\)/);
	assert.match(block[0], /return await listOrEmpty\(\{ projectId, relativePath \}\)/);
	// ENOENT 分档（dev 2026-10 语义）：根 listing 由 backend 映射为稳定错误码；展开中的子目录
	// 返回空子树（抽屉记住的展开态可能已被 pi-subagents 清理）；非 ENOENT 仍须原样抛。
	assert.match(localFileBackend, /if \(isMissingPath\(error\)\) throw new Error\("PROJECT_DIRECTORY_MISSING"\)/);
	assert.match(block[0], /request\.relativePath !== "" && error instanceof Error && error\.message === "PROJECT_DIRECTORY_MISSING"\) return \[\]/);
	assert.match(block[0], /throw error;/);
	assert.match(localFileBackend, /throw error;/);
	assert.match(preload, /list: \(project: string \| ProjectFileTarget/);
});

test("filesReadBase64 enforces a main-process default cap when the renderer omits maxBytes", () => {
	// 回归（2026-10 内存审计）：文件抽屉二进制预览不传 maxBytes，曾整文件读入再 base64
	// 放大 1.33 倍过 IPC——上限必须由主进程兜底（渲染层输入不可信），不能依赖调用方自觉。
	const block = filesIpc.match(/ipcMain\.handle\(\s*ipcChannels\.filesReadBase64,[\s\S]*?\n\t\}\);/);
	assert.ok(block, "filesReadBase64 handler should be discoverable");
	assert.match(filesIpc, /MAX_BINARY_PREVIEW_BYTES = 64 \* 1024 \* 1024/, "默认上限常量必须存在");
	// stat 拦截必须无条件执行：不再包在「调用方传了 maxBytes」的 if 里
	assert.match(block[0], /const effectiveMaxBytes\s*=/);
	assert.match(block[0], /const fileStat = await stat\(readablePath\)/);
	assert.match(block[0], /FILE_TOO_LARGE:\$\{fileStat\.size\}:\$\{Math\.floor\(effectiveMaxBytes\)\}/);
});
