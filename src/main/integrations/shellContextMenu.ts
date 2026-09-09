import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * 资源管理器右键菜单注册（HKCU，免管理员）：
 * - Directory\shell：文件夹图标上右键；
 * - Directory\Background\shell：文件夹空白处右键。
 * 两者都注册，覆盖用户在不同位置触发「用 PiDeck 打开」。
 * 菜单命令统一走 `--open-project <绝对路径>`，主进程据此跳转/新增项目。
 */
const REG_BASE = "HKCU\\Software\\Classes";
export const SHELL_MENU_KEYS = {
	folder: `${REG_BASE}\\Directory\\shell\\PiDeck`,
	background: `${REG_BASE}\\Directory\\Background\\shell\\PiDeck`,
} as const;

/**
 * 注册表中的命令模板。%1 = 被右键的文件夹路径（Directory 场景），
 * %V = 当前目录路径（Background 场景）；两者都由 Explorer 在触发时展开为
 * 实际路径，因此命令行中要显式加引号包裹，保证含空格路径仍被 argv 解析为单参数。
 * 正因为命令不经 cmd /c 执行（reg.exe 直接写值），%1/%V 原样保留在注册表中。
 * dev（electron 二进制）下必须带 app 路径，否则 Explorer 点菜单会启动空白 electron。
 */
const COMMAND_TEMPLATE = (
	exePath: string,
	appPath: string,
	placeholder: "%1" | "%V",
) =>
	appPath
		? `"${exePath}" "${appPath}" --open-project "${placeholder}"`
		: `"${exePath}" --open-project "${placeholder}"`;

/** 注册表查询用：检查 shell 菜单键是否存在 */
async function keyExists(key: string): Promise<boolean> {
	try {
		await execFileAsync("reg", ["query", key]);
		return true;
	} catch {
		return false;
	}
}

/**
 * 注册「用 PiDeck 打开」右键菜单（覆盖式写操作，重复调用幂等）。
 * @param exePath 应用可执行文件绝对路径；dev 下为 electron.exe（会带 app 路径参数）
 * @param appPath dev 模式下的应用根目录，packaged 模式传空串
 * @param menuTitle 右键菜单显示名（新建目录场景），默认英文
 */
export async function registerShellContextMenu(
	exePath: string,
	appPath = "",
	menuTitle = "Open with PiDeck",
): Promise<void> {
	const add = (key: string, value: string, valueName?: string) =>
		execFileAsync("reg", [
			"add",
			key,
			...(valueName ? ["/v", valueName] : ["/ve"]),
			"/d",
			// 直接传原样字符串，禁止手动把 " 预转义成 \"：
			// execFile 经 libuv 拼命令行时，含空格的参数会被外层引号包裹、反斜杠加倍（" → \\"），
			// reg.exe 解析命令行只还原一层，最终写进注册表的会变成字面 \"——Explorer 触发时把 \"
			// 当作路径一部分解析，报“Windows 无法访问指定设备、路径或文件”。实测不预转义时
			// reg.exe 能正确存入嵌套引号（如 "D:\path\PiDeck.exe" --open-project "%1"）。
			value,
			"/f",
		]);
	await Promise.all([
		// 文件夹图标右键：%1 = 被右键的目录
		add(SHELL_MENU_KEYS.folder, menuTitle),
		add(join(SHELL_MENU_KEYS.folder, "command"), COMMAND_TEMPLATE(exePath, appPath, "%1")),
		add(SHELL_MENU_KEYS.folder, exePath, "Icon"),
		// 文件夹空白处右键：%V = 当前目录（Explorer 展开时自带引号）
		add(SHELL_MENU_KEYS.background, menuTitle),
		add(join(SHELL_MENU_KEYS.background, "command"), COMMAND_TEMPLATE(exePath, appPath, "%V")),
		add(SHELL_MENU_KEYS.background, exePath, "Icon"),
	]);
}

/** 取消注册右键菜单（幂等：键不存在时 reg delete /f 也会成功）。 */
export async function unregisterShellContextMenu(): Promise<void> {
	await Promise.all([
		execFileAsync("reg", ["delete", SHELL_MENU_KEYS.folder, "/f"]),
		execFileAsync("reg", ["delete", SHELL_MENU_KEYS.background, "/f"]),
	]);
}

/** 查询右键菜单是否已注册（任一位置存在即视为已启用；注册时两处总是成对写入）。 */
export async function isShellContextMenuRegistered(): Promise<boolean> {
	return (await keyExists(SHELL_MENU_KEYS.folder)) && (await keyExists(SHELL_MENU_KEYS.background));
}