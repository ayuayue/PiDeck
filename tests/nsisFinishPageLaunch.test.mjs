import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 安装器完成页回归：electron-builder 默认用 $launchLink（优先开始菜单 .lnk）作为「运行」目标，
 * 而 .lnk 可能指向另一份同名同版本号的 PiDeck（解包构建/旧安装目录），装完点运行会跑错程序。
 * build/installer.nsh 用 customFinishPage 覆盖成 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"，这份测试守住它。
 */
const scriptPath = join(import.meta.dirname, "..", "build", "installer.nsh");
const script = readFileSync(scriptPath, "utf8");
// 注释里允许解释旧实现（$launchLink），断言只看真正参与编译的指令行
const code = script
	.split("\n")
	.filter((line) => !/^\s*#/.test(line))
	.join("\n");

test("installer.nsh 覆盖完成页启动目标为本次安装目录的 exe", () => {
	assert.match(code, /!macro\s+customFinishPage\b/, "缺少 customFinishPage 宏，electron-builder 会退回默认的 $launchLink 启动逻辑");
	assert.match(code, /ExecShellAsUser[\s\S]*?\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}/, "完成页没有直接启动 $INSTDIR\\${APP_EXECUTABLE_FILENAME}");
});

test("installer.nsh 不依赖快捷方式路径启动", () => {
	assert.doesNotMatch(code, /\$launchLink/, "$launchLink 优先取开始菜单 .lnk，会启动到别的构建");
	assert.doesNotMatch(code, /newStartMenuLink/, "不再使用安装器生成的快捷方式作为启动目标");
});

test("installer.nsh 保留完成页本身与「运行」勾选项", () => {
	assert.match(code, /!define\s+MUI_FINISHPAGE_RUN\b/);
	assert.match(code, /!define\s+MUI_FINISHPAGE_RUN_FUNCTION\s+"StartApp"/);
	assert.match(code, /!insertmacro\s+MUI_PAGE_FINISH/);
	assert.match(code, /\$\{isUpdated\}[\s\S]*?--updated/, "升级场景仍要带 --updated 参数");
});
