/**
 * SoundFileStore —— 自定义音频文件管理（userData/sounds/）。
 *
 * 职责：
 * - 导入：主进程弹文件选择框 → 校验扩展名/大小 → 复制进受管目录（文件名清洗防路径逃逸）；
 * - 列举/删除：供设置页展示与维护；
 * - resolveCustomPath：供 pideck-sound:// 协议 handler 做路径白名单校验。
 * 所有写入都限制在 userData/sounds/ 内，禁止拼接用户输入直接读写任意路径。
 */
import { app, dialog, type BrowserWindow } from "electron";
import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import {
	CUSTOM_SOUND_EXTENSIONS,
	isAllowedCustomSoundName,
	MAX_CUSTOM_SOUND_BYTES,
	type CustomSoundInfo,
	type SoundImportResult,
} from "../../shared/types/soundAlert";

/** 受管目录：userData/sounds/（与背景图/粘贴文件同一「应用数据目录」边界）。 */
export function customSoundsDir(): string {
	return join(app.getPath("userData"), "sounds");
}

/** 文件选择框参数（模块级常量，避免每次弹窗重建对象）。 */
const openDialogOptions: Electron.OpenDialogOptions = {
	title: "Select a sound file",
	properties: ["openFile"],
	filters: [
		{
			name: "Audio",
			extensions: [...CUSTOM_SOUND_EXTENSIONS],
		},
	],
};

/** 文件名清洗：去掉路径分隔符与非法字符，只留安全段 + 允许的扩展名。 */
function sanitizeCustomName(rawName: string): string | null {
	const ext = extname(rawName).toLowerCase().replace(/^\./, "");
	if (!(CUSTOM_SOUND_EXTENSIONS as readonly string[]).includes(ext)) return null;
	// basename 去目录成分；再去掉除 [A-Za-z0-9._-] 外的字符（保留中文会被 isAllowedCustomSoundName 拒绝，
	// 这里统一转 ASCII 安全名，避免协议 URL/设置引用出现编码问题）。
	const stem = basename(rawName, extname(rawName))
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	if (!stem) return null;
	const name = `${stem}.${ext}`;
	return isAllowedCustomSoundName(name) ? name : null;
}

/** 解析并校验自定义文件名 → userData/sounds/ 内绝对路径（逃逸返回 null）。 */
export function resolveCustomSoundPath(name: string): string | null {
	if (!isAllowedCustomSoundName(name)) return null;
	const file = resolve(customSoundsDir(), name);
	const root = resolve(customSoundsDir()) + sep;
	if (!file.startsWith(root)) return null;
	return file;
}

/**
 * 打开文件选择框并导入自定义音频到 userData/sounds/。
 * 同名文件追加数字后缀（导入两次不覆盖）；取消/非法/超限返回结构化错误。
 */
export async function importCustomSound(
	parent: BrowserWindow | null,
): Promise<SoundImportResult> {
	try {
		const result = parent
			? await dialog.showOpenDialog(parent, openDialogOptions)
			: await dialog.showOpenDialog(openDialogOptions);
		if (result.canceled || result.filePaths.length === 0) {
			return { ok: false, error: "canceled" };
		}
		const source = result.filePaths[0];
		const safeName = sanitizeCustomName(basename(source));
		if (!safeName) return { ok: false, error: "invalidType" };
		const size = (await stat(source)).size;
		if (size > MAX_CUSTOM_SOUND_BYTES) return { ok: false, error: "tooLarge" };

		await mkdir(customSoundsDir(), { recursive: true });
		// 同名冲突：追加 -2/-3... 直到不冲突（不覆盖用户已有文件）。
		let target = join(customSoundsDir(), safeName);
		const ext = extname(safeName);
		const stem = safeName.slice(0, safeName.length - ext.length);
		let index = 2;
		while (true) {
			try {
				await stat(target);
				target = join(customSoundsDir(), `${stem}-${index}${ext}`);
				index += 1;
			} catch {
				break;
			}
		}
		await copyFile(source, target);
		return { ok: true, info: { name: basename(target), size } };
	} catch {
		return { ok: false, error: "readFailed" };
	}
}

/** 扫描受管目录，返回全部自定义音频（含大小）。目录不存在视为空。 */
export async function listCustomSounds(): Promise<CustomSoundInfo[]> {
	try {
		await mkdir(customSoundsDir(), { recursive: true });
		const entries = await readdir(customSoundsDir(), { withFileTypes: true });
		const infos: CustomSoundInfo[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !isAllowedCustomSoundName(entry.name)) continue;
			try {
				const s = await stat(join(customSoundsDir(), entry.name));
				infos.push({ name: entry.name, size: s.size });
			} catch {
				// 文件瞬时不可读（杀软锁等）跳过，不阻塞整体列表
			}
		}
		infos.sort((a, b) => a.name.localeCompare(b.name));
		return infos;
	} catch {
		return [];
	}
}

/** 删除自定义音频；文件名非法或不存在时静默（返回 false）。 */
export async function removeCustomSound(name: string): Promise<boolean> {
	const file = resolveCustomSoundPath(name);
	if (!file) return false;
	try {
		await unlink(file);
		return true;
	} catch {
		return false;
	}
}
