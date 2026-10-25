import { app, shell, type NativeImage, type ShortcutDetails } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { join, dirname, win32 } from "node:path";
import { resolveLogoImage } from "./appWindowLogo";
import { DEFAULT_DEV_USER_DATA_NAME, sanitizeDevBranchSegment } from "./devIsolation";
import { getAppLogger } from "./logging/sharedLogger";
import type { LogoStyle } from "../shared/types/settings";

/**
 * 任务栏按钮的身份（应用名 + 图标）跟随设置里的 logo。
 *
 * Windows 解析规则（2027-10「pack:dev 后任务栏变成 Electron 原生 logo」实测结论：用空白 Electron 应用分别
 * 组合「自设 AUMID / 注册表 DisplayName+IconUri / 窗口图标」对照，探针与结论见该 issue 记录）：
 * 1. 任务栏按钮的身份是个「应用注册项」：按 AUMID 找开始菜单/任务栏固定项里同 AUMID 的快捷方式，取它的
 *    名字与图标——残留在开始菜单里的 Electron.lnk（目标 electron.exe、却带着本程序的 AUMID）就把按钮变成
 *    了「Electron + 原子标」。
 * 2. 找不到同 AUMID 的快捷方式时：名字退到 exe 的 FileDescription，图标退到 exe 的静态图标（连窗口图标
 *    WM_SETICON 也不影响任务栏——这正是“设置里换了 logo，任务栏不动”的直接原因）。
 * 3. `HKCU\Software\Classes\AppUserModelId\<AUMID>` 的 DisplayName/IconUri **只作用于通知**：全新 AUMID +
 *    写好这两个值 + 另给窗口图标，按钮名字与图标都不变（已实测证伪，勿再走这条路）。
 *
 * 于是运行期唯一可控的旋钮，是本程序自己那条快捷方式的图标：本模块把当前 logo 落成内容寻址的 .ico，更新
 * **目标 exe 就是本程序**的快捷方式（开始菜单 + 任务栏固定项）的图标；其它快捷方式一律不碰，绝不新建或删除。
 * 快捷方式找不到（win-unpacked 直接跑、用户没建过）时不做事：按钮会按规则 2 退到 exe 的静态图标，只留一行日志。
 *
 * 边界：只处理 Windows；只写当前用户可写的快捷方式（不需要管理员）；任何一步失败只记日志——
 * 任务栏图标不对不该影响会话与其余功能。
 */

/** 打包版 AUMID：安装包、快捷方式、通知归属都认它，改动会让既有固定项与通知归属失效。 */
export const PACKAGED_APP_USER_MODEL_ID = "com.ayuayue.pi-desktop";

/** dev 通道 AUMID 前缀：与正式版分开，避免通知中心归属混淆（与 dev userData 隔离同思路）。 */
const DEV_APP_USER_MODEL_ID_PREFIX = "com.ayuayue.pi-desktop-dev";

/** 图标落盘子目录（相对 userData）与文件名前缀。 */
const TASKBAR_LOGO_DIR = "logos";
const TASKBAR_LOGO_PREFIX = "taskbar-logo-";

/** 图标最大边：任务栏最多用到 48px 级，256 已覆盖 200% DPI，再大只是白写磁盘。 */
const ICON_MAX_EDGE = 256;

/** 快捷方式扫描上限与递归深度：开始菜单正常几十条，设上限只因不受控目录不该拖住启动。 */
const SHORTCUT_SCAN_LIMIT = 2000;
const SHORTCUT_SCAN_MAX_DEPTH = 4;

/** 本进程生效的 AUMID；未登记前同步视为不适用并跳过。 */
let registeredAumid: string | null = null;

/** 上一次已同步的签名，避免同一次启动里重复落盘与重写快捷方式。 */
let lastAppliedSignature: string | null = null;

/**
 * 当前构建生效的 AppUserModelID。
 *
 * 必须与 app.setAppUserModelId 同源：快捷方式匹配、通知归属都认这个串，两处各拼一次迟早会错位。
 */
export function resolveAppUserModelId(input: { isDevBuild: boolean; devUserDataDirName: string; devGitBranch?: string | null }): string {
	if (!input.isDevBuild) return PACKAGED_APP_USER_MODEL_ID;
	if (input.devUserDataDirName === DEFAULT_DEV_USER_DATA_NAME) return DEV_APP_USER_MODEL_ID_PREFIX;
	return `${DEV_APP_USER_MODEL_ID_PREFIX}.${sanitizeDevBranchSegment(input.devGitBranch ?? "detached")}`;
}

/** 启动时在 app.setAppUserModelId 同一处登记进程身份；只登记一次，运行期不变。 */
export function registerTaskbarIdentityAumid(aumid: string): void {
	registeredAumid = aumid;
	lastAppliedSignature = null;
}

