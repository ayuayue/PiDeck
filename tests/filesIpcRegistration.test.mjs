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
  const channelKeys = [...ipc.matchAll(/^\t(files\w+):\s*"files:/gm)].map(
    (m) => m[1],
  );
  assert.ok(
    channelKeys.length >= 10,
    `expected files:* channels, got ${channelKeys.length}`,
  );

  const missing = channelKeys.filter(
    (key) => !filesIpc.includes(`ipcChannels.${key}`),
  );
  assert.deepEqual(
    missing,
    [],
    "filesIpc.ts must register a handler for every files:* channel",
  );
});

test("project-scoped reads are validated in main before touching disk", () => {
  assert.match(filesIpc, /const resolveProjectReadBoundary = async/);
  assert.match(filesIpc, /projectStore\.get\(rawScope\.projectId\)/);
  assert.match(
    filesIpc,
    /createProjectFileReadBoundary\(toWindowsPath\(project\.path\)\)/,
  );
  assert.match(filesIpc, /resolveProjectFileReadPath\(boundary, hostPath\)/);
  assert.match(
    filesIpc,
    /const boundary = await resolveProjectReadBoundary\(scope\)/,
  );
  assert.match(
    filesIpc,
    /const readablePath = await resolveReadablePath\(path, boundary\)/,
  );
  assert.match(filesIpc, /const fileStat = await stat\(readablePath\)/);
  assert.match(filesIpc, /const buffer = await readFile\(readablePath\)/);
  assert.match(
    filesIpc,
    /const writablePath = await resolveReadablePath\(path, boundary\)/,
  );
  assert.match(filesIpc, /await writeFile\(writablePath, content, "utf8"\)/);
  // preload 只能传 projectId scope，不能传一个由 renderer 自报的可信根目录。
  assert.match(preload, /scope\?: ProjectFileAccessScope/);
  assert.match(preload, /filesOpen, path, scope/);
  assert.match(preload, /filesShowInFolder,\s*path,\s*scope/);
  assert.match(preload, /filesReadContent,\s*path,\s*maxBytes,\s*scope/);
  assert.match(preload, /filesPathsExist, paths, scope/);
  assert.match(preload, /filesReadBase64,\s*path,\s*maxBytes,\s*scope/);
  assert.match(preload, /filesWriteContent,\s*path,\s*content,\s*scope/);
});

test("project-scoped open/show operations resolve the registered project boundary", () => {
  const openBlock = filesIpc.match(
    /ipcMain\.handle\(ipcChannels\.filesOpen,[\s\S]*?\n\t\}\);/,
  );
  const showBlock = filesIpc.match(
    /ipcMain\.handle\(ipcChannels\.filesShowInFolder,[\s\S]*?\n\t\}\);/,
  );
  assert.ok(openBlock, "filesOpen handler should be discoverable");
  assert.ok(showBlock, "filesShowInFolder handler should be discoverable");
  for (const block of [openBlock[0], showBlock[0]]) {
    assert.match(block, /resolveProjectReadBoundary\(scope\)/);
    assert.match(block, /resolveReadablePath\(path, boundary\)/);
  }
  assert.match(openBlock[0], /shell\.openPath\(readablePath\)/);
  assert.match(showBlock[0], /shell\.showItemInFolder\(readablePath\)/);
});

test("files:list maps a deleted project root to a stable missing-directory error", () => {
  const block = filesIpc.match(
    /ipcMain\.handle\(\s*ipcChannels\.filesList,[\s\S]*?\n\t\);/,
  );
  assert.ok(block, "filesList handler should be discoverable");
  // 只转换根 listing 的 ENOENT；展开子目录的竞态错误保留原始上下文，便于定位具体路径。
  assert.match(
    block[0],
    /if \(!directory && \(error as NodeJS\.ErrnoException\)\.code === "ENOENT"\)/,
  );
  assert.match(block[0], /throw new Error\("PROJECT_DIRECTORY_MISSING"\)/);
});
