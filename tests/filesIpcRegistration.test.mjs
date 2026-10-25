import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const filesIpc = readFileSync("src/main/ipc/filesIpc.ts", "utf8");
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

	const missing = channelKeys.filter((key) => !filesIpc.includes(`ipcChannels.${key}`));
	assert.deepEqual(missing, [], "filesIpc.ts must register a handler for every files:* channel");
});

test("project-scoped reads are validated in main before touching disk", () => {
	assert.match(filesIpc, /const resolveProjectReadBoundary = async/);
	assert.match(filesIpc, /projectStore\.get\(rawScope\.projectId\)/);
	assert.match(filesIpc, /createProjectFileReadBoundary\(toWindowsPath\(project\.path\)\)/);
	assert.match(filesIpc, /resolveProjectFileReadPath\(boundary, hostPath\)/);
	assert.match(filesIpc, /const boundary = await resolveProjectReadBoundary\(scope\)/);
	assert.match(filesIpc, /const readablePath = await resolveReadablePath\(path, boundary\)/);
	assert.match(filesIpc, /const fileStat = await stat\(readablePath\)/);
	assert.match(filesIpc, /const buffer = await readFile\(readablePath\)/);
	assert.match(filesIpc, /const writablePath = await resolveReadablePath\(path, boundary\)/);
	assert.match(filesIpc, /await writeFile\(writablePath, content, "utf8"\)/);
	// preload 只能传 projectId scope，不能传一个由 renderer 自报的可信根目录。
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
		assert.match(block, /resolveProjectReadBoundary\(scope\)/);
		assert.match(block, /resolveReadablePath\(path, boundary\)/);
	}
	// issue #396：Linux 上 shell.openPath 永不 settle，handler 必须走受保护的统一入口。
	assert.match(openBlock[0], /openSystemPath\s*\(\s*readablePath\s*\)/);
	assert.match(showBlock[0], /shell\.showItemInFolder\(readablePath\)/);
});

test("files:list maps ENOENT by scope: project root → stable error, vanished subdirectory → empty subtree", () => {
	// 闭合括号的缩进/写法可能被 formatter 调整：用 \s* 容忍。
	const block = filesIpc.match(/ipcMain\.handle\(\s*ipcChannels\.filesList,[\s\S]*?\n[\t ]*\}?\s*\);/);
	assert.ok(block, "filesList handler should be discoverable");
	// 根 listing 的 ENOENT 必须映射为稳定错误码（渲染层据此清空文件树/刷新 presence）。
	assert.match(block[0], /if\s*\(\s*!directory\s*\)\s*throw new Error\("PROJECT_DIRECTORY_MISSING"\)/);
	// 子目录 ENOENT 返回空子树而非裸抛：抽屉记住的展开态可能指向已被清理的目录
	// （典型：pi-subagents 运行后清理 artifacts/outputs），裸抛会打 handler 报错
	// 并把节点标成「加载失败」（2026-10-03 子代理会话实测）。
	assert.match(block[0], /return\s*\[\]\s*;/);
	// 非 ENOENT 错误（目录过大/越界）仍须原样抛出，不得被空子树吞掉。
	assert.match(block[0], /if\s*\(\s*\(error as NodeJS\.ErrnoException\)\.code !== "ENOENT"\s*\)\s*throw error/);
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