/** 按内容寻址的图标文件名：内容变则路径变，省得 Windows 拿旧路径的图标缓存糊弄。 */
export function taskbarLogoIcoFileName(ico: Buffer): string {
	return `${TASKBAR_LOGO_PREFIX}${createHash("sha256").update(ico).digest("hex").slice(0, 12)}.ico`;
}

/**
 * 纯函数：把 PNG 包成单条目 ICO（Vista 起允许 ICO 条目直接放 PNG 数据）。
 *
 * 目录条目的宽高字段只有 1 字节，256 必须写 0；`size` 与 PNG 实际边长不一致时 Windows 会用错尺寸，
 * 所以调用方必须传缩放后的真实边长（非正方形 logo 也照实写，只写最长边会让 shell 按正方形渲染）。
 */
export function buildIcoFromPng(png: Buffer, size: { width: number; height: number }): Buffer {
	const header = Buffer.alloc(22);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(1, 4); // 条目数
	header.writeUInt8(size.width >= 256 ? 0 : size.width, 6);
	header.writeUInt8(size.height >= 256 ? 0 : size.height, 7);
	header.writeUInt8(0, 8); // 调色板数（真彩固定 0）
	header.writeUInt8(0, 9); // reserved
	header.writeUInt16LE(1, 10); // color planes
	header.writeUInt16LE(32, 12); // bits per pixel
	header.writeUInt32LE(png.length, 14);
	header.writeUInt32LE(22, 18); // 数据紧跟在头部之后
	return Buffer.concat([header, png]);
}

/**
 * 纯函数：本进程该不该更新这条快捷方式；该更新时返回「保留原属性、只换图标」的完整参数。
 *
 * 两条闸：目标 exe 必须就是本进程（只碰自己的快捷方式），且对方没有别的 AUMID（不是本程序的身份）；
 * 图标已经是当前文件时返回 null，避免每次启动都改用户快捷方式的时间戳。
 */
export function planShortcutIconUpdate(input: { details: ShortcutDetails; execPath: string; aumid: string; iconPath: string }): ShortcutDetails | null {
	const details = input.details;
	if (!sameWindowsPath(details.target, input.execPath)) return null;
	const existingAumid = details.appUserModelId?.trim();
	if (existingAumid && existingAumid !== input.aumid) return null;
	if (details.iconIndex === 0 && sameWindowsPath(details.icon, input.iconPath)) return null;
	return { ...details, icon: input.iconPath, iconIndex: 0 };
}

/** 开始菜单快捷方式目录（当前用户 + 所有用户，安装包可能放任一）与任务栏固定项的快捷方式副本。 */
export function taskbarShortcutDirCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
	const dirs: string[] = [];
	const roaming = env.APPDATA?.trim();
	if (roaming) {
		dirs.push(join(roaming, "Microsoft", "Windows", "Start Menu", "Programs"));
		// 任务栏固定项是开始菜单快捷方式的副本，图标路径也抄了一份，换 logo 后不同步会停在旧图
		dirs.push(join(roaming, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"));
	}
	const programData = env.ProgramData?.trim();
	if (programData) dirs.push(join(programData, "Microsoft", "Windows", "Start Menu", "Programs"));
	return dirs;
}

/** 递归收集 .lnk；单个目录读不动（权限/被删）只跳过该目录，不拖垮整次扫描。 */
export function listShortcutFiles(roots: string[]): string[] {
	const files: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > SHORTCUT_SCAN_MAX_DEPTH || files.length >= SHORTCUT_SCAN_LIMIT) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= SHORTCUT_SCAN_LIMIT) return;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith(".lnk")) files.push(full);
		}
	};
	for (const root of roots) walk(root, 0);
	return files;
}

/**
 * 把当前 logo 同步到任务栏身份（Windows 专用，其它平台直接跳过）。
 *
 * 与 applyWindowLogoStyle/applyTrayLogoStyle 同一份解析路径：风格 + 自定义图进，落点不同
 * （这里是开始菜单快捷方式的图标，即任务栏按钮真正的图标来源）。任何失败只记日志。
 */
export function syncTaskbarShortcutIcon(input: { style: LogoStyle | string | null | undefined; customLogoDataUrl?: string | null }): void {
	if (process.platform !== "win32") return;
	const aumid = registeredAumid;
	if (!aumid) return;
	const entry = resolveLogoImage(input.style, input.customLogoDataUrl);
	if (!entry) return;
	try {
		const ico = toTaskbarLogoIco(entry.image);
		const signature = `${aumid}|${createHash("sha256").update(ico).digest("hex")}`;
		if (signature === lastAppliedSignature) return;
		const iconPath = writeTaskbarLogoIco(ico);
		const result = updateOwnShortcutIcons({ aumid, iconPath, resolved: entry.resolved });
		// 有快捷方式没写成功就当作没同步：不记签名（下次还会重试）也不清旧图标（它可能还被引用）
		if (result.failed === 0) {
			lastAppliedSignature = signature;
			removeStaleTaskbarLogoIcos(iconPath);
		}
	} catch (error) {
		void getAppLogger()?.warn("app-logo", "Failed to sync taskbar shortcut icon", { resolved: entry.resolved, error: error instanceof Error ? error.message : String(error) });
	}
}

