// 聊天页文件链接右键菜单契约（issue #229 第 3 条诉求）。
//
// 背景：issue 要求聊天页的文件/目录链接支持右键菜单——复制文件路径、复制相对路径、
// 打开文件所在目录、用默认应用打开。前三项在 27839bc7 落地，第四项缺失（用户装了
// Typora 也无法用 Typora 打开回复里提到的 .md）。本测试锁住四项齐备、顺序、以及
// 「系统打开必须用解析后的路径」这条安全边界：
//  1. 菜单四项齐备、主操作在首位，与文件抽屉右键菜单（FileContextMenu）同序；
//  2. 「默认方式打开」必须走 desktopApi.files.open(resolvedPath, scope) —— resolvedPath
//     来自 resolveFileLinkPath（已按 baseDir/projectRoot 解析并过项目边界），
//     不允许拼原始 href：主进程虽然会二次授权，渲染层也不该把未解析路径送进 shell.openPath；
//  3. 菜单只挂在文件链接上（普通外链不弹），href 无解析结果时不弹；
//  4. 「复制相对路径」在目标落在项目外（relativePath 为 null）时禁用；
//  5. 复用文件抽屉的 `menu.defaultOpen` 文案，两个语言包都必须存在该 key。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

const linkSource = read("src/renderer/src/components/session/MarkdownLink.tsx");
const zhCopy = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const enCopy = read("src/renderer/src/i18n/rendererCopy.en-US.ts");

/** 取出菜单内容块：菜单项顺序断言只应在 DropdownMenuContent 内部成立。 */
function menuBlock() {
	const block = /<DropdownMenuContent\b[\s\S]*?<\/DropdownMenuContent>/.exec(linkSource)?.[0];
	assert.ok(block, "MarkdownLink should render a DropdownMenuContent for file links");
	return block;
}

test("右键菜单四项齐备，主操作（默认方式打开）在首位", () => {
	const block = menuBlock();
	const keys = ['t("menu.defaultOpen")', 't("fileLink.openInExplorer")', 't("fileLink.copyRelativePath")', 't("fileLink.copyAbsolutePath")'];
	const positions = keys.map((key) => block.indexOf(key));
	assert.ok(
		positions.every((position) => position >= 0),
		`expected all four menu keys, got positions ${positions.join(",")}`,
	);
	assert.deepEqual(
		[...positions].sort((a, b) => a - b),
		positions,
		"menu items must keep the documented order",
	);
});

test("默认方式打开走解析后的路径，失败复用统一错误提示", () => {
	// 项目内：解析后的 resolvedPath + 项目 scope；失败统一走 showOpenFailure（同一份 app.openFileFailed 文案）
	assert.match(linkSource, /const\s+openWithDefaultApp\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,700}?desktopApi\.files\.open\(resolvedPath,\s*scope\)\.catch\(showOpenFailure\)/);
	assert.match(linkSource, /const\s+showOpenFailure\s*=[\s\S]{0,220}?app\.openFileFailed/);
	// 菜单项必须绑到该处理函数，不能内联再复制一份逻辑
	assert.match(menuBlock(), /<DropdownMenuItem\s+onSelect=\{openWithDefaultApp\}>\s*\{t\("menu\.defaultOpen"\)\}/);
});

test("系统打开一律使用解析后的路径，不透传原始 href", () => {
	// 项目内走 (resolvedPath, scope)；项目外走 (externalPath)（无项目边界）；分流函数内部用入参 (targetPath, targetScope)
	const calls = [...linkSource.matchAll(/desktopApi\.files\.open\(([^)]*)\)/g)].map((match) => match[1].replace(/\s+/g, " ").trim());
	assert.ok(calls.length >= 3, `expected explorer route, default-open item and external gate, got ${calls.length} call(s)`);
	for (const args of calls) {
		assert.match(args, /^(resolvedPath, scope|externalPath|targetPath, targetScope)$/, `unexpected files.open arguments: ${args}`);
	}
	// 原始 href / 未解码路径绝不能进主进程
	assert.doesNotMatch(linkSource, /desktopApi\.files\.open\(\s*(fileLinkPath|props\.href|fileLinkRawPath)/);
});

