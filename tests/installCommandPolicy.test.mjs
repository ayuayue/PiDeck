/**
 * piExecInstall 命令白名单策略测试：
 * - validateInstallCommand 纯函数单测（合法形态通过+规范化，非法形态拒绝）；
 * - systemIpc 源码契约：处理器入口必须先过策略校验，execFile 只允许喂 normalized
 *   （防止未来改回直通原始 command 字符串）。
 * 正则按仓库契约空白容忍（\s* / [\s\S]），避免格式化调整打碎断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { validateInstallCommand } = loadTsCommonJs("src/main/pi/installCommandPolicy.ts");

test("合法：默认安装命令（npm install -g @scope/name）", () => {
	const result = validateInstallCommand("npm install -g @earendil-works/pi-coding-agent");
	// 不用 deepEqual：vm 加载的对象跨 realm，原型不同会被 deepStrictEqual 误判
	assert.equal(result.ok, true);
	assert.equal(result.command, "npm install -g @earendil-works/pi-coding-agent");
});

test("合法：各包管理器与动词变体", () => {
	for (const cmd of ["npm i pi-coding-agent@2.5.0", "pnpm add -g @scope/pkg@latest", "yarn global add pkg", "bun install pkg", "npm install -D pkg", "npm install --registry=https://registry.npmmirror.com pkg"]) {
		const result = validateInstallCommand(cmd);
		assert.equal(result.ok, true, cmd);
	}
});

test("合法且规范化：连续空白压成单空格，首尾空白剔除", () => {
	const result = validateInstallCommand("   npm\t install   -g  pkg ");
	assert.equal(result.ok, true);
	assert.equal(result.command, "npm install -g pkg");
});

test("拒绝：非包管理器命令头", () => {
	for (const cmd of ["rm -rf /", "cmd /c evil", "powershell -enc AAA", "echo hi", "npm", "npm run pkg"]) {
		assert.equal(validateInstallCommand(cmd).ok, false, cmd);
	}
});

test("拒绝：shell 元字符（管道/重定向/转义/变量/引号/分号/括号）", () => {
	for (const cmd of ["npm install pkg && calc", "npm install pkg|calc", "npm install foo>bar", "npm install foo<bar", "npm install pkg@^1.2.3", "npm install pkg@>=1", 'npm install "pkg"', "npm install pkg;calc", "npm install $(whoami)", "npm install `id`", "npm install %PATH%", "npm install pkg!v2"]) {
		assert.equal(validateInstallCommand(cmd).ok, false, cmd);
	}
});

test("注入被中和：换行注入的二级命令被折叠进同一条 npm 命令（无害化）", () => {
	const result = validateInstallCommand("npm install pkg\nrm -rf /");
	assert.equal(result.ok, true);
	assert.equal(result.command, "npm install pkg rm -rf /", "孤立 / 也是合法包名 token，无害保留");
});

test("拒绝：动词后再次出现 global、反斜杠路径、超长命令、空命令", () => {
	assert.equal(validateInstallCommand("npm install pkg global").ok, false);
	assert.equal(validateInstallCommand("npm install C:\\pkg\\bar").ok, false);
	assert.equal(validateInstallCommand(`npm install ${"a".repeat(200)}`).ok, false);
	assert.equal(validateInstallCommand("   ").ok, false);
});

test("源码契约：systemIpc 处理器先校验再执行，execFile 只喂 normalized", () => {
	const src = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	assert.match(src, /import \{ validateInstallCommand \} from "\.\.\/pi\/installCommandPolicy"/);
	const handler = src.match(/ipcMain\.handle\(ipcChannels\.piExecInstall,[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.ok(handler, "piExecInstall 处理器存在");
	assert.match(handler, /const check = validateInstallCommand\(command\)/);
	assert.match(handler, /Command rejected: \$\{check\.reason\}/);
	const normalizedArgs = handler.match(/,\s*normalized\]/g) ?? [];
	assert.equal(normalizedArgs.length, 2, "win32 cmd /c 与非 Windows sh -c 两处都必须用 normalized");
	assert.doesNotMatch(handler, /"\/c",\s*command\]/);
	assert.doesNotMatch(handler, /" -c",\s*command\]/);
});
