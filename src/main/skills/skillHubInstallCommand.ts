/**
 * 构造 skill-hub 安装命令（npx skills add <pkg> [--skill <name>] [--global]）。
 *
 * 为什么 win32 要走 cmd.exe 包装：Windows 上不能直接 spawn `*.cmd`（npx.cmd）——
 * Node 24 / Electron 43（内置 Node 24.18）对 .cmd/.bat 的直 spawn 会同步抛 EINVAL
 * （与 PATH/cwd/env 无关，全路径 .cmd 同样失败，而手动 cmd.exe /d /s /c 包装正常）。
 * 因此 win32 复用 piExecInstall / piCheckNpm 的既有策略（systemIpc.ts）：经
 * cmd.exe /d /s /c <命令串> 执行；非 Windows 平台保持 execFile 数组直调。
 *
 * 参数安全：pkg / skillName 必须由调用方先过 SAFE_SLUG_RE（仅 [a-zA-Z0-9@/\-_.]）
 * 白名单校验——拼入 cmd /c 命令串的值不含空白、引号和 &|<>^ 等 shell 元字符，
 * 不存在注入面。本函数不对输入再做校验（调用方 IPC 边界已把关）。
 */
export function buildSkillHubInstallCommand(input: {
	pkg: string;
	/** "--skill <name>"，可为空串 */
	skillName?: string;
	/** true = 按全局作用域安装（追加 --global） */
	global: boolean;
	/** 便于测试注入，默认取当前平台 */
	platform?: NodeJS.Platform;
}): { command: string; args: string[] } {
	const { pkg, skillName = "", global, platform = process.platform } = input;

	if (platform === "win32") {
		// 保持与原实现相同的选项顺序（--agent pi 在 --skill/--global 前，--yes 收尾）
		let cmdline = `npx skills add ${pkg} --agent pi`;
		if (skillName) cmdline += ` --skill ${skillName}`;
		if (global) cmdline += " --global";
		cmdline += " --yes";
		return {
			command: process.env.ComSpec || "cmd.exe",
			args: ["/d", "/s", "/c", cmdline],
		};
	}

	const args = ["skills", "add", pkg, "--agent", "pi"];
	if (skillName) args.push("--skill", skillName);
	if (global) args.push("--global");
	args.push("--yes");
	return { command: "npx", args };
}