test("菜单只挂文件链接，且无可解析路径时不弹", () => {
	assert.match(linkSource, /onContextMenu=\{(?:isFileLink \|\| isLocalRef) \? handleContextMenu : undefined\}/);
	assert.match(linkSource, /const\s+handleContextMenu\s*=[\s\S]{0,200}?if\s*\(!menuPath\)\s*return;/);
	// 菜单渲染整体以 menuPath 为守卫，避免打开一个空菜单
	assert.match(linkSource, /\{menu\s*&&\s*menuPath\s*&&\s*\(/);
});

// 项目外引用（issue：AI 生成/操作在项目外的文件点不开）：左键由 App 侧的安全等级门
// （useExternalPathOpenGate）决定直开 / 二次确认 / 拒绝；右键菜单里的系统动作（默认方式打开 /
// 在资源管理器中打开）走同一道门，项目内仍按项目边界直连主进程。
test("项目外路径：菜单系统动作也过安全等级门，项目内仍带项目 scope", () => {
	assert.match(linkSource, /const\s+externalPath\s*=[\s\S]{0,200}?resolveFileLinkPath\(fileLinkPath,\s*baseDir\)/);
	assert.match(linkSource, /const\s+menuPath\s*=\s*resolvedPath\s*\?\?\s*externalPath;/);
	// 门实例挂在链接自己身上（右键菜单本来就是本组件的局部状态），与 App 侧共用同一套判定函数
	assert.match(linkSource, /const\s*\{\s*requestExternalPathOpen,\s*dialog:\s*externalPathOpenDialog\s*\}\s*=\s*useExternalPathOpenGate\(\)/);
	// 项目外：两个系统动作都带 kind，且 proceed 里不带 scope（主进程无项目边界）
	const reveal = /void\s+requestExternalPathOpen\(\{\s*\n\s*kind:\s*"reveal"[\s\S]*?\n\t+\}\);/.exec(linkSource)?.[0];
	assert.ok(reveal, "「在资源管理器中打开」必须把项目外路径送进安全等级门");
	assert.doesNotMatch(reveal, /scope/);
	const defaultApp = /void\s+requestExternalPathOpen\(\{\s*\n\s*kind:\s*"default-app"[\s\S]*?\n\t+\}\);/.exec(linkSource)?.[0];
	assert.ok(defaultApp, "「默认方式打开」必须把项目外路径送进安全等级门");
	assert.doesNotMatch(defaultApp, /scope/);
	// 项目内继续直连主进程（带 scope），不能因为「项目外可开」就绕开项目边界
	assert.match(linkSource, /if\s*\(resolvedPath\)\s*\{[\s\S]{0,140}?desktopApi\.files\.open\(resolvedPath,\s*scope\)/);
	assert.match(linkSource, /revealInExplorer\(resolvedPath,\s*scope\)/);
	// 「复制绝对路径」不带条件，项目外也能拿到路径
	assert.match(menuBlock(), /<DropdownMenuItem\s+onSelect=\{copyAbsolutePath\}>/);
	assert.match(linkSource, /const\s+copyAbsolutePath\s*=[\s\S]{0,200}?writeClipboard\(menuPath\)/);
	// 确认弹框必须挂在链接上，否则菜单触发的确认框无处渲染
	assert.match(linkSource, /\{externalPathOpenDialog\}/);
});

test("可执行/脚本后缀对项目外不提供「默认方式打开」", () => {
	// canOpenWithDefaultApp：项目内始终给；项目外由 isExecutableLikePath 把关（shell.openPath 等于执行）
	assert.match(linkSource, /const\s+canOpenWithDefaultApp\s*=\s*resolvedPath\s*!==\s*null\s*\|\|\s*\(externalPath\s*!==\s*null\s*&&\s*!isExecutableLikePath\(externalPath\)\)/);
	assert.match(menuBlock(), /\{canOpenWithDefaultApp\s*&&\s*\(/);
	assert.match(linkSource, /import\s*\{\s*isExecutableLikePath\s*\}\s*from\s*"\.\.\/\.\.\/utils\/externalPathAccessPolicy"/);
	// 「在资源管理器中打开」无条件渲染（menuPath 保证菜单有目标），只唤起文件管理器、不读内容
	assert.match(menuBlock(), /<DropdownMenuItem\s+onSelect=\{openInExplorer\}>/);
});

test("复制相对路径在项目外禁用", () => {
	assert.match(menuBlock(), /<DropdownMenuItem\s+onSelect=\{copyRelativePath\}\s+disabled=\{!relativePath\}>/);
});

test("复用文件抽屉的 menu.defaultOpen 文案，两个语言包都在", () => {
	for (const copy of [zhCopy, enCopy]) {
		assert.match(copy, /"menu\.defaultOpen":\s*"/);
		assert.match(copy, /"fileLink\.openInExplorer":\s*"/);
		assert.match(copy, /"fileLink\.copyRelativePath":\s*"/);
		assert.match(copy, /"fileLink\.copyAbsolutePath":\s*"/);
	}
});

// —— issue #229 方案 C：Ctrl/⌘ + 左键 = 系统默认应用 ——
// 只做手势，不引入「全局二选一」或「后缀记忆」这类会被遗忘的设置（用户明确只批了 C）。

test("适配键方案 C：Ctrl/⌘ + 左键走系统默认应用，普通左键行为不变", () => {
	const start = linkSource.indexOf("const handleClick");
	const end = linkSource.indexOf("const handleContextMenu");
	assert.ok(start >= 0 && end > start, "MarkdownLink should keep handleClick before handleContextMenu");
	const clickBlock = linkSource.slice(start, end);
	// 同时接受 ctrlKey 与 metaKey：Windows/Linux 用 Ctrl、macOS 用 ⌘
	assert.match(clickBlock, /if\s*\(\(e\.ctrlKey\s*\|\|\s*e\.metaKey\)\s*&&\s*resolvedPath\)\s*\{[\s\S]{0,80}?openWithDefaultApp\(\);\s*return;\s*\}/);
	// 修饰键分支必须先于内置编辑器跳转，否则两条链路都会触发
	const modifierIndex = clickBlock.search(/if\s*\(\(e\.ctrlKey\s*\|\|\s*e\.metaKey\)/);
	const editorIndex = clickBlock.indexOf("onOpenFile(fileLinkPath, fileLinkLine)");
	assert.ok(editorIndex > modifierIndex, "the modifier branch must run before the built-in editor route");
	// 无修饰键时仍走 onOpenFile（默认体验不退化）
	assert.match(clickBlock, /if\s*\(onOpenFile\s*&&\s*fileLinkPath\)\s*\{[\s\S]{0,80}?onOpenFile\(fileLinkPath, fileLinkLine\)/);
});

test("修饰键文案平台化，且菜单快捷键与左键同源", () => {
	assert.match(linkSource, /const\s+FILE_LINK_MODIFIER\s*=\s*detectRendererPlatform\(\)\s*===\s*"darwin"\s*\?\s*"⌘"\s*:\s*"Ctrl"/);
	const item = /<DropdownMenuItem\s+onSelect=\{openWithDefaultApp\}>[\s\S]*?<\/DropdownMenuItem>/.exec(menuBlock())?.[0];
	assert.ok(item, "the default-open menu item should exist");
	assert.match(item, /<DropdownMenuShortcut>\{t\("fileLink\.modifierClickShortcut",\s*\{\s*modifier:\s*FILE_LINK_MODIFIER\s*\}\)\}<\/DropdownMenuShortcut>/);
	// hover 提示必须同时给出完整路径与快捷键说明（title 走 i18n，不硬编码中文）
	assert.match(linkSource, /title=\{isFileLink\s*\?[\s\S]{0,160}?fileLinkPath[\s\S]{0,160}?fileLink\.modifierOpenHint/);
});

test("修饰键文案两个语言包都在且带 {modifier} 占位符", () => {
	for (const copy of [zhCopy, enCopy]) {
		assert.match(copy, /"fileLink\.modifierClickShortcut":\s*"[^"]*\{modifier\}[^"]*"/);
		assert.match(copy, /"fileLink\.modifierOpenHint":\s*"[^"]*\{modifier\}[^"]*"/);
	}
});
