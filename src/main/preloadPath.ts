import { app } from "electron";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";

export async function preparePreloadPath(sourcePath: string, name: string) {
	if (!is.dev || app.isPackaged) return sourcePath;

	const targetDir = join(app.getPath("userData"), "preload");
	const targetPath = join(targetDir, name);
	await mkdir(targetDir, { recursive: true });
	await copyFile(sourcePath, targetPath);
	return targetPath;
}
