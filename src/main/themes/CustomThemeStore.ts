/**
 * 自定义主题包存储：userData/custom-themes/ 目录的扫描/读取/保存/删除。
 * 校验一律走 shared/customThemes.parseCustomThemePackage（用户 JSON 视为不可信输入，
 * 与内置扩展清单同等姿态：解析失败不致命，条目降级为 parseError 呈现）。
 * 读/删以「文件主键」（文件名去 .json）为准而非包内 id：用户文件可以改名，
 * 也可以与内置示例同 id（内置示例是常量、不在磁盘上），按包内 id 定位会删错/删不掉。
 */
import { app } from "electron";
import { mkdir, access, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { trashPath } from "../fs/trash";
import { getAppLogger } from "../logging/sharedLogger";
import { DEMO_CUSTOM_THEME, parseCustomThemePackage, serializeCustomThemePackage, type CustomThemeListItem } from "../../shared/customThemes";

/** 文件是否存在（不区分错误类型：不存在/无权限都是「不可删」，报错优于默默放过） */
async function pathExists(target: string): Promise<boolean> {
	return access(target).then(
		() => true,
		() => false,
	);
}

/** 用户主题存放目录（与 backgrounds/ 同级的受管目录） */
export function customThemesDir(): string {
	return join(app.getPath("userData"), "custom-themes");
}

/** 内置示例主题条目（由 DEMO_CUSTOM_THEME 常量推导，校验通过才上架，防常量与校验器漂移） */
function builtinDemoItem(): CustomThemeListItem | null {
	const parsed = parseCustomThemePackage(serializeCustomThemePackage(DEMO_CUSTOM_THEME));
	if (!parsed.ok) return null;
	return { source: "builtin", id: parsed.theme.id, name: parsed.theme.name, version: parsed.theme.version, author: parsed.theme.author, description: parsed.theme.description, tokens: parsed.tokens };
}

/**
 * 文件主键 → 绝对路径；非法或可能逃逸主题目录的主键返回 null。
 * 主键来自列表返回的 fileId（用户可手改文件名，故不套包内 id 命名规范），
 * 但必须是单段纯文件名：拒绝对路径、盘符、上跳与分隔符，防止 IPC 入参逃逸。
 */
function resolveThemeFile(fileId: string): string | null {
	if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > 120) return null;
	if (fileId === "." || fileId === ".." || fileId.includes("\0") || fileId.includes(":")) return null;
	if (fileId !== basename(fileId) || isAbsolute(fileId)) return null;
	return join(customThemesDir(), `${fileId}.json`);
}

/** 列出全部主题：内置示例在前，用户目录按文件名序；解析失败的用户文件保留为错误条目 */
export async function listCustomThemes(): Promise<{ dir: string; themes: CustomThemeListItem[] }> {
	const dir = customThemesDir();
	const themes: CustomThemeListItem[] = [];
	const demo = builtinDemoItem();
	if (demo) themes.push(demo);
	await mkdir(dir, { recursive: true }).catch(() => undefined);
	const files = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
	for (const file of files) {
		const fileId = file.replace(/\.json$/, "");
		const raw = await readFile(join(dir, file), "utf8").catch(() => null);
		if (raw === null) continue;
		const parsed = parseCustomThemePackage(raw);
		if (parsed.ok) {
			themes.push({ source: "user", fileId, id: parsed.theme.id, name: parsed.theme.name, version: parsed.theme.version, author: parsed.theme.author, description: parsed.theme.description, tokens: parsed.tokens });
		} else {
			// 解析失败条目：不可应用，仅供定位坏文件（id 与文件主键一致）
			themes.push({ source: "user", fileId, id: fileId, name: file, tokens: { light: {}, dark: {} }, parseError: parsed.errors });
		}
	}
	return { dir, themes };
}

/**
 * 读取用户主题文件原文（编辑器用）。fileId 为列表返回的文件主键；
 * 内置示例不在磁盘上，其原文由渲染层从 DEMO_CUSTOM_THEME 常量序列化，不经这里。
 */
export async function readCustomTheme(fileId: string): Promise<string | null> {
	const target = resolveThemeFile(fileId);
	if (target === null) return null;
	return readFile(target, "utf8").catch(() => null);
}

export type SaveCustomThemeResult = { ok: true; id: string } | { ok: false; errors: string[] };

/** 校验并保存主题包（id 即文件名 <id>.json）；校验失败返回错误清单，不落盘 */
export async function saveCustomTheme(raw: string): Promise<SaveCustomThemeResult> {
	const parsed = parseCustomThemePackage(raw);
	if (!parsed.ok) return { ok: false, errors: parsed.errors };
	// 内置示例 id 保留给常量：用户文件与它同名会在列表里出现两张同名卡片（内置 + 用户），
	// 而「编辑内置示例 → 保存」正是这种影子文件的历史来源（见 deleteCustomTheme 注释）。
	if (parsed.theme.id === DEMO_CUSTOM_THEME.id) {
		return { ok: false, errors: [`id "${DEMO_CUSTOM_THEME.id}" 保留给内置示例，请改用其他 id（例如 my-berry-night）`] };
	}
	const dir = customThemesDir();
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${parsed.theme.id}.json`), serializeCustomThemePackage(parsed.theme), "utf8");
	getAppLogger()?.info("customThemes", "Custom theme saved", { id: parsed.theme.id });
	return { ok: true, id: parsed.theme.id };
}

/**
 * 删除用户主题文件（文件主键校验 + 回收站，可恢复）。
 * 只认文件，不认包内 id：与内置示例同 id 的用户文件会被真正删除（历史 bug：按内置 id 早退 →
 * 界面提示「已删除」而文件仍在）；文件不存在时抛错，由调用方提示失败，不谎报成功。
 */
export async function deleteCustomTheme(fileId: string): Promise<void> {
	const target = resolveThemeFile(fileId);
	if (target === null) return;
	// 文件不存在（已被外部移走，或同名的是不在磁盘上的内置示例）时明确报错：
	// 不交付「已删除」的假成功——历史上这里静默早退，界面提示成功而文件仍在。
	if (!(await pathExists(target))) throw new Error(`主题文件不存在：${basename(target)}`);
	await trashPath(target, { source: "customThemes:delete" });
	getAppLogger()?.info("customThemes", "Custom theme deleted", { fileId });
}