/** 任务栏图标的 ICO 字节：只在大图时按最长边缩放，小图保持原样（放大只会更糊）。 */
function toTaskbarLogoIco(image: NativeImage): Buffer {
	const { width, height } = image.getSize();
	const scaled = Math.max(width, height) > ICON_MAX_EDGE ? image.resize(width >= height ? { width: ICON_MAX_EDGE, quality: "best" } : { height: ICON_MAX_EDGE, quality: "best" }) : image;
	const size = scaled.getSize();
	return buildIcoFromPng(scaled.toPNG(), size);
}

/** 落盘当前 logo：内容寻址，同一份 logo 重复调用不会重写文件。 */
function writeTaskbarLogoIco(ico: Buffer): string {
	const file = join(app.getPath("userData"), TASKBAR_LOGO_DIR, taskbarLogoIcoFileName(ico));
	if (!existsSync(file)) {
		mkdirSync(join(app.getPath("userData"), TASKBAR_LOGO_DIR), { recursive: true });
		writeFileSync(file, ico);
	}
	return file;
}

/** 清掉上一版图标文件（快捷方式已指向新路径）。 */
function removeStaleTaskbarLogoIcos(currentPath: string): void {
	const dir = dirname(currentPath);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(TASKBAR_LOGO_PREFIX) || !name.endsWith(".ico") || join(dir, name) === currentPath) continue;
		try {
			rmSync(join(dir, name), { force: true });
		} catch {
			// 旧文件清理失败只影响 userData 体积，不影响本次同步
		}
	}
}

/** 更新「目标 exe 就是本程序」的那些开始菜单快捷方式；返回命中与失败条数。 */
function updateOwnShortcutIcons(input: { aumid: string; iconPath: string; resolved: LogoStyle }): { matched: number; failed: number } {
	let matched = 0;
	let failed = 0;
	for (const file of listShortcutFiles(taskbarShortcutDirCandidates())) {
		let details: ShortcutDetails;
		try {
			details = shell.readShortcutLink(file);
		} catch {
			continue; // 损坏/非法的 .lnk：跳过，不影响其余条目
		}
		const next = planShortcutIconUpdate({ details, execPath: process.execPath, aumid: input.aumid, iconPath: input.iconPath });
		if (!next) {
			warnAboutConflictingShortcut(file, details, input.aumid);
			continue;
		}
		matched += 1;
		try {
			if (!shell.writeShortcutLink(file, "update", next)) throw new Error("writeShortcutLink returned false");
			void getAppLogger()?.info("app-logo", "Updated taskbar shortcut icon", { file, resolved: input.resolved });
		} catch (error) {
			failed += 1;
			void getAppLogger()?.warn("app-logo", "Failed to update taskbar shortcut icon", { file, resolved: input.resolved, error: error instanceof Error ? error.message : String(error) });
		}
	}
	// 一条自己的快捷方式都没有（win-unpacked 直接跑、用户没建过快捷方式）：任务栏图标退回 exe/窗口图标，
	// 给一行日志，免得下次又从头查一遍「为什么任务栏不是我的 logo」
	if (matched === 0) void getAppLogger()?.info("app-logo", "No start menu shortcut owned by this app; taskbar icon falls back to the exe and window icon", { aumid: input.aumid });
	return { matched, failed };
}

/**
 * 同 AUMID 但目标不是本程序的快捷方式会接管任务栏按钮的身份——「任务栏变成 Electron 原生 logo」就是这个现场
 * （残留在开始菜单里的 electron.exe 快捷方式带着本程序的 AUMID）。只记日志指认，绝不代删别人的快捷方式。
 */
function warnAboutConflictingShortcut(file: string, details: ShortcutDetails, aumid: string): void {
	if (details.appUserModelId?.trim() !== aumid) return;
	if (sameWindowsPath(details.target, process.execPath)) return;
	void getAppLogger()?.warn("app-logo", "Start menu shortcut shares this app's AUMID but targets another program", { file, target: details.target });
}

/** Windows 路径比较：大小写不敏感、分隔符统一（只用于判断「是不是同一个 exe/图标」）。 */
function sameWindowsPath(left?: string | null, right?: string | null): boolean {
	if (!left || !right) return false;
	try {
		return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
	} catch {
		return false;
	}
}
