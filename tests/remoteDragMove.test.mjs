/**
 * 远端文件面板的内部拖放移动 + 本机判定统一 + 本机 IO 超时。
 *
 * 三件都属于「看起来能跑、实际有一条错路」的类型：
 * - 内部拖动若被当成「从系统拖文件上传」，松手就会去读一个不存在的本机路径；
 * - 图片判定若有两份，新加格式时会出现「远端能看、本地打不开」；
 * - UNC 上 `stat()` 永不返回，一次拖放能把「上传中」挂死。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isImageFile, isBinaryExtension, isTextFile, isPdfFile } = loadTsCommonJs("src/renderer/src/utils/isTextFile.ts");
const { imageMimeForPath, BINARY_IMAGE_EXTENSIONS } = loadTsCommonJs("src/renderer/src/utils/imageMime.ts");
const { parseLocalUploadPaths, LOCAL_FILE_IO_TIMEOUT_MS } = loadTsCommonJs("src/main/ipc/remoteUploadPaths.ts");

test("图片判定与 MIME 映射同源：不会出现「远端能预览、本地打不开」", () => {
	for (const ext of BINARY_IMAGE_EXTENSIONS) {
		const path = `dir/photo.${ext}`;
		assert.equal(isImageFile(path), true, `${ext} 必须被 isImageFile 认出`);
		assert.equal(imageMimeForPath(path) !== undefined, true, `${ext} 必须有 MIME`);
		assert.equal(isBinaryExtension(path), true, `${ext} 是二进制`);
		assert.equal(isTextFile(path), false, `${ext} 不能进文本编辑器`);
	}
});

test("SVG 与无扩展名文件的判定：SVG 是文本，无扩展名按文本处理", () => {
	assert.equal(isImageFile("icon.svg"), false);
	assert.equal(isBinaryExtension("icon.svg"), false);
	assert.equal(isTextFile("icon.svg"), true);
	assert.equal(isTextFile("LICENSE"), true);
	// 文件名里带点的目录不能被当成扩展名。
	assert.equal(isImageFile("assets.png/README"), false);
	assert.equal(isPdfFile("docs/report.pdf"), true);
	assert.equal(isPdfFile("docs/report.pdfx"), false);
});

test("上传链路真的用了有界等待（纯函数行为另见 remoteEntryDrag.test.mjs）", () => {
	const source = readFileSync("src/main/ipc/remoteProjectTransferJobIpc.ts", "utf8");
	assert.match(source, /withLocalIoTimeout\(stat\(path\)/);
	// 批级预算：第一条超时后剩余项直接失败，不再各等一个单条上限。
	assert.match(source, /createLocalIoBudget\(\)/);
	assert.match(source, /budget\.exhausted\(\)/);
	assert.match(source, /LOCAL_FILE_IO_TIMEOUT_MS/);
});

test("拖放路径解析不因超时逻辑而放宽（仍然只收本机绝对路径）", () => {
	assert.equal(parseLocalUploadPaths(["/tmp/a.txt"]).ok, true);
	assert.equal(parseLocalUploadPaths(["tmp/a.txt"]).ok, false);
});

test("面板接线用纯函数做拖放路由与落点（逻辑不在 JSX lambda 里）", () => {
	const panel = readFileSync("src/renderer/src/components/session/RemoteProjectPanel.tsx", "utf8");
	// 行组件已与本地文件树共用（FileTreeRows），远端拖拽类型由面板经 remoteDragType 注入。
	const rows = readFileSync("src/renderer/src/components/session/FileTreeRows.tsx", "utf8");
	// 根 drop 必须经 remoteDropRoute 判定，而不是内联的 types 判断。
	assert.match(panel, /remoteDropRoute\(\{ hasFiles:/);
	assert.match(panel, /remoteDropOnBlankArea\(route\)/);
	// 落点经 moveDestination 计算（同目录早退在那里），并把拖动条目传进去。
	assert.match(panel, /moveDestination\(sourcePath, targetDirectory\)/);
	assert.match(panel, /onMoveFiles=\{\(sourcePaths, targetDirectory\)/);
	// 行级落点同样交给共用行组件，并复用常量而不是字面量（字面量会让内部拖动静默退化）。
	assert.match(rows, /setData\(props\.remoteDragType, node\.relativePath\)/);
	assert.match(panel, /remoteDragType=\{REMOTE_ENTRY_DRAG_TYPE\}/);
	assert.match(rows, /dropEffect = "move"/);
	// 单文件红线：行组件抽出后面板必须回到目标范围。
	const lines = panel.split("\n").length;
	assert.ok(lines <= 440, `RemoteProjectPanel 应回到 440 行以内，实际 ${lines}`);
});

test("移动复用 rename（不新增远端写面，也不放宽版本令牌）", () => {
	const panel = readFileSync("src/renderer/src/components/session/RemoteProjectPanel.tsx", "utf8");
	const moveInto = /const moveInto = useCallback\([\s\S]*?\n\t\);/.exec(panel);
	assert.ok(moveInto);
	assert.match(moveInto[0], /files\.renameEntry\(sourcePath, destination\)/);
	assert.doesNotMatch(moveInto[0], /remoteHosts\.(move|delete|create)/, "移动不得绕过 entry 令牌链路");
});
