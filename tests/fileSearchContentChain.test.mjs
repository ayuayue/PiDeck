/**
 * 工作区文件正文搜索（files:search-content，file-index Go sidecar）的链路契约测试。
 *
 * 与跨会话正文搜索同构：IPC 三处同步（通道常量 / main handler / preload 白名单）
 * 漏一处就是运行时 undefined，渲染层静默拿不到结果。这里用源码扫描钉住接点，
 * 并锁住降级语义：无 sidecar / WSL / 未就绪 / 异常一律返回 null（名字搜索照旧）
 * 与内容分区只在有命中时才渲染。正则全部空白容忍（biome 重排格式不破坏断言）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");

test("shared/ipc.ts：通道常量 files:search-content 已定义", () => {
	const source = read("../src/shared/ipc.ts");
	assert.match(source, /filesSearchContent:\s*["']files:search-content["']/);
});

test("filesIpc.ts：内容 handler 注册 + 未注入/WSL/未就绪一律 null（绝不抛错给渲染层）", () => {
	const source = read("../src/main/ipc/filesIpc.ts");
	assert.match(source, /ipcMain\.handle\(ipcChannels\.filesSearchContent/);
	assert.match(source, /getFileIndexService/);
	assert.match(source, /if\s*\(!fileIndex\)\s*return\s+null;/);
	// WSL/无根目录：不查内容（宿主 Go 读 UNC 不可靠），名字搜索保持原样
	assert.match(source, /indexRootsFor\s*=\s*\(environment[\s\S]{0,200}?environment\s*===\s*["']wsl["']/);
	assert.match(source, /if\s*\(roots\.length\s*===\s*0\)\s*return\s+null;/);
	// 未就绪：后台预热 + 本次降级为 null（不把渲染层挂到 boot 结束）
	assert.match(source, /!fileIndex\.isReady\(roots\)\)\s*\{[\s\S]{0,160}?fileIndex\.warmup\(roots\);\s*\n\s*return null;/);
	// 异常吞掉返回 null：搜索入口永不报错
	assert.match(source, /const result = await fileIndex\.searchContent\(roots, normalizedQuery\);[\s\S]{0,120}?return result\.ok \? result\.value : null;/);
});

test("filesIpc.ts：名字搜索优先走索引、失败回退目录扫描（行为不劣化）", () => {
	const source = read("../src/main/ipc/filesIpc.ts");
	assert.match(source, /fileIndex\.searchNames\(/);
	assert.match(source, /fileSystemService\.searchNames\(/);
	// 索引命中要剥掉内部 score，只把 FileSearchResult 形状交给渲染层
	assert.match(source, /hits\.map\(\(hit\)\s*=>\s*\(\{\s*name:\s*hit\.name,\s*path:\s*hit\.path,\s*relativePath:\s*hit\.relativePath,\s*type:\s*hit\.type\s*\}\)\)/);
});

test("preload/index.ts：files.searchContent 暴露在白名单", () => {
	const source = read("../src/preload/index.ts");
	assert.match(source, /searchContent:\s*\(projectId:\s*string,\s*query:\s*string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.filesSearchContent/);
});

test("previewApi.ts：预览模式降级 stub 返回 null", () => {
	const source = read("../src/renderer/src/previewApi.ts");
	assert.match(source, /files:\s*\{[\s\S]{0,600}?searchContent:\s*async\s*\(\)\s*=>\s*null/);
});

test("main/index.ts：装配 FileIndexService + 注册 quitCleanup + 注入 getter", () => {
	const source = read("../src/main/index.ts");
	assert.match(source, /new FileIndexService\(\{/);
	assert.match(source, /quitCleanup\.register\(["']file-index["']/);
	assert.match(source, /getFileIndexService:\s*\(\)\s*=>\s*fileIndexService/);
	// 二进制定位：打包态 resources/file-index，开发态仓库 resources/file-index/bin
	assert.match(source, /join\(process\.resourcesPath,\s*["']file-index["']\)/);
});

test("useFileSearch.ts：内容检索与名字检索同防抖并行，迟到结果按代次丢弃", () => {
	const source = read("../src/renderer/src/hooks/useFileSearch.ts");
	assert.match(source, /export\s+const\s+FILE_CONTENT_SEARCH_MIN_QUERY_LENGTH\s*=\s*2/);
	assert.match(source, /window\.piDesktop\.files\.searchContent\(projectId,\s*trimmed\)/);
	assert.match(source, /seq\s*===\s*requestSeqRef\.current\)\s*setContentResults/);
	// 查询词太短不扫内容（单字符命中几乎是全库）
	assert.match(source, /contentEnabled\s*=\s*trimmed\.length\s*>=\s*FILE_CONTENT_SEARCH_MIN_QUERY_LENGTH/);
});

test("FileSearchResults.tsx：内容命中分区 + 行渲染片段与行号，点击打开文件", () => {
	const source = read("../src/renderer/src/components/session/FileSearchResults.tsx");
	assert.match(source, /contentResults:\s*FileContentSearchResult\s*\|\s*null/);
	assert.match(source, /function\s+FileContentSection\(/);
	assert.match(source, /hit\.relativePath/);
	assert.match(source, /hit\.line/);
	assert.match(source, /hit\.snippet/);
	// 没有命中且不在扫描中时整段不渲染
	assert.match(source, /if\s*\(hits\.length\s*===\s*0\s*&&\s*!props\.isSearching\)\s*return\s+null;/);
	// 右键菜单复用文件树节点形状（在文件夹中显示/复制路径等能力天然具备）
	assert.match(source, /onFileContextMenu\(node,\s*event\.clientX,\s*event\.clientY\)/);
});

test("WorkspaceSurface.tsx：把内容态透传给搜索结果面板", () => {
	const source = read("../src/renderer/src/components/session/WorkspaceSurface.tsx");
	assert.match(source, /contentResults=\{fileSearch\.contentResults\}/);
	assert.match(source, /isContentSearching=\{fileSearch\.isContentSearching\}/);
});

test("i18n：内容分区文案在三份词典中都有（zh-CN/en-US 手写、zh-TW 生成）", () => {
	for (const file of ["../src/renderer/src/i18n/rendererCopy.zh-CN.ts", "../src/renderer/src/i18n/rendererCopy.en-US.ts", "../src/renderer/src/i18n/rendererCopy.zh-TW.ts"]) {
		const source = read(file);
		assert.match(source, /"drawer\.fileSearchContentSection":/);
		assert.match(source, /"drawer\.fileSearchContentScanning":/);
		assert.match(source, /"drawer\.fileSearchContentTruncated":/);
	}
});

test("打包/CI：构建脚本、extraResources、gitignore、dev 与三平台 workflow 都登记了 file-index", () => {
	const pkg = read("../package.json");
	assert.match(pkg, /"build:file-index":\s*"node scripts\/build-file-index\.mjs"/);
	assert.match(pkg, /npm run build:file-index/);
	assert.match(pkg, /"from":\s*"resources\/file-index\/bin"[\s\S]{0,160}?"to":\s*"file-index"/);
	const gitignore = read("../.gitignore");
	assert.match(gitignore, /resources\/file-index\/bin\/\*/);
	assert.match(gitignore, /!resources\/file-index\/bin\/\.gitkeep/);
	const dev = read("../scripts/dev.js");
	assert.match(dev, /npm run build:file-index/);
	for (const workflow of ["../.github/workflows/build-windows.yml", "../.github/workflows/build-linux.yml", "../.github/workflows/build-macos.yml"]) {
		const source = read(workflow);
		assert.match(source, /FILE_INDEX_OS:/);
		assert.match(source, /FILE_INDEX_ARCH:/);
		assert.match(source, /go -C native\/file-index test \.\/\.\.\./);
		// 拼音依赖解析不到时 go build 会失败并 fail-open（功能静默消失），缓存清单必须带上 go.sum
		assert.match(source, /cache-dependency-path: \|[\s\S]{0,200}?native\/file-index\/go\.sum/);
	}
});

test("拼音检索：go.mod 声明依赖、go.sum 入库（fail-open 下静默丢功能的那个坑）", () => {
	const gomod = read("../native/file-index/go.mod");
	assert.match(gomod, /require github\.com\/mozillazg\/go-pinyin v\d/);
	const gosum = read("../native/file-index/go.sum");
	assert.match(gosum, /github\.com\/mozillazg\/go-pinyin v\d[\d.]* h1:/);
	// 拼音通道只在 sidecar 通道里：扫盘兜底（FileSystemService）不得出现拼音实现，
	// 否则两套语义会分叉（用户在不同机器上看到不同结果）。
	const fsService = read("../src/main/fs/FileSystemService.ts");
	assert.doesNotMatch(fsService, /pinyin/i);
});
