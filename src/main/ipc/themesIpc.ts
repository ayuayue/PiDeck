/**
 * 自定义主题 IPC（themes: 域）：只做入参校验与适配，行为在 CustomThemeStore。
 * 写指南文件后用资源管理器定位（与 filesIpc 的 showItemInFolder 同模式）。
 */
import { ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { buildCustomThemeGuideMarkdown, CUSTOM_THEME_GUIDE_FILENAME, type CustomThemeGuideLocale } from "../../shared/customThemeGuide";
import { deleteCustomTheme, listCustomThemes, readCustomTheme, saveCustomTheme, customThemesDir } from "../themes/CustomThemeStore";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function registerThemesIpc(): void {
	ipcMain.handle(ipcChannels.listCustomThemes, () => listCustomThemes());
	ipcMain.handle(ipcChannels.readCustomTheme, (_event, id: unknown) => (typeof id === "string" ? readCustomTheme(id) : null));
	ipcMain.handle(ipcChannels.saveCustomTheme, (_event, raw: unknown) => (typeof raw === "string" ? saveCustomTheme(raw) : Promise.resolve({ ok: false as const, errors: ["主题内容必须是 JSON 字符串"] })));
	ipcMain.handle(ipcChannels.deleteCustomTheme, (_event, id: unknown) => (typeof id === "string" ? deleteCustomTheme(id) : undefined));
	ipcMain.handle(ipcChannels.writeCustomThemeGuide, async (_event, locale: unknown) => {
		const guideLocale: CustomThemeGuideLocale = locale === "en-US" ? "en-US" : "zh-CN";
		const dir = customThemesDir();
		await mkdir(dir, { recursive: true });
		const file = join(dir, CUSTOM_THEME_GUIDE_FILENAME);
		await writeFile(file, buildCustomThemeGuideMarkdown(guideLocale, dir), "utf8");
		// 打开资源管理器并定位文件，用户可直接把文件路径丢给 AI
		shell.showItemInFolder(file);
		return file;
	});
}
