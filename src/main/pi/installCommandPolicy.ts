/**
 * piExecInstall 命令白名单策略（IPC 边界校验，纯函数可单测）。
 *
 * 背景：设置页「安装命令」输入框的字符串经 pi:exec-install 通道直通主进程，
 * 由 cmd.exe /d /s /c（Windows）或 /bin/sh -c（其他平台）执行。渲染层输入一律
 * 不可信（AGENTS.md 安全约束），本策略把合法形态收敛为：
 *
 *   <npm|pnpm|yarn|bun> [global] <install|i|add> [flags...] <package>[@version]...
 *
 * 拒绝一切 shell 元字符与非包管理器命令头，消灭「粘贴任意命令即执行」的注入面。
 * 版本区间（@^1、@>=2 等）被一并拒绝：cmd 的 ^ 是转义符会被静默吞掉、> 是重定向，
 * 允许它们本身就是漏洞；需要精确版本用 @1.2.3 形式。
 */

export type InstallCommandCheck = { ok: true; command: string } | { ok: false; reason: string };

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const INSTALL_VERBS = new Set(["install", "i", "add"]);
/** 包名/带版本后缀的 token：@scope/name、name@1.2.3、name@latest 等均匹配，不含任何 shell 元字符 */
const PACKAGE_TOKEN_RE = /^[@a-zA-Z0-9._/-]+$/;
/** 长旗标：--global、--force、--registry=https://...（值限 URL 常用字符，不含 & ? 等元字符） */
const LONG_FLAG_RE = /^--[a-zA-Z0-9][a-zA-Z0-9-]*(=[a-zA-Z0-9._~:/@-]+)?$/;
/** 短旗标：-g、-D、-gD 等字母组合 */
const SHORT_FLAG_RE = /^-[a-zA-Z]+$/;
const MAX_COMMAND_LENGTH = 200;

/**
 * 校验安装命令。通过则返回规范化（trim + 连续空白压成单空格）后的命令串，
 * 拒绝则返回原因（拼进 PiInstallExecResult.stderr 展示给用户）。
 */
export function validateInstallCommand(raw: string): InstallCommandCheck {
	const command = raw.trim().replace(/\s+/g, " ");
	if (!command) return { ok: false, reason: "command is empty" };
	if (command.length > MAX_COMMAND_LENGTH) {
		return { ok: false, reason: `command is longer than ${MAX_COMMAND_LENGTH} characters` };
	}
	// cmd / sh 元字符全量拒绝：& | < > 重定向与管道、^ 转义、% 变量展开、! 延迟展开、
	// $ 变量、引号/反引号/分号/括号。合法的包名与旗标都不需要它们。
	if (/[&|<>^%!$`'"();,]/.test(command)) {
		return { ok: false, reason: "shell metacharacters are not allowed" };
	}
	const tokens = command.split(" ");
	const [head, ...rest] = tokens;
	if (!PACKAGE_MANAGERS.has(head)) {
		return { ok: false, reason: `command must start with one of: ${[...PACKAGE_MANAGERS].join(", ")}` };
	}
	// yarn 的「global add」形态：动词前允许可选 global 修饰
	let verbIndex = 0;
	if (rest[0] === "global") verbIndex = 1;
	const verb = rest[verbIndex];
	if (!verb || !INSTALL_VERBS.has(verb)) {
		return { ok: false, reason: `expected an install verb (${[...INSTALL_VERBS].join("/")}) after the package manager` };
	}
	for (const token of rest.slice(verbIndex + 1)) {
		if (token === "global") return { ok: false, reason: '"global" is only allowed before the install verb (yarn global add)' };
		if (LONG_FLAG_RE.test(token) || SHORT_FLAG_RE.test(token) || PACKAGE_TOKEN_RE.test(token)) continue;
		return { ok: false, reason: `unsupported token: "${token}" (allowed: flags, package[@version])` };
	}
	return { ok: true, command };
}
